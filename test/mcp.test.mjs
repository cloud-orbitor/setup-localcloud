import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { forward, rewrite } from '../src/mcp-stdio.mjs';

test('MCP forwarding sends project context to the existing runtime and rewrites endpoints', async t => {
  let headers, message;
  const server=createServer((req,res)=>{
    headers=req.headers;let text='';req.on('data',chunk=>text+=chunk);
    req.on('end',()=>{message=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:7,result:{text:'PUBSUB_EMULATOR_HOST=localhost:5383'}}));});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const connection={url:`http://127.0.0.1:${server.address().port}`,project:'ci-project',ports:{'5383':15383}};
  const result=await forward({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'localcloud_get_env'}},connection);
  assert.equal(headers['x-localcloud-project'],'ci-project');assert.equal(message.id,7);
  assert.equal(result.result.text,'PUBSUB_EMULATOR_HOST=127.0.0.1:15383');
});

test('SSE responses do not require closing a persistent stream and preserve query data', async t => {
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:9,result:{text:'localhost:5383 — café'}})+'\n\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const result=await forward({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'localcloud_query_data'}},{url:`http://127.0.0.1:${server.address().port}`,project:'ci-project',ports:{'5383':15383}});
  assert.equal(result.result.text,'localhost:5383 — café');
});

test('MCP endpoint rewrite preserves unrelated values and production URLs', () => {
  const connection={url:'http://localcloud:5380',ports:{}};
  assert.equal(rewrite('https://storage.googleapis.com/path',connection),'https://storage.googleapis.com/path');
  assert.equal(rewrite('http://localhost:5382/storage/v1',connection),'http://localcloud:5382/storage/v1');
  assert.equal(rewrite(42,connection),42);
});
