import { openSync, readSync, closeSync, statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function json(file) {
  if (statSync(file).size > 1024 * 1024) throw Error('Image cache JSON exceeds 1 MiB');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function hash(file) {
  const fd = openSync(file, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
    return 'sha256:' + digest.digest('hex');
  } finally { closeSync(fd); }
}

export function verifyOCI(directory, image, platform) {
  const digest = image.split('@')[1];
  if (!DIGEST.test(digest || '')) throw Error('Image cache requires a pinned digest');
  const sourceFile = join(directory, 'source-manifest.json');
  if (hash(sourceFile) !== digest) throw Error('Image cache source digest mismatch');
  const source = json(sourceFile);
  const descriptors = json(join(directory, 'index.json')).manifests;
  if (!Array.isArray(descriptors)) throw Error('Invalid image cache manifest index');
  const tagged = descriptors.filter(d => d.annotations?.['org.opencontainers.image.ref.name'] === 'localcloud');
  if (tagged.length !== 1) throw Error('Image cache must contain one localcloud manifest');
  const selected = source.manifests
    ? source.manifests.filter(d => d.platform?.os === platform.os && d.platform?.architecture === platform.architecture)
    : [{digest, size:statSync(sourceFile).size}];
  if (selected.length !== 1) throw Error('Pinned image has no unique cached platform');
  if (tagged[0].digest !== selected[0].digest || tagged[0].size !== selected[0].size) throw Error('Image cache manifest does not match pinned platform digest');
  const blob = descriptor => {
    if (!descriptor || !DIGEST.test(descriptor.digest || '') || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0) throw Error('Invalid image cache blob descriptor');
    const file = join(directory, 'blobs', 'sha256', descriptor.digest.slice(7));
    if (statSync(file).size !== descriptor.size) throw Error('Image cache blob size mismatch');
    if (hash(file) !== descriptor.digest) throw Error('Image cache blob digest mismatch');
    return file;
  };
  const manifest = json(blob(selected[0]));
  const config = json(blob(manifest.config));
  if (config.os !== platform.os || config.architecture !== platform.architecture) throw Error('Image cache configuration platform mismatch');
  if (!Array.isArray(manifest.layers)) throw Error('Invalid image cache layers');
  for (const layer of manifest.layers) blob(layer);
  return manifest.config.digest;
}

export function restoreOCI(directory, image, platform, command, transfer = execFileSync) {
  const id = verifyOCI(directory, image, platform);
  try { command(['image', 'inspect', id]); }
  catch (error) {
    if (!/No such image/i.test(error.message)) throw error;
    const temporary = mkdtempSync(join(tmpdir(), 'localcloud-image-import-'));
    try {
      const archive = join(temporary, 'image.tar');
      // Docker's own client preserves remote contexts, TLS settings and credentials.
      transfer('skopeo', ['copy', `oci:${directory}:localcloud`, `docker-archive:${archive}:localcloud-cache:${image.split('@')[1].slice(7)}`], {stdio:['ignore','ignore','pipe'], timeout:600_000, maxBuffer:8*1024*1024});
      command(['image', 'load', '--input', archive]);
    } finally { rmSync(temporary, {recursive:true, force:true}); }
  }
  return id;
}
