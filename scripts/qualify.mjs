import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { options, startRuntime, configure, cleanup, docker, jobFiles } from '../src/runtime.mjs';

const flags=new Set(process.argv.slice(2));
if(flags.has('--local'))process.env.LOCALCLOUD_ACTION_LOCAL_TEST='1';
const config=options({...process.env, ...(flags.has('--mcp')?{INPUT_MCP:'true'}:{})});
const report={image:config.image, services:config.services, project:config.project, platform:JSON.parse(docker(['version','--format','{{json .Server}}'])), checks:{}, started:new Date().toISOString()};
const python=process.env.LOCALCLOUD_TEST_PYTHON || 'python';
const output=process.env.LOCALCLOUD_QUALIFICATION_REPORT || '.local-test/qualification.json';
let runtime;
const run=(command,args,env=process.env)=>{
  const result=spawnSync(command,args,{env,stdio:'inherit',timeout:600_000});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`${command} qualification failed with exit ${result.status}`);
};
try {
  runtime=startRuntime(config);
  let env=await configure(config,runtime);
  if(flags.has('--catalog')) {
    config.services=runtime.catalog.filter(service=>service.id!=='firestore' && service.coverage_status!=='unsupported' && service.availability!=='unavailable' && service.startable!==false && !(service.runtime_dependencies || []).some(d=>d.required)).map(service=>service.id).sort();
    report.services=config.services;
    cleanup(runtime.record);runtime=undefined;
    runtime=startRuntime(config);env=await configure(config,runtime);
  }
  report.checks.readiness='passed';
  report.catalog=runtime.catalog.map(service=>({id:service.id, selected:config.services.includes(service.id), env_key:service.env_var, dependencies:service.runtime_dependencies, unsupported:service.coverage_status==='unsupported', endpoint_configured:Boolean(env[service.env_var])}));
  report.checks.environment='passed';
  const files=jobFiles(config,runtime,env);
  run(python,['examples/python-smoke.py'],{...process.env,...env});report.checks.sdk='passed';
  if(config.mcp) {run(python,['examples/mcp-smoke.py'],{...process.env,...env,LOCALCLOUD_MCP_CONFIG:files.mcpConfig});report.checks.mcp='passed';}
  if(flags.has('--container-app')) {
    docker(['exec',runtime.record.id,'mkdir','-p','/tmp/ci-examples']);
    docker(['cp','examples/.',`${runtime.record.id}:/tmp/ci-examples`]);
    const pip=spawnSync(python,['-c','from pathlib import Path;import pip;print(Path(pip.__file__).parent)'],{encoding:'utf8'});
    if(pip.status!==0)throw Error('The host Python toolchain must provide pip for application-in-runtime qualification');
    docker(['cp',pip.stdout.trim(),`${runtime.record.id}:/var/lib/localcloud/pip`]);
    docker(['exec',runtime.record.id,'python3','-m','venv','--without-pip','/var/lib/localcloud/ci-venv']);
    run('docker',['exec','-e','PYTHONPATH=/var/lib/localcloud',runtime.record.id,'/var/lib/localcloud/ci-venv/bin/python','-m','pip','install','--quiet','-r','/tmp/ci-examples/requirements.txt']);
    const internal=runtime.canonicalEnv;
    run('docker',['exec',...Object.entries(internal).flatMap(([key,value])=>['-e',`${key}=${value}`]),runtime.record.id,'/var/lib/localcloud/ci-venv/bin/python','/tmp/ci-examples/python-smoke.py']);
    report.checks.same_container_sdk='passed';
    run('docker',['run','--rm','--pull=never','--platform',`${runtime.platform.os}/${runtime.platform.architecture}`,'--network',runtime.network,'--env-file',files.dockerEnvFile,'--volumes-from',`${runtime.record.id}:ro`,'--mount',`type=bind,src=${resolve('examples')},dst=/ci-examples,readonly`,'--entrypoint','/var/lib/localcloud/ci-venv/bin/python',runtime.imageReference,'/ci-examples/python-smoke.py']);
    report.checks.application_container_sdk='passed';
  }
} catch(error) {report.error=error.message;process.exitCode=1;}
finally {
  if(runtime?.record) {
    const record=runtime.record;
    try {
      cleanup(record);
      for(const args of [['container','inspect',record.id],['network','inspect',record.network],['volume','inspect',record.volume]]) {
        try {docker(args);throw Error(`Resource survived cleanup: ${args.at(-1)}`);}catch(error) {assert.match(error.message,/No such (object|container|network|volume)|network .+ not found/i);}
      }
      report.checks.cleanup='passed';
    } catch(error) {report.cleanup_error=error.message;process.exitCode=1;}
  }
  report.finished=new Date().toISOString();mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:output,checks:report.checks,error:report.error,cleanup_error:report.cleanup_error}));
}
