import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyOCI, restoreOCI } from '../src/image-cache.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'localcloud-oci-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  mkdirSync(join(directory, 'blobs', 'sha256'), {recursive:true});
  const blob = value => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(directory, 'blobs', 'sha256', digest.slice(7)), bytes);
    return {digest, size:bytes.length};
  };
  const config = blob({os:'linux', architecture:'amd64'});
  const layer = blob('immutable layer');
  const manifest = blob({schemaVersion:2, config, layers:[layer]});
  const source = {schemaVersion:2, manifests:[{...manifest, platform:{os:'linux',architecture:'amd64'}}]};
  const root = blob(source);
  writeFileSync(join(directory, 'source-manifest.json'), JSON.stringify(source));
  writeFileSync(join(directory, 'index.json'), JSON.stringify({schemaVersion:2, manifests:[{...manifest, annotations:{'org.opencontainers.image.ref.name':'localcloud'}}]}));
  return {directory, image:'example.com/localcloud@'+root.digest, config, layer, manifest};
}

test('OCI verification binds the selected configuration to the pinned root', t => {
  const f = fixture(t);
  assert.equal(verifyOCI(f.directory, f.image, {os:'linux', architecture:'amd64'}), f.config.digest);
});

test('tampered layers, root, configuration and platform fail verification', t => {
  for (const target of ['layer','config','source']) {
    const f = fixture(t);
    writeFileSync(target === 'source' ? join(f.directory,'source-manifest.json') : join(f.directory,'blobs','sha256',f[target].digest.slice(7)), 'tampered');
    assert.throws(() => verifyOCI(f.directory, f.image, {os:'linux',architecture:'amd64'}), /digest|size|JSON/);
  }
  const f = fixture(t);
  assert.throws(() => verifyOCI(f.directory, f.image, {os:'linux',architecture:'arm64'}), /platform/);
});

test('an OCI tag cannot select a manifest outside the pinned platform', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory,'index.json'), JSON.stringify({manifests:[{digest:'sha256:'+'f'.repeat(64),size:12,annotations:{'org.opencontainers.image.ref.name':'localcloud'}}]}));
  assert.throws(() => verifyOCI(f.directory, f.image, {os:'linux',architecture:'amd64'}), /manifest|digest/);
});

test('restoration imports through Docker so remote contexts retain their transport', t => {
  const f = fixture(t); const calls = []; const transfers = [];
  assert.equal(restoreOCI(f.directory, f.image, {os:'linux',architecture:'amd64'}, args => {
    calls.push(args);
    if (args[1] === 'inspect') throw Error('No such image');
    return 'loaded';
  }, (program,args) => transfers.push({program,args})), f.config.digest);
  assert.equal(transfers[0].program, 'skopeo');
  assert.match(transfers[0].args[2], /^docker-archive:/);
  assert.equal(calls[1][1], 'load');
  assert.equal(calls.some(args => args[0] === 'context'), false);
});
