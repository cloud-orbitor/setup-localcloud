import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreOCI } from './image-cache.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_IMAGE = 'agentcloud/localcloud@sha256:88e85b86b294e1e4f71b8c63ec43de79d170946ff39556f0e2709f66aa0d368c';
const OWNER_LABEL = 'cloud.local.setup-localcloud.owner';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CONTEXT_KEYS = new Set(['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'LOCALCLOUD_USER', 'LOCALCLOUD_PRINCIPAL', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);

export function options(env = process.env) {
  const get = (name, fallback = '') => env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;
  const services = [...new Set(get('services', 'gcs,pubsub,bigquery').split(',').map(s => s.trim()))];
  if (!services.length || services.length > 40 || services.some(s => !/^[a-z][a-z0-9]*$/.test(s))) throw new Error('services must be comma-separated LocalCloud service IDs');
  const project = get('project-id', 'localcloud-ci');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('project-id must be a 6–30 character Google Cloud project ID');
  const seconds = Number(get('timeout', '120'));
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('timeout must be 1–1800 seconds');
  const image = get('image', DEFAULT_IMAGE);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('image must be pinned with @sha256:<64 hex characters>');
  let url = get('runtime-url');
  const ports = JSON.parse(get('port-map', '{}'));
  if (!ports || Array.isArray(ports) || typeof ports !== 'object' || Object.entries(ports).some(([key,value])=>!/^\d{1,5}$/.test(key) || Number(key)<1 || Number(key)>65535 || !Number.isInteger(value) || value<1 || value>65535)) throw Error('port-map must map canonical ports to integer ports between 1 and 65535');
  if (!url && Object.keys(ports).length) throw Error('port-map requires runtime-url');
  if (url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('runtime-url must be an HTTP(S) gateway origin without credentials, path or query');
    if (/(^|\.)(googleapis\.com|google\.com|gcr\.io|pkg\.dev)$/i.test(parsed.hostname)) throw new Error('runtime-url cannot be a real Google endpoint');
    if (parsed.protocol !== 'http:') throw new Error('Existing runtime must use a local HTTP gateway; TLS SDK configuration is not automatic');
    const gatewayPort=Number(parsed.port || '80');
    if (ports['5380'] && ports['5380'] !== gatewayPort) throw Error('port-map gateway must match runtime-url');
    ports['5380']=gatewayPort;
    url = parsed.origin;
  }
  const boolean = name => {const value=get(name,'false');if(!['true','false'].includes(value))throw Error(`${name} must be true or false`);return value==='true';};
  return { services, project, seconds, image, url, ports, imageCache:get('image-cache'), dockerAccess:boolean('docker-access'), mcp:boolean('mcp') };
}

export function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(-3000)}`);
  return result.stdout.trim();
}

export function githubFile(file, key, value) {
  value = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid GitHub environment-file entry');
  if (file) appendFileSync(file, `${key}=${value}\n`);
}

export function acquireImage(config, command = docker) {
  const server = JSON.parse(command(['version', '--format', '{{json .Server}}']));
  const platform = {os:server.Os, architecture:server.Arch};
  if (platform.os !== 'linux' || !platform.architecture) throw Error('LocalCloud requires a Linux Docker server with a known architecture');
  let reference = config.image;
  let inspected;
  try { inspected = command(['image', 'inspect', reference]); }
  catch (error) {
    if (!/No such image/i.test(error.message)) throw error;
    if (config.imageCache) {
      try {
        reference = restoreOCI(config.imageCache, config.image, platform, command);
        inspected = command(['image', 'inspect', reference]);
      } catch (cacheError) {
        console.error(`LocalCloud image cache unavailable; using pinned registry image: ${cacheError.message.slice(0,300)}`);
        reference = config.image;
      }
    }
    if (!inspected) {
      try { command(['pull', '--platform', `${platform.os}/${platform.architecture}`, config.image]); }
      catch (pullError) {
        const guidance = /toomanyrequests|rate.?limit|429/i.test(pullError.message)
          ? 'Registry limit reached. Configure registry credentials before setup or use a verified mirror; retrying immediately will not reset a quota.'
          : /unauthorized|authentication|denied/i.test(pullError.message)
            ? 'Registry authentication failed. Check docker login credentials and access to the requested image.'
            : 'Image acquisition failed before LocalCloud startup. Check registry connectivity and the pinned digest.';
        throw new Error(`${guidance}\n${pullError.message}`, {cause:pullError});
      }
      inspected = command(['image', 'inspect', config.image]);
    }
  }
  const image = JSON.parse(inspected)[0];
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image.Id || '') || !image.Config) throw Error('Invalid Docker image inspection');
  if (image.Os !== platform.os || image.Architecture !== platform.architecture) throw Error(`LocalCloud image platform ${image.Os}/${image.Architecture} does not match Docker ${platform.os}/${platform.architecture}`);
  if (reference.startsWith('sha256:') && image.Id !== reference) throw Error('Loaded image configuration digest mismatch');
  return {image, reference, platform};
}

export function startRuntime(config, { command = docker, stateFile = process.env.GITHUB_STATE } = {}) {
  if (config.url) return { url: config.url, ports: config.ports || {'5380':Number(new URL(config.url).port || 80)}, strictPorts:new URL(config.url).port !== '5380' || Object.keys(config.ports || {}).length>1, record: null };
  if (process.platform !== 'linux' && !process.env.LOCALCLOUD_ACTION_LOCAL_TEST) throw new Error('Starting LocalCloud requires a Linux Docker runner; use runtime-url to connect to an existing runtime');
  const owner = randomUUID();
  const {image, reference, platform} = acquireImage(config, command);
  const ports = Object.keys(image.Config.ExposedPorts || {}).filter(p => /^\d+\/tcp$/.test(p)).map(p => Number(p.split('/')[0]));
  if (!ports.includes(5380) || ports.length > 100 || ports.some(p => p < 1 || p > 65535)) throw new Error('Image must expose the LocalCloud gateway on 5380/tcp');
  const name = `localcloud-ci-${owner}`;
  // Save ownership before creation so post cleanup can recover a partially failed docker run.
  const record = { id: name, owner, network:name, volume:`${name}-data` };
  record.hash=ownershipHash(record.network,record.volume);
  githubFile(stateFile, 'localcloud_record', JSON.stringify(record));
  const labels={[OWNER_LABEL]:owner,'com.localcloud.managed':'true','com.localcloud.volume-name':record.volume,'com.localcloud.config-hash':record.hash};
  const labelArgs=Object.entries(labels).flatMap(([key,value])=>['--label',`${key}=${value}`]);
  const args = ['run', '--platform', `${platform.os}/${platform.architecture}`, '-d', '--pull', 'never', '--name', name, ...labelArgs, '--network',record.network,'--network-alias','localcloud','--mount',`type=volume,src=${record.volume},dst=/var/lib/localcloud`, '--memory', '4g', '-e', `LOCALCLOUD_SERVICES=${config.services.join(',')}`, '-e', `LOCALCLOUD_PROJECT=${config.project}`, '-e', `LOCALCLOUD_DOCKER_ACCESS=${config.dockerAccess}`, '-e', 'LOCALCLOUD_TELEMETRY=false','-e',`LOCALCLOUD_RUNTIME_NETWORK=${record.network}`,'-e',`LOCALCLOUD_DATA_VOLUME=${record.volume}`,'-e',`LOCALCLOUD_CONFIG_HASH=${record.hash}`,'-e','LOCALCLOUD_MCP_WRITE=false','-e','LOCALCLOUD_MCP_DESTRUCTIVE=false'];
  if(config.dockerAccess) args.push('--mount','type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock','-e','DOCKER_HOST=unix:///var/run/docker.sock');
  for (const port of ports) args.push('-p', `127.0.0.1::${port}`);
  try {
    command(['network','create',...labelArgs,record.network]);
    command(['volume','create',...labelArgs,record.volume]);
    const id = command([...args, reference]);
    record.id = id;
    githubFile(stateFile, 'localcloud_record', JSON.stringify(record));
    const container = JSON.parse(command(['container','inspect', id]))[0];
    const mapped = Object.fromEntries(ports.map(port => {
      const bindings = container.NetworkSettings.Ports[`${port}/tcp`];
      if (!bindings?.length || bindings[0].HostIp !== '127.0.0.1') throw new Error(`Missing loopback publication for ${port}`);
      return [String(port), Number(bindings[0].HostPort)];
    }));
    return { url: `http://127.0.0.1:${mapped['5380']}`, ports: mapped, record, network:record.network, imageReference:reference, platform };
  } catch (error) {
    cleanup(record, command);
    throw error;
  }
}

async function request(url, { method = 'GET', body, milliseconds = 10_000 } = {}) {
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(milliseconds), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('LocalCloud response exceeds 1 MiB');
  if (!response.ok) {
    const error = new Error(`LocalCloud ${method} ${new URL(url).pathname} returned HTTP ${response.status}: ${text.slice(0,800)}`);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(text);
}

export async function configure(config, runtime) {
  const deadline = Date.now() + config.seconds * 1000;
  let last = 'no readiness response';
  let catalog;
  while(Date.now()<deadline) {
    try {catalog=await request(`${runtime.url}/services`,{milliseconds:Math.max(1,Math.min(5000,deadline-Date.now()))});break;}
    catch(error) {if(error.status && error.status!==503)throw error;last=error.message;await delay(Math.min(1000,Math.max(0,deadline-Date.now())));}
  }
  if(!Array.isArray(catalog?.services)) throw Error(`LocalCloud service catalog unavailable: ${last}`);
  for(const id of config.services) {
    const matches=catalog.services.filter(s=>s.id===id);
    if(matches.length!==1)throw Error(`Unknown LocalCloud service ID: ${id}. See the selected runtime's /services catalog.`);
    const service=matches[0];
    if(service.coverage_status==='unsupported' || service.availability==='unavailable' || service.startable===false)throw Error(`LocalCloud service ${id} is unsupported or unavailable in this image`);
    for(const dependency of service.runtime_dependencies || []) {
      if(dependency.required && dependency.status!=='available')throw Error(`LocalCloud ${id} requires ${dependency.id}: ${dependency.message || dependency.status}. ${dependency.id==='docker'?'For an owned runtime set docker-access: true; existing runtime prerequisites remain with its owner.':''} ${(dependency.resolution_steps || []).join(' ')}`);
    }
    if(service.enabled===false)throw Error(`LocalCloud service ${id} is disabled in this runtime; enable it in the runtime owner's configuration and check its tier requirements.`);
  }
  runtime.catalog=catalog.services;
  runtime.endpointKeys=new Set(catalog.services.map(s=>s.env_var).filter(key=>typeof key==='string' && key.endsWith('_HOST')));
  while (Date.now() < deadline) {
    try {
      const ready = await request(`${runtime.url}/readiness?services=${config.services.join(',')}`, { milliseconds: Math.max(1, Math.min(5000, deadline - Date.now())) });
      if (ready.ready === true && config.services.every(id => ready.services?.some(s => s.service_id === id && s.ready === true))) break;
      last = 'selected services are not ready';
    } catch (error) {
      if (error.status && error.status !== 503) throw error;
      last = error.message;
    }
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
  if (Date.now() >= deadline) throw new Error(`LocalCloud readiness timed out after ${config.seconds}s: ${last}`);
  const projects = await request(`${runtime.url}/projects`);
  if (!Array.isArray(projects)) throw new Error('Unexpected LocalCloud projects response');
  if (!projects.some(p => p.project_id === config.project)) await request(`${runtime.url}/projects`, { method: 'POST', body: { project_id: config.project, display_name: config.project } });
  const env = await request(`${runtime.url}/env?format=json&project=${encodeURIComponent(config.project)}`);
  runtime.canonicalEnv=env;
  const configured=environment(env, runtime);
  if(configured.GOOGLE_CLOUD_PROJECT!==config.project)throw Error('LocalCloud env returned the wrong project');
  if(config.mcp) {
    const mcp=await request(`${runtime.url}/mcp`);
    if(mcp.name!=='localcloud-mcp' || mcp.safety?.write_enabled!==false || mcp.safety?.destructive_enabled!==false)throw Error('MCP CI profile requires the same LocalCloud runtime with MCP write/destructive permissions disabled');
  }
  return configured;
}

export function environment(payload, runtime) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('LocalCloud env must be a JSON object');
  const hostname = new URL(runtime.url).hostname;
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    const endpoint = key.endsWith('_EMULATOR_HOST') || runtime.endpointKeys?.has(key) || key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') || /^GOOGLE_.+_CUSTOM_ENDPOINT$/.test(key) || /^LOCALCLOUD_[A-Z0-9]+_(GRPC_AUTHORITY|REST_URL)$/.test(key);
    if (!endpoint && !CONTEXT_KEYS.has(key)) throw new Error(`Unsupported runtime environment key: ${key}`);
    if (typeof value !== 'string' || /[\r\n\0]/.test(value) || !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid runtime environment value: ${key}`);
    if (endpoint) {
      const hasScheme = /^https?:\/\//.test(value);
      const parsed = new URL(hasScheme ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || (!LOCAL_HOSTS.has(parsed.hostname) && parsed.hostname !== hostname)) throw new Error(`Nonlocal or invalid SDK endpoint: ${key}`);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const mapped = runtime.ports[port];
      if ((runtime.record || runtime.strictPorts) && !mapped) throw new Error(`SDK endpoint uses an unpublished port or omitted port mapping: ${key}`);
      parsed.hostname = hostname;
      if (mapped) parsed.port = String(mapped);
      // SDK emulator roots without a slash must stay slashless (Storage concatenates its API path).
      const path = parsed.pathname === '/' && !/^https?:\/\/[^/?#]+\//i.test(value) ? '' : parsed.pathname;
      result[key] = hasScheme ? `${parsed.origin}${path}${parsed.search}` : `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
    } else result[key] = value;
  }
  if (!result.GOOGLE_CLOUD_PROJECT) throw new Error('LocalCloud env omitted GOOGLE_CLOUD_PROJECT');
  return result;
}

export function ownershipHash(network, volume) {
  let hash=0;for(const character of `${network}\0${volume}`)hash=(Math.imul(hash,31)+character.charCodeAt(0))|0;
  return (hash>>>0).toString(16);
}

export function jobFiles(config,runtime,env,base=process.env.RUNNER_TEMP || tmpdir()) {
  const directory=mkdtempSync(join(base,'localcloud-ci-'));
  const envFile=join(directory,'sdk.env');
  writeFileSync(envFile,Object.entries(env).map(([key,value])=>`${key}=${value}\n`).join(''),{mode:0o600});
  let dockerEnvFile='';
  if(runtime.record && runtime.canonicalEnv) {
    dockerEnvFile=join(directory,'container.env');
    const containerEnv=environment(runtime.canonicalEnv,{url:'http://localcloud:5380',ports:{},record:null,endpointKeys:runtime.endpointKeys});
    writeFileSync(dockerEnvFile,Object.entries(containerEnv).map(([key,value])=>`${key}=${value}\n`).join(''),{mode:0o600});
  }
  let mcpConfig='';
  if(config.mcp) {
    mcpConfig=join(directory,'mcp.json');
    const connection={url:runtime.url,ports:runtime.ports,project:config.project};
    writeFileSync(mcpConfig,JSON.stringify({mcpServers:{localcloud:{command:process.execPath,args:[fileURLToPath(new URL('./mcp-stdio.mjs',import.meta.url))],env:{LOCALCLOUD_MCP_CONNECTION:JSON.stringify(connection)}}}},null,2)+'\n',{mode:0o600});
  }
  return {envFile,dockerEnvFile,mcpConfig};
}

export function cleanup(record, command = docker) {
  if (!record) return;
  if (!/^[a-f0-9-]{36}$/.test(record.owner) || !/^(?:[a-f0-9]{64}|localcloud-ci-[a-f0-9-]{36})$/.test(record.id)) throw new Error('Invalid LocalCloud ownership record');
  if(record.network && (record.network!==`localcloud-ci-${record.owner}` || record.volume!==`${record.network}-data` || record.hash!==ownershipHash(record.network,record.volume)))throw Error('Invalid execution ownership record');
  let container;
  try { container = JSON.parse(command(['container','inspect', record.id]))[0]; }
  catch (error) { if (!/No such (?:object|container)/i.test(error.message)) throw error; }
  if(container) {
    if (container.Config.Labels?.[OWNER_LABEL] !== record.owner) throw new Error('Refusing to remove a container not owned by this action');
    if(record.network)command(['stop','--time','20',container.Id]);
  }
  if(record.network) {
    const expected={'com.localcloud.managed':'true','com.localcloud.volume-name':record.volume,'com.localcloud.config-hash':record.hash};
    const children=command(['ps','-aq','--no-trunc',...Object.entries(expected).flatMap(([key,value])=>['--filter',`label=${key}=${value}`])]).split(/\s+/).filter(Boolean);
    for(const id of children) {
      if(id===container?.Id)continue;
      let child;
      try {child=JSON.parse(command(['container','inspect',id]))[0];}
      catch(error) {if(/No such (object|container)/i.test(error.message))continue;throw error;}
      if(!Object.entries(expected).every(([key,value])=>child.Config.Labels?.[key]===value))throw Error('Refusing to remove a child owned by another runtime');
      command(['rm','-f','-v',child.Id]);
    }
  }
  if(container)command(['rm', '-f', '-v', container.Id]);
  if(record.network) {
    for(const [kind,name] of [['network',record.network],['volume',record.volume]]) {
      let resource;
      try {resource=JSON.parse(command([kind,'inspect',name]))[0];}
      catch(error) {if(/No such (?:network|volume)|network .+ not found/i.test(error.message))continue;throw error;}
      if(resource.Labels?.[OWNER_LABEL]!==record.owner || resource.Labels?.['com.localcloud.volume-name']!==record.volume || resource.Labels?.['com.localcloud.config-hash']!==record.hash || resource.Labels?.['com.localcloud.managed']!=='true')throw Error(`Refusing to remove ${kind} not owned by this action`);
      command([kind,'rm',name]);
    }
  }
}

export async function main() {
  const config = options();
  const runtime = startRuntime(config);
  try {
    const env = await configure(config, runtime);
    const files=jobFiles(config,runtime,env);
    for (const [key, value] of Object.entries(env)) {
      if (/TOKEN/.test(key)) console.log(`::add-mask::${value}`);
      githubFile(process.env.GITHUB_ENV, key, value);
    }
    for (const [key,value] of Object.entries({ 'runtime-url': runtime.url, 'container-id': runtime.record?.id || '', 'project-id': config.project,network:runtime.network || '', 'env-file':files.envFile,'docker-env-file':files.dockerEnvFile,'mcp-url':config.mcp?`${runtime.url}/mcp`:'','mcp-config':files.mcpConfig })) githubFile(process.env.GITHUB_OUTPUT, key, value);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### LocalCloud ready\n\nProject: \`${config.project}\`\n\nServices: ${config.services.join(', ')}\n\nGateway: ${runtime.url}\n\n${runtime.record ? `Image: \`${config.image}\`\n\nThis action removes its container and anonymous volume after the job.` : 'Existing runtime: lifecycle remains with its owner.'}\n`);
    console.log(`LocalCloud ready at ${runtime.url}; project ${config.project}; services ${config.services.join(', ')}`);
  } catch (error) {
    cleanup(runtime.record);
    throw error;
  }
}
