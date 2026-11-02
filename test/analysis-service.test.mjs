import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  analysisRunDetail,analysisRunsView,cheapSourceFingerprint,interruptActiveAnalysis,
  loadAnalysisSources,runScheduledAnalysisOnce,savedAnalytics,startAnalysis,startAnalysisScheduler,
  stopAnalysisScheduler,
} from '../cli/lib/analysis-service.mjs';
import {
  analysisPaths,readAnalysisState,readEvidence,readLastSuccessful,readReport,readRun,
  recoverInterruptedAnalysisRuns,writeAnalysisState,
} from '../cli/lib/analysis-runs.mjs';

const THREAD='55555555-5555-4555-8555-555555555555';
const NOW=new Date('2026-10-26T12:00:00.000Z');

function snapshot(overrides={}){
  return {
    schemaVersion:1,connected:true,observedAt:'2026-10-26T11:00:00.000Z',
    binding:{threadId:THREAD,workspace:'/Users/private/worktree',projectId:'p',parentWorkId:'w',title:'登录修复小队'},
    members:[],cursor:'cursor-1',
    tasks:[{
      id:'task-a',title:'修复登录',memberId:'member-1',status:'completed',acceptance:null,
      attempts:[{
        id:'attempt-a',index:1,status:'completed',startedAt:'2026-10-26T10:00:00.000Z',endedAt:'2026-10-26T10:10:00.000Z',
        sessionId:'qoder-session',model:'configured-model',actualModel:null,
        usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,totalTokens:12},
        handoff:{goal:'解决登录失败并补齐验证'},
        events:[{id:'bash-1',kind:'tool_use',toolName:'Bash',text:'node --test',status:'SUCCEEDED'}],
        result:null,error:null,
      }],
    }],
    ...overrides,
  };
}
const ANALYSIS={
  schemaVersion:1,summary:'本机小队近 7 天的分析摘要。',
  categories:{skills_tools:[],time:[],tokens:[]},
  sessionDescriptions:[{threadId:THREAD,title:'登录修复',description:'围绕登录失败完成修复并补齐验证。',representativeTaskIds:['task-a']}],
  benefitMatches:[],
};
function providers({fingerprint='f1',sourceCount=1,views=[snapshot()]}={}){
  return {
    fingerprintProvider:async()=>({fingerprint,sourceCount}),
    sourceLoader:async()=>({views,expected:views.length,unavailable:[]}),
  };
}
function runnerOk(counter){
  return async()=>{
    counter.count+=1;
    return {
      realCodexThreadId:'thread-real-1',analysis:structuredClone(ANALYSIS),outputText:JSON.stringify(ANALYSIS),
      usage:{input_tokens:12,total_tokens:17},exitCode:0,signal:null,
      eventTypes:['thread.started','turn.completed'],stderrBytes:0,
    };
  };
}
async function home(){
  const directory=await mkdtemp(join(tmpdir(),'squad-service-'));
  return {directory,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
function options(directory,input={}){
  return {home:directory,codexHome:join(directory,'codex-home'),requestId:'request-0001',days:7,now:NOW,...input};
}
function taskFixture(id,index=0){
  return {
    id,title:`任务 ${id}`,memberId:'member-1',status:'completed',acceptance:null,
    attempts:[{
      id:`${id}-attempt`,index:1,status:'completed',
      startedAt:`2026-10-26T0${index}:00:00.000Z`,endedAt:`2026-10-26T0${index}:10:00.000Z`,
      sessionId:`qoder-session-${index}`,model:'configured-model',actualModel:null,
      usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,totalTokens:12},
      handoff:{goal:'解决登录失败并补齐验证'},events:[],result:null,error:null,
    }],
  };
}
function snapshotOf(count){
  const tasks=[taskFixture('task-a',0)];
  for(let index=1;index<count;index+=1)tasks.push(taskFixture(`task-${index}`,index));
  return snapshot({tasks});
}
async function waitFor(check,{timeoutMs=2000}={}){
  const started=Date.now();
  for(;;){
    const value=await check();
    if(value)return value;
    if(Date.now()-started>timeoutMs)throw new Error('等待分析状态超时');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
function analysisFor(count){
  if(count<=1)return structuredClone(ANALYSIS);
  return {...structuredClone(ANALYSIS),sessionDescriptions:[]};
}

test('cheap fingerprint only reads bindings and tracks new records',async()=>{
  const {directory,cleanup}=await home();
  try{
    const codexHome=join(directory,'codex-home');
    const empty=await cheapSourceFingerprint({home:directory,codexHome});
    assert.equal(empty.sourceCount,0);
    await mkdir(join(directory,'bindings'),{recursive:true});
    await writeFile(join(directory,'bindings',`${THREAD}.json`),'{"v":1}\n');
    await writeFile(join(directory,'bindings','notes.txt'),'ignored');
    const first=await cheapSourceFingerprint({home:directory,codexHome});
    assert.equal(first.sourceCount,1);
    await writeFile(join(directory,'bindings',`${THREAD}.json`),'{"v":2}\n');
    const second=await cheapSourceFingerprint({home:directory,codexHome});
    assert.equal(second.sourceCount,1);
    assert.notEqual(first.fingerprint,second.fingerprint);
  }finally{await cleanup()}
});

test('source loader isolates unavailable bindings instead of failing the round',async()=>{
  const {directory,cleanup}=await home();
  try{
    await mkdir(join(directory,'bindings'),{recursive:true});
    const other='66666666-6666-4666-8666-666666666666';
    await writeFile(join(directory,'bindings',`${THREAD}.json`),'{}\n');
    await writeFile(join(directory,'bindings',`${other}.json`),'{}\n');
    const loaded=await loadAnalysisSources({
      home:directory,
      readBinding:async id=>({threadId:id,workspace:'/tmp'}),
      snapshot:async binding=>{
        if(binding.threadId===other)throw Object.assign(new Error('down'),{code:'SQUAD_ANALYSIS_SOURCE_UNAVAILABLE'});
        return snapshot();
      },
    });
    assert.equal(loaded.expected,2);
    assert.equal(loaded.views.length,1);
    assert.deepEqual(loaded.unavailable,[{threadId:other,code:'SQUAD_ANALYSIS_SOURCE_UNAVAILABLE'}]);
  }finally{await cleanup()}
});

test('no source records or no tasks skip without creating a Codex run',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const noSource=await startAnalysis(options(directory,{
      requestId:'request-nosource',days:30,...providers({fingerprint:'f0',sourceCount:0}),runner:runnerOk(counter),
    }));
    assert.deepEqual({skipped:noSource.skipped,reason:noSource.reason,run:noSource.run},{skipped:true,reason:'NO_SOURCE_RECORDS',run:null});
    assert.equal(counter.count,0);

    const noTasks=await startAnalysis(options(directory,{
      requestId:'request-notasks',
      ...providers({fingerprint:'f-empty',views:[snapshot({tasks:[]})]}),runner:runnerOk(counter),
    }));
    assert.equal(noTasks.skipped,false);
    const noTaskResult=await noTasks.completion;
    assert.equal(noTaskResult.skipped,true);
    assert.equal(noTaskResult.reason,'NO_ANALYSIS_RECORDS');
    assert.equal(noTaskResult.run,null);
    assert.equal(counter.count,0);
    assert.equal((await readAnalysisState({home:directory})).history.length,0);
    assert.equal((await readAnalysisState({home:directory})).currentRunId,null);
  }finally{await cleanup()}
});

test('manual run freezes stats, publishes a report and replays the same requestId',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const result=await startAnalysis(options(directory,{...providers(),runner:runnerOk(counter)}));
    assert.equal(result.skipped,false);
    assert.equal(result.run.status,'running');
    const completed=await result.completion;
    assert.equal(completed.error,undefined);
    assert.equal(completed.run.status,'succeeded');
    assert.equal(completed.run.realCodexThreadId,'thread-real-1');
    assert.equal(completed.run.codexUrl,'codex://threads/thread-real-1');
    assert.equal(counter.count,1);

    const stored=await readRun(result.run.runId,{home:directory});
    assert.equal(stored.status,'succeeded');
    assert.equal(stored.trigger,'manual');
    assert.equal(stored.days,7);
    assert.equal(stored.source.threads,1);
    assert.equal(stored.source.tasks,1);
    assert.equal(stored.source.attempts,1);
    const report=await readReport(result.run.runId,{home:directory});
    assert.equal(report.stats.metrics.taskCount,1);
    assert.equal(report.analysis.summary,ANALYSIS.summary);
    assert.equal(report.statsDigest,stored.statsDigest);
    assert.equal(report.evidenceDigest,stored.evidenceDigest);

    const saved=await savedAnalytics({}, {days:7}, {home:directory});
    assert.equal(saved.scope,'global');
    assert.equal(saved.metrics.taskCount,1);
    assert.equal(saved.tokens.totalTokens,12);
    assert.equal(saved.analysis.available,true);
    assert.equal(saved.analysis.statsAvailable,true);
    assert.equal(saved.analysis.runId,result.run.runId);
    assert.equal(saved.analysis.codexThreadId,'thread-real-1');
    assert.equal(saved.analysis.sessionDescriptions[0].threadId,THREAD);

    const replay=await startAnalysis(options(directory,{...providers({fingerprint:'other'}),runner:runnerOk(counter)}));
    assert.equal(replay.reused,true);
    assert.equal(replay.skipped,false);
    assert.equal(replay.run.runId,result.run.runId);
    assert.equal(replay.completion,null);
    assert.equal(counter.count,1);

    const state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.enabled,true);
    assert.equal(state.schedule.days,null);
    assert.equal(state.schedule.nextAt,'2026-10-27T12:00:00.000Z');
    assert.deepEqual(await readdir(join(analysisPaths(directory).work)),[]);
    const detail=await analysisRunDetail({home:directory,runId:result.run.runId,origin:'http://127.0.0.1:57999'});
    assert.equal(detail.run.status,'succeeded');
    assert.equal(detail.report.analysis.available,true);
    assert.equal(await analysisRunDetail({home:directory,runId:'77777777-7777-4777-8777-777777777777'}),null);
    assert.equal((await analysisRunsView({home:directory})).lastSuccessful.runId,result.run.runId);
  }finally{await cleanup()}
});

test('same source fingerprint skips the next round with the last report',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const first=await startAnalysis(options(directory,{...providers(),runner:runnerOk(counter)}));
    await first.completion;
    const skipped=await startAnalysis(options(directory,{
      requestId:'request-0002',...providers(),runner:runnerOk(counter),
    }));
    assert.equal(skipped.skipped,true);
    assert.equal(skipped.reason,'NO_NEW_RECORDS');
    assert.equal(skipped.run.runId,first.run.runId);
    assert.equal(counter.count,1);
    assert.equal((await readAnalysisState({home:directory})).history.length,1);
  }finally{await cleanup()}
});

test('a busy global round rejects a second start and failure keeps the last success',async()=>{
  const {directory,cleanup}=await home();
  try{
    let release;
    const gate=new Promise(resolve=>{release=resolve});
    const slowRunner=async()=>{
      await gate;
      return {realCodexThreadId:'thread-real-2',analysis:structuredClone(ANALYSIS),exitCode:0,eventTypes:[],stderrBytes:0};
    };
    const first=await startAnalysis(options(directory,{...providers(),runner:slowRunner}));
    await assert.rejects(
      startAnalysis(options(directory,{requestId:'request-busy',...providers(),runner:runnerOk({count:0})})),
      error=>error.code==='SQUAD_ANALYSIS_BUSY'
    );
    release();
    const completed=await first.completion;
    assert.equal(completed.run.status,'succeeded');

    const failed=await startAnalysis(options(directory,{
      requestId:'request-fail',...providers({fingerprint:'f2'}),runner:async()=>{throw Object.assign(new Error('Codex 失败'),{code:'SQUAD_ANALYSIS_CODEX_FAILED'})},
    }));
    const failure=await failed.completion;
    assert.equal(failure.run.status,'failed');
    assert.equal(failure.error.code,'SQUAD_ANALYSIS_CODEX_FAILED');
    assert.equal(failure.report,null);
    assert.equal((await readLastSuccessful({home:directory,days:7})).run.runId,first.run.runId);
    const failedStored=await readRun(failed.run.runId,{home:directory});
    const saved=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(saved.metrics.taskCount,1);
    assert.equal(saved.analysis.statsAvailable,true);
    assert.equal(saved.analysis.available,false);
    assert.equal(saved.analysis.runId,failed.run.runId);
    assert.equal(saved.analysis.latestRun.runId,failed.run.runId);
    assert.equal(saved.analysis.latestRun.status,'failed');
    assert.equal(saved.analysis.statFingerprint,failedStored.statsDigest);
    assert.equal(saved.analysis.summary,undefined);
  }finally{await cleanup()}
});

test('interrupt active analysis records interrupted without publishing',async()=>{
  const {directory,cleanup}=await home();
  try{
    const runner=({signal})=>new Promise((resolve,reject)=>{
      const abort=()=>reject(Object.assign(new Error('分析服务关闭，本轮分析已中止。'),{code:'SQUAD_ANALYSIS_INTERRUPTED'}));
      if(signal.aborted)abort();
      else signal.addEventListener('abort',abort,{once:true});
    });
    const started=await startAnalysis(options(directory,{...providers(),runner}));
    await waitFor(async()=>{
      const run=await readRun(started.run.runId,{home:directory});
      return run?.phase==='analyzing'?run:null;
    });
    const completed=await interruptActiveAnalysis();
    assert.equal(completed.run.status,'interrupted');
    assert.equal(completed.report,null);
    assert.equal((await readRun(started.run.runId,{home:directory})).status,'interrupted');
    assert.equal(await readReport(started.run.runId,{home:directory}),null);
    assert.equal((await readLastSuccessful({home:directory,days:7})),null);
    const saved=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(saved.analysis.available,false);
    assert.equal(saved.analysis.statsAvailable,true);
    assert.equal(saved.analysis.reason,'SQUAD_ANALYSIS_INTERRUPTED');
  }finally{await cleanup()}
});

function scheduledStart(directory,counter,{failDays=[],fingerprints={}}={}){
  return args=>startAnalysis({
    ...args,
    codexHome:join(directory,'codex-home'),
    fingerprintProvider:async()=>({fingerprint:fingerprints[args.days]||`fp-${args.days}`,sourceCount:1}),
    sourceLoader:async()=>({views:[snapshotOf(args.days===30?2:1)],expected:1,unavailable:[]}),
    runner:async()=>{
      counter.count+=1;
      if(failDays.includes(args.days))throw Object.assign(new Error('Codex 失败'),{code:'SQUAD_ANALYSIS_CODEX_FAILED'});
      return {
        realCodexThreadId:`thread-real-${args.days}`,analysis:analysisFor(args.days===30?2:1),
        outputText:'',usage:{input_tokens:1,total_tokens:1},exitCode:0,signal:null,eventTypes:[],stderrBytes:0,
      };
    },
  });
}

test('a new install becomes due with both windows while reads stay read-only',async()=>{
  const {directory,cleanup}=await home();
  try{
    const before=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(before.analysis.available,false);
    await assert.rejects(readFile(analysisPaths(directory).state),error=>error.code==='ENOENT');

    const calls=[];
    const start=async args=>{
      calls.push(args);
      return {skipped:true,reason:'NO_SOURCE_RECORDS',run:null,report:null};
    };
    const first=await runScheduledAnalysisOnce({home:directory,now:NOW,start});
    assert.equal(first.ran,true);
    assert.equal(first.advanced,true);
    assert.deepEqual(first.windows.map(item=>item.days),[7,30]);
    assert.deepEqual(first.windows.map(item=>item.requestId),[
      `schedule:${NOW.toISOString()}:7`,
      `schedule:${NOW.toISOString()}:30`,
    ]);
    assert.deepEqual(first.windows.map(item=>item.window.key),['7','30']);
    assert.deepEqual(first.windows.map(item=>item.status),['skipped','skipped']);
    assert.deepEqual(first.windows.map(item=>item.reason),['NO_SOURCE_RECORDS','NO_SOURCE_RECORDS']);
    assert.equal(calls.length,2);

    const state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.enabled,true);
    assert.equal(state.schedule.days,null);
    assert.equal(state.schedule.nextAt,'2026-10-27T12:00:00.000Z');
    assert.equal(state.schedule.lastPeriodicCycle,NOW.toISOString());

    const second=await runScheduledAnalysisOnce({home:directory,now:new Date(NOW.getTime()+60000),start});
    assert.equal(second.reason,'NOT_DUE');
    assert.equal(second.advanced,false);
    assert.equal(calls.length,2);
  }finally{await cleanup()}
});

test('one due cycle completes 7 then 30 with separate reports, stats and one advance',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const result=await runScheduledAnalysisOnce({home:directory,now:NOW,start:scheduledStart(directory,counter)});
    assert.equal(result.ran,true);
    assert.equal(result.advanced,true);
    assert.deepEqual(result.windows.map(item=>item.days),[7,30]);
    assert.deepEqual(result.windows.map(item=>item.status),['succeeded','succeeded']);
    assert.ok(result.windows.every(item=>item.reportAvailable));
    assert.equal(new Set(result.windows.map(item=>item.runId)).size,2);
    assert.equal(counter.count,2);

    const seven=await readLastSuccessful({home:directory,days:7});
    const thirty=await readLastSuccessful({home:directory,days:30});
    assert.equal(seven.run.runId,result.windows[0].runId);
    assert.equal(thirty.run.runId,result.windows[1].runId);
    assert.notEqual(seven.run.statsDigest,thirty.run.statsDigest);

    const view7=await savedAnalytics({},{days:7},{home:directory});
    const view30=await savedAnalytics({},{days:30},{home:directory});
    assert.equal(view7.metrics.taskCount,1);
    assert.equal(view30.metrics.taskCount,2);
    assert.equal(view7.analysis.runId,seven.run.runId);
    assert.equal(view30.analysis.runId,thirty.run.runId);
    assert.equal(view7.analysis.statFingerprint,seven.run.statsDigest);
    assert.equal(view30.analysis.statFingerprint,thirty.run.statsDigest);
    assert.equal((await readReport(seven.run.runId,{home:directory})).runId,seven.run.runId);
    assert.equal((await readReport(thirty.run.runId,{home:directory})).runId,thirty.run.runId);

    const state=await readAnalysisState({home:directory});
    assert.equal(state.lastSuccessfulByWindow['7'].runId,seven.run.runId);
    assert.equal(state.lastSuccessfulByWindow['30'].runId,thirty.run.runId);
    assert.equal(state.schedule.nextAt,'2026-10-27T12:00:00.000Z');
    assert.equal(state.schedule.lastPeriodicAt,NOW.toISOString());
    assert.deepEqual(state.schedule.lastPeriodicWindows.map(item=>[item.days,item.status]),[[7,'succeeded'],[30,'succeeded']]);
  }finally{await cleanup()}
});

test('one failed window does not block the other or borrow its report',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const start=scheduledStart(directory,counter,{failDays:[7]});
    const result=await runScheduledAnalysisOnce({home:directory,now:NOW,start});
    assert.equal(result.ran,true);
    assert.equal(result.advanced,true);
    assert.deepEqual(result.windows.map(item=>item.days),[7,30]);
    assert.deepEqual(result.windows.map(item=>item.status),['failed','succeeded']);
    assert.equal(result.windows[0].reason,'SQUAD_ANALYSIS_CODEX_FAILED');
    assert.equal(result.windows[0].reportAvailable,false);
    assert.equal(result.windows[1].reportAvailable,true);
    assert.equal(counter.count,2);
    assert.equal(await readLastSuccessful({home:directory,days:7}),null);
    assert.equal((await readLastSuccessful({home:directory,days:30})).run.runId,result.windows[1].runId);

    const view7=await savedAnalytics({},{days:7},{home:directory});
    const view30=await savedAnalytics({},{days:30},{home:directory});
    assert.equal(view7.analysis.available,false);
    assert.equal(view7.analysis.statsAvailable,true);
    assert.equal(view7.analysis.runId,result.windows[0].runId);
    assert.notEqual(view7.analysis.runId,view30.analysis.runId);
    assert.equal(view30.analysis.available,true);
    assert.equal(view30.metrics.taskCount,2);
    assert.equal(JSON.stringify(view7).includes(view30.analysis.summary),false);

    const state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.nextAt,'2026-10-27T12:00:00.000Z');
    assert.equal(state.schedule.lastPeriodicReason,'SQUAD_ANALYSIS_CODEX_FAILED');

    const again=await runScheduledAnalysisOnce({
      home:directory,now:new Date(NOW.getTime()+60000),
      start:()=>{throw new Error('失败窗口不应在每个 tick 重跑')},
    });
    assert.equal(again.reason,'NOT_DUE');
    assert.equal(again.advanced,false);
    assert.equal(counter.count,2);

    const nextCycle=await runScheduledAnalysisOnce({
      home:directory,now:new Date(state.schedule.nextAt),start,
    });
    assert.deepEqual(nextCycle.windows.map(item=>[item.days,item.status]),[[7,'failed'],[30,'skipped']]);
    assert.equal(counter.count,3);
    assert.equal(nextCycle.advanced,true);
  }finally{await cleanup()}
});

test('unchanged windows both skip without a model run and advance once',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const start=scheduledStart(directory,counter);
    const first=await runScheduledAnalysisOnce({home:directory,now:NOW,start});
    assert.equal(first.advanced,true);
    assert.equal(counter.count,2);

    const due=first.schedule.nextAt;
    const skipped=await runScheduledAnalysisOnce({home:directory,now:new Date(due),start});
    assert.equal(skipped.ran,true);
    assert.equal(skipped.advanced,true);
    assert.deepEqual(skipped.windows.map(item=>item.status),['skipped','skipped']);
    assert.deepEqual(skipped.windows.map(item=>item.reason),['NO_NEW_RECORDS','NO_NEW_RECORDS']);
    assert.equal(skipped.windows[0].runId,first.windows[0].runId);
    assert.equal(skipped.windows[1].runId,first.windows[1].runId);
    assert.equal(counter.count,2);

    const state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.lastPeriodicReason,'NO_NEW_RECORDS');
    assert.equal(state.schedule.lastPeriodicCycle,due);
    assert.equal(state.schedule.nextAt,'2026-10-28T12:00:00.000Z');
    assert.equal(state.history.filter(item=>item.status==='succeeded').length,2);
    const runSeven=await readRun(first.windows[0].runId,{home:directory});
    const runThirty=await readRun(first.windows[1].runId,{home:directory});
    assert.equal(state.statsByWindow['7'].statsDigest,runSeven.statsDigest);
    assert.equal(state.statsByWindow['30'].statsDigest,runThirty.statsDigest);
    assert.notEqual(state.statsByWindow['7'].statsDigest,state.statsByWindow['30'].statsDigest);
  }finally{await cleanup()}
});

test('BUSY stops the cycle and the same due time resumes without repeating the finished window',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const runStart=scheduledStart(directory,counter);
    const busyStart=async args=>{
      if(args.days===30)throw Object.assign(new Error('另一轮分析正在执行'),{code:'SQUAD_ANALYSIS_BUSY'});
      return runStart(args);
    };
    const first=await runScheduledAnalysisOnce({home:directory,now:NOW,start:busyStart});
    assert.equal(first.ran,true);
    assert.equal(first.advanced,false);
    assert.deepEqual(first.windows.map(item=>[item.days,item.status]),[[7,'succeeded'],[30,'busy']]);
    assert.equal(counter.count,1);
    const sevenRunId=first.windows[0].runId;
    let state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.nextAt,NOW.toISOString());
    assert.equal(state.schedule.lastPeriodicAt,null);

    const resumed=await runScheduledAnalysisOnce({
      home:directory,now:new Date(NOW.getTime()+60000),start:runStart,
    });
    assert.equal(resumed.advanced,true);
    assert.deepEqual(resumed.windows.map(item=>item.days),[7,30]);
    assert.deepEqual(resumed.windows.map(item=>item.status),['succeeded','succeeded']);
    assert.equal(resumed.windows[0].runId,sevenRunId);
    assert.equal(resumed.windows[0].reused,true);
    assert.equal(resumed.windows[1].reused,false);
    assert.equal(counter.count,2);
    assert.equal(resumed.schedule.nextAt,'2026-10-27T12:01:00.000Z');
    state=await readAnalysisState({home:directory});
    assert.deepEqual(state.schedule.lastPeriodicWindows.map(item=>[item.days,item.status]),[[7,'succeeded'],[30,'succeeded']]);
  }finally{await cleanup()}
});

test('BUSY on the first window leaves both intervals for the next tick',async()=>{
  const {directory,cleanup}=await home();
  try{
    const counter={count:0};
    const runStart=scheduledStart(directory,counter);
    const first=await runScheduledAnalysisOnce({
      home:directory,now:NOW,
      start:async()=>{throw Object.assign(new Error('另一轮分析正在执行'),{code:'SQUAD_ANALYSIS_BUSY'})},
    });
    assert.equal(first.ran,false);
    assert.equal(first.advanced,false);
    assert.deepEqual(first.windows.map(item=>[item.days,item.status]),[[7,'busy'],[30,'pending']]);
    assert.equal(first.windows[1].requestId,`schedule:${NOW.toISOString()}:30`);
    assert.equal(counter.count,0);

    const resumed=await runScheduledAnalysisOnce({
      home:directory,now:new Date(NOW.getTime()+60000),start:runStart,
    });
    assert.equal(resumed.advanced,true);
    assert.deepEqual(resumed.windows.map(item=>[item.days,item.status]),[[7,'succeeded'],[30,'succeeded']]);
    assert.equal(counter.count,2);
  }finally{await cleanup()}
});

test('an explicit disabled schedule is respected by ticks and reads',async()=>{
  const {directory,cleanup}=await home();
  try{
    await writeAnalysisState({
      schemaVersion:1,currentRunId:null,requestIndex:{},history:[],lastSuccessfulByWindow:{},
      schedule:{enabled:false,days:null,nextAt:null,lastManualAt:null,lastPeriodicAt:null},
    },{home:directory});
    const calls=[];
    const start=async args=>{calls.push(args);return {skipped:true,reason:'NO_NEW_RECORDS',run:null}};
    const result=await runScheduledAnalysisOnce({home:directory,now:NOW,start});
    assert.equal(result.reason,'SCHEDULE_DISABLED');
    assert.equal(result.advanced,false);
    assert.equal(calls.length,0);

    const view=await savedAnalytics({},{days:30},{home:directory});
    assert.equal(view.analysis.available,false);
    let state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.enabled,false);
    assert.equal(state.schedule.nextAt,null);

    const controller=startAnalysisScheduler({home:directory,intervalMs:1000,now:()=>NOW,start});
    await new Promise(resolve=>setTimeout(resolve,80));
    await stopAnalysisScheduler();
    assert.equal(controller.tick instanceof Function,true);
    state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.enabled,false);
    assert.equal(calls.length,0);
  }finally{await stopAnalysisScheduler();await cleanup()}
});

test('scheduler startup gives a new install an enabled due plan and runs both windows',async()=>{
  const {directory,cleanup}=await home();
  try{
    const calls=[];
    const controller=startAnalysisScheduler({
      home:directory,intervalMs:1000,now:()=>NOW,
      start:async args=>{calls.push(args);return {skipped:true,reason:'NO_SOURCE_RECORDS',run:null,report:null}},
    });
    await new Promise(resolve=>setTimeout(resolve,80));
    await stopAnalysisScheduler();
    assert.equal(controller.tick instanceof Function,true);
    assert.deepEqual(calls.map(item=>item.days),[7,30]);
    assert.deepEqual(calls.map(item=>item.trigger),['schedule','schedule']);
    assert.equal(calls[0].requestId,`schedule:${NOW.toISOString()}:7`);
    assert.equal(calls[1].requestId,`schedule:${NOW.toISOString()}:30`);
    const state=await readAnalysisState({home:directory});
    assert.equal(state.schedule.enabled,true);
    assert.equal(state.schedule.days,null);
    assert.equal(state.schedule.lastPeriodicCycle,NOW.toISOString());
    assert.equal(state.schedule.nextAt,'2026-10-27T12:00:00.000Z');
  }finally{await stopAnalysisScheduler();await cleanup()}
});

test('saved analytics refuses unsupported scope without reading sources',async()=>{
  const {directory,cleanup}=await home();
  try{
    await assert.rejects(savedAnalytics({},{scope:'session',days:7},{home:directory}),error=>error.code==='SQUAD_ANALYSIS_SCOPE_UNSUPPORTED');
    const empty=await savedAnalytics({},{days:30},{home:directory});
    assert.equal(empty.analysis.available,false);
    assert.equal(empty.analysis.statsAvailable,false);
    assert.equal(empty.analysis.reason,'NO_SUCCESSFUL_REPORT');
    assert.equal(empty.metrics.taskCount,0);
    assert.equal((await readAnalysisState({home:directory})).history.length,0);
  }finally{await cleanup()}
});

test('saved stats stay readable while the AI runner is blocked',async()=>{
  const {directory,cleanup}=await home();
  try{
    let release;
    const gate=new Promise(resolve=>{release=resolve});
    const runner=async()=>{
      await gate;
      return {realCodexThreadId:'thread-real-blocked',analysis:structuredClone(ANALYSIS),exitCode:0,eventTypes:[],stderrBytes:0};
    };
    const started=await startAnalysis(options(directory,{...providers(),runner}));
    const analyzing=await waitFor(async()=>{
      const run=await readRun(started.run.runId,{home:directory});
      return run?.phase==='analyzing'?run:null;
    });
    assert.equal(analyzing.statsDigest.length,64);

    const first=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(first.metrics.taskCount,1);
    assert.equal(first.analysis.statsAvailable,true);
    assert.equal(first.analysis.available,false);
    assert.equal(first.analysis.reason,'ANALYSIS_RUNNING');
    assert.equal(first.analysis.runId,started.run.runId);
    assert.equal(first.analysis.statFingerprint,analyzing.statsDigest);
    assert.equal(first.analysis.latestRun.status,'running');
    assert.equal(first.analysis.summary,undefined);
    assert.equal(first.analysis.sessionDescriptions,undefined);

    const reread=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(reread.analysis.statFingerprint,first.analysis.statFingerprint);
    assert.equal(reread.analysis.statsObservedAt,first.analysis.statsObservedAt);
    assert.equal(reread.metrics.taskCount,1);

    release();
    const completed=await started.completion;
    assert.equal(completed.run.status,'succeeded');
    const final=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(final.analysis.available,true);
    assert.equal(final.analysis.statsAvailable,true);
    assert.equal(final.analysis.statFingerprint,analyzing.statsDigest);
    assert.equal(final.analysis.summary,ANALYSIS.summary);
    assert.equal(completed.report.statsDigest,analyzing.statsDigest);
  }finally{await cleanup()}
});

test('a failed AI round keeps its frozen stats and never mixes the previous suggestions',async()=>{
  const {directory,cleanup}=await home();
  try{
    const first=await startAnalysis(options(directory,{...providers(),runner:runnerOk({count:0})}));
    const firstDone=await first.completion;
    assert.equal(firstDone.run.status,'succeeded');
    const firstStored=await readRun(first.run.runId,{home:directory});
    const oldSummary=(await readReport(first.run.runId,{home:directory})).analysis.summary;

    const failed=await startAnalysis(options(directory,{
      requestId:'request-failed-mix',...providers({fingerprint:'f2',views:[snapshotOf(2)]}),
      runner:async()=>{throw Object.assign(new Error('Codex 失败'),{code:'SQUAD_ANALYSIS_CODEX_FAILED'})},
    }));
    const failure=await failed.completion;
    assert.equal(failure.run.status,'failed');
    const failedStored=await readRun(failed.run.runId,{home:directory});

    const saved=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(saved.metrics.taskCount,2);
    assert.equal(saved.analysis.statsAvailable,true);
    assert.equal(saved.analysis.available,false);
    assert.equal(saved.analysis.reason,'SQUAD_ANALYSIS_CODEX_FAILED');
    assert.equal(saved.analysis.runId,failed.run.runId);
    assert.equal(saved.analysis.statFingerprint,failedStored.statsDigest);
    assert.equal(saved.analysis.latestRun.runId,failed.run.runId);
    assert.equal(saved.analysis.latestRun.status,'failed');
    assert.equal(saved.analysis.summary,undefined);
    assert.equal(saved.analysis.sessionDescriptions,undefined);
    assert.notEqual(saved.analysis.statFingerprint,firstStored.statsDigest);
    assert.equal(JSON.stringify(saved).includes(oldSummary),false);

    const previous=await analysisRunDetail({home:directory,runId:first.run.runId});
    assert.equal(previous.run.status,'succeeded');
    assert.equal(previous.report.analysis.available,true);
    assert.equal(previous.report.analysis.statFingerprint,firstStored.statsDigest);
    assert.equal((await readLastSuccessful({home:directory,days:7})).run.runId,first.run.runId);
  }finally{await cleanup()}
});

test('retrying a failed AI round reuses saved stats without rescanning sources',async()=>{
  const {directory,cleanup}=await home();
  try{
    let loads=0;
    const fingerprintProvider=async()=>({fingerprint:'f-retry',sourceCount:1});
    const first=await startAnalysis(options(directory,{
      requestId:'request-retry-1',fingerprintProvider,
      sourceLoader:async()=>{loads+=1;return {views:[snapshotOf(2)],expected:1,unavailable:[]}},
      runner:async()=>{throw Object.assign(new Error('Codex 失败'),{code:'SQUAD_ANALYSIS_CODEX_FAILED'})},
    }));
    const failure=await first.completion;
    assert.equal(failure.run.status,'failed');
    assert.equal(loads,1);
    const frozenDigest=(await readRun(first.run.runId,{home:directory})).statsDigest;
    assert.equal(frozenDigest.length,64);

    const counter={count:0};
    const retry=await startAnalysis(options(directory,{
      requestId:'request-retry-2',fingerprintProvider,
      sourceLoader:async()=>{throw new Error('重试不应重新扫描来源')},
      runner:async()=>{
        counter.count+=1;
        return {realCodexThreadId:'thread-real-retry',analysis:analysisFor(2),exitCode:0,eventTypes:[],stderrBytes:0};
      },
    }));
    const completed=await retry.completion;
    assert.equal(completed.run.status,'succeeded');
    assert.equal(counter.count,1);
    assert.equal(completed.report.statsDigest,frozenDigest);
    assert.equal((await readRun(retry.run.runId,{home:directory})).statsDigest,frozenDigest);
    const saved=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(saved.metrics.taskCount,2);
    assert.equal(saved.analysis.available,true);
    assert.equal(saved.analysis.statsAvailable,true);
    assert.equal(saved.analysis.statFingerprint,frozenDigest);
    assert.equal((await readLastSuccessful({home:directory,days:7})).run.runId,retry.run.runId);
  }finally{await cleanup()}
});

test('saved stats survive restart recovery and keep 7, 30 and all windows isolated',async()=>{
  const {directory,cleanup}=await home();
  try{
    const runs={};
    for(const [days,count,fingerprint] of [[7,1,'f-7'],[30,2,'f-30'],[null,3,'f-all']]){
      const counter={count:0};
      const started=await startAnalysis({
        home:directory,codexHome:join(directory,'codex-home'),requestId:`request-window-${days??'all'}`,days,now:NOW,
        ...providers({fingerprint,views:[snapshotOf(count)]}),
        runner:async()=>{
          counter.count+=1;
          return {realCodexThreadId:`thread-real-${days??'all'}`,analysis:analysisFor(count),exitCode:0,eventTypes:[],stderrBytes:0};
        },
      });
      const completed=await started.completion;
      assert.equal(completed.run.status,'succeeded');
      runs[days??'all']=await readRun(completed.run.runId,{home:directory});
    }

    for(const [days,count] of [[7,1],[30,2],[null,3]]){
      const view=await savedAnalytics({},{days},{home:directory});
      assert.equal(view.metrics.taskCount,count);
      assert.equal(view.analysis.available,true);
      assert.equal(view.analysis.statsAvailable,true);
      assert.equal(view.analysis.statFingerprint,runs[days??'all'].statsDigest);
    }

    const restarted=await import(`../cli/lib/analysis-service.mjs?restart=${Date.now()}`);
    for(const [days,count] of [[7,1],[30,2],[null,3]]){
      const view=await restarted.savedAnalytics({},{days},{home:directory});
      assert.equal(view.metrics.taskCount,count);
      assert.equal(view.analysis.statsAvailable,true);
      assert.equal(view.analysis.statFingerprint,runs[days??'all'].statsDigest);
    }

    const blocked=await startAnalysis(options(directory,{
      requestId:'request-restart-7',days:7,...providers({fingerprint:'f-7-restart',views:[snapshotOf(2)]}),
      runner:({signal})=>new Promise((resolve,reject)=>{
        const abort=()=>reject(Object.assign(new Error('分析服务中断'),{code:'SQUAD_ANALYSIS_INTERRUPTED'}));
        if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
      }),
    }));
    await waitFor(async()=>{
      const run=await readRun(blocked.run.runId,{home:directory});
      return run?.phase==='analyzing'?run:null;
    });
    await recoverInterruptedAnalysisRuns({home:directory,isAlive:()=>false});
    const afterRestart=await restarted.savedAnalytics({},{days:7},{home:directory});
    assert.equal(afterRestart.metrics.taskCount,2);
    assert.equal(afterRestart.analysis.statsAvailable,true);
    assert.equal(afterRestart.analysis.available,false);
    assert.equal(afterRestart.analysis.reason,'SQUAD_ANALYSIS_INTERRUPTED');
    assert.equal(afterRestart.analysis.latestRun.status,'interrupted');
    assert.equal(afterRestart.analysis.statFingerprint,(await readRun(blocked.run.runId,{home:directory})).statsDigest);
    assert.notEqual(afterRestart.analysis.statFingerprint,runs[7].statsDigest);
    await interruptActiveAnalysis();
    const interrupted=await blocked.completion;
    assert.equal(interrupted.run.status,'interrupted');

    const legacyState=await readAnalysisState({home:directory});
    delete legacyState.statsByWindow['7'];
    await writeAnalysisState(legacyState,{home:directory});
    const legacy=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(legacy.analysis.available,true);
    assert.equal(legacy.analysis.statsAvailable,true);
    assert.equal(legacy.analysis.runId,runs[7].runId);
    assert.equal(legacy.metrics.taskCount,1);
    const stillIsolated=await savedAnalytics({},{days:30},{home:directory});
    assert.equal(stillIsolated.metrics.taskCount,2);
  }finally{await cleanup()}
});

function codexUsageLine({timestamp,ordinal,responseId,input,total}){
  return `${JSON.stringify({
    timestamp,ordinal,type:'token_usage_record',
    payload:{
      thread_id:'99999999-9999-4999-8999-999999999999',turn_id:'turn-codex',response_id:responseId,
      usage:{input_tokens:input,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:input},
      thread_token_usage:{input_tokens:total,output_tokens:0,total_tokens:total},
    },
  })}\n`;
}
async function codexFixture(directory,records){
  const codexHome=join(directory,'codex-home');
  await mkdir(codexHome,{recursive:true});
  const threadId='99999999-9999-4999-8999-999999999999';
  const rollout=join(codexHome,'rollout.jsonl');
  await writeFile(rollout,records.join(''));
  const db=new DatabaseSync(join(codexHome,'state_5.sqlite'));
  try{
    db.exec(`CREATE TABLE threads(
      id TEXT PRIMARY KEY,title TEXT,name TEXT,tokens_used INTEGER,model TEXT,
      rollout_path TEXT,updated_at INTEGER,updated_at_ms INTEGER,archived INTEGER
    )`);
    db.prepare('INSERT INTO threads(id,title,name,tokens_used,model,rollout_path,updated_at,updated_at_ms,archived) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(threadId,'本机 Codex 会话',null,300,null,rollout,0,0,0);
  }finally{db.close();}
  return {codexHome,rollout};
}

test('cheap fingerprint changes when Codex thread metadata changes',async()=>{
  const {directory,cleanup}=await home();
  try{
    const codexHome=join(directory,'codex-home');
    await mkdir(codexHome,{recursive:true});
    await mkdir(join(directory,'bindings'),{recursive:true});
    await writeFile(join(directory,'bindings',`${THREAD}.json`),'{"v":1}\n');
    const file=join(codexHome,'state_5.sqlite');
    const db=new DatabaseSync(file);
    try{
      db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,tokens_used INTEGER,updated_at_ms INTEGER)');
      db.prepare('INSERT INTO threads VALUES(?,?,?)').run('codex-thread',10,1);
    }finally{db.close();}

    const first=await cheapSourceFingerprint({home:directory,codexHome});
    const writer=new DatabaseSync(file);
    try{writer.prepare('UPDATE threads SET tokens_used=?,updated_at_ms=? WHERE id=?').run(11,2,'codex-thread');}
    finally{writer.close();}
    const second=await cheapSourceFingerprint({home:directory,codexHome});
    assert.equal(first.sourceCount,1);
    assert.equal(second.sourceCount,1);
    assert.notEqual(first.fingerprint,second.fingerprint);
  }finally{await cleanup()}
});

test('analysis-only usage does not recursively schedule another analysis',async()=>{
  const {directory,cleanup}=await home();
  try{
    const codexHome=join(directory,'codex-home');
    await mkdir(codexHome,{recursive:true});
    await mkdir(join(directory,'bindings'),{recursive:true});
    await writeFile(join(directory,'bindings',`${THREAD}.json`),'{"v":1}\n');
    const runs=analysisPaths(directory).runs;
    await mkdir(runs,{recursive:true});
    await writeFile(join(runs,'00000000-0000-4000-8000-000000000000.json'),JSON.stringify({schemaVersion:1,runId:'00000000-0000-4000-8000-000000000000',realCodexThreadId:'analysis-thread',requestedByThreadId:THREAD}));
    const db=new DatabaseSync(join(codexHome,'state_5.sqlite'));
    try{
      db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,tokens_used INTEGER,updated_at_ms INTEGER)');
      db.prepare('INSERT INTO threads VALUES(?,?,?)').run('work-thread',10,1);
      const first=await cheapSourceFingerprint({home:directory,codexHome});
      db.prepare('INSERT INTO threads VALUES(?,?,?)').run('analysis-thread',500,2);
      const second=await cheapSourceFingerprint({home:directory,codexHome});
      assert.equal(second.fingerprint,first.fingerprint);
      db.prepare('UPDATE threads SET tokens_used=11,updated_at_ms=3 WHERE id=?').run('work-thread');
      const third=await cheapSourceFingerprint({home:directory,codexHome});
      assert.notEqual(third.fingerprint,second.fingerprint);
    }finally{db.close()}
  }finally{await cleanup()}
});

test('frozen stats carry local Codex usage per window and GET never rescans source metadata',async()=>{
  const {directory,cleanup}=await home();
  try{
    const fixture=await codexFixture(directory,[
      codexUsageLine({timestamp:'2026-10-26T12:00:00.000Z',ordinal:1,responseId:'c1',input:100,total:100}),
      codexUsageLine({timestamp:'2026-10-17T12:00:00.000Z',ordinal:2,responseId:'c2',input:100,total:200}),
      codexUsageLine({timestamp:'2026-09-17T12:00:00.000Z',ordinal:3,responseId:'c3',input:100,total:300}),
    ]);
    const runs={};
    for(const [days,expected] of [[7,100],[30,200],[null,300]]){
      const started=await startAnalysis(options(directory,{
        requestId:`request-codex-${days??'all'}`,days,fingerprint:`codex-${days??'all'}`,
        fingerprintProvider:async()=>({fingerprint:`codex-${days??'all'}`,sourceCount:1}),
        sourceLoader:async()=>({views:[snapshot()],expected:1,unavailable:[]}),
        runner:async()=>({realCodexThreadId:'thread-real-codex',analysis:structuredClone(ANALYSIS),exitCode:0,eventTypes:[],stderrBytes:0}),
      }));
      const completed=await started.completion;
      assert.equal(completed.run.status,'succeeded');
      assert.equal(completed.report.stats.codexUsage.available,true);
      assert.equal(completed.report.stats.codexUsage.totals.inputTokens,expected);
      runs[days??'all']=await readRun(completed.run.runId,{home:directory});
    }

    for(const [days,expected] of [[7,100],[30,200],[null,300]]){
      const view=await savedAnalytics({},{days},{home:directory});
      assert.equal(view.metrics.taskCount,1);
      assert.equal(view.codexUsage.available,true);
      assert.equal(view.codexUsage.totals.inputTokens,expected);
      assert.equal(view.codexUsage.sessions.length,1);
      assert.equal(view.codexUsage.sessions[0].title,'本机 Codex 会话');
      assert.equal(view.analysis.statFingerprint,runs[days??'all'].statsDigest);
    }

    await rm(join(directory,'codex-usage'),{recursive:true,force:true});
    await rm(fixture.rollout,{force:true});
    const cached=await savedAnalytics({},{days:30},{home:directory});
    assert.equal(cached.codexUsage.totals.inputTokens,200);
    assert.equal(cached.metrics.taskCount,1);
  }finally{await cleanup()}
});

test('Codex metadata failure stays isolated from frozen Qoder stats',async()=>{
  const {directory,cleanup}=await home();
  try{
    const started=await startAnalysis(options(directory,{
      requestId:'request-codex-failure',
      ...providers({fingerprint:'codex-failure'}),
      codexUsageProvider:async()=>{throw Object.assign(new Error('metadata failed'),{code:'SQUAD_CODEX_USAGE_UNAVAILABLE'});},
      runner:runnerOk({count:0}),
    }));
    const completed=await started.completion;
    assert.equal(completed.run.status,'succeeded');
    assert.equal(completed.report.stats.metrics.taskCount,1);
    assert.equal(completed.report.stats.tokens.totalTokens,12);
    assert.equal(completed.report.stats.codexUsage.available,false);
    const saved=await savedAnalytics({},{days:7},{home:directory});
    assert.equal(saved.metrics.taskCount,1);
    assert.equal(saved.tokens.totalTokens,12);
    assert.equal(saved.codexUsage.available,false);
    assert.match(saved.codexUsage.note,/读取失败/);
    assert.equal(saved.analysis.available,true);
  }finally{await cleanup()}
});

const NATIVE_HOST='77777777-7777-4777-8777-777777777777';
const NATIVE_SUB='88888888-8888-4888-8888-888888888888';
const NATIVE_BASELINE='99999999-9999-4999-8999-999999999999';
const NATIVE_WORK='w-native';

function nativeLine(type,payload,{timestamp,ordinal}={}){
  const value={};
  if(timestamp!==undefined)value.timestamp=timestamp;
  if(ordinal!==undefined)value.ordinal=ordinal;
  value.type=type;
  value.payload=payload;
  return `${JSON.stringify(value)}\n`;
}
function nativeTurn(turnId,model,{timestamp,ordinal}){
  return nativeLine('turn_context',{turn_id:turnId,model,effort:'high',sandbox_policy:{type:'workspace-write'},approval_policy:'on-request'},{timestamp,ordinal});
}
function nativeStarted(turnId,startedAt,ordinal){
  return nativeLine('event_msg',{type:'task_started',turn_id:turnId,started_at:Date.parse(startedAt)/1000},{timestamp:startedAt,ordinal});
}
function nativeUser(text,{turnId,timestamp,ordinal}){
  return nativeLine('event_msg',{
    type:'item_completed',turn_id:turnId,
    item:{type:'UserMessage',content:[{type:'text',text}]},
  },{timestamp,ordinal});
}
function nativeDelegation(input,{turnId,timestamp,ordinal}){
  return nativeLine('event_msg',{
    type:'item_completed',turn_id:turnId,
    item:{type:'FunctionCallOutput',id:`delegation-${ordinal}`,namespace:'codex_app',name:'send_message_to_thread',
      output:`<codex_delegation><source_thread_id>${NATIVE_SUB}</source_thread_id><input>${input}</input></codex_delegation>`},
  },{timestamp,ordinal});
}
function nativeUsage({turnId,input,cached=0,output,timestamp,ordinal}){
  return nativeLine('token_usage_record',{
    thread_id:'native',turn_id:turnId,response_id:`response-${ordinal}`,
    usage:{
      input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:0,
      output_tokens:output,reasoning_output_tokens:0,total_tokens:input+output,
    },
  },{timestamp,ordinal});
}
function nativeComplete({turnId,completedAt,durationMs,message,ordinal}){
  return nativeLine('event_msg',{
    type:'task_complete',turn_id:turnId,
    completed_at:Date.parse(completedAt)/1000,duration_ms:durationMs,last_agent_message:message,
  },{timestamp:completedAt,ordinal});
}
async function writeNativeCodex(codexHome){
  await mkdir(codexHome,{recursive:true});
  const hostRollout=join(codexHome,'host.jsonl');
  const subRollout=join(codexHome,'sub.jsonl');
  const baselineRollout=join(codexHome,'baseline.jsonl');
  await writeFile(hostRollout,[
    nativeTurn('t1','gpt-5',{timestamp:'2026-10-26T09:00:00.000Z',ordinal:1}),
    nativeStarted('t1','2026-10-26T09:00:00.000Z',2),
    nativeUser('请实现登录功能并通过验收',{turnId:'t1',timestamp:'2026-10-26T09:00:01.000Z',ordinal:3}),
    nativeDelegation('正式需求：完成本机实现与证据，真实共享 API 待统一验证。',{
      turnId:'t1',timestamp:'2026-10-26T09:00:02.000Z',ordinal:4,
    }),
    nativeUsage({turnId:'t1',input:100,cached:40,output:200,timestamp:'2026-10-26T10:00:00.000Z',ordinal:5}),
    nativeComplete({
      turnId:'t1',completedAt:'2026-10-26T11:00:00.000Z',durationMs:7200000,
      message:'已完成登录功能并通过验收。',ordinal:6,
    }),
  ].join(''));
  await writeFile(subRollout,[
    nativeTurn('t2','gpt-5',{timestamp:'2026-10-26T10:10:00.000Z',ordinal:1}),
    nativeStarted('t2','2026-10-26T10:10:00.000Z',2),
    nativeUsage({turnId:'t2',input:50,output:100,timestamp:'2026-10-26T10:20:00.000Z',ordinal:3}),
    nativeComplete({
      turnId:'t2',completedAt:'2026-10-26T10:25:00.000Z',durationMs:900000,
      message:'子任务完成。',ordinal:4,
    }),
  ].join(''));
  await writeFile(baselineRollout,[
    nativeTurn('b1','gpt-5',{timestamp:'2026-10-24T08:50:00.000Z',ordinal:1}),
    nativeStarted('b1','2026-10-24T08:50:00.000Z',2),
    nativeUser('重构登录模块',{turnId:'b1',timestamp:'2026-10-24T08:50:01.000Z',ordinal:3}),
    nativeUsage({turnId:'b1',input:300,output:700,timestamp:'2026-10-24T08:55:00.000Z',ordinal:4}),
    nativeComplete({
      turnId:'b1',completedAt:'2026-10-24T09:00:00.000Z',durationMs:600000,
      message:'历史交付已完成。',ordinal:5,
    }),
  ].join(''));
  const db=new DatabaseSync(join(codexHome,'state_5.sqlite'));
  try{
    db.exec(`CREATE TABLE threads(
      id TEXT PRIMARY KEY,title TEXT,name TEXT,tokens_used INTEGER,model TEXT,rollout_path TEXT,
      updated_at INTEGER,updated_at_ms INTEGER,archived INTEGER,reasoning_effort TEXT,cwd TEXT,
      sandbox_policy TEXT,approval_mode TEXT,source TEXT,thread_source TEXT
    )`);
    const insert=db.prepare(`INSERT INTO threads(
      id,title,name,tokens_used,model,rollout_path,updated_at,updated_at_ms,archived,
      reasoning_effort,cwd,sandbox_policy,approval_mode,source,thread_source
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(NATIVE_HOST,'登录功能交付',null,300,'gpt-5',hostRollout,0,0,0,'high','/tmp/native','workspace-write','on-request',null,'cli');
    insert.run(NATIVE_SUB,'登录子任务',null,150,'gpt-5',subRollout,0,0,0,'high','/tmp/native','workspace-write','on-request',
      JSON.stringify({subagent:{thread_spawn:{parent_thread_id:NATIVE_HOST}}}),'subagent');
    insert.run(NATIVE_BASELINE,'历史登录重构',null,1000,'gpt-5',baselineRollout,0,0,0,'high','/tmp/history','workspace-write','on-request',null,'cli');
  }finally{db.close();}
  return {codexHome,hostRollout,subRollout,baselineRollout};
}

function nativeSnapshot(){
  return {
    schemaVersion:1,connected:true,observedAt:'2026-10-26T11:30:00.000Z',
    binding:{
      threadId:NATIVE_HOST,workspace:'/Users/private/native',projectId:'p-native',
      parentWorkId:NATIVE_WORK,title:'登录功能交付',
    },
    members:[{id:'member-qoder',executor:'qoder'},{id:'member-codex',executor:'codex'}],
    cursor:'cursor-native',
    parent:{status:'backlog'},
    tasks:[
      {
        id:'task-qoder',title:'实现登录',memberId:'member-qoder',status:'completed',
        acceptance:{at:'2026-10-26T10:40:00.000Z',note:'通过验收'},attempts:[{
          id:'attempt-qoder',index:1,status:'completed',
          startedAt:'2026-10-26T09:30:00.000Z',endedAt:'2026-10-26T10:00:00.000Z',
          sessionId:'qoder-native-session',model:'configured-model',actualModel:'qwen',
          usage:{inputTokens:20,outputTokens:10,cachedInputTokens:0,totalTokens:30},
          handoff:{goal:'实现登录功能并通过验收'},events:[],result:null,error:null,
        }],
      },
      {
        id:'task-codex',title:'验证登录',memberId:'member-codex',status:'completed',
        acceptance:{at:'2026-10-26T10:40:00.000Z',note:'通过验收'},attempts:[{
          id:'attempt-codex',index:1,status:'completed',
          startedAt:'2026-10-26T10:10:00.000Z',endedAt:'2026-10-26T10:30:00.000Z',
          sessionId:NATIVE_SUB,model:'gpt-5',actualModel:'gpt-5',
          usage:{inputTokens:50,outputTokens:100,cachedInputTokens:0,totalTokens:150},
          handoff:{goal:'补充登录验证'},events:[],result:null,error:null,
        }],
      },
    ],
  };
}
function nativeMatch(){
  const deliveryRef=`benefit-delivery:${NATIVE_WORK}:${NATIVE_HOST}`;
  const baselineRef=`benefit-baseline:codex-session:${NATIVE_BASELINE}`;
  return {
    deliveryId:`${NATIVE_WORK}:${NATIVE_HOST}`,
    baselineId:`codex-session:${NATIVE_BASELINE}`,
    basis:[
      {aspect:'workType',deliveryText:'实现登录功能',baselineText:'重构登录模块',deliveryRef,baselineRef},
      {aspect:'scale',deliveryText:'登录',baselineText:'登录',deliveryRef,baselineRef},
      {aspect:'acceptance',deliveryText:'通过验收',baselineText:'完成',deliveryRef,baselineRef},
    ],
  };
}
function nativeRunner(counter){
  return async()=>{
    counter.count+=1;
    const analysis={...structuredClone(ANALYSIS),sessionDescriptions:[],benefitMatches:[nativeMatch()]};
    return {
      realCodexThreadId:'thread-real-native',analysis,outputText:JSON.stringify(analysis),
      usage:{input_tokens:12,total_tokens:17},exitCode:0,signal:null,
      eventTypes:['thread.started','turn.completed'],stderrBytes:0,
    };
  };
}

test('native inventory freezes candidates, applies validated matching and serves the saved result without rescanning',async()=>{
  const {directory,cleanup}=await home();
  try{
    const {codexHome}=await writeNativeCodex(join(directory,'codex-home'));
    const counter={count:0};
    const result=await startAnalysis(options(directory,{
      requestId:'request-native-benefits',codexHome,
      fingerprintProvider:async()=>({fingerprint:'native-f1',sourceCount:1}),
      sourceLoader:async()=>({views:[nativeSnapshot()],expected:1,unavailable:[]}),
      runner:nativeRunner(counter),
    }));
    const completed=await result.completion;
    assert.equal(completed.error,undefined);
    assert.equal(completed.run.status,'succeeded');
    assert.equal(counter.count,1);

    const report=completed.report;
    const benefits=report.stats.benefits;
    assert.equal(benefits.coverage.nativeDeliveries,1);
    assert.equal(benefits.coverage.pendingMatchDeliveries,0);
    assert.equal(benefits.coverage.tokenEstimatedDeliveries,1);
    assert.equal(benefits.coverage.timeEstimatedDeliveries,1);
    assert.deepEqual(benefits.coverage.benefitMatches,{provided:1,applied:1,rejected:0,details:[]});
    assert.deepEqual(benefits.summary,{
      baselineCodexTokens:1000,actualCodexTokens:450,qoderTokens:30,
      codexTokensSaved:550,tokenSavingRate:0.55,
      baselineSeconds:6300,squadSeconds:4500,secondsSaved:1800,
      timeSavingRate:0.285714,
    });
    assert.equal(benefits.deliveries.length,1);
    const delivery=benefits.deliveries[0];
    assert.equal(delivery.deliveryId,`${NATIVE_WORK}:${NATIVE_HOST}`);
    assert.equal(delivery.status,'completed');
    assert.equal(delivery.evidenceSource,'native-delivery');
    assert.equal(delivery.matchPending,false);
    assert.equal(delivery.taskCount,2);
    assert.equal(delivery.nativeSummary.tasks,2);
    assert.equal(delivery.nativeSummary.threads,2);
    assert.equal(delivery.actual.codex.tokens,450);
    assert.equal(delivery.actual.qoder.tokens,30);
    assert.equal(delivery.baseline.tokens,1000);
    assert.equal(delivery.estimate.codexTokensSaved,550);
    assert.equal(delivery.estimate.secondsSaved,1800);
    assert.equal(delivery.estimate.timeBasis,'run');
    assert.equal(delivery.estimate.timeRough,true);
    assert.equal(delivery.baseline.conditionsMatched,true);
    assert.equal(delivery.baseline.native,true);

    const stored=await readRun(result.run.runId,{home:directory});
    assert.equal(stored.status,'succeeded');
    assert.equal(stored.statsDigest,report.statsDigest);
    const evidence=await readEvidence(result.run.runId,{home:directory});
    assert.equal(evidence.statsDigest,report.statsDigest);
    assert.equal(evidence.stats.benefits.summary.codexTokensSaved,550);
    assert.equal(evidence.benefitSources.candidates.deliveries.length,1);
    assert.equal(evidence.benefitSources.candidates.deliveries[0].ref,`benefit-delivery:${NATIVE_WORK}:${NATIVE_HOST}`);
    assert.equal(evidence.benefitSources.candidates.baselines.length,1);
    assert.equal(evidence.benefitSources.candidates.baselines[0].ref,`benefit-baseline:codex-session:${NATIVE_BASELINE}`);
    assert.equal(evidence.evidence.benefits.candidates.deliveries.length,1);
    assert.match(evidence.evidence.benefits.candidates.deliveries[0].finalMessage,/已完成登录功能/);
    assert.match(evidence.benefitSources.candidates.deliveries[0].publicGoals[0].text,/正式需求/);
    assert.match(evidence.evidence.benefits.candidates.deliveries[0].publicGoals[0].text,/真实共享 API 待统一验证/);

    const saved=await savedAnalytics({threadId:NATIVE_HOST},{scope:'global',days:7},{home:directory,origin:null});
    assert.equal(saved.metrics.taskCount,2);
    assert.equal(saved.benefits.summary.codexTokensSaved,550);
    assert.equal(saved.benefits.coverage.benefitMatches.applied,1);
    assert.equal(saved.benefits.coverage.pendingMatchDeliveries,0);
    assert.equal(saved.benefits.deliveries[0].status,'completed');
    assert.equal(saved.benefits.deliveries[0].matchPending,false);
    assert.equal(saved.analysis.benefitMatches.length,1);

    await rm(codexHome,{recursive:true,force:true});
    await rm(join(directory,'codex-usage'),{recursive:true,force:true});
    const cached=await savedAnalytics({threadId:NATIVE_HOST},{scope:'global',days:7},{home:directory,origin:null});
    assert.equal(cached.metrics.taskCount,2);
    assert.equal(cached.benefits.summary.codexTokensSaved,550);
    assert.equal(cached.benefits.coverage.benefitMatches.applied,1);
    assert.equal(cached.analysis.benefitMatches.length,1);
  }finally{await cleanup()}
});
