import { writeFileSync } from 'node:fs';
import { docker } from '../src/runtime.mjs';

const id = process.env.LOCALCLOUD_CONTAINER_ID;
const container = JSON.parse(docker(['inspect', id]))[0];
const anonymousVolumes = container.Mounts.filter(m => m.Type === 'volume').map(m => m.Name);
const networks=Object.keys(container.NetworkSettings.Networks).filter(name=>name.startsWith('localcloud-ci-'));
writeFileSync('.localcloud-cleanup-proof.json', JSON.stringify({ id, volumes: anonymousVolumes, networks }));
console.log('Recorded owned container and volume for verification after the action post hook');
