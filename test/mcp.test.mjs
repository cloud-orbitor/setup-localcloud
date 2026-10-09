import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('stdio cancellation reaches an operation while its response is pending', {timeout:5000}, async t => {
  let pending;
  const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const message=JSON.parse(body);
    if(message.method==='slow') {pending=res;child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}})+'\n');}
    else {assert.equal(message.method,'notifications/cancelled');res.writeHead(202);res.end();pending.setHeader('Content-Type','application/json');pending.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{cancelled:true}}));}
  });});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp-stdio.mjs',import.meta.url))],{env:{...process.env,LOCALCLOUD_MCP_CONNECTION:JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,project:'ci-project',ports:{}})}});
  t.after(()=>{child.kill();server.closeAllConnections();server.close();});
  const response=once(child.stdout,'data');child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n');
  assert.equal(JSON.parse((await response)[0].toString()).result.cancelled,true);child.stdin.end();
});

test('stdio forwards a server callback and its client response while the request is pending', {timeout:5000}, async t => {
  let pending;
  const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const message=JSON.parse(body);
    if(message.method==='slow') {pending=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"jsonrpc":"2.0","id":"callback","method":"sampling/createMessage","params":{}}\n\n');}
    else {assert.equal(message.id,'callback');assert.equal(message.result.content.text,'client response');res.writeHead(202);res.end();pending.write('data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n');}
  });});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp-stdio.mjs',import.meta.url))],{env:{...process.env,LOCALCLOUD_MCP_CONNECTION:JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,project:'ci-project',ports:{}})}});
  t.after(()=>{child.kill();server.closeAllConnections();server.close();});
  let buffer='';
  const completed=new Promise(resolve=>child.stdout.on('data',bytes=>{buffer+=bytes.toString();let end;while((end=buffer.indexOf('\n'))!==-1){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(message.method==='sampling/createMessage')child.stdin.write('{"jsonrpc":"2.0","id":"callback","result":{"content":{"text":"client response"}}}\n');else if(message.id===2)resolve(message);}}));
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"slow"}\n');
  assert.equal((await completed).result.ok,true);child.stdin.end();
});

test('saturated request slots still allow cancellation control messages', {timeout:10000}, async t => {
  const waiting=[];
  const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const message=JSON.parse(body);
    if(message.method==='slow') {
      waiting.push({res,id:message.id});
      if(waiting.length===64)child.stdin.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');
    } else {
      assert.equal(message.method,'notifications/cancelled');res.writeHead(202);res.end();
      for(const request of waiting) {request.res.setHeader('Content-Type','application/json');request.res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{cancelled:true}}));}
    }
  });});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/mcp-stdio.mjs',import.meta.url))],{env:{...process.env,LOCALCLOUD_MCP_CONNECTION:JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,project:'ci-project',ports:{}})}});
  t.after(()=>{child.kill();server.closeAllConnections();server.close();});
  let buffer='',count=0;
  const completed=new Promise(resolve=>child.stdout.on('data',bytes=>{buffer+=bytes.toString();let end;while((end=buffer.indexOf('\n'))!==-1){const response=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);assert.equal(response.result?.cancelled,true);if(++count===64)resolve();}}));
  for(let id=1;id<=64;id++)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'slow'})+'\n');
  await completed;child.stdin.end();
});
