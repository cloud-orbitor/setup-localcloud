import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireImage, options } from '../src/runtime.mjs';

const image = { Id: `sha256:${'a'.repeat(64)}`, Os: 'linux', Architecture: 'amd64', Config: { ExposedPorts: {'5380/tcp': {}} } };

test('warm exact-digest acquisition never pulls', () => {
  const calls = [];
  const result = acquireImage(options({}), args => {
    calls.push(args);
    if (args[0] === 'version') return '{"Os":"linux","Arch":"amd64"}';
    if (args[0] === 'image') return JSON.stringify([image]);
    throw Error('Registry access is unavailable');
  });
  assert.equal(result.reference, options({}).image);
  assert.equal(calls.filter(args => args[0] === 'pull').length, 0);
});

test('cold acquisition pulls once and validates the resulting platform', () => {
  const calls = []; let available = false;
  const result = acquireImage(options({}), args => {
    calls.push(args);
    if (args[0] === 'version') return '{"Os":"linux","Arch":"amd64"}';
    if (args[0] === 'image') { if (!available) throw Error('No such image'); return JSON.stringify([image]); }
    if (args[0] === 'pull') { available = true; return ''; }
    throw Error('Unexpected command');
  });
  assert.equal(result.image.Id, image.Id);
  assert.equal(calls.filter(args => args[0] === 'pull').length, 1);
  assert.deepEqual(calls.find(args => args[0] === 'pull').slice(0,3), ['pull','--platform','linux/amd64']);
});

test('daemon failures and wrong platform are not cache misses', () => {
  for (const failure of ['permission denied', 'Cannot connect to the Docker daemon']) {
    const calls = [];
    assert.throws(() => acquireImage(options({}), args => {
      calls.push(args);
      if (args[0] === 'version') return '{"Os":"linux","Arch":"amd64"}';
      throw Error(failure);
    }), new RegExp(failure));
    assert.equal(calls.some(args => args[0] === 'pull'), false);
  }
  assert.throws(() => acquireImage(options({}), args => args[0] === 'version' ? '{"Os":"linux","Arch":"amd64"}' : JSON.stringify([{...image, Architecture: 'arm64'}])), /platform/);
});

test('quota and authentication errors give configuration guidance without retrying', () => {
  for (const [failure, guidance] of [['toomanyrequests: pull rate limit', /credentials|mirror/], ['unauthorized: authentication required', /login|credentials/]]) {
    let pulls = 0;
    assert.throws(() => acquireImage(options({}), args => {
      if (args[0] === 'version') return '{"Os":"linux","Arch":"amd64"}';
      if (args[0] === 'image') throw Error('No such image');
      pulls++; throw Error(failure);
    }), guidance);
    assert.equal(pulls, 1);
  }
});
