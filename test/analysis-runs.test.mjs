import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  acquireAnalysisLock,advanceAnalysisSchedule,analysisPaths,analysisWindow,beginAnalysisRun,
  compactRun,ensureAnalysisSchedule,failAnalysisRun,finishAnalysisRun,readAnalysisState,readAnalysisStateView,readLastSuccessful,
  readReport,readRun,readStatsPointer,readStatsSnapshot,recoverInterruptedAnalysisRuns,
  rememberSkippedRequest,rememberStatsSnapshot,requestLookup,updateRun,writeAnalysisState,writeEvidence,writeReport,
} from '../cli/lib/analysis-runs.mjs';
import {digestJson} from '../cli/lib/analysis-report.mjs';

async function home(){
  const directory=await mkdtemp(join(tmpdir(),'squad-runs-'));
  return {directory,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
const THREAD='11111111-1111-4111-8111-111111111111';

function reportFor(run,statsDigest='a'.repeat(64)){
  return {
    schemaVersion:1,runId:run.runId,trigger:run.trigger,window:run.window,generatedAt:'2026-10-26T00:00:00.000Z',
    statsObservedAt:'2026-10-26T00:00:00.000Z',sourceFingerprint:run.sourceFingerprint,statsDigest,evidenceDigest:'b'.repeat(64),
    realCodexThreadId:'thread-real-1',codexUrl:'codex://threads/thread-real-1',stats:{schemaVersion:1},analysis:{schemaVersion:1},
  };
}

test('analysis windows normalize only 7, 30 or all',()=>{
  const at=new Date('2026-10-26T12:00:00.000Z');
  assert.deepEqual(analysisWindow(7,at),{key:'7',days:7,from:'2026-10-19T12:00:00.000Z',to:'2026-10-26T12:00:00.000Z'});
  assert.equal(analysisWindow(30,at).key,'30');
  assert.equal(analysisWindow(null,at).from,null);
  assert.equal(analysisWindow(undefined,at).key,'all');
  assert.throws(()=>analysisWindow(14,at),/窗口/);
});

test('exclusive lock rejects a live owner and replaces a dead one',async()=>{
  const {directory,cleanup}=await home();
  try{
    const lock=await acquireAnalysisLock({home:directory});
    await assert.rejects(acquireAnalysisLock({home:directory}),error=>error.code==='SQUAD_ANALYSIS_BUSY');
    await lock.release();
    await mkdir(analysisPaths(directory).root,{recursive:true});
    await writeFile(analysisPaths(directory).lock,'999999999\n');
    await utimes(analysisPaths(directory).lock,new Date(0),new Date(0));
    const second=await acquireAnalysisLock({home:directory});
    await second.release();
  }finally{await cleanup()}
});

test('run lifecycle keeps history and last successful report per window',async()=>{
  const {directory,cleanup}=await home();
  try{
    const now=new Date('2026-10-26T10:00:00.000Z');
    const run=await beginAnalysisRun({
      home:directory,trigger:'manual',requestId:'manual-request-1',days:7,now,
      sourceFingerprint:'f'.repeat(64),requestedByThreadId:THREAD,
    });
    assert.equal(run.status,'running');
    assert.equal(run.phase,'collecting');
    assert.equal((await requestLookup({home:directory,requestId:'manual-request-1'}))?.runId,run.runId);
    assert.equal((await readAnalysisStateView({home:directory})).current.runId,run.runId);

    const report=reportFor(run);
    await writeReport(run.runId,report,{home:directory});
    await finishAnalysisRun({home:directory,run,report,now:new Date('2026-10-26T10:05:00.000Z')});

    const stored=await readRun(run.runId,{home:directory});
    assert.equal(stored.status,'succeeded');
    assert.equal(stored.phase,'completed');
    assert.equal(stored.reportAvailable,true);
    assert.equal(stored.realCodexThreadId,'thread-real-1');
    assert.equal(stored.endedAt,'2026-10-26T10:05:00.000Z');
    assert.equal((await readReport(run.runId,{home:directory})).runId,run.runId);

    const state=await readAnalysisState({home:directory});
    assert.equal(state.currentRunId,null);
    assert.equal(state.schedule.enabled,true);
    assert.equal(state.schedule.days,null);
    assert.equal(state.schedule.lastManualAt,'2026-10-26T00:00:00.000Z');
    assert.equal(state.schedule.nextAt,'2026-10-27T00:00:00.000Z');
    assert.equal(state.schedule.lastPeriodicAt,null);
    assert.equal(state.lastSuccessfulByWindow['7'].runId,run.runId);
    assert.equal(state.history[0].status,'succeeded');

    const previous=await readLastSuccessful({home:directory,days:7});
    assert.equal(previous.run.runId,run.runId);
    assert.equal(previous.entry.sourceFingerprint,'f'.repeat(64));
    assert.equal((await readLastSuccessful({home:directory,days:30})),null);

    const history=await readdir(analysisPaths(directory).runs);
    assert.deepEqual(history,[`${run.runId}.json`]);
    assert.equal((await compactRun(stored)).codexUrl,'codex://threads/thread-real-1');
  }finally{await cleanup()}
});

test('failed and interrupted runs never replace a successful report',async()=>{
  const {directory,cleanup}=await home();
  try{
    const success=await beginAnalysisRun({home:directory,trigger:'manual',requestId:'success-1',days:null,sourceFingerprint:'1'.repeat(64)});
    const successReport=reportFor(success);
    await writeReport(success.runId,successReport,{home:directory});
    await finishAnalysisRun({home:directory,run:success,report:successReport});

    const failed=await beginAnalysisRun({home:directory,trigger:'manual',requestId:'failed-1',days:null,sourceFingerprint:'2'.repeat(64)});
    await failAnalysisRun({home:directory,run:failed,code:'SQUAD_ANALYSIS_CODEX_FAILED',message:'失败'});
    assert.equal((await readRun(failed.runId,{home:directory})).status,'failed');
    assert.equal((await readLastSuccessful({home:directory,days:null})).run.runId,success.runId);

    const interrupted=await beginAnalysisRun({home:directory,trigger:'manual',requestId:'interrupted-1',days:null,sourceFingerprint:'3'.repeat(64)});
    await failAnalysisRun({home:directory,run:interrupted,code:'SQUAD_ANALYSIS_INTERRUPTED',message:'服务关闭',status:'interrupted'});
    const stored=await readRun(interrupted.runId,{home:directory});
    assert.equal(stored.status,'interrupted');
    assert.equal(stored.error.code,'SQUAD_ANALYSIS_INTERRUPTED');
    assert.equal((await readLastSuccessful({home:directory,days:null})).run.runId,success.runId);
    const state=await readAnalysisState({home:directory});
    assert.equal(state.currentRunId,null);
    assert.deepEqual(state.history.map(item=>item.status),['interrupted','failed','succeeded']);
  }finally{await cleanup()}
});

test('request replay and skipped receipts are idempotent',async()=>{
  const {directory,cleanup}=await home();
  try{
    const run=await beginAnalysisRun({home:directory,trigger:'manual',requestId:'same-request',days:7,sourceFingerprint:'4'.repeat(64)});
    const first=await requestLookup({home:directory,requestId:'same-request'});
    const second=await requestLookup({home:directory,requestId:'same-request'});
    assert.deepEqual(first,second);
    assert.equal(first.runId,run.runId);
    assert.equal((await readAnalysisState({home:directory})).history.length,1);

    await rememberSkippedRequest({home:directory,requestId:'skip-request',runId:run.runId,reason:'NO_NEW_RECORDS'});
    const skipped=await requestLookup({home:directory,requestId:'skip-request'});
    assert.deepEqual({kind:skipped.kind,runId:skipped.runId,reason:skipped.reason},{kind:'skipped',runId:run.runId,reason:'NO_NEW_RECORDS'});
    assert.equal((await readAnalysisState({home:directory})).history.length,1);
  }finally{await cleanup()}
});

test('state view exposes compact history without raw owner or stats',async()=>{
  const {directory,cleanup}=await home();
  try{
    const run=await beginAnalysisRun({home:directory,trigger:'schedule',requestId:'schedule-1',days:30,sourceFingerprint:'5'.repeat(64)});
    await updateRun(run,{home:directory});
    const view=await readAnalysisStateView({home:directory});
    assert.equal(view.schemaVersion,1);
    assert.equal(view.current.runId,run.runId);
    assert.equal(view.current.days,30);
    assert.equal('ownerPid' in view.current,false);
    assert.equal('statsDigest' in view.current,false);
    assert.equal(view.history.length,1);
    assert.equal(view.schedule.enabled,false);
    assert.equal(view.lastSuccessful,null);
  }finally{await cleanup()}
});

test('recovery marks dead running runs interrupted and keeps successes',async()=>{
  const {directory,cleanup}=await home();
  try{
    const success=await beginAnalysisRun({home:directory,trigger:'manual',requestId:'ok-1',days:7,sourceFingerprint:'6'.repeat(64)});
    const successReport=reportFor(success);
    await writeReport(success.runId,successReport,{home:directory});
    await finishAnalysisRun({home:directory,run:success,report:successReport});

    const orphan=await beginAnalysisRun({home:directory,trigger:'schedule',requestId:'orphan-1',days:7,sourceFingerprint:'7'.repeat(64)});
    const file=join(analysisPaths(directory).runs,`${orphan.runId}.json`);
    const raw=JSON.parse(await readFile(file,'utf8'));
    raw.ownerPid=999999999;
    await writeFile(file,`${JSON.stringify(raw)}\n`);

    const recovered=await recoverInterruptedAnalysisRuns({home:directory,now:new Date('2026-10-26T11:00:00.000Z')});
    assert.equal(recovered.recovered,true);
    const stored=await readRun(orphan.runId,{home:directory});
    assert.equal(stored.status,'interrupted');
    assert.equal(stored.reportAvailable,false);
    assert.equal((await readAnalysisState({home:directory})).currentRunId,null);
    assert.equal((await readLastSuccessful({home:directory,days:7})).run.runId,success.runId);
  }finally{await cleanup()}
});

test('periodic schedule advances only when enabled',async()=>{
  const {directory,cleanup}=await home();
  try{
    const now=new Date('2026-10-26T12:00:00.000Z');
    assert.equal((await advanceAnalysisSchedule({home:directory,now})).enabled,false);
    await writeAnalysisState({
      schemaVersion:1,currentRunId:null,requestIndex:{},history:[],lastSuccessfulByWindow:{},
      schedule:{enabled:true,days:7,nextAt:now.toISOString(),lastManualAt:now.toISOString(),lastPeriodicAt:null},
    },{home:directory});
    const schedule=await advanceAnalysisSchedule({
      home:directory,now,reason:'NO_NEW_RECORDS',cycle:now.toISOString(),
      windows:[{days:7,status:'skipped'},{days:30,status:'skipped'}],
    });
    assert.equal(schedule.days,null);
    assert.equal(schedule.nextAt,'2026-10-27T12:00:00.000Z');
    assert.equal(schedule.lastPeriodicAt,'2026-10-26T12:00:00.000Z');
    assert.equal(schedule.lastPeriodicReason,'NO_NEW_RECORDS');
    assert.equal(schedule.lastPeriodicCycle,now.toISOString());
    assert.deepEqual(schedule.lastPeriodicWindows,[{days:7,status:'skipped'},{days:30,status:'skipped'}]);
  }finally{await cleanup()}
});

test('only a new install gets an enabled periodic plan; explicit disable and existing due times stay untouched',async()=>{
  const {directory,cleanup}=await home();
  try{
    const now=new Date('2026-10-26T12:00:00.000Z');
    const created=await ensureAnalysisSchedule({home:directory,now});
    assert.equal(created.created,true);
    assert.equal(created.schedule.enabled,true);
    assert.equal(created.schedule.days,null);
    assert.equal(created.schedule.nextAt,now.toISOString());

    const later=new Date('2026-10-27T12:00:00.000Z');
    assert.equal((await ensureAnalysisSchedule({home:directory,now:later})).schedule.nextAt,now.toISOString());

    await writeAnalysisState({
      schemaVersion:1,currentRunId:null,requestIndex:{},history:[],lastSuccessfulByWindow:{},
      schedule:{enabled:false,days:null,nextAt:null,lastManualAt:null,lastPeriodicAt:null},
    },{home:directory});
    const disabled=await ensureAnalysisSchedule({home:directory,now});
    assert.equal(disabled.created,false);
    assert.equal(disabled.schedule.enabled,false);
    assert.equal(disabled.schedule.nextAt,null);

    await writeAnalysisState({
      schemaVersion:1,currentRunId:null,requestIndex:{},history:[],lastSuccessfulByWindow:{},
      schedule:{enabled:true,days:7,nextAt:null,lastManualAt:null,lastPeriodicAt:null},
    },{home:directory});
    const repaired=await ensureAnalysisSchedule({home:directory,now});
    assert.equal(repaired.repaired,true);
    assert.equal(repaired.schedule.enabled,true);
    assert.equal(repaired.schedule.days,null);
    assert.equal(repaired.schedule.nextAt,now.toISOString());
  }finally{await cleanup()}
});

test('a successful manual run enables a disabled plan without moving an enabled one',async()=>{
  const {directory,cleanup}=await home();
  try{
    const now=new Date('2026-10-26T10:00:00.000Z');
    await writeAnalysisState({
      schemaVersion:1,currentRunId:null,requestIndex:{},history:[],lastSuccessfulByWindow:{},
      schedule:{enabled:true,days:7,nextAt:'2026-10-27T08:00:00.000Z',lastManualAt:null,lastPeriodicAt:null},
    },{home:directory});
    const run=await beginAnalysisRun({home:directory,trigger:'manual',requestId:'manual-does-not-advance',days:7,now,sourceFingerprint:'8'.repeat(64)});
    const report=reportFor(run);
    await writeReport(run.runId,report,{home:directory});
    await finishAnalysisRun({home:directory,run,report,now:new Date('2026-10-26T10:05:00.000Z')});
    const state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.nextAt,'2026-10-27T08:00:00.000Z');
    assert.equal(state.schedule.days,null);
    assert.equal(state.schedule.lastManualAt,report.generatedAt);
    assert.equal(state.schedule.lastPeriodicAt,null);

    await writeAnalysisState({...state,schedule:{...state.schedule,enabled:false,nextAt:null}},{home:directory});
    const enabledRun=await beginAnalysisRun({home:directory,trigger:'manual',requestId:'manual-enables-plan',days:30,now,sourceFingerprint:'9'.repeat(64)});
    const enabledReport=reportFor(enabledRun);
    await writeReport(enabledRun.runId,enabledReport,{home:directory});
    await finishAnalysisRun({home:directory,run:enabledRun,report:enabledReport,now:new Date('2026-10-26T10:05:00.000Z')});
    const enabled=await readAnalysisState({home:directory});
    assert.equal(enabled.schedule.enabled,true);
    assert.equal(enabled.schedule.days,null);
    assert.equal(enabled.schedule.nextAt,'2026-10-27T00:00:00.000Z');
  }finally{await cleanup()}
});

test('stats snapshot pointers stay per window, survive failure and read legacy state',async()=>{
  const {directory,cleanup}=await home();
  try{
    await mkdir(analysisPaths(directory).root,{recursive:true});
    await writeFile(analysisPaths(directory).state,JSON.stringify({
      schemaVersion:1,currentRunId:null,requestIndex:{},history:[],lastSuccessfulByWindow:{},
      schedule:{enabled:false,days:null,nextAt:null,lastManualAt:null,lastPeriodicAt:null},
    }));
    assert.deepEqual((await readAnalysisState({home:directory})).statsByWindow,{});
    assert.equal(await readStatsPointer({home:directory,days:7}),null);

    const run=await beginAnalysisRun({
      home:directory,trigger:'manual',requestId:'snapshot-run-1',days:7,
      now:new Date('2026-10-26T12:00:00.000Z'),sourceFingerprint:'a'.repeat(64),
    });
    const stats={schemaVersion:1,observedAt:'2026-10-26T11:00:00.000Z',metrics:{taskCount:2}};
    const statsDigest=digestJson(stats);
    await writeEvidence(run.runId,{
      schemaVersion:1,runId:run.runId,window:run.window,sourceFingerprint:run.sourceFingerprint,
      statsDigest,stats,
    },{home:directory});
    const pointer=await rememberStatsSnapshot({home:directory,run,stats,statsDigest});
    assert.equal(pointer.runId,run.runId);
    assert.equal(pointer.statsDigest,statsDigest);

    const snapshot=await readStatsSnapshot({home:directory,days:7});
    assert.equal(snapshot.runId,run.runId);
    assert.equal(snapshot.statsDigest,statsDigest);
    assert.equal(snapshot.stats.metrics.taskCount,2);
    assert.equal(snapshot.statsObservedAt,'2026-10-26T11:00:00.000Z');
    assert.equal(await readStatsSnapshot({home:directory,days:30}),null);
    assert.equal(await readStatsSnapshot({home:directory,days:null}),null);

    await failAnalysisRun({
      home:directory,run,code:'SQUAD_ANALYSIS_CODEX_FAILED',message:'模型失败',
      now:new Date('2026-10-26T12:01:00.000Z'),
    });
    assert.equal((await readStatsPointer({home:directory,days:7})).runId,run.runId);
    assert.equal((await readStatsSnapshot({home:directory,days:7})).stats.metrics.taskCount,2);
    assert.equal((await readAnalysisState({home:directory})).currentRunId,null);

    await writeEvidence(run.runId,{
      schemaVersion:1,runId:run.runId,window:run.window,sourceFingerprint:run.sourceFingerprint,
      statsDigest,stats:{...stats,metrics:{taskCount:9}},
    },{home:directory});
    assert.equal(await readStatsSnapshot({home:directory,days:7}),null);
  }finally{await cleanup()}
});
