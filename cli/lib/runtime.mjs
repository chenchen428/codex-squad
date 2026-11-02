import {nodeFlags} from './node-runtime.mjs';
import {registerSpawnedWorker,isWorkerAlive,requestWorkerStop} from './worker-control.mjs';
import {sweepOrphanedAcp} from './orphan-recovery.mjs';
import {dataRoot} from './storage-paths.mjs';
import {verifyHostSession,readHostTurn} from './host-session.mjs';
import {hostThreadTitle} from './host-title.mjs';
import {qoderClientOptions,qoderFailureDiagnostic} from './qoder-execution.mjs';
import {projectConversation} from './conversation.mjs';
import {deliveryFromEvents} from './presentation.mjs';
import {realpathSync} from 'node:fs';
import {normalizeWritePaths,writeConflict} from './write-scope.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {open,readFile,rename,mkdir,rm,stat} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {fingerprintCandidate,inspectAcceptance} from './evidence.mjs';
import {RETIREMENT_OUTCOMES,inboxOf} from './task-lifecycle.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const workerPath=join(root,'cli','lib','worker.mjs');
const sourceType='codex-squad';
const sourceRefVersion='squad:v2';
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestIdPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const diagnosticCache=new Map();
const localClients=new Map();
const terminalStatuses=new Set(['completed','failed','stopped','interrupted']);

export const MEMBERS=Object.freeze([
  Object.freeze({id:'implementer',name:'实现成员',executor:'qoder',model:'DeepSeek-Flash',readOnly:false}),
]);

const historicalReviewer=Object.freeze({id:'reviewer',name:'历史检查成员',executor:'codex',model:'gpt-5.6-sol',readOnly:true});
function assertExecutable(member){if(member?.id!=='implementer')throw squadError('SQUAD_MAIN_SESSION_ONLY','方案、UED 与验收由主 Codex 完成，不再启动或续接 Codex 检查子会话。')}

function squadError(code,message,cause){return Object.assign(new Error(message,cause?{cause}:undefined),{code});}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function text(value){return typeof value==='string'?value.trim():'';}
function nowIso(options={}){const value=options.now?options.now():Date.now();return (value instanceof Date?value:new Date(value)).toISOString();}
function digest(value){return createHash('sha256').update(String(value)).digest('hex');}

function bindingPath(threadId,options={}){return join(dataRoot(options),'bindings',`${threadId}.json`);}
function workspacePath(workspace,options={}){return join(dataRoot(options),'workspaces',`${digest(realpathSync(resolve(workspace))).slice(0,24)}.json`);}
function pluginEnv(options={}){return options.env||process.env;}
function memberById(id){return MEMBERS.find(member=>member.id===id)||null;}
function hostThread(options={}){
  const value=text(pluginEnv(options).CODEX_THREAD_ID);
  if(!uuidPattern.test(value))throw squadError('SQUAD_HOST_THREAD_MISSING','当前进程没有可信的 CODEX_THREAD_ID，无法绑定小队。');
  return value;
}
function assertKnown(value,allowed,label='输入'){
  if(!isRecord(value))throw squadError('SQUAD_INPUT_INVALID',`${label}必须是 JSON 对象。`);
  for(const key of Object.keys(value))if(!allowed.includes(key))throw squadError('SQUAD_INPUT_UNKNOWN_FIELD',`${label}包含未知字段：${key}`);
}
function requiredText(value,field,max,code='SQUAD_INPUT_INVALID'){
  const candidate=text(value);
  if(!candidate)throw squadError(code,`${field}不能为空。`);
  if(candidate.length>max)throw squadError(code,`${field}不能超过 ${max} 个字符。`);
  if(/[\r\n\0]/.test(candidate)&&field!=='context')throw squadError(code,`${field}包含无效字符。`);
  return candidate;
}
function stringList(value,field,{required=true}={}){
  if(value===undefined&&!required)return [];
  if(!Array.isArray(value)||value.length===0)throw squadError('SQUAD_INPUT_INVALID',`${field}必须是非空字符串数组。`);
  if(value.length>50)throw squadError('SQUAD_INPUT_INVALID',`${field}最多 50 项。`);
  return value.map((item,index)=>{
    if(typeof item!=='string'||!item.trim())throw squadError('SQUAD_INPUT_INVALID',`${field}[${index}]必须是非空字符串。`);
    if(item.length>1000)throw squadError('SQUAD_INPUT_INVALID',`${field}[${index}]不能超过 1000 个字符。`);
    return item.trim();
  });
}
function optionalContext(value){
  if(value===undefined)return '';
  if(typeof value!=='string')throw squadError('SQUAD_INPUT_INVALID','context 必须是字符串。');
  if(value.length>16000)throw squadError('SQUAD_INPUT_INVALID','context 不能超过 16000 个字符。');
  return value;
}
function assertHandoffSize(handoff){
  if(JSON.stringify(handoff).length>80000)throw squadError('SQUAD_INPUT_INVALID','交接内容过长，不能写入单条 小队存储 事件。');
}
function validateDispatchInput(input){
  assertKnown(input,['requestId','memberId','title','goal','scope','criteria','context','reason','writePaths']);
  const requestId=requiredText(input.requestId,'requestId',80);
  if(!requestIdPattern.test(requestId))throw squadError('SQUAD_INPUT_INVALID','requestId 只能包含字母、数字、点、下划线和连字符。');
  const memberId=text(input.memberId);
  if(memberId==='reviewer')assertExecutable(historicalReviewer);
  const member=memberById(memberId);
  if(!member)throw squadError('SQUAD_MEMBER_FIXED',`成员固定为 ${MEMBERS.map(item=>item.id).join('、')}，不能使用 ${memberId||'空成员'}。`);
  const reason=input.reason===undefined?null:requiredText(input.reason,'reason',2000);
  if(member.readOnly&&!reason)throw squadError('SQUAD_REASON_REQUIRED','检查成员的交接必须说明独立检查的原因。');
  const handoff={
    requestId,memberId,title:requiredText(input.title,'title',200),goal:requiredText(input.goal,'goal',4000),
    scope:stringList(input.scope,'scope'),criteria:stringList(input.criteria,'criteria'),context:optionalContext(input.context),reason,
    ...(input.writePaths===undefined?{}:{writePaths:input.writePaths}),
  };
  assertHandoffSize(handoff);
  return handoff;
}
function validateContinueInput(input){
  assertKnown(input,['taskId','requestId','goal','scope','criteria','context','reason','writePaths']);
  const requestId=requiredText(input.requestId,'requestId',80);
  if(!requestIdPattern.test(requestId))throw squadError('SQUAD_INPUT_INVALID','requestId 只能包含字母、数字、点、下划线和连字符。');
  const reason=input.reason===undefined?null:requiredText(input.reason,'reason',2000);
  const handoff={
    taskId:requiredText(input.taskId,'taskId',160),requestId,goal:requiredText(input.goal,'goal',4000),
    scope:stringList(input.scope,'scope'),criteria:stringList(input.criteria,'criteria'),context:optionalContext(input.context),reason,
    ...(input.writePaths===undefined?{}:{writePaths:input.writePaths}),
  };
  assertHandoffSize(handoff);
  return handoff;
}

async function readJsonFile(file,fallback){
  try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
async function writeJsonFile(file,value,options={}){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
  await writePrivate(temporary,`${JSON.stringify(value)}\n`);
  await rename(temporary,file);
  if(Number(options.chmodMode||0))await import('node:fs/promises').then(fs=>fs.chmod(file,options.chmodMode)).catch(()=>{});
}
async function writePrivate(file,contents){
  const handle=await open(file,'w',0o600);
  try{await handle.writeFile(contents,{encoding:'utf8'});}finally{await handle.close();}
}
async function withFileLock(file,fn,options={}){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const deadline=Date.now()+(options.lockTimeoutMs??10000);
  for(;;){
    let handle;
    try{handle=await open(file,'wx',0o600);}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const current=await stat(file).catch(()=>null);
      const owner=Number(await readFile(file,'utf8').catch(()=>''));
      let ownerAlive=false;
      if(Number.isSafeInteger(owner)&&owner>0){try{process.kill(owner,0);ownerAlive=true}catch(probe){ownerAlive=probe.code==='EPERM'}}
      if(!ownerAlive&&current&&(owner>0||Date.now()-current.mtimeMs>60000)){await rm(file,{force:true});continue;}
      if(Date.now()>deadline)throw squadError('SQUAD_BINDING_LOCKED','小队状态正在被另一个进程更新，请稍后重试。');
      await delay(40);
      continue;
    }
    try{
      await handle.writeFile(`${process.pid}\n`);
      return await fn();
    }finally{
      await handle.close().catch(()=>{});
      await rm(file,{force:true}).catch(()=>{});
    }
  }
}

function normalizeBinding(value,threadId){
  if(!isRecord(value)||Number(value.schemaVersion)!==1||value.threadId!==threadId
    ||!isRecord(value.attempts)||!isRecord(value.workers)||!Array.isArray(value.tasks)
    ||!text(value.workspace)||!value.projectId||!value.parentWorkId){
    throw squadError('SQUAD_BINDING_CORRUPT','小队绑定记录损坏，请在原会话重新绑定。');
  }
  return {
    schemaVersion:1,threadId,workspace:value.workspace,projectId:String(value.projectId),
    parentWorkId:String(value.parentWorkId),title:String(value.title||''),
    tasks:value.tasks.filter(item=>typeof item==='string'&&item),
    attempts:value.attempts,workers:value.workers,
    reviews:isRecord(value.reviews)?value.reviews:{},
    retirements:isRecord(value.retirements)?value.retirements:{},
    createdAt:String(value.createdAt||''),updatedAt:String(value.updatedAt||''),
  };
}

export async function readBinding(threadId,options={}){
  const id=typeof threadId==='object'?threadId?.threadId:String(threadId||'');
  if(!uuidPattern.test(String(id)))throw squadError('SQUAD_HOST_THREAD_INVALID','小队绑定标识无效。');
  let value;
  try{value=await readJsonFile(bindingPath(id,options),null);}
  catch(error){
    if(error instanceof SyntaxError)throw squadError('SQUAD_BINDING_CORRUPT','小队绑定记录损坏，请在原会话重新绑定。');
    throw error;
  }
  if(value===null)return null;
  const binding=normalizeBinding(value,id);
  binding.title=options.includeTitle===false?'':await hostThreadTitle(id,{env:options.env||process.env,codexHome:options.codexHome})||'未获取会话标题';
  return binding;
}
async function writeBinding(binding,options={}){
  binding.updatedAt=nowIso(options);
  await writeJsonFile(bindingPath(binding.threadId,options),binding);
}
async function requireBinding(options={}){
  const binding=await readBinding(hostThread(options),options);
  if(!binding)throw squadError('SQUAD_BINDING_NOT_FOUND','当前会话尚未绑定小队，请先执行 bind。');
  return binding;
}
export async function withBindingLock(threadId,fn,options={}){
  return withFileLock(`${bindingPath(threadId,options)}.lock`,fn,options);
}
export async function updateBinding(threadId,mutator,options={}){
  return withBindingLock(threadId,async()=>{
    const binding=await readBinding(threadId,options);
    if(!binding)throw squadError('SQUAD_BINDING_NOT_FOUND','当前会话尚未绑定小队。');
    await mutator(binding);
    await writeBinding(binding,options);
    return binding;
  },options);
}
function withAdmissionLock(fn,options={}){
  return withFileLock(join(dataRoot(options),'dispatch.lock'),fn,options);
}

export async function loadModules(options={}){
  if(options.modules)return options.modules;
  const {createLocalStore}=await import('./local-store.mjs');
  const home=dataRoot(options),workspace=resolve(options.defaultWorkspace||process.cwd()),key=JSON.stringify([home,workspace]);
  if(!options.client&&!localClients.has(key))localClients.set(key,createLocalStore({home,workspace}));
  return {
    client:options.client||localClients.get(key),
    qoderRunner:await import('./qoder/qoder-acp-runner.mjs'),
    qoderClient:await import('./qoder/qoder-acp-client.mjs'),
  };
}

async function localClient(options={}){
  if(options.client)return options.client;
  return (await loadModules(options)).client;
}
export async function viewerClient(binding,options={}){
  return localClient({...options,defaultWorkspace:binding.workspace});
}
function defaultClientOptions(options={}){
  return {actor:options.actor,defaultWorkspace:options.defaultWorkspace};
}


export async function bindCurrent(options={}){
  const threadId=hostThread(options);
  const cwd=resolve(options.cwd||process.cwd());
  await (options.verifyHost||verifyHostSession)({threadId,cwd,options});
  const client=await localClient({...options,defaultWorkspace:cwd});
  return withBindingLock(threadId,async()=>{
    const existing=await readBinding(threadId,options);
    if(existing){
      if(resolve(existing.workspace)!==cwd)throw squadError('SQUAD_BINDING_WORKSPACE_MISMATCH','该会话已绑定其他工作目录，不能在同一会话混用。');
      const {task:parent}=await client.operate('work.get',{workId:existing.parentWorkId},defaultClientOptions(options));
      if(parent?.projectId!==existing.projectId||parent?.harness?.sourceType!==sourceType||parent?.harness?.sourceRef!==`${sourceRefVersion}:${threadId}:parent`)throw squadError('SQUAD_BINDING_CONFLICT','小队绑定与 小队存储 父任务身份不一致。');
      return existing;
    }
    const projectName=`Codex 小队 · ${basename(cwd)||'workspace'}`;
    const title=await hostThreadTitle(threadId,{env:options.env||process.env,codexHome:options.codexHome})||'未获取会话标题';
    const projectResult=await client.operate('project.create',{
      name:projectName,clientRequestId:`codex-squad:workspace:${digest(cwd)}`,
    },defaultClientOptions({...options,defaultWorkspace:cwd}));
    const project=projectResult?.project||projectResult;
    if(!project?.id)throw squadError('SQUAD_PROJECT_UNAVAILABLE','小队存储 未返回小队项目。');
    const parentResult=await client.operate('work.create',{
      projectId:project.id,title,description:`当前 Codex 会话交办的任务与执行进展。`,
      status:'backlog',labels:['codex-squad','codex-squad-parent'],sourceType,sourceRef:`${sourceRefVersion}:${threadId}:parent`,
    },defaultClientOptions({...options,defaultWorkspace:cwd}));
    const parent=parentResult?.task;
    if(!parent?.id)throw squadError('SQUAD_PARENT_WORK_UNAVAILABLE','小队存储 未返回小队父 Work。');
    const at=nowIso(options);
    const binding={schemaVersion:1,threadId,workspace:cwd,projectId:String(project.id),parentWorkId:String(parent.id),
      title,tasks:[],attempts:{},workers:{},reviews:{},retirements:{},createdAt:at,updatedAt:at};
    await writeBinding(binding,options);
    return binding;
  },options);
}

function taskSourceRef(binding,memberId,requestId){
  return `${sourceRefVersion}:${binding.threadId}:${encodeURIComponent(binding.parentWorkId)}:${memberId}:${requestId}`;
}
export function memberFromTask(binding,task){
  const ref=text(task?.harness?.sourceRef);
  const prefix=`${sourceRefVersion}:${binding.threadId}:`;
  if(!ref.startsWith(prefix))return null;
  const parts=ref.slice(prefix.length).split(':');
  if(parts.length!==3)return null;
  let parentWorkId;
  try{parentWorkId=decodeURIComponent(parts[0]);}catch{return null;}
  if(parentWorkId!==binding.parentWorkId)return null;
  const member=memberById(parts[1])||(parts[1]==='reviewer'?historicalReviewer:null);
  if(!member||!requestIdPattern.test(parts[2]))return null;
  return {member,requestId:parts[2]};
}
function assertTaskOwned(binding,task){
  if(task?.harness?.sourceType!==sourceType||!memberFromTask(binding,task)){
    throw squadError('SQUAD_BINDING_TASK_MISMATCH','小队存储 任务不属于当前会话的小队。');
  }
}
async function getTask(binding,taskId,client,options={}){
  const result=await client.operate('work.get',{workId:taskId},{
    ...defaultClientOptions({...options,defaultWorkspace:binding.workspace}),
  });
  const task=result?.task;
  if(!task?.id||task.id!==taskId)throw squadError('SQUAD_TASK_UNAVAILABLE',`无法读取任务 ${taskId}。`);
  assertTaskOwned(binding,task);
  return task;
}
export async function verifyParent(binding,client,options={}){
  const {task:parent}=await client.operate('work.get',{workId:binding.parentWorkId},defaultClientOptions({...options,defaultWorkspace:binding.workspace}));
  if(parent?.projectId!==binding.projectId||parent?.harness?.sourceType!==sourceType||parent?.harness?.sourceRef!==`${sourceRefVersion}:${binding.threadId}:parent`)throw squadError('SQUAD_BINDING_CONFLICT','父任务与当前会话绑定不一致。');
  return parent;
}
export async function ownedTask(binding,taskId,client,options={}){
  return getTask(binding,taskId,client,options);
}
export async function readExecutionDigest(client,taskId,generation,options={}){
  return client.operate('work.execution.digest',{workId:taskId,generation},defaultClientOptions(options));
}
export async function readExecutionDelta(client,taskId,generation,afterSequence,options={}){
  const read=after=>client.operate('work.execution.get',{workId:taskId,generation,limit:1000,...(after?{afterSequence:after}:{})},defaultClientOptions(options));
  const first=await read(afterSequence);
  const events=[...(first.events||[])];
  const target=Number(first.highWaterSequence||0);
  let sequence=Number(events.at(-1)?.sequence||afterSequence||0);
  while(sequence<target){
    const page=await read(sequence);
    const next=(page.events||[]).filter(event=>Number(event.sequence)>sequence&&Number(event.sequence)<=target);
    if(!next.length)throw squadError('SQUAD_EVENT_HISTORY_INCOMPLETE','执行记录分页缺少预期事件，请核对 小队存储 记录。');
    events.push(...next);sequence=Number(next.at(-1).sequence);
  }
  return {...first,events};
}
export async function readGeneration(client,taskId,generation,options={}){
  return readExecutionDelta(client,taskId,generation,0,options);
}
function handoffFromPayload(value){
  if(!isRecord(value))return null;
  return {
    goal:text(value.goal),scope:(Array.isArray(value.scope)?value.scope:[]).filter(item=>typeof item==='string'),
    criteria:(Array.isArray(value.criteria)?value.criteria:[]).filter(item=>typeof item==='string'),
    context:typeof value.context==='string'?value.context:'',
    ...(typeof value.title==='string'?{title:value.title}:{}),...(typeof value.reason==='string'?{reason:value.reason}:{}),
    ...(Array.isArray(value.writePaths)?{writePaths:value.writePaths.filter(item=>typeof item==='string')}:{}),
  };
}
export function refFromEvents(events,generation){
  const started=(events||[]).find(event=>event?.type==='SQUAD_ATTEMPT_STARTED'&&event.payload?.attemptId);
  if(!started)return null;
  return {
    attemptId:String(started.payload.attemptId),index:Number(started.payload.index)||Number(generation),
    generation:Number(generation),requestId:String(started.payload.requestId||''),
    resumedFrom:started.payload.resumedFrom||null,startedAt:started.occurredAt||null,
    nativeSessionId:started.payload.nativeSessionId||null,writePaths:started.payload.handoff?.writePaths,worker:null,
  };
}
export async function collectTaskReferences(binding,task,client,options={}){
  const refs=(binding.attempts[task.id]||[]).filter(ref=>ref&&ref.attemptId&&Number.isSafeInteger(Number(ref.generation))).map(ref=>({
    ...ref,generation:Number(ref.generation),index:Number(ref.index)||Number(ref.generation),
  }));
  const known=new Set(refs.map(ref=>ref.generation));
  const executions=new Map();
  const maxGeneration=Math.max(0,Math.min(Number(task.harness?.activeGeneration||0),100));
  for(const ref of refs){
    if(!executions.has(ref.generation))executions.set(ref.generation,await readGeneration(client,task.id,ref.generation,{...options,defaultWorkspace:binding.workspace}));
  }
  for(let generation=1;generation<=maxGeneration;generation+=1){
    if(known.has(generation))continue;
    const execution=await readGeneration(client,task.id,generation,{...options,defaultWorkspace:binding.workspace});
    executions.set(generation,execution);
    const recovered=refFromEvents(execution?.events,generation);
    if(recovered&&!refs.some(ref=>ref.attemptId===recovered.attemptId)){refs.push(recovered);known.add(generation);}
  }
  refs.sort((left,right)=>left.index-right.index||left.generation-right.generation);
  return {refs,executions};
}
function mergeReferences(binding,task,refs,options={}){
  if(!binding.tasks.includes(task.id))binding.tasks.push(task.id);
  const current=binding.attempts[task.id]||[];
  for(const ref of refs){
    const index=current.findIndex(item=>item?.attemptId===ref.attemptId);
    if(index<0)current.push(ref);
    else current[index]={...current[index],...ref,worker:current[index].worker||ref.worker};
  }
  binding.attempts[task.id]=current;
  binding.updatedAt=nowIso(options);
}

async function defaultIsWorkerProcess(pid,nonce,options={}){
  return isWorkerAlive(Number(pid),nonce,options);
}

function workerProcess(options={}){return options.isWorkerProcess||defaultIsWorkerProcess;}
export async function workerAlive(worker,options={}){
  if(!worker?.pid)return false;
  return workerProcess(options)(worker.pid,worker.nonce||'',options);
}

// Association is verified from the host rollout itself. A failed association never blocks
// dispatch and never fabricates a stop: it is recorded as unverified/unknown for readers.
async function hostTurnLink(binding,options={}){
  let session;
  try{session=await (options.verifyHost||verifyHostSession)({threadId:binding.threadId,cwd:binding.workspace,options});}
  catch(error){return {state:'unverified',turnId:null,rolloutPath:null,reason:`宿主会话未核实：${error.message}`};}
  const rolloutPath=text(session?.rolloutPath);
  if(!rolloutPath)return {state:'unverified',turnId:null,rolloutPath:null,reason:'宿主会话记录未返回可读取的 rollout 路径。'};
  let turn;
  try{turn=await (options.readHostTurn||readHostTurn)({rolloutPath,options});}
  catch(error){return {state:'unverified',turnId:null,rolloutPath,reason:`宿主轮次未核实：${error.message}`};}
  const turnId=text(turn?.turnId);
  if(turn?.state!=='active'||!uuidPattern.test(turnId))
    return {state:'unknown',turnId:uuidPattern.test(turnId)?turnId:null,rolloutPath,reason:`宿主当前轮次不可确认：${turn?.reason||turn?.evidence||turn?.state||'unknown'}`};
  const offset=Number.isSafeInteger(Number(turn?.bytes))&&Number(turn.bytes)>=0?Number(turn.bytes):null;
  if(offset===null)return {state:'unknown',turnId,rolloutPath,reason:'宿主会话记录未返回可核实的字节位置。'};
  return {state:'linked',turnId,rolloutPath,offset,reason:null};
}
function hostTurnView(link){
  if(!link)return null;
  return {state:link.state,turnId:link.turnId||null,reason:link.reason||null};
}

async function liveWorkspaceWrites(workspace,options={}){
  const file=workspacePath(workspace,options);
  return withFileLock(`${file}.lock`,async()=>{
    const state=await readJsonFile(file,{schemaVersion:1,workspace,entries:[]});
    const entries=Array.isArray(state?.entries)?state.entries:[];
    const live=[];
    for(const entry of entries)if(await workerProcess(options)(entry.pid,entry.nonce||'',options))live.push(entry);
    if(live.length!==entries.length)await writeJsonFile(file,{schemaVersion:1,workspace,entries:live});
    return live;
  },options);
}
async function addWorkspaceWrite(workspace,entry,options={}){
  const file=workspacePath(workspace,options);
  await withFileLock(`${file}.lock`,async()=>{
    const state=await readJsonFile(file,{schemaVersion:1,workspace,entries:[]});
    const entries=(Array.isArray(state?.entries)?state.entries:[]).filter(item=>!(item.threadId===entry.threadId&&item.taskId===entry.taskId&&item.attemptId===entry.attemptId));
    for(const current of entries){
      if(await workerProcess(options)(current.pid,current.nonce||'',options)){
        const conflict=writeConflict(entry.writePaths,current.writePaths);
        if(conflict)throw squadError('SQUAD_WORKSPACE_BUSY',`写入范围 ${conflict} 被任务 ${current.taskId}（会话 ${current.threadId}）占用。`);
      }
    }
    entries.push(entry);
    await writeJsonFile(file,{schemaVersion:1,workspace,entries});
  },options);
}
export async function removeWorkspaceWrite(entry,options={}){
  const workspace=entry?.workspace;
  if(!workspace)return;
  const file=workspacePath(workspace,options);
  await withFileLock(`${file}.lock`,async()=>{
    const state=await readJsonFile(file,{schemaVersion:1,workspace,entries:[]});
    const entries=(Array.isArray(state?.entries)?state.entries:[]).filter(item=>!(item.threadId===entry.threadId&&item.taskId===entry.taskId&&item.attemptId===entry.attemptId));
    await writeJsonFile(file,{schemaVersion:1,workspace,entries});
  },options);
}


function cleanChildEnv(source){
  return Object.fromEntries(Object.entries(source).filter(([key])=>!key.startsWith('CODEX_')));
}
async function defaultStartWorker(job,{binding,options={}}){
  const logDirectory=join(dataRoot(options),'logs');
  await mkdir(logDirectory,{recursive:true,mode:0o700});
  const handle=await open(join(logDirectory,`${job.taskId}-${job.attemptId}.log`),'a',0o600);
  let child;
  try{
    child=spawn(process.execPath,[...nodeFlags(),workerPath,'--worker-nonce',job.nonce],{
      cwd:binding.workspace,detached:true,env:cleanChildEnv(pluginEnv(options)),
      stdio:['pipe',handle.fd,handle.fd],
    });
  }finally{await handle.close();}
  if(!child?.pid)throw squadError('SQUAD_WORKER_START_FAILED','无法启动成员执行进程。');
  child.once('error',()=>{});
  child.stdin.on('error',()=>{});
  await registerSpawnedWorker(child,job.nonce,{
    ...options,taskId:job.taskId,attemptId:job.attemptId,generation:job.generation,
  });
  child.stdin.end(JSON.stringify(job));
  child.unref();
  return {pid:child.pid};
}
function startWorker(job,context){return (context.options.startWorker||defaultStartWorker)(job,context);}

export async function verifyMemberModel(member,workspace,options={}){
  assertExecutable(member);
  if(typeof options.verifyModel==='function')return options.verifyModel({member,workspace});
  const modules=await loadModules(options);
  let models;
  try{
    const clientOptions=qoderClientOptions(workspace,pluginEnv(options));
    models=await modules.qoderRunner.discoverQoderAcpModels({
      workspace,agentEnv:clientOptions.env,qoderAcpArgs:clientOptions.args,
      cacheModels:options.cacheModels!==false,modelCatalogTtlMs:options.modelCatalogTtlMs,
      modelCatalogDir:options.modelCatalogDir||join(dataRoot(options),'model-catalog'),
    });
  }catch(error){
    throw squadError('SQUAD_MODEL_DISCOVERY_FAILED',`Qoder 模型目录读取失败，尚未启动任务：${error.message}`,error);
  }finally{await modules.qoderRunner?.closeQoderAcpSessions?.()}
  try{return {modelId:modules.qoderRunner.resolveQoderAcpModel(models,member.model)}}
  catch(error){throw squadError('SQUAD_MODEL_UNAVAILABLE',`Qoder 实际目录中没有可用的 ${member.model}：${error.message}`,error)}
}

export function taskStatusView(task,attempts,worker,alive){
  const latest=attempts.at(-1);
  if(latest?.endedAt&&['failed','stopped','interrupted'].includes(latest.status))return latest.status;
  if(task.status==='in_progress'){
    if(!latest||latest.endedAt)return 'unknown';
    if(!worker||!alive)return 'unknown';
    return worker.stopRequestedAt?'stopping':latest.sessionId?'running':'starting';
  }
  if(task.status==='in_review')return 'waiting_review';
  return String(task.status||'unknown');
}
export function attemptView(ref,execution,task,member,worker,alive,latest,{allEvents=false,publicEvents:providedEvents=null}={}){
  const events=(execution?.events||[]).slice().sort((left,right)=>Number(left.sequence)-Number(right.sequence));
  const started=events.find(event=>event?.type==='SQUAD_ATTEMPT_STARTED');
  const completed=[...events].reverse().find(event=>event?.type==='SQUAD_ATTEMPT_COMPLETED');
  const sessionEvent=[...events].reverse().find(event=>event?.type==='SQUAD_ATTEMPT_SESSION');
  const usageEvent=[...events].reverse().find(event=>event?.type==='SQUAD_USAGE_REPORTED');
  const legacyEvents=providedEvents?[]:events.filter(event=>event?.type==='SQUAD_ATTEMPT_EVENT').map(event=>({
    id:String(event.payload?.eventId||event.eventId),time:event.payload?.time||event.occurredAt,
    kind:String(event.payload?.kind||'event'),...(event.payload?.role?{role:event.payload.role}:{}),
    text:String(event.payload?.text||''),...(event.payload?.revision!==undefined?{revision:event.payload.revision}:{}),...(event.payload?.status?{status:event.payload.status}:{}),...(event.payload?.result?{result:event.payload.result}:{}),...(event.payload?.updatedAt?{updatedAt:event.payload.updatedAt}:{}),...(event.payload?.toolName?{toolName:event.payload.toolName}:{}),
  }));
  const projected=providedEvents||[...legacyEvents,...projectConversation(events)];
  const publicEvents=allEvents?projected:projected.slice(-200);
  let status='unknown';
  if(completed){
    const reported=String(completed.payload?.status||'').toLowerCase();
    status=terminalStatuses.has(reported)?reported:'unknown';
  }else if(latest&&task.status==='in_progress'){
    if(alive&&worker)status=worker.stopRequestedAt?'stopping':sessionEvent||ref.nativeSessionId?'running':'starting';
  }
  const endedAt=completed?.payload?.endedAt||completed?.occurredAt||null;
  const result=typeof completed?.payload?.result==='string'?completed.payload.result:null;
  return {
    id:ref.attemptId,index:ref.index,status,
    startedAt:started?.occurredAt||ref.startedAt||null,
    endedAt,
    sessionId:completed?.payload?.nativeSessionId||sessionEvent?.payload?.sessionId||ref.nativeSessionId||null,
    model:member?.model||null,actualModel:completed?.payload?.actualModel||null,
    usage:normalizeUsage(completed?.payload?.usage)||normalizeUsage(usageEvent?.payload?.usage)||null,
    handoff:handoffFromPayload(started?.payload?.handoff)||handoffFromPayload(ref.handoff)||null,
    delivery:deliveryFromEvents([...events,...publicEvents],{status,endedAt,activeAttempt:Boolean(latest&&task.status==='in_progress')}),
    events:publicEvents,
    result,
    error:typeof completed?.payload?.error==='string'?completed.payload.error:!started?'小队存储 未保留此尝试的公开记录，状态和用量待核实。':null,
    resumedFrom:started?.payload?.resumedFrom||ref.resumedFrom||null,
  };
}
export function acceptanceFrom(execution){
  const event=[...(execution?.events||[])].reverse().find(item=>item?.type==='SQUAD_ACCEPTANCE');
  if(!event?.payload)return null;
  return {
    attemptId:String(event.payload.attemptId||''),
    fingerprint:String(event.payload.fingerprint||''),
    note:String(event.payload.note||''),
    at:String(event.payload.at||event.occurredAt||''),
    files:Array.isArray(event.payload.files)?event.payload.files:[],
  };
}

export async function attemptDiagnostic(binding,member,attempt,options={}){
  if(member?.executor!=='qoder'||attempt?.status!=='failed'||!attempt.endedAt||!attempt.sessionId)return null;
  const key=JSON.stringify([binding.workspace,attempt.id,attempt.sessionId,attempt.endedAt]);
  if(!diagnosticCache.has(key)){
    try{diagnosticCache.set(key,await qoderFailureDiagnostic({workspace:binding.workspace,nativeSessionId:attempt.sessionId,startedAt:attempt.startedAt}))}catch{return null}
    if(diagnosticCache.size>200)diagnosticCache.delete(diagnosticCache.keys().next().value);
  }
  return diagnosticCache.get(key)||null;
}
export function membersView(tasks){
  return [...MEMBERS,...(tasks.some(task=>task.memberId==='reviewer')?[historicalReviewer]:[])].map(member=>{
    const memberTasks=tasks.filter(task=>task.memberId===member.id);
    const activeTasks=memberTasks.filter(task=>['running','starting','stopping'].includes(task.status));
    const activeTask=memberTasks.find(task=>['running','starting','stopping'].includes(task.status));
    if(activeTask)return {id:member.id,name:member.name,executor:member.executor,model:member.model,status:activeTask.status,currentTaskId:activeTask.id,activeCount:activeTasks.length,currentTaskIds:activeTasks.map(task=>task.id)};
    const latest=memberTasks.at(-1);
    const unknown=latest?.status==='unknown'?latest:null;
    return {id:member.id,name:member.name,executor:member.executor,model:member.model,status:unknown?'unknown':'idle',currentTaskId:unknown?.id||null};
  });
}
export function usageView(tasks){
  const usage={inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,reportedAttempts:0,totalAttempts:0,mainSession:'unavailable',currency:null};
  for(const task of tasks)for(const attempt of task.attempts){
    usage.totalAttempts+=1;
    if(!attempt.usage)continue;
    usage.reportedAttempts+=1;
    for(const key of ['inputTokens','outputTokens','cachedInputTokens','totalTokens']){
      if(typeof attempt.usage[key]==='number')usage[key]=(usage[key]??0)+attempt.usage[key];
    }
  }
  return usage;
}

export async function snapshot(binding,options={}){
  binding=await readBinding(typeof binding==='string'?binding:binding?.threadId,options);
  if(!binding)throw squadError('SQUAD_BINDING_NOT_FOUND','当前会话尚未绑定小队。');
  const client=await localClient({...options,defaultWorkspace:binding.workspace});
  const parent=await verifyParent(binding,client,options);
  const tasks=[];
  const cursorParts=[];
  for(const taskId of binding.tasks){
    const task=await getTask(binding,taskId,client,options);
    const {refs,executions}=await collectTaskReferences(binding,task,client,options);
    const worker=binding.workers[taskId]||refs.at(-1)?.worker||null;
    const alive=await workerAlive(worker,options);
    const owned=memberFromTask(binding,task);
    const attempts=refs.map((ref,index)=>attemptView(ref,executions.get(ref.generation),task,owned.member,worker,alive,index===refs.length-1,{allEvents:options.allEvents===true}));
    for(let index=0;index<attempts.length;index+=1){
      const attempt=attempts[index],ref=refs[index];
      const rawAcceptance=acceptanceFrom(executions.get(ref.generation));
      if(rawAcceptance&&rawAcceptance.attemptId===attempt.id)attempt.acceptance=await inspectAcceptance(binding.workspace,rawAcceptance);
      const verification=binding.reviews?.[task.id]?.[attempt.id];
      if(verification)attempt.verification=verification;
      const diagnostic=await attemptDiagnostic(binding,owned.member,attempt,options);
      if(diagnostic)attempt.diagnostic=diagnostic;
    }
    const latest=attempts.at(-1);
    const acceptance=latest?.acceptance||null;
    const verification=latest?.verification||null;
    const retirement=binding.retirements?.[task.id]||null;
    const hostTurn=worker?.hostTurn?{state:worker.hostTurn.state||'unverified',turnId:worker.hostTurn.turnId||null,watch:worker.hostWatch||null}:null;
    const stop=stopView(worker,latest?.status||null);
    tasks.push({
      id:task.id,title:String(task.title||''),memberId:owned.member.id,
      status:taskStatusView(task,attempts,worker,alive),
      sessionId:latest?.sessionId||null,
      reason:text(task.harness?.blocker?.summary)||text(task.harness?.blocker?.title)||null,
      attempts,acceptance,verification,retirement,stop,hostTurn,
    });
    cursorParts.push({id:task.id,version:Number(task.version||0),status:task.status,acceptance,verification,retirement,stop,hostTurn,attempts:attempts.map(attempt=>({
      id:attempt.id,status:attempt.status,endedAt:attempt.endedAt,events:attempt.events.length,
      last:attempt.events.at(-1)?.id||null,revisions:attempt.events.map(event=>[event.id,event.revision,event.status]),usage:attempt.usage,result:attempt.result,error:attempt.error,diagnostic:attempt.diagnostic,
      acceptance:attempt.acceptance?.fingerprint||null,verification:attempt.verification?.at||null,
    })),worker:worker?{pid:worker.pid,stopRequestedAt:worker.stopRequestedAt||null,exitedAt:worker.exitedAt||null}:null});
  }
  const members=membersView(tasks);
  const usage=usageView(tasks);
  const inbox=inboxOf(tasks);
  const cursor=digest(JSON.stringify({title:binding.title,updatedAt:binding.updatedAt,parent:{id:parent.id,version:parent.version,title:parent.title,description:parent.description,status:parent.status},reviews:binding.reviews,retirements:binding.retirements,tasks:cursorParts}));
  return {
    schemaVersion:1,connected:true,observedAt:nowIso(options),
    binding:{threadId:binding.threadId,workspace:binding.workspace,projectId:binding.projectId,parentWorkId:binding.parentWorkId,title:binding.title},
    parent:{id:parent.id,title:String(parent.title||''),description:String(parent.description||''),status:String(parent.status||'unknown')},
    members,tasks,usage,inbox,cursor,
  };
}

export function compactView(view){
  return {
    schemaVersion:1,changed:true,cursor:view.cursor,observedAt:view.observedAt,binding:view.binding,usage:view.usage,inbox:view.inbox,
    members:view.members.map(member=>({id:member.id,name:member.name,executor:member.executor,model:member.model,status:member.status,currentTaskId:member.currentTaskId})),
    tasks:view.tasks.map(task=>{
      const latest=task.attempts.at(-1);
      return {id:task.id,title:task.title,memberId:task.memberId,status:task.status,reason:task.reason,
        attempts:task.attempts.length,acceptance:task.acceptance,verification:task.verification,retirement:task.retirement,stop:task.stop,hostTurn:task.hostTurn,
        latest:latest?{id:latest.id,index:latest.index,status:latest.status,sessionId:latest.sessionId,model:latest.model,actualModel:latest.actualModel,endedAt:latest.endedAt,usage:latest.usage,result:typeof latest.result==='string'?latest.result.slice(0,2000):null,resultTruncated:(latest.result?.length||0)>2000,error:latest.error,acceptance:latest.acceptance,verification:latest.verification}:null};
    }),
  };
}

async function assertConcurrencyAvailable(binding,client,options={}){
  let active=0;
  for(const taskId of binding.tasks){
    const task=await getTask(binding,taskId,client,options);
    if(task.status==='in_progress')active++;
  }
  if(active>=19)throw squadError('SQUAD_CONCURRENCY_LIMIT','当前主会话已达 19 项执行上限，请等待任务结束。');
}
async function assertWorkspaceWriteAvailable(binding,writePaths,options={}){
  const live=await liveWorkspaceWrites(binding.workspace,options);
  for(const entry of live){const conflict=writeConflict(writePaths,entry.writePaths);if(conflict)throw squadError('SQUAD_WORKSPACE_BUSY',`写入范围 ${conflict} 被任务 ${entry.taskId}（会话 ${entry.threadId}）占用。`)}
}
async function requestAttemptFromDigest(client,taskId,generation,requestId,options={}){
  if(!Number.isSafeInteger(Number(generation))||Number(generation)<1)return null;
  const digest=await client.operate('work.execution.digest',{workId:taskId,generation:Number(generation)},{
    ...defaultClientOptions({...options,defaultWorkspace:options.defaultWorkspace}),
  });
  const events=(digest?.events||[]).map(item=>item?.event||item);
  const ref=refFromEvents(events,Number(generation));
  return ref&&ref.requestId===requestId?ref:null;
}

/**
 * Duplicate intake is answered from the binding's bound attempts, then from the
 * persistent task identity index. Missing refs recover only the target task's
 * current generation, never the whole session history.
 */
async function findRequestAttempt(binding,requestId,client,options={}){
  for(const taskId of binding.tasks){
    const direct=(binding.attempts[taskId]||[]).find(ref=>ref?.requestId===requestId);
    if(direct)return {taskId,ref:direct};
  }
  if(!options.memberId)return null;
  const found=await client.operate('work.find',{
    sourceType,sourceRef:taskSourceRef(binding,options.memberId,requestId),
  },defaultClientOptions({...options,defaultWorkspace:binding.workspace}));
  const task=found?.task;
  if(!task?.id)return null;
  assertTaskOwned(binding,task);
  const direct=(binding.attempts[task.id]||[]).find(ref=>ref?.requestId===requestId);
  if(direct)return {taskId:task.id,ref:direct};
  const ref=await requestAttemptFromDigest(client,task.id,Number(task.harness?.activeGeneration||0),requestId,options);
  return ref?{taskId:task.id,ref}:null;
}
async function duplicateResult(binding,client,match,options={}){
  const task=await getTask(binding,match.taskId,client,options);
  let status=String(task.status||'unknown');
  if(task.status==='in_progress'){
    const refs=binding.attempts[match.taskId]||[];
    const worker=binding.workers[match.taskId]||refs.at(-1)?.worker||null;
    status=await workerAlive(worker,options)?(worker?.stopRequestedAt?'stopping':'running'):'unknown';
  }else if(task.status==='in_review')status='waiting_review';
  return {accepted:true,duplicate:true,taskId:match.taskId,attemptId:match.ref.attemptId,index:match.ref.index,status};
}

async function claimGeneration(binding,task,client,options={}){
  const scan=await client.reserveExecution({manual:true,cardId:task.id,projectId:binding.projectId});
  const claim=(scan?.claims||[]).find(item=>String(item.cardId)===task.id);
  if(!claim){
    const skipped=(scan?.skipped||[]).map(item=>item.reason).filter(Boolean).join('、');
    throw squadError('SQUAD_SCHEDULER_UNAVAILABLE',`小队存储 没有分配执行代次${skipped?`（${skipped}）`:''}。`);
  }
  const dispatched=await client.startExecution(claim.claimKey);
  const context=dispatched?.context;
  if(!context||Number(context.version)!==1||!context.storeInstanceId||!Number.isSafeInteger(Number(context.generation))){
    await client.failExecution?.(claim.claimKey,'调度上下文不完整');
    throw squadError('SQUAD_SCHEDULER_CONTEXT_INVALID','小队存储 返回的调度上下文不完整。');
  }
  if(resolve(String(context.worktreePath||''))!==resolve(binding.workspace)){
    await client.failExecution?.(claim.claimKey,'工作目录与小队绑定不一致');
    throw squadError('SQUAD_WORKSPACE_MISMATCH','小队存储 分配的工作目录与小队绑定不一致。');
  }
  return {claimKey:claim.claimKey,context};
}

export async function appendSquadEvent(client,{taskId,generation,sessionId,sequence,type,attemptId,entityId,payload={}}){
  const at=nowIso();
  const event={
    schemaVersion:'agent-bridge.conversation/v1',
    eventId:`squad:${type.toLowerCase()}:${taskId}:${attemptId||'task'}:${sequence}`,
    sessionId,runId:`${sessionId}:${generation}`,sequence,
    entityId:entityId||`squad:${attemptId||taskId}:${sequence}`,entityRevision:1,
    type,operation:'APPEND',occurredAt:at,origin:{providerId:'codex-squad'},payload,
  };
  return client.appendExecutionEvent(taskId,{
    generation,sequence,sessionId,providerId:'codex-squad',event,createdAt:at,
    ...(payload.nativeSessionId?{nativeSessionId:String(payload.nativeSessionId).slice(0,256)}:{}),
  });
}

export async function finalizeAttempt(client,{taskId,generation,storeInstanceId,executor,sessionId,eventKind,eventSequence,errorSummary,outcomeSummary,turnId,nativeSessionId,occurredAt}){
  const context={version:1,storeInstanceId,cardId:taskId,generation:Number(generation),executor};
  const event={
    version:1,sessionId,eventSequence:Number(eventSequence),eventKind,
    occurredAt:occurredAt||nowIso(),
    ...(uuidPattern.test(String(nativeSessionId||''))?{codexThreadId:String(nativeSessionId)}:{}),
    ...(turnId?{turnId:String(turnId)}:{}),
    ...(errorSummary?{errorSummary:String(errorSummary).slice(0,2000)}:{}),
    ...(outcomeSummary?{outcomeSummary:String(outcomeSummary).slice(0,16000)}:{}),
  };
  const applied=await client.applyExecutionOutcome(context,event);
  if(applied?.applied===true||applied?.duplicate===true)return applied;
  throw squadError('SQUAD_TERMINAL_NOT_APPLIED',applied?.stale?'小队存储 判定该终态属于过期执行代次。':'小队存储 未确认成员终态。');
}

async function finalizeFailure(client,binding,{taskId,generation,storeInstanceId,sessionId,executor,sequence,attemptId,error}){
  try{
    await appendSquadEvent(client,{
      taskId,generation,sessionId,sequence,type:'SQUAD_ATTEMPT_COMPLETED',attemptId:attemptId||null,
      payload:{attemptId:attemptId||null,status:'failed',error:String(error),endedAt:nowIso()},
    });
  }catch{}
  try{
    await finalizeAttempt(client,{
      taskId,generation,storeInstanceId,executor,sessionId,eventKind:'failed',
      eventSequence:sequence,errorSummary:String(error),
    });
  }catch{}
}

async function startAttempt({binding,task,member,handoff,client,options,generationContext,claimKey,resumedFrom,nativeSessionId,firstAttempt,hostLink}){
  const generation=Number(generationContext.generation);
  // 小队存储 sequences are unique across all generations of one envelope session.
  // A run gets its own envelope; nativeSessionId still preserves executor continuity.
  const sessionId=`squad-run-${task.id}-${generation}`;
  let sequence=1;
  let attemptId=null;
  let index=null;
  let worker=null;
  let workspaceRegistered=false;
  try{
    const execution=await readGeneration(client,task.id,generation,{...options,defaultWorkspace:binding.workspace});
    const existing=refFromEvents(execution?.events,generation);
    if(existing){
      mergeReferences(binding,task,[existing],options);
      await writeBinding(binding,options);
      return duplicateResult(binding,client,{taskId:task.id,ref:existing},options);
    }
    const refs=binding.attempts[task.id]||[];
    index=Math.max(0,...refs.map(ref=>Number(ref.index)||0))+1;
    attemptId=`att-${index}-${digest(handoff.requestId).slice(0,10)}`;
    sequence=Number(execution?.highWaterSequence||0)+1;
    if(firstAttempt){
      await appendSquadEvent(client,{
        taskId:task.id,generation,sessionId,sequence,type:'SQUAD_TASK_DECLARED',attemptId,
        payload:{taskId:task.id,memberId:member.id,title:handoff.title,goal:handoff.goal,scope:handoff.scope,criteria:handoff.criteria,context:handoff.context,writePaths:handoff.writePaths,requestId:handoff.requestId,
          ...(handoff.reason?{reason:handoff.reason}:{})},
      });
      sequence+=1;
    }
    const startedAt=nowIso(options);
    await appendSquadEvent(client,{
      taskId:task.id,generation,sessionId,sequence,type:'SQUAD_ATTEMPT_STARTED',attemptId,
      payload:{attemptId,index,requestId:handoff.requestId,memberId:member.id,model:member.model,resumedFrom,startedAt,
        ...(nativeSessionId?{nativeSessionId}:{}),handoff:{goal:handoff.goal,scope:handoff.scope,criteria:handoff.criteria,context:handoff.context,writePaths:handoff.writePaths,
          ...(handoff.reason?{reason:handoff.reason}:{})}},
    });
    sequence+=1;
    const persisted=await readGeneration(client,task.id,generation,{...options,defaultWorkspace:binding.workspace});
    if(!persisted.events.some(event=>event.type==='SQUAD_ATTEMPT_STARTED'&&event.payload?.attemptId===attemptId))throw squadError('SQUAD_ATTEMPT_RECEIPT_MISSING','小队存储 未保留本次交接，停止启动成员以免产生不可追溯消耗。');
    const nonce=randomUUID();
    const job={
      version:1,threadId:binding.threadId,taskId:task.id,attemptId,attemptIndex:index,requestId:handoff.requestId,
      memberId:member.id,memberName:member.name,executor:member.executor,model:member.model,
      workspace:binding.workspace,generation,storeInstanceId:generationContext.storeInstanceId,sessionId,
      claimKey:claimKey||null,
      nativeSessionId:nativeSessionId||null,resumedFrom,nextSequence:sequence,nonce,
      hostTurnState:hostLink?.state||'unverified',hostTurnId:hostLink?.turnId||null,hostRolloutPath:hostLink?.rolloutPath||null,
      hostRolloutOffset:hostLink?.state==='linked'?hostLink.offset??null:null,
      handoff:{title:handoff.title,goal:handoff.goal,scope:handoff.scope,criteria:handoff.criteria,context:handoff.context,writePaths:handoff.writePaths,reason:handoff.reason},
    };
    const started=await (async()=>{
      // Dispatch-time orphan check is throttled in-process; it never scans by process name.
      await sweepOrphanedAcp({home:dataRoot(options)}).catch(()=>{});
      return startWorker(job,{binding,options});
    })();
    worker={pid:Number(started.pid),nonce,startedAt,hostTurn:hostTurnView(hostLink)};
    if(!member.readOnly){
      await addWorkspaceWrite(binding.workspace,{threadId:binding.threadId,taskId:task.id,attemptId,pid:worker.pid,nonce,startedAt,writePaths:handoff.writePaths},options);
      workspaceRegistered=true;
    }
    mergeReferences(binding,task,[{attemptId,index,generation,requestId:handoff.requestId,resumedFrom,startedAt,nativeSessionId:nativeSessionId||null,writePaths:handoff.writePaths,worker}],options);
    binding.workers[task.id]=worker;
    await writeBinding(binding,options);
  }catch(error){
    if(worker){try{if(options.terminate)options.terminate(worker.pid);else await requestWorkerStop(worker.nonce,options)}catch{}}
    if(workspaceRegistered)await removeWorkspaceWrite({workspace:binding.workspace,threadId:binding.threadId,taskId:task.id,attemptId},options).catch(()=>{});
    await finalizeFailure(client,binding,{taskId:task.id,generation,storeInstanceId:generationContext.storeInstanceId,sessionId,executor:member.executor,sequence,attemptId,error:`成员执行启动失败：${error.message}`});
    if(claimKey)await client.failExecution?.(claimKey,String(error?.message||error)).catch(()=>{});
    throw error?.code?error:squadError('SQUAD_WORKER_START_FAILED','成员执行未能启动。',error);
  }
  return {accepted:true,duplicate:false,taskId:task.id,attemptId,index,status:'starting',generation,hostTurn:hostTurnView(hostLink)};
}

export async function dispatch(input,options={}){
  const handoff=validateDispatchInput(input);
  const member=memberById(handoff.memberId);
  let binding=await requireBinding(options);
  const client=await localClient({...options,defaultWorkspace:binding.workspace});
  const early=await findRequestAttempt(binding,handoff.requestId,client,{...options,memberId:member.id});
  if(early)return duplicateResult(binding,client,early,options);
  handoff.writePaths=await normalizeWritePaths(binding.workspace,handoff.writePaths);
  await verifyMemberModel(member,binding.workspace,options);
  const hostLink=await hostTurnLink(binding,options);
  return withAdmissionLock(()=>withBindingLock(binding.threadId,async()=>{
    binding=await requireBinding(options);
    const duplicate=await findRequestAttempt(binding,handoff.requestId,client,{...options,memberId:member.id});
    if(duplicate)return duplicateResult(binding,client,duplicate,options);
    await assertConcurrencyAvailable(binding,client,options);
    if(!member.readOnly)await assertWorkspaceWriteAvailable(binding,handoff.writePaths,options);
    const created=await client.operate('work.create',{
      projectId:binding.projectId,title:handoff.title,description:handoff.goal,status:'todo',
      labels:['codex-squad',`codex-squad-${member.id}`],sourceType,sourceRef:taskSourceRef(binding,member.id,handoff.requestId),
      workingCopyId:`wc_${digest(resolve(binding.workspace)).slice(0,24)}`,
    },{...defaultClientOptions({...options,defaultWorkspace:binding.workspace}),resolveWorkingCopyPath:async()=>binding.workspace});
    const task=created?.task;
    if(!task?.id)throw squadError('SQUAD_TASK_CREATE_FAILED','小队存储 未返回成员任务。');
    assertTaskOwned(binding,task);
    const refs=await collectTaskReferences(binding,task,client,options);
    if(refs.refs.length){
      mergeReferences(binding,task,refs.refs,options);
      await writeBinding(binding,options);
      return duplicateResult(binding,client,{taskId:task.id,ref:refs.refs.at(-1)},options);
    }
    if(String(task.status)!=='todo'){
      if(String(task.status)==='backlog'){
        const updated=await client.operate('work.update',{workId:task.id,expectedVersion:task.version,status:'todo'},
          defaultClientOptions({...options,defaultWorkspace:binding.workspace}));
        if(!updated?.task)throw squadError('SQUAD_TASK_UPDATE_FAILED','无法把成员任务移入待执行。');
      }else throw squadError('SQUAD_TASK_NOT_DISPATCHABLE',`成员任务状态为 ${task.status}，不能重新派发。`);
    }
    await client.operate('work.agent.save',{
      workId:task.id,executor:member.executor,model:member.model,approvalMode:'auto',
    },defaultClientOptions({...options,defaultWorkspace:binding.workspace}));
    const claimed=await claimGeneration(binding,{...task,status:'todo'},client,options);
    return startAttempt({binding,task,member,handoff,client,options,generationContext:claimed.context,claimKey:claimed.claimKey,resumedFrom:null,nativeSessionId:null,firstAttempt:true,hostLink});
  },options),options);
}

export async function continueTask(input,options={}){
  const request=validateContinueInput(input);
  let binding=await requireBinding(options);
  const hostLink=await hostTurnLink(binding,options);
  for(let attempt=0;attempt<2;attempt+=1){
    const task=await (async()=>{
      const client=await localClient({...options,defaultWorkspace:binding.workspace});
      return getTask(binding,request.taskId,client,options);
    })();
    const owner=memberFromTask(binding,task);
    if(!owner)throw squadError('SQUAD_BINDING_TASK_MISMATCH','任务不属于当前会话的小队。');
    const member=owner.member;
    assertExecutable(member);
    if(member.readOnly&&!request.reason)throw squadError('SQUAD_REASON_REQUIRED','检查成员的续接必须说明独立检查的原因。');
    if(binding.retirements?.[task.id])throw squadError('SQUAD_TASK_RETIRED','任务已记录不再继续，不能续接。');
    if(task.status==='in_progress')throw squadError('SQUAD_TASK_RUNNING','任务仍在执行，不能同时续接。');
    const client=await localClient({...options,defaultWorkspace:binding.workspace});
    const {refs}=await collectTaskReferences(binding,task,client,options);
    const duplicate=refs.find(ref=>ref.requestId===request.requestId);
    if(duplicate)return duplicateResult(binding,client,{taskId:task.id,ref:duplicate},options);
    const latest=refs.at(-1);
    if(!latest)throw squadError('SQUAD_ATTEMPT_MISSING','任务没有可续接的执行尝试。');
    if(!latest.nativeSessionId){
      const completed=await readGeneration(client,task.id,latest.generation,{...options,defaultWorkspace:binding.workspace});
      latest.nativeSessionId=[...(completed?.events||[])].reverse().find(event=>event?.type==='SQUAD_ATTEMPT_COMPLETED')?.payload?.nativeSessionId
        ||[...(completed?.events||[])].reverse().find(event=>event?.type==='SQUAD_ATTEMPT_SESSION')?.payload?.sessionId||null;
    }
    if(!latest.nativeSessionId)throw squadError('SQUAD_NATIVE_SESSION_UNAVAILABLE','原执行会话不可恢复，不能把新建会话写成成功续接。');
    await verifyMemberModel(member,binding.workspace,options);
    const handoff={...request,title:task.title,memberId:member.id,reason:request.reason,writePaths:await normalizeWritePaths(binding.workspace,request.writePaths===undefined?latest.writePaths:request.writePaths)};
    return withAdmissionLock(()=>withBindingLock(binding.threadId,async()=>{
      binding=await requireBinding(options);
      const current=await getTask(binding,task.id,client,options);
      if(binding.retirements?.[task.id])throw squadError('SQUAD_TASK_RETIRED','任务已记录不再继续，不能续接。');
      if(current.status==='in_progress')throw squadError('SQUAD_TASK_RUNNING','任务仍在执行，不能同时续接。');
      const duplicateRef=(binding.attempts[current.id]||[]).find(ref=>ref?.requestId===request.requestId)
        ||await requestAttemptFromDigest(client,current.id,Number(current.harness?.activeGeneration||0),request.requestId,{...options,defaultWorkspace:binding.workspace});
      if(duplicateRef)return duplicateResult(binding,client,{taskId:current.id,ref:duplicateRef},options);
      await assertConcurrencyAvailable(binding,client,options);
      if(!member.readOnly)await assertWorkspaceWriteAvailable(binding,handoff.writePaths,options);
      if(current.status!=='todo'){
        await client.operate('work.update',{workId:current.id,expectedVersion:current.version,status:'todo'},
          defaultClientOptions({...options,defaultWorkspace:binding.workspace}));
      }
      const claimed=await claimGeneration(binding,{...current,status:'todo'},client,options);
      return startAttempt({binding,task:current,member,handoff,client,options,generationContext:claimed.context,claimKey:claimed.claimKey,
        resumedFrom:latest.attemptId,nativeSessionId:latest.nativeSessionId,firstAttempt:false,hostLink});
    },options),options);
  }
  throw squadError('SQUAD_CONTINUE_CONFLICT','任务状态在续接过程中发生变化，请重新读取快照。');
}

function latestAttempt(binding,taskId){return (binding.attempts[taskId]||[]).slice().sort((left,right)=>Number(left.index)-Number(right.index)).at(-1)||null;}
function findAttemptEvent(execution,attemptId,type){
  return [...(execution?.events||[])].reverse().find(event=>event?.type===type&&(!attemptId||String(event.payload?.attemptId||'')===attemptId))||null;
}

export function stopView(worker,terminal=null){
  if(!worker?.stopRequestedAt)return null;
  const state=['stopped','interrupted'].includes(terminal)?'stopped':['starting','running','in_progress','stopping'].includes(terminal)?'stopping':'unconfirmed';
  return {state,requestedAt:worker.stopRequestedAt,reason:worker.stopReason||null,source:worker.stopSource||null,
    hostTurnId:worker.hostTurnId||worker.hostTurn?.turnId||null,association:worker.hostTurn?.state||null,terminal,
    ...(worker.turnAbort?{turnAbort:worker.turnAbort}:{})};
}
async function latestTerminalStatus(client,binding,task,ref,options={}){
  const fallback=String(task.status||'unknown');
  if(!ref)return fallback;
  try{
    const execution=await readGeneration(client,task.id,ref.generation,{...options,defaultWorkspace:binding.workspace});
    const completed=findAttemptEvent(execution,ref.attemptId,'SQUAD_ATTEMPT_COMPLETED');
    return completed?String(completed.payload?.status||fallback).toLowerCase():fallback;
  }catch{return fallback}
}

export async function stopTask(input,options={}){
  assertKnown(input,['taskId','reason']);
  const taskId=requiredText(input.taskId,'taskId',160);
  const reason=requiredText(input.reason,'reason',500);
  const binding=await requireBinding(options);
  const client=await localClient({...options,defaultWorkspace:binding.workspace});
  const task=await getTask(binding,taskId,client,options);
  const ref=latestAttempt(binding,taskId);
  const worker=binding.workers[taskId]||ref?.worker||null;
  if(task.status!=='in_progress'){
    const status=await latestTerminalStatus(client,binding,task,ref,options);
    return {taskId,attemptId:ref?.attemptId||null,stopped:false,status,reason:'任务当前没有执行中的成员进程。',stop:stopView(worker,status)};
  }
  if(!worker?.pid){
    return {taskId,attemptId:ref?.attemptId||null,stopped:false,status:'unknown',reason:'缺少可核实的执行进程 PID，无法确认停止。',stop:stopView(worker)};
  }
  if(!(await workerAlive(worker,options))){
    return {taskId,attemptId:ref?.attemptId||null,stopped:false,status:'unknown',reason:'执行进程已不可核实，无法确认停止。',stop:stopView(worker)};
  }
  await updateBinding(binding.threadId,fresh=>{
    const current=fresh.workers[taskId]||worker;
    fresh.workers[taskId]={...current,stopRequestedAt:current.stopRequestedAt||nowIso(options),stopReason:current.stopReason||reason,stopSource:current.stopSource||'manual'};
  },options);
  try{if(options.terminate)options.terminate(worker.pid);else await requestWorkerStop(worker.nonce,options);}
  catch{
    return {taskId,attemptId:ref?.attemptId||null,stopped:false,status:'unknown',reason:'停止信号未能送达执行进程。',stop:stopView(worker)};
  }
  const timeout=Math.max(1000,Math.min(30000,Number(options.stopTimeoutMs)||15000));
  const deadline=Date.now()+timeout;
  let deadSince=0;
  while(Date.now()<deadline){
    await (options.sleep||delay)(200).catch(()=>{});
    const current=await readBinding(binding.threadId,options);
    const currentWorker=current?.workers?.[taskId]||worker;
    const execution=await readGeneration(client,taskId,ref?.generation||Number(task.harness?.activeGeneration||0),{...options,defaultWorkspace:binding.workspace});
    const completed=findAttemptEvent(execution,ref?.attemptId,'SQUAD_ATTEMPT_COMPLETED');
    if(completed){
      const status=String(completed.payload?.status||'unknown').toLowerCase();
      return {taskId,attemptId:ref?.attemptId||null,stopped:['stopped','interrupted'].includes(status),status,
        reason:['stopped','interrupted'].includes(status)?reason:'执行器在停止请求后返回了其他终态。',
        endedAt:completed.payload?.endedAt||completed.occurredAt||null,exitCode:currentWorker?.exitCode??null,stop:stopView(currentWorker,status)};
    }
    const alive=await workerAlive(currentWorker,options);
    if(!alive){
      deadSince=deadSince||Date.now();
      if(Date.now()-deadSince>1000)return {taskId,attemptId:ref?.attemptId||null,stopped:false,status:'unknown',reason:'执行进程已退出，但未收到执行器终止回执。',exitCode:currentWorker?.exitCode??null,stop:stopView(currentWorker,'unknown')};
    }
  }
  return {taskId,attemptId:ref?.attemptId||null,stopped:false,status:'stopping',reason:'已发送停止请求，执行器尚未返回终止回执。',stop:stopView(worker,'stopping')};
}

export async function acceptTask(input,options={}){
  assertKnown(input,['taskId','files','note']);
  const taskId=requiredText(input.taskId,'taskId',160);
  const note=input.note===undefined?'':String(input.note);
  if(note.length>2000)throw squadError('SQUAD_INPUT_INVALID','note 不能超过 2000 个字符。');
  const binding=await requireBinding(options);
  if(binding.retirements?.[taskId])throw squadError('SQUAD_TASK_RETIRED','任务已记录不再继续，不能记录验收。');
  const candidate=await fingerprintCandidate(binding.workspace,input.files);
  const client=await localClient({...options,defaultWorkspace:binding.workspace});
  const task=await getTask(binding,taskId,client,options);
  const {refs,executions}=await collectTaskReferences(binding,task,client,options);
  const latest=refs.at(-1);
  if(!latest)throw squadError('SQUAD_ACCEPTANCE_NOT_READY','任务没有可验收的成员返回。');
  const execution=executions.get(latest.generation);
  const completed=findAttemptEvent(execution,latest.attemptId,'SQUAD_ATTEMPT_COMPLETED');
  if(String(completed?.payload?.status||'')!=='completed'||task.status!=='in_review'){
    throw squadError('SQUAD_ACCEPTANCE_NOT_READY','只有已返回且等待负责人验收的任务才能记录验收。');
  }
  const verification=binding.reviews?.[taskId]?.[latest.attemptId]||null;
  if(!verification)throw squadError('SQUAD_VERIFICATION_REQUIRED','请先用 verify 记录本轮负责人核验，再记录验收。');
  const worker=binding.workers[taskId]||null;
  if(await workerAlive(worker,options))throw squadError('SQUAD_ACCEPTANCE_NOT_READY','成员进程仍在运行，不能记录验收。');
  const existing=acceptanceFrom(execution);
  if(existing?.attemptId===latest.attemptId&&existing.fingerprint===candidate.fingerprint){
    return {taskId,accepted:true,duplicate:true,acceptance:{fingerprint:existing.fingerprint,note:existing.note,at:existing.at},verification:{at:verification.at}};
  }
  const sessionId=String(execution?.activeSessionId||latest.nativeSessionId||'');
  if(!sessionId)throw squadError('SQUAD_ACCEPTANCE_NOT_READY','缺少可写入验收记录的执行会话。');
  const sequence=Number(execution?.highWaterSequence||0)+1;
  const at=nowIso(options);
  await appendSquadEvent(client,{
    taskId,generation:latest.generation,sessionId,sequence,type:'SQUAD_ACCEPTANCE',attemptId:latest.attemptId,
    payload:{attemptId:latest.attemptId,index:latest.index,...candidate,note,at,verificationAt:verification.at},
  });
  return {taskId,accepted:true,duplicate:false,acceptance:{...candidate,note,at},verification:{at:verification.at}};
}

export async function verifyTask(input,options={}){
  assertKnown(input,['taskId']);
  const taskId=requiredText(input.taskId,'taskId',160);
  const binding=await requireBinding(options);
  if(binding.retirements?.[taskId])throw squadError('SQUAD_TASK_RETIRED','任务已记录不再继续，不能登记核验。');
  const client=await localClient({...options,defaultWorkspace:binding.workspace});
  const task=await getTask(binding,taskId,client,options);
  const {refs,executions}=await collectTaskReferences(binding,task,client,options);
  const latest=refs.at(-1);
  if(!latest)throw squadError('SQUAD_VERIFICATION_NOT_READY','任务没有可核验的成员返回。');
  const execution=executions.get(latest.generation);
  const completed=findAttemptEvent(execution,latest.attemptId,'SQUAD_ATTEMPT_COMPLETED');
  if(String(completed?.payload?.status||'')!=='completed'){
    throw squadError('SQUAD_VERIFICATION_NOT_READY','只有已返回的成员结果才能登记负责人核验。');
  }
  const worker=binding.workers[taskId]||latest.worker||null;
  if(await workerAlive(worker,options))throw squadError('SQUAD_VERIFICATION_NOT_READY','成员进程仍在运行，不能登记核验。');
  const at=nowIso(options);
  let duplicate=false;
  const updated=await updateBinding(binding.threadId,fresh=>{
    if(fresh.reviews?.[taskId]?.[latest.attemptId]){duplicate=true;return;}
    fresh.reviews=fresh.reviews||{};
    fresh.reviews[taskId]={...(fresh.reviews[taskId]||{}),[latest.attemptId]:{
      attemptId:latest.attemptId,index:latest.index,generation:latest.generation,
      sessionId:String(completed?.payload?.nativeSessionId||latest.nativeSessionId||'')||null,at,
    }};
  },options);
  const record=updated.reviews?.[taskId]?.[latest.attemptId]||null;
  if(!record)throw squadError('SQUAD_VERIFICATION_NOT_READY','小队未能保留本轮核验记录。');
  return {taskId,attemptId:latest.attemptId,attemptIndex:latest.index,generation:latest.generation,
    verified:true,duplicate,phase:'verifying',verifiedAt:record.at};
}

export async function retireTask(input,options={}){
  assertKnown(input,['taskId','outcome','reason','replacedBy']);
  const taskId=requiredText(input.taskId,'taskId',160);
  const outcome=requiredText(input.outcome,'outcome',32);
  if(!RETIREMENT_OUTCOMES.includes(outcome))throw squadError('SQUAD_RETIREMENT_OUTCOME_INVALID','outcome 只能是 cancelled 或 superseded。');
  const reason=requiredText(input.reason,'reason',2000);
  const replacedBy=input.replacedBy===undefined?null:requiredText(input.replacedBy,'replacedBy',200);
  const initial=await requireBinding(options);
  return withBindingLock(initial.threadId,async()=>{
    const binding=await requireBinding(options);
    const existing=binding.retirements?.[taskId];
    if(existing){
      if(existing.outcome===outcome&&existing.reason===reason&&(existing.replacedBy||null)===replacedBy){
        return {taskId,retired:true,duplicate:true,outcome,reason,replacedBy,status:outcome,attemptId:existing.attemptId||null,at:existing.at||null};
      }
      throw squadError('SQUAD_TASK_RETIRED','任务已记录不再继续，不能改成其他处置。');
    }
    const client=await localClient({...options,defaultWorkspace:binding.workspace});
    const task=await getTask(binding,taskId,client,options);
    const {refs,executions}=await collectTaskReferences(binding,task,client,options);
    const latest=refs.at(-1);
    const worker=binding.workers?.[taskId]||latest?.worker||null;
    if(await workerAlive(worker,options))throw squadError('SQUAD_TASK_RUNNING','成员进程仍在运行，请先停止并取得真实终止回执。');
    const execution=latest?executions.get(latest.generation):null;
    const completed=latest?findAttemptEvent(execution,latest.attemptId,'SQUAD_ATTEMPT_COMPLETED'):null;
    const attemptStatus=String(completed?.payload?.status||'').toLowerCase();
    const acceptance=latest?acceptanceFrom(execution):null;
    if(acceptance&&acceptance.attemptId===latest.attemptId)throw squadError('SQUAD_TASK_ACCEPTED','已记录验收的任务不能取消或替代。');
    if(!completed&&['in_progress','unknown'].includes(String(task.status||'unknown').toLowerCase())){
      throw squadError('SQUAD_STOP_NOT_CONFIRMED','任务仍在执行或进程状态未知，取得真实终止回执前不能记录取消或替代。');
    }
    const at=nowIso(options);
    const record={outcome,reason,replacedBy,at,
      attemptId:latest?.attemptId||null,index:latest?.index??null,generation:latest?.generation??null,
      taskStatus:String(task.status||'unknown'),attemptStatus:attemptStatus||null};
    binding.retirements=binding.retirements||{};
    binding.retirements[taskId]=record;
    await writeBinding(binding,options);
    const saved=record;
    return {taskId,retired:true,duplicate:false,outcome,reason,replacedBy,status:outcome,
      attemptId:saved.attemptId||null,at:saved.at||at};
  },options);
}

export function normalizeUsage(value){
  if(!isRecord(value))return null;
  const token=item=>{
    return typeof item==='number'&&Number.isFinite(item)&&item>=0?Math.trunc(item):null;
  };
  const inputTokens=token(value.inputTokens??value.input_tokens??value.promptTokens??value.prompt_tokens);
  const outputTokens=token(value.outputTokens??value.output_tokens??value.completionTokens??value.completion_tokens);
  const cachedInputTokens=token(value.cachedInputTokens??value.cached_input_tokens??value.cacheReadInputTokens??value.cache_read_input_tokens??value.cachedTokens??value.cached_tokens);
  const explicitTotal=token(value.totalTokens??value.total_tokens);
  const totalTokens=explicitTotal??(inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:null);
  if(inputTokens===null&&outputTokens===null&&cachedInputTokens===null&&totalTokens===null)return null;
  return {inputTokens,outputTokens,cachedInputTokens,totalTokens};
}

export {workerPath};
