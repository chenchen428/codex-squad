import test from 'node:test';
import assert from 'node:assert/strict';
import {buildExecutorUsage} from '../cli/lib/executor-usage.mjs';

const NOW=new Date('2026-01-10T12:00:00.000Z');
const DAY=86400000;
const HOUR=3600000;

function usage(inputTokens=null,outputTokens=null,cachedInputTokens=null,totalTokens=null){
  return {inputTokens,outputTokens,cachedInputTokens,totalTokens};
}
function attempt(id,overrides={}){
  return {
    id,
    index:1,
    executor:'qoder',
    startedAt:'2026-01-10T10:00:00.000Z',
    endedAt:'2026-01-10T10:10:00.000Z',
    model:'qoder-model',
    actualModel:null,
    usage:null,
    ...overrides
  };
}
function thread(threadId,tasks,title=`会话 ${threadId}`){return {threadId,title,tasks}}
function task(id,attempts){return {id,attempts}}

function assertTokenConservation(result){
  const values=key=>result.sessions.map(session=>session.tokens[key]??0).reduce((sum,value)=>sum+value,0);
  for(const key of ['inputTokens','cachedInputTokens','outputTokens','totalTokens']){
    assert.equal(values(key),result.totals[key]??0,`${key} 会话合计应等于总量`);
  }
  const modelValues=key=>result.models.map(group=>group.tokens[key]??0).reduce((sum,value)=>sum+value,0);
  for(const key of ['inputTokens','cachedInputTokens','outputTokens','totalTokens']){
    assert.equal(modelValues(key),result.totals[key]??0,`${key} 模型合计应等于总量`);
  }
}

test('only explicit qoder executors count, duplicate snapshots collapse and sessions align by threadId',()=>{
  const threadA=thread('thread-a',[
    task('task-a',[
      attempt('attempt-a1',{usage:usage(10,2,3,12),actualModel:'qoder-actual',model:'configured-fallback'}),
      attempt('attempt-a2',{index:2,usage:usage(20,4,0,24)})
    ]),
    task('task-b',[
      attempt('attempt-codex',{executor:'codex',usage:usage(999,999,999,999)}),
      attempt('attempt-a3',{index:2,usage:usage(5,1)})
    ])
  ],'真实会话 A');
  const threadB=thread('thread-b',[task('task-c',[attempt('attempt-b1',{usage:usage(0,0,0,0)})])],'真实会话 B');
  const result=buildExecutorUsage([threadA,threadA,threadB],{now:NOW,days:null});

  assert.equal(result.executor,'qoder');
  assert.equal(result.available,true);
  assert.deepEqual(result.totals,{inputTokens:35,cachedInputTokens:3,outputTokens:7,totalTokens:36});
  assert.equal(result.coverage.totalAttempts,4,'Codex 执行器与重复快照都不进入 Qoder 总量');
  assert.equal(result.coverage.reportedAttempts,4);
  assert.deepEqual(result.coverage.inputTokens,{reported:4,total:4});
  assert.deepEqual(result.coverage.cachedInputTokens,{reported:3,total:4});
  assert.deepEqual(result.coverage.totalTokens,{reported:3,total:4});
  assert.equal(result.coverage.executedAttempts,4);

  assert.deepEqual(result.sessions.map(session=>session.threadId),['thread-a','thread-b']);
  const [sessionA,sessionB]=result.sessions;
  assert.equal(sessionA.title,'真实会话 A');
  assert.equal(sessionB.title,'真实会话 B');
  assert.deepEqual(sessionA.tokens,{inputTokens:35,cachedInputTokens:3,outputTokens:7,totalTokens:36});
  assert.deepEqual(sessionB.tokens,{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0});
  assert.equal(sessionA.coverage.totalAttempts,3);
  assert.equal(sessionB.coverage.reportedAttempts,1);
  assert.equal(sessionA.models.find(group=>group.model==='qoder-actual').source,'actual');
  assert.equal(sessionA.models.find(group=>group.model==='qoder-model').source,'configured');
  assertTokenConservation(result);
});

test('repeated attempt identities inside one task are counted once with the latest value',()=>{
  const repeated=thread('thread-repeat',[
    task('task-repeat',[
      attempt('attempt-same',{usage:usage(10,0,0,10)}),
      attempt('attempt-same',{usage:usage(11,0,0,11)})
    ])
  ]);
  const result=buildExecutorUsage([repeated,repeated],{now:NOW,days:null});
  assert.equal(result.coverage.totalAttempts,1);
  assert.equal(result.totals.totalTokens,11);
  assert.equal(result.sessions.length,1);
});

test('missing fields stay null and partial cache never becomes zero',()=>{
  const partial=thread('thread-partial',[
    task('task-partial',[
      attempt('attempt-input',{usage:usage(10,null,null,12)}),
      attempt('attempt-output',{index:2,usage:usage(null,5,3,null)}),
      attempt('attempt-empty',{index:3,usage:usage(null,null,null,null)})
    ])
  ]);
  const result=buildExecutorUsage([partial],{now:NOW,days:null});
  assert.deepEqual(result.totals,{inputTokens:10,cachedInputTokens:3,outputTokens:5,totalTokens:12});
  assert.equal(result.coverage.reportedAttempts,2);
  assert.equal(result.coverage.totalAttempts,3);
  assert.deepEqual(result.coverage.inputTokens,{reported:1,total:3});
  assert.deepEqual(result.coverage.outputTokens,{reported:1,total:3});
  assert.deepEqual(result.coverage.cachedInputTokens,{reported:1,total:3});
  assert.deepEqual(result.coverage.totalTokens,{reported:1,total:3});
  assert.equal(result.available,true,'有执行但无 token 字段时应保留尝试覆盖');

  const empty=buildExecutorUsage([thread('thread-empty',[task('task-empty',[attempt('attempt-none')])])],{now:NOW,days:null});
  assert.deepEqual(empty.totals,{inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null});
  assert.equal(empty.coverage.reportedAttempts,0);
  assert.equal(empty.coverage.totalAttempts,1);
  assert.equal(empty.totals.inputTokens===null,true,'未上报不等于 0');

  const zero=buildExecutorUsage([thread('thread-zero',[task('task-zero',[attempt('attempt-zero',{usage:usage(0,0,0,0)})])])],{now:NOW,days:null});
  assert.deepEqual(zero.totals,{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0});
  assert.equal(zero.coverage.reportedAttempts,1);
});

test('7/30/all share one cutoff, exclude future and undated executions and keep sessions aligned',()=>{
  const attempts=[
    attempt('in-7',{startedAt:new Date(NOW.getTime()-2*HOUR).toISOString(),usage:usage(0,0,0,1)}),
    attempt('in-30',{index:2,startedAt:new Date(NOW.getTime()-10*DAY).toISOString(),usage:usage(0,0,0,2)}),
    attempt('older',{index:3,startedAt:new Date(NOW.getTime()-40*DAY).toISOString(),usage:usage(0,0,0,4)}),
    attempt('from-7',{index:4,startedAt:new Date(NOW.getTime()-7*DAY).toISOString(),usage:usage(0,0,0,32)}),
    attempt('at-now',{index:5,startedAt:NOW.toISOString(),usage:usage(0,0,0,64)}),
    attempt('future',{index:6,startedAt:new Date(NOW.getTime()+HOUR).toISOString(),usage:usage(0,0,0,8)}),
    attempt('undated',{index:7,startedAt:undefined,usage:usage(0,0,0,16)})
  ];
  const views=[
    thread('thread-window',[task('task-window',attempts)]),
    thread('thread-older',[task('task-older',[attempt('attempt-older',{startedAt:new Date(NOW.getTime()-40*DAY).toISOString(),usage:usage(0,0,0,4)})])])
  ];

  const week=buildExecutorUsage(views,{now:NOW,days:7});
  assert.equal(week.totals.totalTokens,97);
  assert.equal(week.coverage.totalAttempts,3);
  assert.equal(week.coverage.executedAttempts,8);
  assert.equal(week.coverage.beforeWindowAttempts,3);
  assert.equal(week.coverage.futureAttempts,1);
  assert.equal(week.coverage.undatedAttempts,1);
  assert.equal(week.range.from,new Date(NOW.getTime()-7*DAY).toISOString());
  assert.deepEqual(week.sessions.map(session=>session.threadId),['thread-window']);

  const month=buildExecutorUsage(views,{now:NOW,days:30});
  assert.equal(month.totals.totalTokens,99);
  assert.equal(month.coverage.totalAttempts,4);
  assert.equal(month.coverage.beforeWindowAttempts,2);
  assert.equal(month.coverage.futureAttempts,1);
  assert.equal(month.coverage.undatedAttempts,1);
  assert.deepEqual(month.sessions.map(session=>session.threadId),['thread-window']);

  const all=buildExecutorUsage(views,{now:NOW,days:null});
  assert.equal(all.totals.totalTokens,107,'all 也排除未来尝试');
  assert.equal(all.coverage.totalAttempts,6);
  assert.equal(all.coverage.beforeWindowAttempts,0);
  assert.equal(all.coverage.futureAttempts,1);
  assert.equal(all.coverage.undatedAttempts,1);
  assert.equal(all.range.from,null);
  assert.deepEqual(all.sessions.map(session=>session.threadId),['thread-window','thread-older']);
});

test('model provenance separates actual, configured and unlabeled groups without inferring actual',()=>{
  const models=thread('thread-models',[
    task('task-models',[
      attempt('actual-only',{actualModel:'actual-x',model:'configured-y',usage:usage(1,1,1,2)}),
      attempt('configured-only',{index:2,actualModel:null,model:'configured-y',usage:usage(2,2,null,4)}),
      attempt('configured-second',{index:3,actualModel:null,model:'configured-y',usage:usage(3,null,null,null)}),
      attempt('shared-actual',{index:4,actualModel:'shared',model:null,usage:usage(0,0,0,8)}),
      attempt('shared-configured',{index:5,actualModel:null,model:'shared',usage:null}),
      attempt('unlabeled',{index:6,actualModel:null,model:null,usage:null})
    ])
  ]);
  const result=buildExecutorUsage([models],{now:NOW,days:null});
  const byModel=Object.fromEntries(result.models.map(group=>[String(group.model),group]));

  assert.equal(byModel['actual-x'].source,'actual');
  assert.equal(byModel['actual-x'].actualAttempts,1);
  assert.equal(byModel['actual-x'].tokens.totalTokens,2);
  assert.equal(byModel['configured-y'].source,'configured');
  assert.equal(byModel['configured-y'].attempts,2);
  assert.equal(byModel['configured-y'].reportedAttempts,2);
  assert.equal(byModel['shared'].source,'mixed');
  assert.equal(byModel['shared'].actualAttempts,1);
  assert.equal(byModel['shared'].configuredAttempts,1);
  assert.equal(byModel['shared'].tokens.totalTokens,8);
  assert.equal(byModel.null.source,'unknown');
  assert.equal(byModel.null.model,null);
  assert.equal(byModel.null.tokens.inputTokens,null);
  assert.equal(result.coverage.totalAttempts,6);
  assertTokenConservation(result);
});

test('no qoder executor keeps unavailable null totals while matching executor names case-insensitively',()=>{
  const codexOnly=buildExecutorUsage([
    thread('thread-codex',[task('task-codex',[
      attempt('attempt-codex',{executor:'codex',usage:usage(1,1,1,1)}),
      attempt('attempt-unknown',{index:2,executor:null,usage:usage(2,2,2,2)})
    ])])
  ],{now:NOW,days:null});
  assert.equal(codexOnly.available,false);
  assert.deepEqual(codexOnly.totals,{inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null});
  assert.equal(codexOnly.coverage.totalAttempts,0);
  assert.equal(codexOnly.coverage.executedAttempts,0);
  assert.deepEqual(codexOnly.models,[]);
  assert.deepEqual(codexOnly.sessions,[]);

  const mixedCase=buildExecutorUsage([thread('thread-case',[task('task-case',[attempt('attempt-case',{executor:' Qoder ',usage:usage(0,0,0,7)})])])],{now:NOW,days:null});
  assert.equal(mixedCase.available,true);
  assert.equal(mixedCase.totals.totalTokens,7);
});

test('invalid aggregation options fail fast',()=>{
  assert.throws(()=>buildExecutorUsage('nope',{now:NOW}),/threads/);
  assert.throws(()=>buildExecutorUsage([],{now:NOW,days:14}),/days/);
  assert.throws(()=>buildExecutorUsage([],{now:new Date('nope')}),/now/);
  assert.throws(()=>buildExecutorUsage([],{now:NOW,executor:' '}),/executor/);
});
