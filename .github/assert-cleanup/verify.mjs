import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

if (existsSync('.localcloud-cleanup-proof.json')) {
  const proof = JSON.parse(readFileSync('.localcloud-cleanup-proof.json', 'utf8'));
  const inspect = spawnSync('docker', ['inspect', proof.id], { encoding: 'utf8' });
  assert.notEqual(inspect.status, 0, 'action-owned container survived automatic post cleanup');
  assert.match(inspect.stderr, /no such (?:object|container)/i);
  for (const name of proof.volumes) {
    const volume = spawnSync('docker', ['volume', 'inspect', name], { encoding: 'utf8' });
    assert.notEqual(volume.status, 0, 'anonymous volume survived automatic post cleanup');
    assert.match(volume.stderr, /no such volume/i);
  }
  for(const name of proof.networks || []) {
    const network=spawnSync('docker',['network','inspect',name],{encoding:'utf8'});
    assert.notEqual(network.status,0,'owned network survived automatic post cleanup');
    assert.match(network.stderr,/No such network|network .+ not found/i);
  }
  console.log('Automatic action post hook removed the owned container, volumes and network');
} else {
  console.log('No runtime resources were recorded; setup outcome is checked by the preceding steps');
}
