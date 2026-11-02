import {randomUUID} from 'node:crypto';
import {mkdir,open,readdir,readFile,rename,rm,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {dataRoot} from './storage-paths.mjs';
import {codexThreadUrl,digestJson} from './analysis-report.mjs';

const STATE_VERSION=1;
const REQUEST_LIMIT=200;
const HISTORY_LIMIT=100;

function fail(code,message){return Object.assign(new Error(message),{code})}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function nowIso(now=Date.now()){const value=now instanceof Date?now:new Date(now);return value.toISOString()}
function windowKey(days){return days===null||days===undefined?'all':String(days)}
function normalizeDays(days){
  if(days===undefined)return null;
  if(days===null||days===7||days===30)return days;
  throw fail('SQUAD_ANALYSIS_WINDOW_INVALID','分析窗口只支持 7 天、30 天或全部。');
}
export function analysisWindow(days,now=new Date()){
  const value=normalizeDays(days),to=now instanceof Date?now:new Date(now);
  if(!Number.isFinite(to.getTime()))throw fail('SQUAD_ANALYSIS_WINDOW_INVALID','分析截止时间无效。');
  return {key:windowKey(value),days:value,from:value===null?null:new Date(to.getTime()-value*86400000).toISOString(),to:to.toISOString()};
}
export function analysisPaths(home){
  const root=join(dataRoot({home}),'analysis');
  return {
    root,
    state:join(root,'state.json'),
    lock:join(root,'run.lock'),
    runs:join(root,'runs'),
    evidence:join(root,'evidence'),
    reports:join(root,'reports'),
    work:join(root,'work'),
  };
}
function emptyState(now=Date.now()){
  return {
    schemaVersion:STATE_VERSION,updatedAt:nowIso(now),currentRunId:null,
    requestIndex:{},history:[],lastSuccessfulByWindow:{},statsByWindow:{},
    schedule:{enabled:false,days:null,nextAt:null,lastManualAt:null,lastPeriodicAt:null,lastPeriodicReason:null,lastPeriodicCycle:null},
  };
}
function normalizeState(value){
  if(!isRecord(value)||value.schemaVersion!==STATE_VERSION)throw fail('SQUAD_ANALYSIS_STATE_CORRUPT','分析状态文件损坏。');
  return {
    ...emptyState(),...value,
    requestIndex:isRecord(value.requestIndex)?value.requestIndex:{},
    history:Array.isArray(value.history)?value.history:[],
    lastSuccessfulByWindow:isRecord(value.lastSuccessfulByWindow)?value.lastSuccessfulByWindow:{},
    statsByWindow:isRecord(value.statsByWindow)?value.statsByWindow:{},
    schedule:{...emptyState().schedule,...(isRecord(value.schedule)?value.schedule:{})},
  };
}
async function readJson(file,fallback=null){
  let raw;
  try{raw=await readFile(file,'utf8');}
  catch(error){if(error.code==='ENOENT')return fallback;throw error;}
  try{return JSON.parse(raw);}
  catch{throw fail('SQUAD_ANALYSIS_STATE_CORRUPT','分析状态文件损坏。')}
}
async function writeJson(file,value){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle=await open(temporary,'w',0o600);
  try{
    await handle.writeFile(`${JSON.stringify(value)}\n`,{encoding:'utf8'});
    await handle.sync();
  }finally{await handle.close()}
  try{await rename(temporary,file)}
  catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error}
}
export async function readAnalysisState({home}={}){
  return normalizeState(await readJson(analysisPaths(home).state,emptyState())||emptyState());
}
export async function writeAnalysisState(state,{home}={}){
  state.updatedAt=nowIso();
  await writeJson(analysisPaths(home).state,state);
  return state;
}
/**
 * Only the periodic scheduler calls this. A missing state file is a new
 * install and starts with the periodic plan already due; any existing state
 * keeps its persisted choice, so an explicit enabled:false stays off.
 */
export async function ensureAnalysisSchedule({home,now=new Date()}={}){
  const paths=analysisPaths(home);
  let raw;
  try{raw=await readFile(paths.state,'utf8');}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const state=emptyState(now);
    state.schedule={...state.schedule,enabled:true,days:null,nextAt:nowIso(now)};
    await writeAnalysisState(state,{home});
    return {created:true,repaired:false,schedule:state.schedule};
  }
  let value;
  try{value=JSON.parse(raw);}
  catch{throw fail('SQUAD_ANALYSIS_STATE_CORRUPT','分析状态文件损坏。')}
  const state=normalizeState(value);
  if(!state.schedule.enabled)return {created:false,repaired:false,schedule:state.schedule};
  if(Number.isFinite(Date.parse(state.schedule.nextAt||'')))return {created:false,repaired:false,schedule:state.schedule};
  state.schedule={...state.schedule,days:null,nextAt:nowIso(now)};
  await writeAnalysisState(state,{home});
  return {created:false,repaired:true,schedule:state.schedule};
}
function processAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}
}
async function lockOwner(file){
  try{
    const [raw,info]=await Promise.all([readFile(file,'utf8'),stat(file)]);
    return {pid:Number(String(raw).trim())||0,mtimeMs:info.mtimeMs};
  }catch(error){
    if(error.code==='ENOENT')return null;
    throw error;
  }
}
export async function acquireAnalysisLock({home,timeoutMs=0,now=Date.now}={}){
  const file=analysisPaths(home).lock;
  await mkdir(analysisPaths(home).root,{recursive:true,mode:0o700});
  const deadline=Date.now()+Math.max(0,Number(timeoutMs)||0);
  for(;;){
    let handle;
    try{handle=await open(file,'wx',0o600);}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const owner=await lockOwner(file);
      if(owner&&!processAlive(owner.pid)&&(owner.pid>0||Date.now()-owner.mtimeMs>60000)){
        await rm(file,{force:true});
        continue;
      }
      if(Date.now()>=deadline)throw fail('SQUAD_ANALYSIS_BUSY','另一轮小队分析正在执行，请稍后重试。');
      await delay(80);
      continue;
    }
    try{
      await handle.writeFile(`${process.pid}\n`);
      let released=false;
      return {
        pid:process.pid,
        async release(){
          if(released)return;
          released=true;
          await handle.close().catch(()=>{});
          await rm(file,{force:true}).catch(()=>{});
        },
      };
    }catch(error){
      await handle.close().catch(()=>{});
      await rm(file,{force:true}).catch(()=>{});
      throw error;
    }
  }
}
function pruneRequests(state,at=Date.now()){
  const entries=Object.entries(state.requestIndex);
  if(entries.length<=REQUEST_LIMIT)return;
  entries.sort((left,right)=>Number(left[1]?.at||0)-Number(right[1]?.at||0));
  for(const [key] of entries.slice(0,entries.length-REQUEST_LIMIT))delete state.requestIndex[key];
}
function compactHistory(entry){
  return {
    runId:entry.runId,status:entry.status,trigger:entry.trigger,requestId:entry.requestId||null,
    days:entry.days??null,window:entry.window||null,startedAt:entry.startedAt||null,endedAt:entry.endedAt||null,
    phase:entry.phase||null,realCodexThreadId:entry.realCodexThreadId||null,
    codexUrl:entry.realCodexThreadId?codexThreadUrl(entry.realCodexThreadId):null,
    reportAvailable:Boolean(entry.reportAvailable),source:entry.source||null,
    error:entry.error||null,
  };
}
export function compactRun(run){
  if(!run)return null;
  return compactHistory({
    ...run,codexUrl:run.realCodexThreadId?codexThreadUrl(run.realCodexThreadId):null,
  });
}
export async function readRun(runId,{home}={}){
  if(typeof runId!=='string'||!/^[a-f0-9-]{36}$/i.test(runId))return null;
  const value=await readJson(join(analysisPaths(home).runs,`${runId}.json`),null);
  if(!value)return null;
  if(!isRecord(value)||value.runId!==runId||value.schemaVersion!==1)throw fail('SQUAD_ANALYSIS_RUN_CORRUPT','分析运行记录损坏。');
  return value;
}
export async function writeRun(run,{home}={}){
  await writeJson(join(analysisPaths(home).runs,`${run.runId}.json`),run);
  return run;
}
export async function readEvidence(runId,{home}={}){
  if(typeof runId!=='string'||!/^[a-f0-9-]{36}$/i.test(runId))return null;
  return readJson(join(analysisPaths(home).evidence,`${runId}.json`),null);
}
export async function writeEvidence(runId,value,{home}={}){
  await writeJson(join(analysisPaths(home).evidence,`${runId}.json`),value);
  return value;
}
export async function rememberStatsSnapshot({home,run,stats,statsDigest,now=new Date()}={}){
  if(!run?.runId)throw fail('SQUAD_ANALYSIS_RUN_INVALID','缺少运行标识。');
  if(!stats||stats.schemaVersion!==1)throw fail('SQUAD_ANALYSIS_STATS_INVALID','缺少可冻结的确定性统计。');
  const digest=statsDigest||digestJson(stats);
  if(digestJson(stats)!==digest)throw fail('SQUAD_ANALYSIS_STATS_INVALID','统计快照校验失败。');
  const state=await readAnalysisState({home});
  const key=run.window?.key||windowKey(run.days);
  const entry={
    schemaVersion:1,runId:run.runId,days:run.days??null,window:run.window||null,
    sourceFingerprint:run.sourceFingerprint||'',statsDigest:digest,
    statsObservedAt:stats.observedAt||null,savedAt:nowIso(now),
  };
  state.statsByWindow[key]=entry;
  await writeAnalysisState(state,{home});
  return entry;
}
export async function readStatsPointer({home,days=null}={}){
  const state=await readAnalysisState({home});
  const entry=state.statsByWindow[windowKey(days)];
  return entry?.runId?entry:null;
}
export async function readStatsSnapshot({home,days=null}={}){
  const entry=await readStatsPointer({home,days});
  if(!entry)return null;
  const evidence=await readEvidence(entry.runId,{home});
  if(!isRecord(evidence)||evidence.schemaVersion!==1||!isRecord(evidence.stats)||evidence.stats.schemaVersion!==1)return null;
  const statsDigest=digestJson(evidence.stats);
  if(entry.statsDigest&&entry.statsDigest!==statsDigest)return null;
  return {
    schemaVersion:1,runId:entry.runId,pointer:entry,stats:evidence.stats,statsDigest,
    sourceFingerprint:evidence.sourceFingerprint??entry.sourceFingerprint??null,
    window:evidence.window||entry.window||null,
    statsObservedAt:evidence.stats.observedAt||entry.statsObservedAt||null,
    days:entry.days??null,
  };
}
export async function readReport(runId,{home}={}){
  if(typeof runId!=='string'||!/^[a-f0-9-]{36}$/i.test(runId))return null;
  return readJson(join(analysisPaths(home).reports,`${runId}.json`),null);
}
export async function writeReport(runId,value,{home}={}){
  await writeJson(join(analysisPaths(home).reports,`${runId}.json`),value);
  return value;
}
export async function beginAnalysisRun({home,trigger,requestId,days,now=new Date(),sourceFingerprint,requestedByThreadId=null}={}){
  const window=analysisWindow(days,now);
  const state=await readAnalysisState({home});
  const run={
    schemaVersion:1,runId:randomUUID(),status:'running',phase:'collecting',
    trigger:trigger==='schedule'?'schedule':'manual',requestId:String(requestId||''),
    days:window.days,window,startedAt:nowIso(now),endedAt:null,
    ownerPid:process.pid,requestedByThreadId:requestedByThreadId||null,
    sourceFingerprint:String(sourceFingerprint||''),realCodexThreadId:null,
    reportAvailable:false,source:null,error:null,codex:null,
  };
  await writeRun(run,{home});
  state.currentRunId=run.runId;
  state.history.unshift(compactRun(run));
  if(state.history.length>HISTORY_LIMIT)state.history.length=HISTORY_LIMIT;
  state.requestIndex[run.requestId]={kind:'run',runId:run.runId,at:Date.now()};
  pruneRequests(state);
  await writeAnalysisState(state,{home});
  return run;
}
export async function updateRun(run,{home}={}){
  return writeRun(run,{home});
}
export async function discardAnalysisRun({home,run}={}){
  if(!run?.runId)return null;
  await rm(join(analysisPaths(home).runs,`${run.runId}.json`),{force:true});
  const state=await readAnalysisState({home});
  state.history=state.history.filter(entry=>entry.runId!==run.runId);
  if(state.currentRunId===run.runId)state.currentRunId=null;
  if(state.requestIndex[run.requestId]?.runId===run.runId)delete state.requestIndex[run.requestId];
  await writeAnalysisState(state,{home});
  return run;
}
export async function setRunPhase(run,phase,{home}={}){
  run.phase=phase;
  await writeRun(run,{home});
  return run;
}
async function updateHistory(state,run){
  const entry=compactRun(run);
  const index=state.history.findIndex(item=>item.runId===run.runId);
  if(index>=0)state.history[index]=entry;
  else{state.history.unshift(entry);if(state.history.length>HISTORY_LIMIT)state.history.length=HISTORY_LIMIT}
}
export async function finishAnalysisRun({home,run,report=null,now=new Date()}={}){
  if(report){
    run.status='succeeded';
    run.phase='completed';
    run.reportAvailable=true;
    run.error=null;
    run.realCodexThreadId=report.realCodexThreadId||run.realCodexThreadId;
  }else{
    if(run.status==='running')run.status='failed';
    run.reportAvailable=false;
  }
  run.endedAt=run.endedAt||nowIso(now);
  await writeRun(run,{home});
  const state=await readAnalysisState({home});
  if(state.currentRunId===run.runId)state.currentRunId=null;
  await updateHistory(state,run);
  if(report&&run.status==='succeeded'){
    state.lastSuccessfulByWindow[run.window?.key||windowKey(run.days)]={
      runId:run.runId,generatedAt:report.generatedAt,sourceFingerprint:run.sourceFingerprint,
      statsDigest:report.statsDigest,days:run.days,
    };
    // A successful manual CLI run may turn the schedule back on, but only the
    // periodic scheduler advances an already enabled schedule. The plan is
    // always both windows, never whichever window the manual run happened to use.
    if(run.trigger==='manual'&&!state.schedule.enabled){
      state.schedule={
        ...state.schedule,enabled:true,days:null,
        nextAt:new Date(Date.parse(report.generatedAt)+86400000).toISOString(),
        lastManualAt:report.generatedAt,
      };
    }else if(run.trigger==='manual'){
      state.schedule={...state.schedule,days:null,lastManualAt:report.generatedAt};
    }
  }
  state.requestIndex[run.requestId]={kind:'run',runId:run.runId,at:Date.now()};
  pruneRequests(state);
  await writeAnalysisState(state,{home});
  return run;
}
export async function failAnalysisRun({home,run,code='SQUAD_ANALYSIS_FAILED',message,status='failed',now=new Date()}={}){
  run.status=status;
  run.phase='completed';
  run.endedAt=nowIso(now);
  run.reportAvailable=false;
  run.error={code,message:String(message||'').slice(0,400),at:nowIso(now)};
  await writeRun(run,{home});
  const state=await readAnalysisState({home});
  if(state.currentRunId===run.runId)state.currentRunId=null;
  await updateHistory(state,run);
  state.requestIndex[run.requestId]={kind:'run',runId:run.runId,at:Date.now()};
  pruneRequests(state);
  await writeAnalysisState(state,{home});
  return run;
}
export async function rememberSkippedRequest({home,requestId,runId=null,reason='NO_NEW_RECORDS',now=new Date()}={}){
  const state=await readAnalysisState({home});
  state.requestIndex[String(requestId)]={kind:'skipped',runId:runId||null,reason,at:Date.now()};
  pruneRequests(state);
  await writeAnalysisState(state,{home});
  return state.requestIndex[String(requestId)];
}
export async function advanceAnalysisSchedule({home,now=new Date(),reason='SKIPPED',cycle=null,windows=null}={}){
  const state=await readAnalysisState({home});
  if(!state.schedule.enabled)return state.schedule;
  const at=nowIso(now);
  state.schedule={
    ...state.schedule,days:null,lastPeriodicAt:at,lastPeriodicReason:reason,
    nextAt:new Date(Date.parse(at)+86400000).toISOString(),
    ...(cycle?{lastPeriodicCycle:cycle}:{}),
  };
  if(Array.isArray(windows))state.schedule.lastPeriodicWindows=windows;
  await writeAnalysisState(state,{home});
  return state.schedule;
}
export async function requestLookup({home,requestId}={}){
  if(!requestId)return null;
  const state=await readAnalysisState({home});
  return state.requestIndex[String(requestId)]||null;
}
export async function readLastSuccessful({home,days=null}={}){
  const state=await readAnalysisState({home});
  const entry=state.lastSuccessfulByWindow[windowKey(days)];
  if(!entry?.runId)return null;
  const run=await readRun(entry.runId,{home});
  if(!run||run.status!=='succeeded')return null;
  const report=await readReport(entry.runId,{home});
  if(!report)return null;
  return {run,report,entry};
}
export async function readAnalysisStateView({home}={}){
  const state=await readAnalysisState({home});
  let current=null;
  if(state.currentRunId)current=compactRun(await readRun(state.currentRunId,{home}));
  const successful=[];
  for(const [key,entry] of Object.entries(state.lastSuccessfulByWindow)){
    if(!entry?.runId)continue;
    const run=await readRun(entry.runId,{home});
    if(run&&run.status==='succeeded')successful.push({key,...compactRun(run),generatedAt:entry.generatedAt||run.endedAt||null});
  }
  successful.sort((left,right)=>String(right.generatedAt||'').localeCompare(String(left.generatedAt||'')));
  const lastSuccessful=successful[0]||null;
  const byWindow={};
  for(const entry of successful){
    if(!byWindow[entry.key])byWindow[entry.key]=entry;
  }
  return {
    schemaVersion:1,
    observedAt:nowIso(),
    current,
    lastSuccessful,
    lastSuccessfulByWindow:byWindow,
    history:state.history.slice(0,24).map(compactHistory),
    schedule:{...state.schedule},
  };
}
export async function recoverInterruptedAnalysisRuns({home,now=new Date(),isAlive=processAlive}={}){
  const state=await readAnalysisState({home});
  const paths=analysisPaths(home);
  const lock=await lockOwner(paths.lock);
  let changed=false;
  const candidates=new Set(state.history.filter(entry=>entry.status==='running').map(entry=>entry.runId));
  if(state.currentRunId)candidates.add(state.currentRunId);
  try{
    for(const file of await readdir(paths.runs)){
      if(/^[a-f0-9-]{36}\.json$/i.test(file))candidates.add(file.slice(0,-5));
    }
  }catch(error){if(error.code!=='ENOENT')throw error}
  for(const runId of candidates){
    const run=await readRun(runId,{home});
    if(!run||run.status!=='running')continue;
    if(isAlive(run.ownerPid)&&lock)continue;
    run.status='interrupted';
    run.phase='completed';
    run.endedAt=run.endedAt||nowIso(now);
    run.reportAvailable=false;
    run.error={code:'SQUAD_ANALYSIS_INTERRUPTED',message:'分析服务中断，本轮未发布报告。',at:nowIso(now)};
    await writeRun(run,{home});
    await updateHistory(state,run);
    if(state.currentRunId===runId)state.currentRunId=null;
    changed=true;
  }
  if(changed)await writeAnalysisState(state,{home});
  return {recovered:changed,state};
}
