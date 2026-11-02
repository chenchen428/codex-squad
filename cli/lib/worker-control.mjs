import {mkdir,readFile,readdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {dataRoot} from './storage-paths.mjs';
import {readProcessIdentity,sameProcessIdentity,verifiableIdentity} from './qoder/process-identity.mjs';

const RECEIPT_NAME=/^([a-f0-9-]{36})\.json$/i;
const writeQueues=new Map();

function file(nonce,options={}){
  if(!/^[a-f0-9-]{36}$/i.test(nonce||''))throw new Error('执行进程标识无效。');
  return join(dataRoot(options),'workers',`${nonce}.json`);
}
async function save(target,value){
  const temporary=`${target}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});await rename(temporary,target);
}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
async function readReceipt(target){
  let raw;
  try{raw=await readFile(target,'utf8')}catch(error){if(error.code==='ENOENT')return null;throw error}
  try{
    const value=JSON.parse(raw);
    return isRecord(value)?value:null;
  }catch{return null}
}
/** Serializes read-merge-write per receipt so the heartbeat cannot drop a concurrent ACP record. */
function mutate(nonce,options,change){
  const target=file(nonce,options);
  const previous=writeQueues.get(target)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
    await mkdir(join(dataRoot(options),'workers'),{recursive:true,mode:0o700});
    const current=(await readReceipt(target))||{};
    const value=change(current);
    if(value===null)return current;
    await save(target,value);
    return value;
  });
  writeQueues.set(target,next);
  next.finally(()=>{if(writeQueues.get(target)===next)writeQueues.delete(target)}).catch(()=>{});
  return next;
}
async function identityOf(pid,options){
  if(options.identity!==undefined)return options.identity;
  try{return await (options.readIdentity||readProcessIdentity)(Number(pid));}catch{return null}
}

export async function registerWorker(pid,nonce,options={}){
  const target=Number(pid);
  const identity=await identityOf(target,options);
  return mutate(nonce,options,(current)=>({
    ...current,
    pid:target,
    pgid:Number.isSafeInteger(Number(current.pgid))?Number(current.pgid):target,
    nonce,
    updatedAt:Date.now(),
    exited:false,
    ...(options.taskId?{taskId:String(options.taskId)}:{}),
    ...(options.attemptId?{attemptId:String(options.attemptId)}:{}),
    ...(Number.isSafeInteger(Number(options.generation))?{generation:Number(options.generation)}:{}),
    ...(identity?{identity}:{}),
  }));
}
/** A spawned worker receives its job only after durable registration. */
export async function registerSpawnedWorker(child,nonce,options={}){
  try{return await registerWorker(child.pid,nonce,options)}catch(error){
    const exited=()=>child.exitCode!==null||child.signalCode!==null;
    const wait=milliseconds=>new Promise(resolve=>{
      if(exited())return resolve(true);
      const finish=()=>{clearTimeout(timer);child.off('exit',finish);resolve(exited())};
      const timer=setTimeout(finish,milliseconds);child.once('exit',finish);
    });
    child.stdin?.destroy();
    if(!exited())child.kill('SIGTERM');
    if(!await wait(1500)){if(!exited())child.kill('SIGKILL');await wait(1500)}
    if(!exited())throw Object.assign(new Error('Worker registration failed and exit was not confirmed',{cause:error}),{code:'SQUAD_WORKER_CLEANUP_UNCONFIRMED'});
    throw error;
  }
}
export async function recordWorkerIdentity(pid,nonce,identity,options={}){
  if(!identity)return null;
  return mutate(nonce,options,(current)=>({...current,pid:Number(pid),identity,updatedAt:Date.now()}));
}
export async function recordAcpProcess(nonce,details={},options={}){
  const pid=Number(details?.pid);
  if(!Number.isSafeInteger(pid)||pid<1)return null;
  return mutate(nonce,options,(current)=>{
    if(current.nonce!==nonce||!Number.isSafeInteger(current.pid))throw new Error('ACP owner is not registered');
    const previous=isRecord(current.acp)?current.acp:{};
    return {
      ...current,
      updatedAt:Date.now(),
      acp:{
        ...previous,
        pid,
        ownerNonce:nonce,
        ownerPid:current.pid,
        pgid:Number.isSafeInteger(Number(details.pgid))?Number(details.pgid):pid,
        recordedAt:previous.recordedAt||Date.now(),
        ...(details.executable?{executable:String(details.executable)}:{}),
        ...(details.state?{state:String(details.state)}:{}),
        ...(isRecord(details.identity)?{identity:details.identity}:{}),
        exited:false,
      },
    };
  });
}
export async function markAcpExited(nonce,details={},options={}){
  return mutate(nonce,options,(current)=>{
    if(!isRecord(current.acp))return null;
    return {
      ...current,
      updatedAt:Date.now(),
      acp:{
        ...current.acp,
        exited:details.result?.exited!==false,
        closedAt:details.at||new Date().toISOString(),
        closedBy:details.by||'worker',
        ...(details.result?{closeResult:details.result}:{}),
      },
    };
  });
}
export async function recordWorkerShutdown(nonce,details={},options={}){
  return mutate(nonce,options,(current)=>({
    ...current,
    updatedAt:Date.now(),
    lastExit:{
      at:details.at||new Date().toISOString(),
      reason:details.reason||'worker_exit',
      signal:details.signal||null,
      exitCode:Number.isSafeInteger(Number(details.exitCode))?Number(details.exitCode):null,
      ...(details.acp?{acp:details.acp}:{}),
    },
  }));
}
export async function recordReclaim(nonce,details={},options={}){
  return mutate(nonce,options,(current)=>({
    ...current,
    updatedAt:Date.now(),
    reclaim:{
      at:details.at||new Date().toISOString(),
      result:details.result||'unknown',
      signal:details.signal||null,
      forced:Boolean(details.forced),
      reason:details.reason||null,
      pid:Number.isSafeInteger(Number(details.pid))?Number(details.pid):null,
    },
    ...(isRecord(current.acp)&&['terminated','already_exited'].includes(details.result)?{acp:{...current.acp,exited:true,closedAt:details.at||new Date().toISOString(),closedBy:'reclaim'}}:{}),
  }));
}
export async function readWorkerReceipt(nonce,options={}){
  return readReceipt(file(nonce,options));
}
export async function listWorkerReceipts(options={}){
  const directory=join(dataRoot(options),'workers');
  let names;
  try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error}
  const receipts=[];
  for(const name of names){
    const match=RECEIPT_NAME.exec(name);
    if(!match)continue;
    const value=await readReceipt(join(directory,name));
    receipts.push({nonce:match[1],value});
  }
  return receipts;
}

export async function isWorkerAlive(pid,nonce,options={}){
  if(!Number.isSafeInteger(Number(pid))||Number(pid)<1)return false;
  let receipt;try{receipt=JSON.parse(await readFile(file(nonce,options),'utf8'))}catch(error){if(error.code==='ENOENT')return false;throw error}
  if(receipt.pid!==Number(pid)||receipt.nonce!==nonce||receipt.exited)return false;
  if(verifiableIdentity(receipt.identity)){
    const current=await readProcessIdentity(Number(pid));
    if(current===null)return false;
    if(verifiableIdentity(current))return sameProcessIdentity(receipt.identity,current);
  }
  try{process.kill(Number(pid),0);return true}catch(error){return error.code==='EPERM'}
}
export async function requestWorkerStop(nonce,options={}){
  await writeFile(file(nonce,options)+'.stop',JSON.stringify({nonce})+'\n',{mode:0o600});
}
export async function watchWorker(nonce,controller,options={}){
  const target=file(nonce,options);await registerWorker(process.pid,nonce,options);
  let running=false,closed=false,updated=Date.now();
  const poll=async()=>{
    if(running||closed)return;running=true;
    try{
      const request=JSON.parse(await readFile(target+'.stop','utf8').catch(error=>{if(error.code==='ENOENT')return 'null';throw error}));
      if(closed)return;
      if(request?.nonce===nonce)controller.abort();
      if(Date.now()-updated>=1000){await mutate(nonce,options,current=>({...current,updatedAt:Date.now()}));updated=Date.now()}
    }catch(error){controller.abort();process.stderr.write(`[codex-squad] 执行控制记录不可读：${error.message}\n`)}finally{running=false}
  };
  const timer=setInterval(()=>void poll(),200);timer.unref();
  return async(details={})=>{
    if(closed)return;closed=true;clearInterval(timer);
    await mutate(nonce,options,(current)=>({
      ...current,pid:process.pid,nonce,updatedAt:Date.now(),exited:true,
      ...(current.lastExit?{}:(details.reason||details.signal||details.exitCode!==undefined
        ?{lastExit:{
          at:details.at||new Date().toISOString(),reason:details.reason||'worker_exit',
          signal:details.signal||null,exitCode:Number.isSafeInteger(Number(details.exitCode))?Number(details.exitCode):null,
        }}
        :{})),
    }));
  };
}
