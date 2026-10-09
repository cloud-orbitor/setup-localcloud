import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { verifyOCI } from '../src/image-cache.mjs';

const [image, directory, architecture = process.arch] = process.argv.slice(2);
if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image || '') || !directory || !['amd64','arm64','x64'].includes(architecture)) throw Error('Usage: node scripts/image-cache.mjs IMAGE@sha256:DIGEST CACHE_DIRECTORY [amd64|arm64]');
const platform = {os:'linux', architecture:architecture === 'x64' ? 'amd64' : architecture};
mkdirSync(directory, {recursive:true});
// Credentials stay in Skopeo's external auth store, outside the cached layout.
writeFileSync(join(directory, 'source-manifest.json'), execFileSync('skopeo', ['inspect','--raw',`docker://${image}`], {maxBuffer:1024*1024, timeout:60_000}));
execFileSync('skopeo', ['--override-os',platform.os,'--override-arch',platform.architecture,'copy','--preserve-digests',`docker://${image}`,`oci:${directory}:localcloud`], {stdio:'inherit', timeout:600_000});
console.log(`Verified cached image configuration: ${verifyOCI(directory, image, platform)}`);
