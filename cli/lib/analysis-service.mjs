import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {dataRoot} from './storage-paths.mjs';
import {readBinding as defaultReadBinding,snapshot as defaultSnapshot} from './runtime.mjs';
import {aggregateAnalytics,cliAttemptInputs} from './analytics.mjs';
import {CLI_STATS_VERSION} from './cli-metrics.mjs';
import {BENEFITS_STATS_VERSION,buildSquadBenefits} from './squad-benefits.mjs';
import {collectQoderCliUsage} from './qoder-cli-usage.mjs';
import {loadQoderModelEvidence} from './qoder-model-evidence.mjs';
import {runCodexAnalysis} from './analysis-runner.mjs';
import {codexMetadataStamp,collectCodexInventory,emptyCodexUsage,loadCodexUsage} from './codex-usage.mjs';
import {applyBenefitMatches,collectBenefitSources} from './benefit-evidence.mjs';
import {
  acquireAnalysisLock,advanceAnalysisSchedule,analysisPaths,analysisWindow,
  beginAnalysisRun,compactRun,discardAnalysisRun,ensureAnalysisSchedule,failAnalysisRun,finishAnalysisRun,readAnalysisState,readAnalysisStateView,
  readEvidence,readLastSuccessful,readReport,readRun,readStatsPointer,readStatsSnapshot,recoverInterruptedAnalysisRuns,
  rememberSkippedRequest,rememberStatsSnapshot,requestLookup,updateRun,writeEvidence,writeReport,
} from './analysis-runs.mjs';
import {
  analysisSchemaText,buildEvidence,buildPrompt,buildReport,digestJson,emptyAnalytics,
  reportView,statsView,validateAnalysisOutput,
} from './analysis-report.mjs';

const requestIdPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const failedStatuses=new Set(['failed','interrupted']);

function fail(code,message){return Object.assign(new Error(message),{code})}
function safeMessage(error,home){
  let message=String(error?.message||error||'分析失败');
  if(home)message=message.split(home).join('[数据目录]');
  message=message.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return message.slice(0,400)||'分析失败';
}
function requestIdOf(value){
  if(typeof value!=='string'||!requestIdPattern.test(value))throw fail('SQUAD_ANALYSIS_REQUEST_INVALID','requestId 必须是 8-128 位字母、数字、点、下划线、冒号或连字符。');
  return value;
}
function fingerprintOf(value){
  if(typeof value==='string')return {fingerprint:value,sourceCount:0};
  if(!value||typeof value.fingerprint!=='string')throw fail('SQUAD_ANALYSIS_SOURCE_INVALID','无法读取分析数据指纹。');
  return {fingerprint:value.fingerprint,sourceCount:Number(value.sourceCount)||0};
}
export async function cheapSourceFingerprint({home,codexHome=null}={}){
  const directory=join(dataRoot({home}),'bindings');
  let files;
  try{files=await readdir(directory);}
  catch(error){if(error.code==='ENOENT')files=[];else throw error}
  const selected=files.filter(file=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i.test(file)).sort();
  const hash=createHash('sha256');
  let sourceCount=0;
  for(const file of selected){
    let contents;
    try{contents=await readFile(join(directory,file));}
    catch(error){if(error.code==='ENOENT')continue;throw error}
    hash.update(file);hash.update('\0');hash.update(contents);hash.update('\0');
    sourceCount+=1;
  }
  // A parser upgrade changes the frozen cli section without touching any binding.
  hash.update('cli-stats\0');hash.update(CLI_STATS_VERSION);hash.update('\0');
  hash.update(BENEFITS_STATS_VERSION);hash.update('\0');
  // Bindings change at dispatch/closure; streamed execution changes live in SQLite.
  const file=join(dataRoot({home}),'local-store.sqlite');
  try{
    await stat(file);
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});
    try{
      const rows=db.prepare("SELECT t.id,t.version,t.status,e.generation,e.high_water_sequence FROM tasks t LEFT JOIN executions e ON e.task_id=t.id WHERE t.source_type='codex-squad' ORDER BY t.id,e.generation").all();
      hash.update(JSON.stringify(rows));
    }finally{db.close()}
  }catch(error){if(error.code!=='ENOENT')throw error}
  // Host rollout usage changes without touching squad storage; a cheap DB stamp keeps it detectable.
  let stamp;
  try{stamp=await codexMetadataStamp({codexHome,excludeThreadIds:[...(await analysisThreadLinks({home})).keys()]});}
  catch(error){stamp={unavailable:String(error?.code||'SQUAD_CODEX_USAGE_UNAVAILABLE')};}
  // Analysis itself remains visible in the next usage snapshot, but must not
  // trigger another scheduled model run merely by writing its own usage.
  const {main,wal,...activity}=stamp;
  hash.update(JSON.stringify(activity));
  return {fingerprint:hash.digest('hex'),sourceCount};
}
export async function loadAnalysisSources({
  home,concurrency=4,snapshots=null,
  readBinding=defaultReadBinding,snapshot=defaultSnapshot,
}={}){
  if(Array.isArray(snapshots))return {views:snapshots,expected:snapshots.length,unavailable:[]};
  const directory=join(dataRoot({home}),'bindings');
  let files;
  try{files=await readdir(directory);}
  catch(error){if(error.code==='ENOENT')return {views:[],expected:0,unavailable:[]};throw error}
  const ids=files.filter(file=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i.test(file)).map(file=>file.slice(0,-5)).sort();
  const views=[],unavailable=[];
  for(let index=0;index<ids.length;index+=Math.max(1,concurrency)){
    const results=await Promise.allSettled(ids.slice(index,index+Math.max(1,concurrency)).map(async id=>{
      const binding=await readBinding(id,{home});
      if(!binding)throw fail('SQUAD_ANALYSIS_SOURCE_UNAVAILABLE','绑定不可用。');
      const view=await snapshot(binding,{home,allEvents:true});
      if(view?.binding?.threadId!==id)throw fail('SQUAD_ANALYSIS_SOURCE_MISMATCH','分析来源身份不一致。');
      return view;
    }));
    results.forEach((result,offset)=>{
      if(result.status==='fulfilled')views.push(result.value);
      else unavailable.push({threadId:ids[index+offset],code:result.reason?.code||'SQUAD_ANALYSIS_SOURCE_UNAVAILABLE'});
    });
  }
  return {views,expected:ids.length,unavailable};
}
async function squadThreadIds({home,views}){
  const ids=new Set();
  for(const view of views){
    const threadId=view?.binding?.threadId;
    if(typeof threadId==='string'&&threadId)ids.add(threadId);
  }
  try{
    for(const file of await readdir(join(dataRoot({home}),'bindings'))){
      if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i.test(file))ids.add(file.slice(0,-5));
    }
  }catch(error){if(error.code!=='ENOENT')throw error}
  return [...ids];
}
async function analysisThreadLinks({home}){
  const links=new Map();
  let files;
  try{files=await readdir(analysisPaths(home).runs);}
  catch(error){if(error.code==='ENOENT')return links;throw error}
  for(const file of files){
    if(!/^[a-f0-9-]{36}\.json$/i.test(file))continue;
    try{
      const run=await readRun(file.slice(0,-5),{home});
      const threadId=typeof run?.realCodexThreadId==='string'?run.realCodexThreadId.trim():'';
      if(!threadId)continue;
      const requested=typeof run?.requestedByThreadId==='string'&&run.requestedByThreadId.trim()?run.requestedByThreadId.trim():null;
      if(!links.has(threadId)||(!links.get(threadId)&&requested))links.set(threadId,requested);
    }catch{}
  }
  return links;
}
async function codexUsageFor({
  home,codexHome,days,now,views,codexUsageProvider,inventory=null,threadIds=null,analysisThreads=null,
}){
  if(codexUsageProvider){
    return codexUsageProvider({home,codexHome,days,now,views});
  }
  const ids=Array.isArray(threadIds)?threadIds:await squadThreadIds({home,views});
  const analysis=Array.isArray(analysisThreads)
    ?analysisThreads
    :[...await analysisThreadLinks({home})].map(([realCodexThreadId,requestedByThreadId])=>({realCodexThreadId,requestedByThreadId}));
  return loadCodexUsage({
    home,codexHome,days,now,squadThreadIds:ids,analysisThreads:analysis,inventory,
  });
}
export async function collectFrozen({
  home,days,now,codexHome=null,qoderHome=null,
  sourceLoader=loadAnalysisSources,fingerprintProvider=cheapSourceFingerprint,codexUsageProvider=null,
  qoderUsageProvider=null,inventoryProvider=collectCodexInventory,
}){
  const before=fingerprintOf(await fingerprintProvider({home,codexHome}));
  const loaded=await sourceLoader({home});
  const views=Array.isArray(loaded?.views)?loaded.views:[];
  const stats=aggregateAnalytics(views,{scope:'global',days,now});
  stats.coverage.sources={expected:Number(loaded?.expected??views.length),loaded:views.length,unavailable:Array.isArray(loaded?.unavailable)?loaded.unavailable:[]};
  // One native inventory feeds both the legacy usage window and the benefit
  // collector; rollout records are parsed once per cutoff.
  let inventory=null;
  if(inventoryProvider){
    try{inventory=await inventoryProvider({home,codexHome});}catch{inventory=null}
  }
  let threadIds=[],links=new Map();
  try{
    [threadIds,links]=await Promise.all([squadThreadIds({home,views}),analysisThreadLinks({home})]);
  }catch{}
  const analysisThreads=[...links].map(([realCodexThreadId,requestedByThreadId])=>({realCodexThreadId,requestedByThreadId}));
  try{
    stats.codexUsage=await codexUsageFor({
      home,codexHome,days,now,views,codexUsageProvider,inventory,threadIds,analysisThreads,
    });
  }catch{
    stats.codexUsage=emptyCodexUsage({now,available:false,note:'本机 Codex 用量读取失败，未计入 Codex 消耗。'});
  }
  // Native Qoder receipts replace public command records only for attempts they cover.
  // Any failure here keeps the public CLI statistics untouched and reports coverage.
  try{
    await collectQoderCliUsage({stats,views,days,now,qoderHome,provider:qoderUsageProvider||undefined});
  }catch(error){
    stats.capabilities.cli={...stats.capabilities.cli,coverage:{...(stats.capabilities.cli?.coverage||{}),qoderNative:{available:false,errorCode:String(error?.code||'QODER_NATIVE_UNAVAILABLE')}}};
  }
  let nativeSources;
  try{
    nativeSources=collectBenefitSources({views,inventory,now,squadThreadIds:threadIds,analysisThreadIds:[...links.keys()]});
  }catch{
    nativeSources={version:1,window:null,deliveryEvidence:[],baselines:[],speedSamples:[],candidates:{deliveries:[],baselines:[]},coverage:{available:false,reason:'BENEFIT_SOURCE_FAILED'}};
  }
  let benefitViews=views,qoderModelCoverage=null;
  try{
    const eligible=new Set(nativeSources.deliveryEvidence.map(delivery=>delivery.threadId));
    const nativeModels=await loadQoderModelEvidence({inputs:cliAttemptInputs(views.filter(view=>eligible.has(view.binding?.threadId)),{days:null,now}),qoderHome});
    qoderModelCoverage=nativeModels.coverage;
    const models=new Map(nativeModels.attempts.filter(attempt=>attempt.model).map(attempt=>[
      `${attempt.threadId}\u0000${attempt.taskId}\u0000${attempt.attemptId}`,attempt.model,
    ]));
    benefitViews=views.map(view=>({...view,tasks:(view.tasks||[]).map(task=>({...task,attempts:(task.attempts||[]).map(attempt=>{
      const model=models.get(`${view.binding?.threadId}\u0000${task.id}\u0000${attempt.id}`);
      if(!model)return attempt;
      // A conflicting native receipt must not silently replace another actual model.
      return {...attempt,actualModel:attempt.actualModel&&attempt.actualModel!==model?null:model};
    })}))}));
    if(models.size)nativeSources=collectBenefitSources({
      views:benefitViews,inventory,now,squadThreadIds:threadIds,analysisThreadIds:[...links.keys()],
    });
  }catch{}
  nativeSources.coverage.qoderModels=qoderModelCoverage;
  const deliveryEvidence=[...(Array.isArray(loaded?.deliveryEvidence)?loaded.deliveryEvidence:[]),...nativeSources.deliveryEvidence];
  const speedSamples=[...(Array.isArray(loaded?.speedSamples)?loaded.speedSamples:[]),...nativeSources.speedSamples];
  const benefitSources={...nativeSources,deliveryEvidence,speedSamples};
  stats.benefits=buildSquadBenefits({views,codexUsage:stats.codexUsage,now,days,
    deliveryEvidence,speedSamples});
  // The saved input is immutable. Later writes belong to the next round; active work need not stop.
  return {stats,fingerprint:before,benefitSources};
}
async function collectInWorker({home,days,now,signal,codexHome=null}){
  const worker=new Worker(new URL('./analysis-worker.mjs',import.meta.url),{workerData:{kind:'collect',home,days,now:new Date(now).toISOString(),codexHome}});
  return new Promise((resolve,reject)=>{
    const abort=()=>{void worker.terminate();reject(fail('SQUAD_ANALYSIS_INTERRUPTED','分析采集已中断。'))};
    signal?.addEventListener('abort',abort,{once:true});
    const done=()=>signal?.removeEventListener('abort',abort);
    worker.once('message',message=>{done();void worker.terminate();message.error?reject(Object.assign(new Error(message.error.message),{code:message.error.code})):resolve(message.result)});
    worker.once('error',error=>{done();reject(error)});
    worker.once('exit',code=>{done();if(code!==0&&!signal?.aborted)reject(fail('SQUAD_ANALYSIS_COLLECT_FAILED','分析采集进程已中断。'))});
    if(signal?.aborted)abort();
  });
}

let active=null;
let scheduler=null;

async function lookupResult(lookup,{home}){
  const run=lookup.runId?await readRun(lookup.runId,{home}):null;
  const report=run?await readReport(lookup.runId,{home}):null;
  if(lookup.kind==='skipped'){
    return {skipped:true,reason:lookup.reason||'NO_NEW_RECORDS',run:compactRun(run),report:report||null,reused:true};
  }
  if(active?.runId===lookup.runId){
    return {skipped:false,run:compactRun(run),report:null,reused:true,inProgress:true,completion:active.promise};
  }
  return {skipped:false,run:compactRun(run),report:null,reused:true,inProgress:run?.status==='running',completion:null};
}
async function skipResult({home,lock,requestId,reason,lastRunId,report,now}){
  await rememberSkippedRequest({home,requestId,runId:lastRunId,reason,now});
  await lock.release();
  return {skipped:true,reason,run:lastRunId?compactRun(await readRun(lastRunId,{home})):null,report:report||null};
}

async function reusableStats({home,days,fingerprint}){
  const snapshot=await readStatsSnapshot({home,days});
  if(!snapshot||snapshot.sourceFingerprint!==fingerprint)return null;
  if(!Number(snapshot.stats?.metrics?.taskCount))return null;
  const prior=await readRun(snapshot.runId,{home});
  if(!prior||prior.status==='succeeded')return null;
  const evidence=await readEvidence(snapshot.runId,{home});
  if(!evidence?.benefitSources||typeof evidence.benefitSources!=='object')return null;
  return {stats:snapshot.stats,benefitSources:evidence.benefitSources};
}

export async function startAnalysis({
  home,trigger='manual',requestId,days=null,now=new Date(),signal=null,codexHome=null,qoderHome=null,
  sourceLoader=loadAnalysisSources,fingerprintProvider=cheapSourceFingerprint,codexUsageProvider=null,
  qoderUsageProvider=null,
  runner=runCodexAnalysis,runnerOptions={},requestedByThreadId=null,keepWork=false,lockTimeoutMs=0,
}={}){
  const at=now instanceof Date?now:new Date(now);
  const window=analysisWindow(days,at);
  const normalizedRequestId=requestIdOf(requestId);
  const replay=await requestLookup({home,requestId:normalizedRequestId});
  if(replay)return lookupResult(replay,{home});
  let lock;
  try{lock=await acquireAnalysisLock({home,timeoutMs:lockTimeoutMs})}catch(error){
    const concurrent=await requestLookup({home,requestId:normalizedRequestId});
    if(concurrent)return lookupResult(concurrent,{home});
    throw error;
  }
  try{
    await recoverInterruptedAnalysisRuns({home,now:at});
    const lookup=await requestLookup({home,requestId:normalizedRequestId});
    if(lookup){
      const result=await lookupResult(lookup,{home});
      await lock.release();
      return result;
    }
    if(active)throw fail('SQUAD_ANALYSIS_BUSY','另一轮小队分析正在执行，请稍后重试。');
    const previous=await readLastSuccessful({home,days:window.days});
    const before=fingerprintOf(await fingerprintProvider({home,codexHome}));
    if(!before.sourceCount){
      return await skipResult({home,lock,requestId:normalizedRequestId,reason:'NO_SOURCE_RECORDS',lastRunId:previous?.run?.runId||null,report:previous?.report||null,now:at});
    }
    if(previous&&previous.entry?.sourceFingerprint===before.fingerprint){
      return await skipResult({home,lock,requestId:normalizedRequestId,reason:'NO_NEW_RECORDS',lastRunId:previous.run.runId,report:previous.report||null,now:at});
    }
    const run=await beginAnalysisRun({
      home,trigger,requestId:normalizedRequestId,days:window.days,now:at,
      sourceFingerprint:before.fingerprint,requestedByThreadId,
    });
    const controller=new AbortController();
    const abort=()=>controller.abort();
    if(signal){if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})}
    const completion=(async()=>{
      try{
        const reusable=await reusableStats({home,days:window.days,fingerprint:before.fingerprint});
        let frozen;
        if(reusable){
          frozen={
            stats:reusable.stats,
            benefitSources:reusable.benefitSources,
            fingerprint:{fingerprint:before.fingerprint,sourceCount:before.sourceCount},
          };
        }else{
          const request={home,days:window.days,now:at,codexHome,qoderHome,qoderUsageProvider,sourceLoader,fingerprintProvider,codexUsageProvider,signal:controller.signal};
          const workerSafe=sourceLoader===loadAnalysisSources&&fingerprintProvider===cheapSourceFingerprint
            &&!codexUsageProvider&&!qoderUsageProvider&&!qoderHome;
          frozen=await (workerSafe?collectInWorker(request):collectFrozen(request));
        }
        if(controller.signal.aborted)throw fail('SQUAD_ANALYSIS_INTERRUPTED','分析采集已中断。');
        // Stats are frozen and readable before the model starts; a round without records publishes nothing.
        if(!frozen.stats?.metrics?.taskCount){
          await discardAnalysisRun({home,run});
          await rememberSkippedRequest({home,requestId:normalizedRequestId,runId:previous?.run?.runId||null,reason:'NO_ANALYSIS_RECORDS',now:at});
          return {skipped:true,reason:'NO_ANALYSIS_RECORDS',run:null,report:previous?.report||null};
        }
        run.sourceFingerprint=frozen.fingerprint.fingerprint;
        run.source={threads:frozen.stats.coverage.sessions,tasks:frozen.stats.coverage.tasks,attempts:frozen.stats.coverage.attempts};
        run.statsDigest=digestJson(frozen.stats);
        await updateRun(run,{home});
        return await executeRun({home,run,frozen,runner,runnerOptions,signal:controller.signal,now:at,keepWork});
      }catch(error){
        const code=error?.code||'SQUAD_ANALYSIS_FAILED',message=safeMessage(error,home);
        const current=await readRun(run.runId,{home}).catch(()=>run);
        if(current?.status==='running')await failAnalysisRun({home,run:current,code,message,status:controller.signal.aborted?'interrupted':'failed'}).catch(()=>{});
        return {run:compactRun(current||run),report:null,error:{code,message}};
      }finally{
        signal?.removeEventListener('abort',abort);
        if(active?.runId===run.runId)active=null;
        await lock.release().catch(()=>{});
      }
    })();
    active={runId:run.runId,controller,promise:completion,home};
    return {skipped:false,run:compactRun(run),completion};
  }catch(error){
    await lock.release().catch(()=>{});
    throw error;
  }
}

async function executeRun({home,run,frozen,runner,runnerOptions,signal,now,keepWork}){
  const paths=analysisPaths(home);
  const workDir=join(paths.work,run.runId);
  const schemaPath=join(workDir,'schema.json');
  const evidencePath=join(workDir,'evidence.json');
  const lastMessagePath=join(workDir,'last-message.json');
  const sources=frozen.benefitSources&&typeof frozen.benefitSources==='object'?frozen.benefitSources:null;
  const benefitCandidates=sources?.candidates??null;
  try{
    const statsDigest=digestJson(frozen.stats);
    if(run.statsDigest&&run.statsDigest!==statsDigest)throw fail('SQUAD_ANALYSIS_SOURCE_CHANGED','冻结统计与运行记录不一致。');
    const evidence=buildEvidence(frozen.stats,{window:run.window,benefitCandidates});
    const evidenceDigest=digestJson({stats:frozen.stats,evidence,benefitSources:sources});
    await writeEvidence(run.runId,{
      schemaVersion:1,runId:run.runId,window:run.window,sourceFingerprint:run.sourceFingerprint,
      statsDigest,evidenceDigest,stats:frozen.stats,evidence,benefitSources:sources,
    },{home});
    await rememberStatsSnapshot({home,run,stats:frozen.stats,statsDigest,now});
    await mkdir(workDir,{recursive:true,mode:0o700});
    await writeFile(schemaPath,analysisSchemaText(),{mode:0o600});
    await writeFile(evidencePath,JSON.stringify(evidence),{mode:0o600});
    run.evidenceDigest=evidenceDigest;
    run.phase='analyzing';
    await updateRun(run,{home});
    const prompt=buildPrompt(evidence,{window:run.window});
    const result=await runner({
      prompt,schemaPath,runDir:workDir,lastMessagePath,
      command:runnerOptions.command||'codex',
      commandPrefix:runnerOptions.commandPrefix||[],
      env:runnerOptions.env||process.env,
      timeoutMs:runnerOptions.timeoutMs,
      signal,
      onThread:async threadId=>{run.realCodexThreadId=threadId;await updateRun(run,{home})},
    });
    const analysis=validateAnalysisOutput(result.analysis,{
      threads:evidence.sessions,tasks:evidence.tasks,refs:evidence.refs,
      benefitCandidates,requireBenefitMatches:true,
    });
    run.realCodexThreadId=result.realCodexThreadId;
    run.codex={
      exitCode:result.exitCode??0,
      usage:result.usage||null,
      eventTypes:Array.isArray(result.eventTypes)?result.eventTypes.slice(0,50):[],
    };
    // The model only supplies semantic matches; deterministic code recomputes
    // benefits from the frozen sources and persists the final digest.
    let finalStats=frozen.stats;
    let finalEvidence=evidence;
    let finalEvidenceDigest=evidenceDigest;
    if(sources&&analysis.benefitMatches.length){
      const benefitNow=frozen.stats.observedAt?new Date(frozen.stats.observedAt):now;
      finalStats=applyBenefitMatches({
        stats:frozen.stats,sources,matches:analysis.benefitMatches,
        now:benefitNow,days:run.days??null,
      });
      const finalStatsDigest=digestJson(finalStats);
      if(finalStatsDigest!==statsDigest){
        finalEvidence=buildEvidence(finalStats,{window:run.window,benefitCandidates});
        finalEvidenceDigest=digestJson({stats:finalStats,evidence:finalEvidence,benefitSources:sources});
        await writeEvidence(run.runId,{
          schemaVersion:1,runId:run.runId,window:run.window,sourceFingerprint:run.sourceFingerprint,
          statsDigest:finalStatsDigest,evidenceDigest:finalEvidenceDigest,stats:finalStats,evidence:finalEvidence,benefitSources:sources,
        },{home});
        await rememberStatsSnapshot({home,run,stats:finalStats,statsDigest:finalStatsDigest,now});
        run.statsDigest=finalStatsDigest;
        run.evidenceDigest=finalEvidenceDigest;
        await updateRun(run,{home});
      }
    }
    const report=buildReport({run,stats:finalStats,analysis,evidenceDigest:finalEvidenceDigest});
    if(report.statsDigest!==digestJson(finalStats))throw fail('SQUAD_ANALYSIS_REPORT_CORRUPT','报告统计校验失败。');
    await writeReport(run.runId,report,{home});
    run.phase='publishing';
    await updateRun(run,{home});
    await finishAnalysisRun({home,run,report});
    return {run:compactRun(run),report};
  }catch(error){
    const code=error?.code||'SQUAD_ANALYSIS_FAILED';
    const status=code==='SQUAD_ANALYSIS_INTERRUPTED'||signal?.aborted?'interrupted':'failed';
    const message=safeMessage(error,home);
    if(run.status==='running')await failAnalysisRun({home,run,code,message,status});
    return {run:compactRun(run),report:null,error:{code,message}};
  }finally{
    if(!keepWork)await rm(workDir,{recursive:true,force:true}).catch(()=>{});
    if(failedStatuses.has(run.status))run.phase='completed';
  }
}

export async function interruptActiveAnalysis(){
  if(!active)return null;
  active.controller.abort();
  return active.promise;
}
export async function stopActiveAnalysis(){
  if(!active)return;
  active.controller.abort();
  await active.promise.catch(()=>{});
}

function snapshotBlock(run,snapshot){
  const running=run?.status==='running';
  return {
    available:false,statsAvailable:true,
    reason:running?'ANALYSIS_RUNNING':run?.error?.code||'NO_SUCCESSFUL_REPORT',
    runId:snapshot.runId,trigger:run?.trigger||null,
    window:snapshot.window||run?.window||null,
    statsObservedAt:snapshot.statsObservedAt,statFingerprint:snapshot.statsDigest,
    latestRun:run?compactRun(run):null,
  };
}

export async function savedAnalytics(binding,{scope='global',days=null}={},context={}){
  if(scope!=='global')throw fail('SQUAD_ANALYSIS_SCOPE_UNSUPPORTED','分析报告只保存整体范围。');
  const at=new Date();
  analysisWindow(days,at);
  const home=context.home;
  const origin=context.origin||null;
  const pointer=await readStatsPointer({home,days});
  if(pointer){
    const snapshot=await readStatsSnapshot({home,days});
    const run=await readRun(pointer.runId,{home});
    if(!snapshot)return emptyAnalytics({days,now:at,latestRun:run?compactRun(run):null});
    if(run?.status==='succeeded'){
      const report=await readReport(pointer.runId,{home});
      if(report&&report.statsDigest===snapshot.statsDigest){
        try{return await reportView(report,{home:home||dataRoot(),origin});}catch{}
      }
    }
    return statsView(snapshot.stats,{home:home||dataRoot(),origin,analysis:snapshotBlock(run,snapshot)});
  }
  const previous=await readLastSuccessful({home,days});
  if(previous){
    try{return await reportView(previous.report,{home:home||dataRoot(),origin});}
    catch{return emptyAnalytics({days,now:at,latestRun:compactRun(previous.run)});}
  }
  const state=await readAnalysisStateView({home});
  const latestRun=[state.current,...state.history].find(run=>run?.days===days)||null;
  return emptyAnalytics({days,now:at,latestRun});
}
export const analyze=savedAnalytics;

export async function analysisRunsView({home}={}){
  return readAnalysisStateView({home});
}
export async function analysisRunDetail({home,runId,origin=null}={}){
  const run=await readRun(runId,{home});
  if(!run)return null;
  const report=await readReport(runId,{home});
  if(!report)return {schemaVersion:1,run:compactRun(run),report:null};
  try{return {schemaVersion:1,run:compactRun(run),report:await reportView(report,{home,origin})};}
  catch(error){return {schemaVersion:1,run:compactRun(run),report:null,reportError:{code:error?.code||'SQUAD_ANALYSIS_REPORT_CORRUPT'}};}
}
export async function analysisReport({home,runId=null,days=null,origin=null}={}){
  let run=null,report=null;
  if(runId){
    run=await readRun(runId,{home});
    if(!run)return null;
    report=await readReport(runId,{home});
  }else{
    const previous=await readLastSuccessful({home,days});
    run=previous?.run||null;report=previous?.report||null;
  }
  if(!run)return null;
  if(!report)return {schemaVersion:1,run:compactRun(run),report:null};
  return {schemaVersion:1,run:compactRun(run),report:await reportView(report,{home,origin})};
}

const SCHEDULE_WINDOWS=Object.freeze([7,30]);
function scheduledCycleKey(due){return new Date(due).toISOString()}
function scheduledRequestId(cycle,days){return `schedule:${cycle}:${days}`}
function windowEntry({days,requestId,at,status,reason=null,run=null,error=null,reused=false,reportAvailable=false,processed=true,window=null}){
  return {
    days,requestId,window:window||analysisWindow(days,at),status,reason,runId:run?.runId||null,
    reportAvailable:Boolean(reportAvailable||run?.reportAvailable),reused,processed,
    ...(error?{error}:{}),
  };
}
async function runScheduledWindow({home,start,at,due,days}){
  const cycle=scheduledCycleKey(due),requestId=scheduledRequestId(cycle,days);
  let started;
  try{
    started=await start({home,trigger:'schedule',requestId,days,now:at,requestedByThreadId:null,lockTimeoutMs:0});
  }catch(error){
    if(error?.code==='SQUAD_ANALYSIS_BUSY'){
      return windowEntry({days,requestId,at,status:'busy',reason:'BUSY',processed:false});
    }
    const code=error?.code||'SQUAD_ANALYSIS_FAILED',message=safeMessage(error,home);
    return windowEntry({days,requestId,at,status:'failed',reason:code,error:{code,message}});
  }
  let completed=null;
  try{if(started?.completion)completed=await started.completion;}
  catch(error){
    const code=error?.code||'SQUAD_ANALYSIS_FAILED',message=safeMessage(error,home);
    return windowEntry({
      days,requestId,at,status:'failed',reason:code,error:{code,message},
      run:started?.run||null,reused:Boolean(started?.reused),
    });
  }
  const result=completed||started||{};
  const run=result.run||null;
  const reused=Boolean(started?.reused);
  if(result.skipped){
    return windowEntry({
      days,requestId,at,status:'skipped',reason:result.reason||'SKIPPED',run,
      reused,reportAvailable:Boolean(result.report),window:run?.window||null,
    });
  }
  if(run?.status==='running'){
    return windowEntry({days,requestId,at,status:'in_progress',reason:'RUNNING',run,reused,processed:false,window:run.window||null});
  }
  if(!run){
    return windowEntry({days,requestId,at,status:'failed',reason:'SQUAD_ANALYSIS_RUN_MISSING',reused});
  }
  return windowEntry({
    days,requestId,at,status:run.status,reason:result.error?.code||run.error?.code||run.status,
    run,reused,reportAvailable:Boolean(result.report),window:run.window||null,
  });
}
function scheduledCycleReason(windows){
  const failure=windows.find(item=>item.status==='failed'||item.status==='interrupted');
  if(failure)return failure.reason||failure.status.toUpperCase();
  if(windows.length&&windows.every(item=>item.status==='skipped'))return windows[0].reason||'NO_NEW_RECORDS';
  if(windows.every(item=>item.status==='succeeded'))return 'PERIODIC_COMPLETE';
  return 'PERIODIC_INCOMPLETE';
}
function scheduledResults(windows){
  return Object.fromEntries(windows.map(item=>[String(item.days),{
    days:item.days,status:item.status,reason:item.reason,runId:item.runId,
    window:item.window,reportAvailable:item.reportAvailable,reused:item.reused,processed:item.processed,
  }]));
}
export async function runScheduledAnalysisOnce({home,now=new Date(),start=startAnalysis}={}){
  const at=now instanceof Date?now:new Date(now);
  await ensureAnalysisSchedule({home,now:at});
  const state=await readAnalysisState({home});
  if(!state.schedule?.enabled)return {ran:false,reason:'SCHEDULE_DISABLED',cycle:null,windows:[],results:{},advanced:false};
  const due=Date.parse(state.schedule.nextAt);
  if(!Number.isFinite(due))return {ran:false,reason:'NOT_DUE',cycle:null,windows:[],results:{},advanced:false};
  const cycle={key:scheduledCycleKey(due),dueAt:new Date(due).toISOString()};
  if(at.getTime()<due)return {ran:false,reason:'NOT_DUE',cycle,windows:[],results:{},advanced:false};
  await recoverInterruptedAnalysisRuns({home,now:at}).catch(()=>{});
  const windows=[];
  let busy=false;
  for(const days of SCHEDULE_WINDOWS){
    if(busy){
      windows.push(windowEntry({
        days,requestId:scheduledRequestId(cycle.key,days),at,status:'pending',reason:'BUSY',processed:false,
      }));
      continue;
    }
    const entry=await runScheduledWindow({home,start,at,due,days});
    windows.push(entry);
    if(entry.status==='busy')busy=true;
  }
  const processed=windows.length===SCHEDULE_WINDOWS.length&&windows.every(item=>item.processed);
  if(!processed){
    const reason=windows.some(item=>item.status==='busy')?'BUSY':'INCOMPLETE';
    return {
      ran:windows.some(item=>item.processed),reason,cycle,windows,results:scheduledResults(windows),
      advanced:false,schedule:{...state.schedule},
    };
  }
  const reason=scheduledCycleReason(windows);
  const schedule=await advanceAnalysisSchedule({
    home,now:at,reason,cycle:cycle.key,
    windows:windows.map(item=>({days:item.days,status:item.status,reason:item.reason,runId:item.runId})),
  });
  return {ran:true,reason,cycle,windows,results:scheduledResults(windows),advanced:true,schedule};
}

export function startAnalysisScheduler({home,intervalMs=60000,now=()=>new Date(),onError=null,start=startAnalysis}={}){
  if(scheduler){scheduler.stop();scheduler=null;}
  let busy=false,stopped=false;
  const tick=async()=>{
    if(busy||stopped)return;
    busy=true;
    try{await runScheduledAnalysisOnce({home,now:now(),start});}
    catch(error){if(onError)onError(error);}
    finally{busy=false;}
  };
  const timer=setInterval(()=>void tick(),Math.max(1000,Number(intervalMs)||60000));
  timer.unref?.();
  const immediate=setImmediate(()=>void tick());
  immediate.unref?.();
  const controller={
    stop(){if(stopped)return;stopped=true;clearInterval(timer);clearImmediate(immediate);if(scheduler===controller)scheduler=null;},
    tick,
  };
  scheduler=controller;
  return controller;
}
export async function stopAnalysisScheduler(){scheduler?.stop();scheduler=null;}

let worker=null,sequence=0;
const pending=new Map();
function workerRead(binding){
  if(!worker){
    const current=new Worker(new URL('./analysis-worker.mjs',import.meta.url));worker=current;current.unref();
    current.on('message',message=>{const call=pending.get(message.id);if(!call)return;pending.delete(message.id);if(message.error)call.reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else call.resolve(message.result);if(!pending.size)current.unref()});
    const fail=error=>{if(worker!==current)return;worker=null;for(const call of pending.values())call.reject(error);pending.clear()};
    current.on('error',fail);current.on('exit',code=>fail(new Error(`快照读取已结束 (${code})`)));
  }
  const result=new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.ref();worker.postMessage({id,kind:'snapshot',binding})});
  result.finally(()=>{}).catch(()=>{});return result;
}
export const snapshotInWorker=binding=>workerRead(binding);
export async function closeAnalysis(){
  const current=worker;worker=null;
  for(const call of pending.values())call.reject(new Error('页面服务已关闭'));
  pending.clear();
  if(current)await current.terminate();
}
