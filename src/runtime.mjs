import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreOCI } from './image-cache.mjs';

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
  if (url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('runtime-url must be an HTTP(S) gateway origin without credentials, path or query');
    if (/(^|\.)(googleapis\.com|google\.com|gcr\.io|pkg\.dev)$/i.test(parsed.hostname)) throw new Error('runtime-url cannot be a real Google endpoint');
    if (parsed.port !== '5380' || parsed.protocol !== 'http:') throw new Error('Existing runtime must use http://<host>:5380 with canonical service ports; omit runtime-url for automatic Docker port mapping');
    url = parsed.origin;
  }
  return { services, project, seconds, image, url, imageCache:get('image-cache') };
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
      try { command(['pull', config.image]); }
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
  return {image, reference};
}

export function startRuntime(config, { command = docker, stateFile = process.env.GITHUB_STATE } = {}) {
  // shortcut: connect mode uses canonical ports, add explicit port maps when custom external publication is needed.
  if (config.url) return { url: config.url, ports: { '5380': Number(new URL(config.url).port || (config.url.startsWith('https:') ? 443 : 80)) }, record: null };
  if (process.platform !== 'linux' && !process.env.LOCALCLOUD_ACTION_LOCAL_TEST) throw new Error('Starting LocalCloud requires a Linux Docker runner; use runtime-url to connect to an existing runtime');
  const owner = randomUUID();
  const {image, reference} = acquireImage(config, command);
  const ports = Object.keys(image.Config.ExposedPorts || {}).filter(p => /^\d+\/tcp$/.test(p)).map(p => Number(p.split('/')[0]));
  if (!ports.includes(5380) || ports.length > 100 || ports.some(p => p < 1 || p > 65535)) throw new Error('Image must expose the LocalCloud gateway on 5380/tcp');
  const name = `localcloud-ci-${owner}`;
  // Save ownership before creation so post cleanup can recover a partially failed docker run.
  const record = { id: name, owner };
  githubFile(stateFile, 'localcloud_record', JSON.stringify(record));
  const args = ['run', '-d', '--pull', 'never', '--name', name, '--label', `${OWNER_LABEL}=${owner}`, '--memory', '4g', '-e', `LOCALCLOUD_SERVICES=${config.services.join(',')}`, '-e', `LOCALCLOUD_PROJECT=${config.project}`, '-e', 'LOCALCLOUD_DOCKER_ACCESS=false', '-e', 'LOCALCLOUD_TELEMETRY=false'];
  for (const port of ports) args.push('-p', `127.0.0.1::${port}`);
  try {
    const id = command([...args, reference]);
    record.id = id;
    githubFile(stateFile, 'localcloud_record', JSON.stringify(record));
    const container = JSON.parse(command(['inspect', id]))[0];
    const mapped = Object.fromEntries(ports.map(port => {
      const bindings = container.NetworkSettings.Ports[`${port}/tcp`];
      if (!bindings?.length || bindings[0].HostIp !== '127.0.0.1') throw new Error(`Missing loopback publication for ${port}`);
      return [String(port), Number(bindings[0].HostPort)];
    }));
    return { url: `http://127.0.0.1:${mapped['5380']}`, ports: mapped, record };
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
  return environment(env, runtime);
}

export function environment(payload, runtime) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('LocalCloud env must be a JSON object');
  const hostname = new URL(runtime.url).hostname;
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    const endpoint = key.endsWith('_EMULATOR_HOST') || key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') || /^GOOGLE_.+_CUSTOM_ENDPOINT$/.test(key);
    if (!endpoint && !CONTEXT_KEYS.has(key)) throw new Error(`Unsupported runtime environment key: ${key}`);
    if (typeof value !== 'string' || /[\r\n\0]/.test(value) || !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid runtime environment value: ${key}`);
    if (endpoint) {
      const hasScheme = /^https?:\/\//.test(value);
      const parsed = new URL(hasScheme ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || (!LOCAL_HOSTS.has(parsed.hostname) && parsed.hostname !== hostname)) throw new Error(`Nonlocal or invalid SDK endpoint: ${key}`);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const mapped = runtime.ports[port];
      if (runtime.record && !mapped) throw new Error(`SDK endpoint uses an unpublished port: ${key}`);
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

export function cleanup(record, command = docker) {
  if (!record) return;
  if (!/^[a-f0-9-]{36}$/.test(record.owner) || !/^(?:[a-f0-9]{64}|localcloud-ci-[a-f0-9-]{36})$/.test(record.id)) throw new Error('Invalid LocalCloud ownership record');
  let container;
  try { container = JSON.parse(command(['inspect', record.id]))[0]; }
  catch (error) { if (/No such (?:object|container)/i.test(error.message)) return; throw error; }
  if (container.Config.Labels?.[OWNER_LABEL] !== record.owner) throw new Error('Refusing to remove a container not owned by this action');
  command(['rm', '-f', '-v', container.Id]);
}

export async function main() {
  const config = options();
  const runtime = startRuntime(config);
  try {
    const env = await configure(config, runtime);
    for (const [key, value] of Object.entries(env)) {
      if (/TOKEN/.test(key)) console.log(`::add-mask::${value}`);
      githubFile(process.env.GITHUB_ENV, key, value);
    }
    for (const [key,value] of Object.entries({ 'runtime-url': runtime.url, 'container-id': runtime.record?.id || '', 'project-id': config.project })) githubFile(process.env.GITHUB_OUTPUT, key, value);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### LocalCloud ready\n\nProject: \`${config.project}\`\n\nServices: ${config.services.join(', ')}\n\nGateway: ${runtime.url}\n\n${runtime.record ? `Image: \`${config.image}\`\n\nThis action removes its container and anonymous volume after the job.` : 'Existing runtime: lifecycle remains with its owner.'}\n`);
    console.log(`LocalCloud ready at ${runtime.url}; project ${config.project}; services ${config.services.join(', ')}`);
  } catch (error) {
    cleanup(runtime.record);
    throw error;
  }
}
