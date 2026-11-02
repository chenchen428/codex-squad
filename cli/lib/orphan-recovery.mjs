import {listWorkerReceipts,markAcpExited,recordReclaim} from './worker-control.mjs';
import {readProcessIdentity,sameProcessIdentity,verifiableIdentity} from './qoder/process-identity.mjs';
import {dataRoot} from './storage-paths.mjs';

export const ORPHAN_SWEEP_INTERVAL_MS=5*60*1000;
const sweeps=new Map(),lastSweeps=new Map();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function groupExists(pgid){
  try{process.kill(-pgid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}
}
async function identity(read,pid){
  try{return await read(pid)}catch{return {supported:false,reason:'identity_read_failed'}}
}
async function ownerState(value,read){
  if(!verifiableIdentity(value.identity))return {state:'unknown',reason:'worker_identity_missing'};
  const current=await identity(read,value.pid);
  if(current===null)return {state:'dead',reason:'worker_not_found'};
  if(!verifiableIdentity(current))return {state:'unknown',reason:'worker_identity_unavailable'};
  return sameProcessIdentity(value.identity,current)?{state:'alive',reason:'worker_alive'}:{state:'reused',reason:'worker_identity_changed'};
}
/** Revalidate the owner and ACP immediately before every signal, including escalation. */
async function guard(value,nonce,read,exists){
  const acp=value.acp;
  if(value.nonce!==nonce||acp.ownerNonce!==nonce||acp.ownerPid!==value.pid)return {state:'unknown',reason:'acp_ownership_missing'};
  const owner=await ownerState(value,read);
  if(owner.state==='alive'||owner.state==='unknown')return owner;
  const current=await identity(read,acp.pid);
  if(current===null){
    try{return exists(acp.pgid)?{state:'unknown',reason:'leader_missing_group_alive'}:{state:'gone',reason:'already_exited'}}
    catch{return {state:'unknown',reason:'process_group_unavailable'}}
  }
  if(!verifiableIdentity(current))return {state:'unknown',reason:'acp_identity_unavailable'};
  if(!sameProcessIdentity(acp.identity,current))return {state:'unknown',reason:'acp_identity_mismatch'};
  if(current.pgid!==acp.pgid||acp.pgid!==acp.pid)return {state:'unknown',reason:'acp_pgid_mismatch'};
  if(current.ppid!==1&&current.ppid!==value.pid)return {state:'unknown',reason:'acp_owned_by_another_process'};
  if(current.ppid===value.pid&&owner.state==='reused')return {state:'unknown',reason:'acp_owner_ambiguous'};
  return {state:'owned',reason:owner.reason};
}
async function waitGone(value,read,exists,milliseconds,clock){
  const deadline=clock()+Math.max(0,milliseconds);
  for(;;){
    const current=await identity(read,value.acp.pid);
    if(current===null){
      try{return exists(value.acp.pgid)?{state:'unknown',reason:'leader_missing_group_alive'}:{state:'gone'}}
      catch{return {state:'unknown',reason:'process_group_unavailable'}}
    }
    if(!verifiableIdentity(current))return {state:'unknown',reason:'acp_identity_unavailable'};
    if(!sameProcessIdentity(value.acp.identity,current))return {state:'unknown',reason:'acp_identity_mismatch'};
    if(clock()>=deadline)return {state:'waiting'};
    await delay(40);
  }
}
export async function reclaimOrphanedAcp({
  home,readIdentity=readProcessIdentity,graceMs=1500,forceMs=2000,
  sendSignal=(pgid,signal)=>process.kill(-pgid,signal),processGroupExists=groupExists,clock=()=>performance.now(),
}={}){
  const report={scanned:0,reclaimed:[],skipped:[]};
  const receipts=await listWorkerReceipts({home});
  for(const {nonce,value} of receipts){
    report.scanned++;
    if(!value?.acp||value.acp.exited===true)continue;
    const acp=value.acp;
    if(!Number.isSafeInteger(acp.pid)||acp.pid<=1||acp.pid===process.pid||!Number.isSafeInteger(acp.pgid)){
      report.skipped.push({nonce,reason:'acp_pid_invalid'});continue;
    }
    let check=await guard(value,nonce,readIdentity,processGroupExists);
    if(check.state!=='owned'&&check.state!=='gone'){report.skipped.push({nonce,pid:acp.pid,reason:check.reason});continue}
    const reason=check.reason;
    let signal=null,forced=false;
    if(check.state!=='gone'){
      signal='SIGTERM';
      try{sendSignal(acp.pgid,signal)}catch(error){check={state:'unknown',reason:'signal_failed:'+error.code}}
      if(check.state==='owned')check=await waitGone(value,readIdentity,processGroupExists,graceMs,clock);
      if(check.state==='waiting'){
        check=await guard(value,nonce,readIdentity,processGroupExists);
        if(check.state==='owned'){
          signal='SIGKILL';forced=true;
          try{sendSignal(acp.pgid,signal);check=await waitGone(value,readIdentity,processGroupExists,forceMs,clock)}
          catch(error){check={state:'unknown',reason:'signal_failed:'+error.code}}
        }
      }
    }
    const exited=check.state==='gone';
    const result=exited?(signal?'terminated':'already_exited'):'unconfirmed';
    if(exited)await markAcpExited(nonce,{by:'reclaim',result:{exited,forced,signal}},{home});
    await recordReclaim(nonce,{result,signal,forced,reason:exited?reason:check.reason||'exit_not_confirmed',pid:acp.pid},{home});
    report.reclaimed.push({nonce,pid:acp.pid,result,signal,forced,reason:exited?reason:check.reason||'exit_not_confirmed'});
  }
  return report;
}
/** Shared runtime and dispatch reuse one in-flight sweep per data directory. */
export async function sweepOrphanedAcp(options={}){
  const key=dataRoot(options);
  if(sweeps.has(key))return sweeps.get(key);
  const now=performance.now(),interval=Number.isFinite(options.intervalMs)?options.intervalMs:ORPHAN_SWEEP_INTERVAL_MS;
  if(!options.force&&now-(lastSweeps.get(key)??-Infinity)<interval)return {skipped:true,reason:'sweep_throttled'};
  lastSweeps.set(key,now);
  const pending=reclaimOrphanedAcp(options);
  sweeps.set(key,pending);
  try{return await pending}finally{if(sweeps.get(key)===pending)sweeps.delete(key)}
}
