import { pathToFileURL } from 'node:url';

export function rewrite(value,connection) {
  if(Array.isArray(value))return value.map(item=>rewrite(item,connection));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item,connection)]));
  if(typeof value!=='string')return value;
  const host=new URL(connection.url).hostname;
  return value.replace(/(?<![A-Za-z0-9_.-])(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\b/g,(match,local,port)=>`${host}:${connection.ports?.[port] || port}`);
}

export async function forward(message,connection,onMessage=()=>{}) {
  const target=new URL(connection.url);
  if(target.protocol!=='http:' || target.username || target.password || target.pathname!=='/' || /(^|\.)(googleapis\.com|google\.com|gcr\.io|pkg\.dev)$/i.test(target.hostname))throw Error('MCP requires the configured local HTTP runtime origin');
  if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(connection.project || ''))throw Error('Invalid MCP project');
  const response=await fetch(`${target.origin}/mcp`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60_000),headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':connection.protocolVersion || '2025-11-25','X-LocalCloud-Project':connection.project,...(connection.session?{'MCP-Session-Id':connection.session}:{})},body:JSON.stringify(message)});
  if(!response.ok)throw Error(`LocalCloud MCP returned HTTP ${response.status}`);
  if(response.headers.get('mcp-session-id'))connection.session=response.headers.get('mcp-session-id');
  const request=typeof message.method==='string' && Object.hasOwn(message,'id');
  if(!request) {await response.body?.cancel();return undefined;}
  let text='',payload,total=0;const decoder=new TextDecoder();
  const events=(response.headers.get('content-type') || '').includes('text/event-stream');
  for await(const bytes of response.body) {
    total+=bytes.length;if(total>1024*1024)throw Error('MCP response exceeds 1 MiB');
    text+=decoder.decode(bytes,{stream:true});
    if(events) {
      let boundary;
      while((boundary=text.search(/\r?\n\r?\n/))!==-1) {
        const event=text.slice(0,boundary);text=text.slice(boundary).replace(/^\r?\n\r?\n/,'');
        const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(data) {
          const item=JSON.parse(data);
          if(item.jsonrpc!=='2.0')throw Error('MCP returned an invalid stream message');
          if(typeof item.method==='string')onMessage(item);
          else if(item.id===message.id)payload=item;
        }
      }
      if(payload)break;
    }
  }
  if(!events)payload=JSON.parse(text+decoder.decode());
  if(!payload || payload.jsonrpc!=='2.0' || payload.id!==message.id)throw Error('MCP returned an invalid response');
  if(payload.result?.protocolVersion)connection.protocolVersion=payload.result.protocolVersion;
  const environment=message.method==='tools/call' && message.params?.name==='localcloud_get_env';
  return environment?rewrite(payload,connection):payload;
}

async function main() {
  const connection=JSON.parse(process.env.LOCALCLOUD_MCP_CONNECTION || '{}');
  let buffer='';const decoder=new TextDecoder();const pending=new Set();
  const emit=message=>process.stdout.write(JSON.stringify(message)+'\n');
  async function dispatch(line) {
    let message;
    try {
      message=JSON.parse(line);
      if(!message || message.jsonrpc!=='2.0' || (typeof message.method!=='string' && !(Object.hasOwn(message,'id') && (Object.hasOwn(message,'result') || Object.hasOwn(message,'error')))))throw Error('Invalid MCP message');
      if(pending.size>=64 && typeof message.method==='string' && Object.hasOwn(message,'id'))throw Error('Too many concurrent MCP requests');
      const result=await forward(message,connection,emit);
      if(result)emit(result);
    } catch(error) {
      if(message && (!Object.hasOwn(message,'id') || typeof message.method!=='string'))console.error(error.message);
      else emit({jsonrpc:'2.0',id:message?.id ?? null,error:{code:-32603,message:error.message}});
    }
  }
  for await(const bytes of process.stdin) {
    buffer+=decoder.decode(bytes,{stream:true});
    if(Buffer.byteLength(buffer)>1024*1024)throw Error('MCP input exceeds 1 MiB');
    let end;
    while((end=buffer.indexOf('\n'))!==-1) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      const task=dispatch(line);pending.add(task);task.finally(()=>pending.delete(task));
    }
  }
  await Promise.allSettled(pending);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
