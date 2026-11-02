import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';

export const DEFAULT_ANALYSIS_TIMEOUT_MS=15*60*1000;
const MAX_STDOUT_BYTES=8*1024*1024;
const MAX_STDERR_BYTES=32*1024;
const THREAD_ID_PATTERN=/^[A-Za-z0-9._:-]{8,160}$/;

function fail(code,message){return Object.assign(new Error(message),{code})}
function threadIdOf(event){
  const value=event?.thread_id??event?.threadId;
  return typeof value==='string'?value.trim():'';
}
function sanitizedEnv(env){
  const value={...env};
  for(const key of ['CODEX_THREAD_ID','CODEX_PARENT_THREAD_ID','CODEX_SESSION_ID'])delete value[key];
  return value;
}
export function codexExecArgs({schemaPath,runDir,lastMessagePath}){
  return [
    'exec','--json','--output-schema',schemaPath,
    '--sandbox','read-only','--skip-git-repo-check','--cd',runDir,
    '-c','project_doc_max_bytes=0',
    '-c','model_reasoning_effort="medium"',
    '-c','agents.max_depth=0',
    '-c','mcp_servers={}',
    '-c','shell_environment_policy.inherit=none',
    '-c','features.multi_agent=false',
    '-c','agents.enabled=false',
    '-c','skills.include_instructions=false',
    '-c','skills.bundled.enabled=false',
    '-c','features.skip_host_skill_discovery=true',
    '-c','features.plugins=false',
    '-c','features.apps=false',
    '-c','features.memories=false',
    '-c','features.shell_tool=false',
    '-c','features.hooks=false',
    '--output-last-message',lastMessagePath,
    '-',
  ];
}
function parseEvents(stdout){
  const events=[];
  for(const line of stdout.split('\n')){
    if(!line.trim())continue;
    let event;
    try{event=JSON.parse(line);}
    catch{throw fail('SQUAD_ANALYSIS_PROTOCOL_INVALID','Codex 分析进程返回了无法识别的协议事件。');}
    if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'){
      throw fail('SQUAD_ANALYSIS_PROTOCOL_INVALID','Codex 分析进程返回了无法识别的协议事件。');
    }
    events.push(event);
  }
  return events;
}
function normalizeUsage(value){
  if(!value||typeof value!=='object')return null;
  const keys=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
  const output={};
  for(const key of keys)if(typeof value[key]==='number'&&Number.isFinite(value[key]))output[key]=value[key];
  return Object.keys(output).length?output:null;
}
async function lastMessage(file,fallback){
  try{
    const value=(await readFile(file,'utf8')).replace(/^\uFEFF/,'').trim();
    if(value)return value;
  }catch(error){if(error.code!=='ENOENT')throw error}
  if(typeof fallback==='string'&&fallback.trim())return fallback.trim();
  throw fail('SQUAD_ANALYSIS_OUTPUT_MISSING','Codex 分析进程未返回最终分析结果。');
}
export async function runCodexAnalysis({
  prompt,schemaPath,runDir,lastMessagePath,command='codex',commandPrefix=[],
  env=process.env,timeoutMs=DEFAULT_ANALYSIS_TIMEOUT_MS,signal=null,onSpawn=null,onThread=null,
}={}){
  if(typeof prompt!=='string'||!prompt.trim())throw fail('SQUAD_ANALYSIS_PROMPT_INVALID','分析指令为空。');
  if(!schemaPath||!runDir||!lastMessagePath)throw fail('SQUAD_ANALYSIS_RUN_INVALID','分析运行目录不完整。');
  const args=[...commandPrefix,...codexExecArgs({schemaPath,runDir,lastMessagePath})];
  const child=spawn(command,args,{
    cwd:runDir,
    env:sanitizedEnv(env),
    stdio:['pipe','pipe','pipe'],
    detached:true,
  });
  if(onSpawn)onSpawn(child);
  const chunks=[];let stdoutBytes=0,stderrBytes=0,stdoutText='',lineBuffer='',streamThreadId='',callbackError=null;const callbacks=[];
  let aborted=false,timedOut=false,outputOverflow=false,killed=false;
  const killGroup=signalName=>{
    if(!child.pid)return;
    try{process.kill(-child.pid,signalName);}
    catch{
      try{child.kill(signalName);}catch{}
    }
  };
  const terminate=()=>{
    if(killed)return;
    killed=true;
    killGroup('SIGTERM');
    const timer=globalThis.setTimeout(()=>killGroup('SIGKILL'),2000);
    timer.unref?.();
  };
  const onAbort=()=>{aborted=true;terminate()};
  if(signal){
    if(signal.aborted)onAbort();
    else signal.addEventListener('abort',onAbort,{once:true});
  }
  const timer=globalThis.setTimeout(()=>{timedOut=true;terminate()},Math.max(1000,Number(timeoutMs)||DEFAULT_ANALYSIS_TIMEOUT_MS));
  timer.unref?.();
  const exit=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signalName)=>resolve({code,signalName}));
  });
  child.stdout.on('data',chunk=>{
    stdoutBytes+=chunk.length;
    if(stdoutBytes>MAX_STDOUT_BYTES){outputOverflow=true;terminate();return;}
    chunks.push(chunk);
    lineBuffer+=chunk.toString('utf8');
    let newline;
    while((newline=lineBuffer.indexOf('\n'))>=0){
      const line=lineBuffer.slice(0,newline);lineBuffer=lineBuffer.slice(newline+1);
      try{const event=JSON.parse(line);if(event.type==='thread.started'){
        const id=threadIdOf(event);if(!THREAD_ID_PATTERN.test(id))throw fail('SQUAD_ANALYSIS_THREAD_INVALID','Codex 分析会话身份无效。');
        if(streamThreadId&&streamThreadId!==id)throw fail('SQUAD_ANALYSIS_THREAD_INVALID','Codex 分析会话身份不一致。');
        if(!streamThreadId){streamThreadId=id;if(onThread)callbacks.push(Promise.resolve().then(()=>onThread(id)).catch(error=>{callbackError=error;terminate()}));}
      }}catch(error){if(error.code){callbackError=error;terminate()}}
    }
  });
  child.stderr.on('data',chunk=>{
    stderrBytes=Math.min(MAX_STDERR_BYTES,stderrBytes+chunk.length);
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(prompt);
  let result;
  try{result=await exit;}
  catch(error){throw fail('SQUAD_ANALYSIS_CODEX_UNAVAILABLE',`无法启动 Codex 分析进程：${error.message}`.slice(0,300));}
  finally{
    signal?.removeEventListener('abort',onAbort);
    globalThis.clearTimeout(timer);
  }
  await Promise.all(callbacks);
  if(callbackError)throw callbackError;
  if(outputOverflow)throw fail('SQUAD_ANALYSIS_OUTPUT_LIMIT','Codex 分析输出超过安全上限。');
  if(aborted)throw fail('SQUAD_ANALYSIS_INTERRUPTED','分析服务关闭，本轮分析已中止。');
  if(timedOut)throw fail('SQUAD_ANALYSIS_TIMEOUT','Codex 分析超时，本轮报告未发布。');
  if(result.code!==0)throw fail('SQUAD_ANALYSIS_CODEX_FAILED',`Codex 分析进程异常退出 (${result.code??'signal'})。`);
  try{stdoutText=Buffer.concat(chunks).toString('utf8');}
  catch{throw fail('SQUAD_ANALYSIS_PROTOCOL_INVALID','Codex 分析进程输出无法解码。');}
  const events=parseEvents(stdoutText);
  let realCodexThreadId='';
  let completed=false;
  let usage=null;
  let turnFailure=false;
  let agentMessage='';
  for(const event of events){
    if(event.type==='thread.started'){
      const value=threadIdOf(event);
      if(value&&realCodexThreadId&&value!==realCodexThreadId)throw fail('SQUAD_ANALYSIS_THREAD_INVALID','Codex 分析会话身份不一致。');
      if(value)realCodexThreadId=value;
    }else if(event.type==='turn.completed'){
      completed=true;usage=normalizeUsage(event.usage)||usage;
    }else if(event.type==='turn.failed'){
      turnFailure=true;
    }else if(event.type==='item.completed'&&event.item?.type==='agent_message'){
      if(typeof event.item.text==='string')agentMessage=event.item.text;
    }
  }
  if(!realCodexThreadId)throw fail('SQUAD_ANALYSIS_THREAD_MISSING','Codex 分析进程未返回真实会话身份。');
  if(!THREAD_ID_PATTERN.test(realCodexThreadId))throw fail('SQUAD_ANALYSIS_THREAD_INVALID','Codex 分析进程返回的会话身份无效。');
  if(turnFailure)throw fail('SQUAD_ANALYSIS_TURN_FAILED','Codex 分析回合失败，本轮报告未发布。');
  if(!completed)throw fail('SQUAD_ANALYSIS_INCOMPLETE','Codex 分析进程未返回完成状态。');
  const outputText=await lastMessage(lastMessagePath,agentMessage);
  let analysis;
  try{analysis=JSON.parse(outputText);}
  catch{throw fail('SQUAD_ANALYSIS_OUTPUT_INVALID','Codex 分析结果不是严格 JSON。');}
  return {
    realCodexThreadId,analysis,outputText,usage,
    exitCode:result.code,signal:result.signalName||null,
    eventTypes:events.map(event=>event.type),stderrBytes,
  };
}
