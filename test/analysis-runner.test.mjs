import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexExecArgs,runCodexAnalysis} from '../cli/lib/analysis-runner.mjs';

const FIXTURE=`
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
const mode=process.env.FIXTURE_MODE||'ok';
const output=args[args.indexOf('--output-last-message')+1];
if(process.env.FIXTURE_ARGS_FILE)writeFileSync(process.env.FIXTURE_ARGS_FILE,JSON.stringify(args));
if(process.env.FIXTURE_ENV_FILE)writeFileSync(process.env.FIXTURE_ENV_FILE,JSON.stringify({
  thread:process.env.CODEX_THREAD_ID||null,parent:process.env.CODEX_PARENT_THREAD_ID||null,session:process.env.CODEX_SESSION_ID||null
}));
const prompt=readFileSync(0,'utf8');
if(process.env.FIXTURE_PROMPT_FILE)writeFileSync(process.env.FIXTURE_PROMPT_FILE,prompt);
const analysis=JSON.stringify({schemaVersion:1,summary:'测试摘要',categories:{skills_tools:[],time:[],tokens:[]},sessionDescriptions:[]});
function emit(type,extra){process.stdout.write(JSON.stringify({type,...extra})+'\\n')}
if(mode==='malformed'){process.stdout.write('not-json\\n');process.exit(0)}
if(mode==='slow'){emit('thread.started',{thread_id:'thread-slow-1'});setInterval(()=>{},1000);}
else{
  if(mode!=='no-thread')emit('thread.started',{thread_id:'thread-real-1'});
  emit('turn.started',{});
  if(mode==='turn-failed')emit('turn.failed',{error:{message:'x'}});
  if(mode==='no-completed'){emit('item.completed',{item:{type:'agent_message',text:analysis}});process.exit(0)}
  if(mode!=='no-output')emit('item.completed',{item:{type:'agent_message',text:analysis}});
  emit('turn.completed',{usage:{input_tokens:12,cached_input_tokens:3,output_tokens:5,total_tokens:17}});
  if(mode==='output-invalid')writeFileSync(output,'not-json');
  else if(mode!=='no-output')writeFileSync(output,analysis);
  process.exit(mode==='exit-1'?1:0);
}
`;

async function setup(){
  const directory=await mkdtemp(join(tmpdir(),'squad-runner-'));
  const fixture=join(directory,'fake-codex.mjs');
  await writeFile(fixture,FIXTURE);
  return {
    directory,fixture,
    file:name=>join(directory,name),
    cleanup:()=>rm(directory,{recursive:true,force:true}),
  };
}
async function run(fixture,mode,extras={}){
  const argsFile=join(fixture.directory,`${mode}-args.json`);
  const envFile=join(fixture.directory,`${mode}-env.json`);
  const promptFile=join(fixture.directory,`${mode}-prompt.txt`);
  const schemaPath=join(fixture.directory,'schema.json');
  const lastMessagePath=join(fixture.directory,`${mode}-last.json`);
  await writeFile(schemaPath,'{}');
  const promise=runCodexAnalysis({
    prompt:'冻结证据 JSON：{"ok":true}',schemaPath,runDir:fixture.directory,lastMessagePath,
    command:process.execPath,commandPrefix:[fixture.fixture],
    env:{...process.env,CODEX_THREAD_ID:'must-not-leak',CODEX_PARENT_THREAD_ID:'must-not-leak',CODEX_SESSION_ID:'must-not-leak',
      FIXTURE_MODE:mode,FIXTURE_ARGS_FILE:argsFile,FIXTURE_ENV_FILE:envFile,FIXTURE_PROMPT_FILE:promptFile},
    ...extras,
  });
  return {promise,argsFile,envFile,promptFile};
}

test('exec arguments keep the default model and read-only evidence directory',()=>{
  const args=codexExecArgs({schemaPath:'/tmp/schema.json',runDir:'/tmp/run',lastMessagePath:'/tmp/last.json'});
  assert.deepEqual(args.slice(0,7),['exec','--json','--output-schema','/tmp/schema.json','--sandbox','read-only','--skip-git-repo-check']);
  assert.equal(args.includes('-m'),false);
  assert.equal(args.includes('--model'),false);
  assert.equal(args.includes('--ephemeral'),false);
  assert.equal(args.includes('--ignore-user-config'),false);
  assert.equal(args.at(-1),'-');
  for(const option of ['project_doc_max_bytes=0','model_reasoning_effort="medium"','agents.max_depth=0','mcp_servers={}','shell_environment_policy.inherit=none','features.multi_agent=false']){
    assert.equal(args.includes(option),true,option);
  }
  assert.equal(args[args.indexOf('--cd')+1],'/tmp/run');
});

test('successful run captures the real thread, completion and strict output',async()=>{
  const fixture=await setup();
  try{
    const {promise,argsFile,envFile,promptFile}=await run(fixture,'ok');
    const result=await promise;
    assert.equal(result.realCodexThreadId,'thread-real-1');
    assert.equal(result.analysis.schemaVersion,1);
    assert.equal(result.exitCode,0);
    assert.deepEqual(result.usage,{input_tokens:12,cached_input_tokens:3,output_tokens:5,total_tokens:17});
    assert.deepEqual(result.eventTypes,['thread.started','turn.started','item.completed','turn.completed']);
    assert.match(await readFile(promptFile,'utf8'),/冻结证据 JSON/);
    const args=JSON.parse(await readFile(argsFile,'utf8'));
    assert.equal(args[0],'exec');
    assert.equal(args.includes('-m'),false);
    assert.equal(args.includes('--model'),false);
    assert.deepEqual(JSON.parse(await readFile(envFile,'utf8')),{thread:null,parent:null,session:null});
  }finally{await fixture.cleanup()}
});

test('protocol, identity and completion violations fail without a result',async()=>{
  const fixture=await setup();
  try{
    for(const [mode,code] of [
      ['malformed','SQUAD_ANALYSIS_PROTOCOL_INVALID'],
      ['no-thread','SQUAD_ANALYSIS_THREAD_MISSING'],
      ['no-completed','SQUAD_ANALYSIS_INCOMPLETE'],
      ['turn-failed','SQUAD_ANALYSIS_TURN_FAILED'],
      ['output-invalid','SQUAD_ANALYSIS_OUTPUT_INVALID'],
      ['no-output','SQUAD_ANALYSIS_OUTPUT_MISSING'],
      ['exit-1','SQUAD_ANALYSIS_CODEX_FAILED'],
    ]){
      const {promise}=await run(fixture,mode);
      await assert.rejects(promise,error=>error.code===code,`${mode} -> ${code}`);
    }
  }finally{await fixture.cleanup()}
});

test('abort terminates only the analysis child and reports interruption',async()=>{
  const fixture=await setup();
  try{
    const controller=new AbortController();
    let spawned=null;
    const {promise}=await run(fixture,'slow',{signal:controller.signal,onSpawn:child=>{spawned=child}});
    await new Promise(resolve=>setTimeout(resolve,120));
    assert.ok(spawned?.pid);
    controller.abort();
    await assert.rejects(promise,error=>error.code==='SQUAD_ANALYSIS_INTERRUPTED');
    assert.equal(spawned.exitCode!==null||spawned.signalCode!==null,true);
  }finally{await fixture.cleanup()}
});
