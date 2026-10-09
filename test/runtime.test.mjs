import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { options, environment, configure, cleanup, startRuntime, githubFile, DEFAULT_IMAGE } from '../src/runtime.mjs';

test('invalid inputs fail before Docker or HTTP', () => {
  for (const env of [ {'INPUT_IMAGE':'agentcloud/localcloud:latest'}, {'INPUT_SERVICES':'gcs,;touch /tmp/x'}, {'INPUT_PROJECT-ID':'bad\nproject'}, {'INPUT_TIMEOUT':'Infinity'}, {'INPUT_RUNTIME-URL':'https://storage.googleapis.com'}, {'INPUT_RUNTIME-URL':'http://user:secret@localhost:5380'} ]) assert.throws(() => options(env));
  assert.equal(options({}).image, DEFAULT_IMAGE);
  assert.deepEqual(options({}).services,['gcs','pubsub','bigquery']);
});

test('SDK HTTP and gRPC addresses use actual published ports', () => {
  const env = environment({ GOOGLE_CLOUD_PROJECT:'ci-project', STORAGE_EMULATOR_HOST:'http://localhost:5382', PUBSUB_EMULATOR_HOST:'localhost:5383', CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE:'http://localhost:5380/' }, { url:'http://127.0.0.1:6100', ports:{'5380':6100,'5382':6102,'5383':6103}, record:{} });
  assert.equal(env.STORAGE_EMULATOR_HOST,'http://127.0.0.1:6102');
  assert.equal(env.PUBSUB_EMULATOR_HOST,'127.0.0.1:6103');
  assert.equal(env.CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE,'http://127.0.0.1:6100/');
});

test('native service consumers use the service host and internal ports', () => {
  const env = environment({ GOOGLE_CLOUD_PROJECT:'ci-project', PUBSUB_EMULATOR_HOST:'localhost:5383' }, { url:'http://localcloud:5380', ports:{}, record:null });
  assert.equal(env.PUBSUB_EMULATOR_HOST,'localcloud:5383');
});

test('production endpoints, environment injection and unpublished ports fail closed', () => {
  const runtime={url:'http://127.0.0.1:6100', ports:{'5380':6100},record:{}};
  for (const payload of [ {GOOGLE_CLOUD_PROJECT:'ci-project', STORAGE_EMULATOR_HOST:'https://storage.googleapis.com'}, {GOOGLE_CLOUD_PROJECT:'ci-project', NODE_OPTIONS:'--import bad.mjs'}, {GOOGLE_CLOUD_PROJECT:'ci-project\nPATH=/tmp'}, {GOOGLE_CLOUD_PROJECT:'ci-project', PUBSUB_EMULATOR_HOST:'localhost:5383'} ]) assert.throws(() => environment(payload,runtime));
});

test('GitHub files reject newline injection', () => {
  const dir=mkdtempSync(join(tmpdir(),'localcloud-action-'));
  try {
    const file=join(dir,'env');
    githubFile(file,'GOOGLE_CLOUD_PROJECT','ci-project');
    assert.equal(readFileSync(file,'utf8'),'GOOGLE_CLOUD_PROJECT=ci-project\n');
    assert.throws(() => githubFile(file,'SAFE','good\nEVIL=yes'));
  } finally { rmSync(dir,{recursive:true}); }
});

test('existing runtime neither invokes Docker nor creates cleanup state', () => {
  const config=options({'INPUT_RUNTIME-URL':'http://localcloud:5380'});
  const runtime=startRuntime(config,{command:()=>{throw Error('Docker must not run');}});
  assert.equal(runtime.url,'http://localcloud:5380');
  assert.equal(runtime.record,null);
});

test('owned Docker startup records actual ports and recovers publication failure', () => {
  const dir=mkdtempSync(join(tmpdir(),'localcloud-action-owned-'));
  const old=process.env.LOCALCLOUD_ACTION_LOCAL_TEST;
  process.env.LOCALCLOUD_ACTION_LOCAL_TEST='1';
  try {
    for (const broken of [false,true]) {
      const calls=[];let owner='';const id='b'.repeat(64);const stateFile=join(dir,String(broken));
      const command=args=>{
        calls.push(args);
        if(args[0]==='version') return '{"Os":"linux","Arch":"amd64"}';
        if(args[0]==='image') return JSON.stringify([{Id:'sha256:'+'a'.repeat(64),Os:'linux',Architecture:'amd64',Config:{ExposedPorts:{'5380/tcp':{},'5382/tcp':{}}}}]);
        if(args[0]==='run') { owner=args[args.indexOf('--label')+1].split('=')[1];return id; }
        if(args[0]==='inspect') return JSON.stringify([{Id:id,Config:{Labels:{'cloud.local.setup-localcloud.owner':owner}},NetworkSettings:{Ports:{'5380/tcp':[{HostIp:broken?'0.0.0.0':'127.0.0.1',HostPort:'6100'}],'5382/tcp':[{HostIp:'127.0.0.1',HostPort:'6102'}]}}}]);
        return '';
      };
      if(broken) {
        assert.throws(()=>startRuntime(options({}),{command,stateFile}),/loopback publication/);
        assert.deepEqual(calls.at(-1),['rm','-f','-v',id]);
      } else {
        const runtime=startRuntime(options({}),{command,stateFile});
        assert.equal(runtime.url,'http://127.0.0.1:6100');
        assert.equal(runtime.ports['5382'],6102);
        assert.equal(JSON.parse(readFileSync(stateFile,'utf8').trim().split('\n').at(-1).split('=')[1]).id,id);
      }
    }
  } finally { if(old===undefined) delete process.env.LOCALCLOUD_ACTION_LOCAL_TEST;else process.env.LOCALCLOUD_ACTION_LOCAL_TEST=old;rmSync(dir,{recursive:true}); }
});

test('cleanup checks ownership and removes only the recorded container and anonymous volume', () => {
  const record={id:'a'.repeat(64),owner:'12345678-1234-1234-1234-123456789abc'};
  const commands=[];
  cleanup(record,args=>{commands.push(args);return JSON.stringify([{Id:record.id,Config:{Labels:{'cloud.local.setup-localcloud.owner':record.owner}}}]);});
  assert.deepEqual(commands.at(-1),['rm','-f','-v',record.id]);
  assert.throws(()=>cleanup(record,()=>JSON.stringify([{Id:record.id,Config:{Labels:{}}}])) ,/not owned/);
  assert.throws(()=>cleanup({id:'developer-runtime',owner:record.owner}),/Invalid/);
  cleanup(record,()=>{throw Error('No such object');});
});

async function api(t, handler) {
  const server=createServer(handler);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('readiness requires all selected services and provisions a missing project', async t => {
  let checks=0;const writes=[];
  const url=await api(t,(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url.startsWith('/readiness')) { checks++; return res.end(JSON.stringify({ready:checks>1,services:[{service_id:'gcs',ready:checks>1}]})); }
    if(req.url==='/projects' && req.method==='GET') return res.end('[]');
    if(req.url==='/projects' && req.method==='POST') { let body=''; req.on('data',chunk=>body+=chunk);return req.on('end',()=>{writes.push(JSON.parse(body));res.statusCode=201;res.end('{}');}); }
    if(req.url.startsWith('/env')) return res.end(JSON.stringify({GOOGLE_CLOUD_PROJECT:'ci-project',STORAGE_EMULATOR_HOST:'http://localhost:5382'}));
    res.statusCode=404;res.end('{}');
  });
  const env=await configure({services:['gcs'],project:'ci-project',seconds:3},{url,ports:{'5382':6102},record:null});
  assert.equal(checks,2);assert.equal(writes[0].project_id,'ci-project');assert.match(env.STORAGE_EMULATOR_HOST,/:6102/);
});

test('unknown service and timeouts fail before project mutation', async t => {
  let projectCalls=0;
  const url=await api(t,(req,res)=>{ if(req.url.startsWith('/projects')) projectCalls++;res.statusCode=404;res.end('{"error":"unknown service"}'); });
  await assert.rejects(configure({services:['typo'],project:'ci-project',seconds:1},{url}),/HTTP 404/);
  assert.equal(projectCalls,0);
  const notReady=await api(t,(req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"ready":true,"services":[]}');});
  await assert.rejects(configure({services:['gcs'],project:'ci-project',seconds:1},{url:notReady}),/timed out/);
});
