import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBenefitMatches,collectBenefitSources} from '../cli/lib/benefit-evidence.mjs';
import {buildSquadBenefits} from '../cli/lib/squad-benefits.mjs';

const NOW=new Date('2026-01-10T12:00:00.000Z');
const ms=value=>Date.parse(value);
const iso=value=>new Date(value).toISOString();
const DELIVERY_ID='work-native:host-squad';
const BASELINE_ID='codex-session:baseline-root';

function record(turn,input,cached,output,at){
  return {r:`r:${turn}:${at}`,t:ms(at),turn,i:input,c:cached,o:output};
}

function entry({turns,records,starts,completes,lastCompleteAt,lastMessage,userMessages=[],publicGoals=[]}){
  const lifecycleTurns={};
  for(const [turn,model] of Object.entries(turns))lifecycleTurns[turn]=model;
  return {
    ino:1,size:1,mtimeMs:ms(lastCompleteAt),headHash:'head',offset:1,
    modernRecords:records,legacyRecords:[],
    baseline:null,baselineSource:null,modernCumulative:null,legacyLast:null,
    currentTurn:null,modernNoCumulativeTurns:[],
    turns:{...turns},
    lifecycle:{
      turns:lifecycleTurns,contexts:Object.fromEntries(Object.keys(turns).map(id=>[id,{reasoning:'high',sandbox:'workspace-write',approval:'on-request'}])),starts,completes,aborted:{},
      lastKind:'complete',lastAt:ms(lastCompleteAt),lastCompleteAt:ms(lastCompleteAt),
      lastStartedAt:ms(starts[Object.keys(starts)[0]]?.startedAt??lastCompleteAt),
      lastMessage,userMessages,publicGoals,
    },
  };
}

function hostEntry(){
  return entry({
    turns:{h1:'gpt-5'},
    records:[record('h1',100,40,200,'2026-01-10T10:00:00.000Z')],
    starts:{h1:{startedAt:ms('2026-01-10T09:00:00.000Z')}},
    completes:{h1:{completedAt:ms('2026-01-10T11:00:00.000Z'),durationMs:7200000,message:'已完成登录功能并通过验收。'}},
    lastCompleteAt:'2026-01-10T11:00:00.000Z',
    lastMessage:'已完成登录功能并通过验收。',
    userMessages:['请实现登录功能'],
    publicGoals:[
      {text:'预检：确认目录和依赖。',turn:'h1',at:ms('2026-01-10T08:50:00.000Z'),sourceThreadId:'sub-1'},
      {text:'正式需求：完成登录实现与聚焦测试。',turn:'h1',at:ms('2026-01-10T09:00:00.000Z'),sourceThreadId:'sub-1'},
      {text:'中断续接：继续当前轮次。',turn:'h1',at:ms('2026-01-10T09:40:00.000Z'),sourceThreadId:'sub-1'},
      {text:'追加需求：增加增量视图并保留筛选。',turn:'h1',at:ms('2026-01-10T10:30:00.000Z'),sourceThreadId:'sub-2'},
    ],
  });
}
function subEntry(){
  return entry({
    turns:{s1:'gpt-5'},
    records:[record('s1',50,0,100,'2026-01-10T10:20:00.000Z')],
    starts:{s1:{startedAt:ms('2026-01-10T10:10:00.000Z')}},
    completes:{s1:{completedAt:ms('2026-01-10T10:25:00.000Z'),durationMs:900000,message:'子任务完成。'}},
    lastCompleteAt:'2026-01-10T10:25:00.000Z',
    lastMessage:'子任务完成。',
  });
}
function baselineEntry(){
  return entry({
    turns:{b1:'gpt-5'},
    records:[record('b1',300,0,700,'2026-01-08T08:55:00.000Z')],
    starts:{b1:{startedAt:ms('2026-01-08T08:50:00.000Z')}},
    completes:{b1:{completedAt:ms('2026-01-08T09:00:00.000Z'),durationMs:600000,message:'历史交付已完成。'}},
    lastCompleteAt:'2026-01-08T09:00:00.000Z',
    lastMessage:'历史交付已完成。',
    userMessages:['重构登录模块'],
    publicGoals:[
      {text:'历史正式需求：重构登录模块。',turn:'b1',at:ms('2026-01-08T08:50:00.000Z'),sourceThreadId:'sub-b'},
      {text:'历史追加需求：补齐回归。',turn:'b1',at:ms('2026-01-08T08:58:00.000Z'),sourceThreadId:'sub-b'},
    ],
  });
}
function activeEntry(){
  const value=entry({
    turns:{a1:'gpt-5'},
    records:[record('a1',10,0,5,'2026-01-10T11:00:00.000Z')],
    starts:{a1:{startedAt:ms('2026-01-10T10:50:00.000Z')}},
    completes:{},
    lastCompleteAt:'2026-01-10T11:00:00.000Z',
    lastMessage:'进行中。',
  });
  value.lifecycle.lastKind='started';
  value.lifecycle.completes={};
  return value;
}
function activeTaskEntry(){
  return entry({
    turns:{at1:'gpt-5'},
    records:[record('at1',10,0,0,'2026-01-10T11:00:00.000Z')],
    starts:{at1:{startedAt:ms('2026-01-10T10:50:00.000Z')}},
    completes:{at1:{completedAt:ms('2026-01-10T11:00:00.000Z'),durationMs:600000,message:'任务仍在推进。'}},
    lastCompleteAt:'2026-01-10T11:00:00.000Z',
    lastMessage:'任务仍在推进。',
  });
}

function thread(threadId,rolloutPath,overrides={}){
  return {
    threadId,parentThreadId:null,rolloutPath,title:threadId,tokensUsed:0,
    reasoningEffort:'high',sandbox:'workspace-write',approval:'on-request',
    source:null,threadSource:'user_thread',model:'gpt-5',
    ...overrides,
  };
}
function inventory(){
  const hostPath='/codex/host.jsonl',subPath='/codex/sub.jsonl',basePath='/codex/base.jsonl',
    activePath='/codex/active.jsonl',activeTaskPath='/codex/active-task.jsonl';
  const active=activeEntry();
  active.lifecycle.lastKind='started';
  return {
    available:true,
    threads:[
      thread('host-squad',hostPath,{title:'小队交付会话'}),
      thread('host-sub',subPath,{parentThreadId:'host-squad',title:'Codex 子 Agent'}),
      thread('baseline-root',basePath,{title:'历史纯 Codex 会话'}),
      thread('active-host',activePath,{title:'活跃会话'}),
      thread('active-task-host',activeTaskPath,{title:'活跃任务会话'}),
      thread('missing-host','/codex/missing.jsonl',{title:'缺失记录'}),
    ],
    index:{files:{
      [hostPath]:hostEntry(),
      [subPath]:subEntry(),
      [basePath]:baselineEntry(),
      [activePath]:active,
      [activeTaskPath]:activeTaskEntry(),
    }},
    readable:new Set([hostPath,subPath,basePath,activePath,activeTaskPath]),
  };
}

function acceptance(at){return {attemptId:'a1',fingerprint:'fp-a',note:'测试通过',at,files:[]}}
function attempt(id,{executor,startedAt,endedAt,status='completed',...rest}={}){
  return {id,index:1,status,startedAt,endedAt,usage:{inputTokens:0,outputTokens:0},executor,...rest};
}
function task(id,{title=id,status='accepted',attempts=[],acceptance:accepted=null,memberId='implementer'}={}){
  return {id,title,memberId,status,attempts,acceptance:accepted};
}
function view({threadId,parentWorkId,title=threadId,observedAt=iso(NOW.getTime()),tasks=[],members=[],parentStatus='done'}){
  return {
    schemaVersion:1,connected:true,observedAt,
    binding:{threadId,workspace:'/workspace',projectId:'project',parentWorkId,title},
    parent:{id:parentWorkId,status:parentStatus,completedAt:null},
    members,tasks,
  };
}

function nativeView(){
  return view({
    threadId:'host-squad',parentWorkId:'work-native',title:'登录功能交付',parentStatus:'backlog',
    members:[{id:'implementer',executor:'qoder'}],
    tasks:[task('task-login',{
      title:'实现登录功能',
      acceptance:acceptance('2026-01-10T10:40:00.000Z'),
      attempts:[
        attempt('a1',{executor:'qoder',startedAt:'2026-01-10T09:30:00.000Z',endedAt:'2026-01-10T10:00:00.000Z',
          actualModel:'qwen',usage:{inputTokens:20,outputTokens:10,cachedInputTokens:0},handoff:{goal:'实现登录功能'}}),
        attempt('a2',{index:2,executor:'codex',sessionId:'host-sub',
          startedAt:'2026-01-10T10:10:00.000Z',endedAt:'2026-01-10T10:30:00.000Z'}),
      ],
    })],
  });
}
function pendingViewOnly(){
  return view({
    threadId:'view-only-host',parentWorkId:'work-view',title:'观察中的工作',
    tasks:[task('task-pending',{status:'in_progress',attempts:[]})],
  });
}
function excludedViews(){
  return [
    view({
      threadId:'active-host',parentWorkId:'work-active',title:'活跃会话',
      tasks:[task('task-active',{acceptance:acceptance('2026-01-10T10:40:00.000Z')})],
    }),
    view({
      threadId:'missing-host',parentWorkId:'work-missing',title:'缺失记录',
      tasks:[task('task-missing',{acceptance:acceptance('2026-01-10T10:40:00.000Z')})],
    }),
    view({
      threadId:'active-task-host',parentWorkId:'work-active-task',title:'活跃任务会话',
      tasks:[task('task-running',{
        status:'in_progress',acceptance:acceptance('2026-01-10T10:40:00.000Z'),
      })],
    }),
  ];
}
function views(){return [nativeView(),...excludedViews(),pendingViewOnly()]}
function sources(){return collectBenefitSources({views:views(),inventory:inventory(),now:NOW})}

function match(){
  const ref=(prefix,id)=>`${prefix}:${id}`;
  return {
    deliveryId:DELIVERY_ID,
    baselineId:BASELINE_ID,
    basis:[
      {aspect:'workType',deliveryText:'实现登录功能',baselineText:'重构登录模块',
        deliveryRef:ref('benefit-delivery',DELIVERY_ID),baselineRef:ref('benefit-baseline',BASELINE_ID)},
      {aspect:'scale',deliveryText:'单模块改动',baselineText:'单模块重构',
        deliveryRef:ref('benefit-delivery',DELIVERY_ID),baselineRef:ref('benefit-baseline',BASELINE_ID)},
      {aspect:'acceptance',deliveryText:'测试通过并验收',baselineText:'测试通过并验收',
        deliveryRef:ref('benefit-delivery',DELIVERY_ID),baselineRef:ref('benefit-baseline',BASELINE_ID)},
    ],
  };
}
function close(actual,expected,epsilon=1e-6){
  assert.ok(Math.abs(actual-expected)<epsilon,`${actual} 应接近 ${expected}`);
}
function byId(benefits,id){return benefits.deliveries.find(delivery=>delivery.deliveryId===id)}
function codes(benefits){return benefits.coverage.benefitMatches.details.map(item=>item.code)}

test('native collection builds one complete delivery, a pure Codex baseline and measured run speeds',()=>{
  const collected=sources();

  assert.equal(collected.version,1);
  assert.equal(collected.coverage.available,true);
  assert.equal(collected.coverage.threads,6);
  assert.equal(collected.coverage.attemptedDeliveries,5);
  assert.equal(collected.coverage.completeDeliveries,1);
  assert.equal(collected.coverage.excludedDeliveries,4);
  assert.equal(collected.deliveryEvidence.length,1);
  assert.equal(collected.baselines.length,1);
  assert.equal(collected.coverage.baselineCandidates,1);
  assert.equal(collected.coverage.speedSamples,4);

  const native=collected.deliveryEvidence[0];
  assert.equal(native.native,true);
  assert.equal(native.matchRequired,true);
  assert.equal(native.deliveryId,DELIVERY_ID);
  assert.equal(native.completedAt,'2026-01-10T11:00:00.000Z');
  assert.equal(native.range.startedAt,'2026-01-10T09:00:00.000Z');
  assert.deepEqual(native.actual.codex.models.map(model=>[model.model,model.inputTokens,model.outputTokens]),[['gpt-5',150,300]]);
  assert.equal(native.actual.codex.threadCount,2,'主控与 Codex 子 Agent 合并进同一交付');
  assert.equal(native.actual.qoder.used,true);
  assert.equal(native.actual.qoder.reportedAttempts,1);
  assert.deepEqual(native.hardConditions.values,{
    model:'gpt-5',reasoning:'high',tools:'workspace-write',permissions:'on-request',
  });
  assert.equal(native.conditions,null);
  assert.equal(native.nativeSummary.tasks,1);
  assert.equal(native.nativeSummary.threads,2);

  const baseline=collected.baselines[0];
  assert.equal(baseline.baselineId,BASELINE_ID);
  assert.equal(baseline.pureCodex,true);
  assert.equal(baseline.sourceRef,'codex:baseline-root');
  assert.equal(baseline.completedAt,'2026-01-08T09:00:00.000Z');
  assert.deepEqual(baseline.hardConditions.values,native.hardConditions.values);

  const candidate=collected.candidates.deliveries[0];
  assert.equal(candidate.ref,`benefit-delivery:${DELIVERY_ID}`);
  assert.equal(candidate.finalMessage,'已完成登录功能并通过验收。');
  assert.deepEqual(candidate.publicGoals.map(goal=>goal.text),[
    '预检：确认目录和依赖。',
    '正式需求：完成登录实现与聚焦测试。',
    '追加需求：增加增量视图并保留筛选。',
  ],'首尾保留正式开工与追加需求，不让预检占满');
  assert.equal(candidate.publicGoals[1].turn,'h1');
  assert.equal(candidate.publicGoals[1].at,'2026-01-10T09:00:00.000Z');
  assert.deepEqual(candidate.userMessages,['请实现登录功能']);
  assert.equal(candidate.tasks[0].accepted,true);
  assert.equal(candidate.tasks[0].goal,'实现登录功能');
  assert.equal(collected.candidates.baselines[0].ref,`benefit-baseline:${BASELINE_ID}`);
  assert.deepEqual(collected.candidates.baselines[0].publicGoals.map(goal=>goal.text),[
    '历史正式需求：重构登录模块。','历史追加需求：补齐回归。',
  ]);

  const excluded=collected.coverage.excluded;
  const lifecycle=excluded.filter(item=>item.code==='delivery-codex-lifecycle-incomplete');
  assert.ok(lifecycle.some(item=>item.examples.some(example=>example.threads.some(thread=>thread.threadId==='active-host'&&thread.reason==='thread-active'))));
  assert.ok(lifecycle.some(item=>item.examples.some(example=>example.threads.some(thread=>thread.threadId==='missing-host'&&thread.reason==='rollout-missing'))));
  assert.ok(excluded.some(item=>item.code==='delivery-unaccepted'));
  assert.ok(excluded.some(item=>item.code==='delivery-active-task'
    &&item.examples.some(example=>example.threadId==='active-task-host')),'完成轮次上的活跃任务不能被当成已完成交付');
  assert.ok(excluded.some(item=>item.code==='baseline-overlaps-squad-or-analysis'
    &&item.examples.some(example=>example.threadId==='active-task-host')),'已绑定小队会话不能成为纯 Codex 基线');

  assert.deepEqual(collected.speedSamples.map(sample=>sample.scope),['run','run','run','run']);
  assert.deepEqual([...new Set(collected.speedSamples.map(sample=>sample.model))].sort(),['gpt-5','qwen']);
});

test('native pending delivery stays visible as investment and matched sources recompute frozen benefits',()=>{
  const collected=sources();
  const base=buildSquadBenefits({
    views:views(),codexUsage:null,now:NOW,days:null,
    deliveryEvidence:collected.deliveryEvidence,speedSamples:collected.speedSamples,
  });
  const pending=byId(base,DELIVERY_ID);
  assert.equal(pending.status,'completed');
  assert.equal(pending.matchPending,true);
  assert.equal(pending.estimate,null);
  assert.equal(pending.taskCount,1);
  assert.ok(pending.excludedReasons.some(reason=>reason.code==='baseline-match-pending'));
  assert.equal(base.coverage.pendingMatchDeliveries,1);
  assert.equal(base.coverage.tokenEstimatedDeliveries,0);

  const applied=applyBenefitMatches({
    stats:{benefits:base,codexUsage:null},sources:collected,matches:[match()],now:NOW,days:null,
  });
  const benefits=applied.benefits;
  assert.deepEqual(benefits.coverage.benefitMatches,{provided:1,applied:1,rejected:0,details:[]});

  const native=byId(benefits,DELIVERY_ID);
  assert.equal(native.matchPending,false);
  assert.equal(native.evidenceSource,'native-delivery');
  assert.equal(native.status,'completed');
  assert.equal(native.baseline.native,true);
  assert.equal(native.baseline.conditionsMatched,true);
  assert.equal(native.actual.codex.tokens,450);
  assert.equal(native.actual.codex.complete,true);
  assert.equal(native.actual.qoder.tokens,30);
  assert.equal(native.estimate.codexTokensSaved,550);
  assert.equal(native.estimate.tokenSavingRate,0.55);
  assert.equal(native.estimate.timeBasis,'run');
  assert.equal(native.estimate.timeRough,true);
  close(native.estimate.baselineSeconds,6300);
  close(native.estimate.squadSeconds,4500);
  close(native.estimate.secondsSaved,1800);
  assert.ok(native.excludedReasons.some(reason=>reason.code==='speed-run-basis'));

  assert.equal(benefits.summary.baselineCodexTokens,1000);
  assert.equal(benefits.summary.actualCodexTokens,450);
  assert.equal(benefits.summary.codexTokensSaved,550);
  assert.equal(benefits.summary.qoderTokens,30);
  close(benefits.summary.secondsSaved,1800);
  assert.equal(benefits.coverage.nativeDeliveries,1);
  assert.equal(benefits.coverage.pendingMatchDeliveries,0);
  assert.equal(benefits.coverage.tokenEstimatedDeliveries,1);
  assert.equal(benefits.coverage.timeEstimatedDeliveries,1);

  assert.ok(byId(benefits,'work-view:view-only-host'),'同窗口的纯视图交付在重算后仍然保留');
  assert.match(benefits.observation,/已有可比较的历史基线/);
});

test('matching rejects hard mismatches and later baselines but reuses a comparable historical reference',()=>{
  const collected=sources();
  const delivery=collected.deliveryEvidence[0];
  const baseline=collected.baselines[0];
  const stats={benefits:null,codexUsage:null};

  const mismatched=applyBenefitMatches({
    stats,now:NOW,days:null,matches:[match()],
    sources:{
      ...collected,
      deliveryEvidence:[{...delivery,hardConditions:{...delivery.hardConditions,values:{
        ...delivery.hardConditions.values,permissions:'never',
      }}}],
    },
  });
  assert.equal(mismatched.benefits.coverage.benefitMatches.applied,0);
  assert.ok(codes(mismatched.benefits).includes('hard-conditions-mismatch'));

  const notHistorical=applyBenefitMatches({
    stats,now:NOW,days:null,matches:[match()],
    sources:{...collected,baselines:[{...baseline,completedAt:'2026-01-10T11:00:00.000Z'}]},
  });
  assert.equal(notHistorical.benefits.coverage.benefitMatches.applied,0);
  assert.ok(codes(notHistorical.benefits).includes('baseline-not-historical'));

  const duplicate=applyBenefitMatches({
    stats,now:NOW,days:null,
    matches:[match(),{...match(),deliveryId:'work-native:host-other'}],
    sources:{...collected,deliveryEvidence:[delivery,{...delivery,threadId:'host-other',deliveryId:'work-native:host-other',actual:{codex:{...delivery.actual.codex,sourceRef:'codex:host-other'},qoder:{...delivery.actual.qoder,sourceRef:'qoder:host-other'}}}]},
  });
  assert.equal(duplicate.benefits.coverage.benefitMatches.applied,2);
  assert.equal(duplicate.benefits.coverage.tokenEstimatedDeliveries,2,'不同真实交付可复用同一可比基线，不重复统计实际来源');
});

test('baseline purity, recorded conditions and bounded exclusion coverage remain evidence based',()=>{
  const native=inventory();
  native.threads.find(thread=>thread.threadId==='baseline-root').threadSource='agent_created_thread';
  let collected=collectBenefitSources({views:[nativeView(),...excludedViews()],inventory:native,now:NOW});
  assert.equal(collected.baselines.length,1,'用户发起的独立聊天可以是基线');
  native.index.files['/codex/base.jsonl'].lifecycle.externalExecutors=['qoder'];
  collected=collectBenefitSources({views:[nativeView(),...excludedViews()],inventory:native,now:NOW});
  assert.equal(collected.baselines.length,0,'调用过Qoder的聊天不可用作纯Codex基线');
  assert.ok(collected.coverage.excluded.some(item=>item.code==='baseline-external-executor'));
  native.index.files['/codex/base.jsonl'].lifecycle.externalExecutors=[];
  native.index.files['/codex/base.jsonl'].lifecycle.contexts.b1.reasoning='max';
  collected=collectBenefitSources({views:[nativeView(),...excludedViews()],inventory:native,now:NOW});
  assert.notEqual(collected.baselines[0].hardConditions.values.reasoning,collected.deliveryEvidence[0].hardConditions.values.reasoning,
    '使用实际回合配置，不能拿数据库最后配置覆盖');
  for(let i=0;i<100;i++)native.threads.push(thread('missing-'+i,'/missing/'+i));
  collected=collectBenefitSources({views:[nativeView(),...excludedViews()],inventory:native,now:NOW});
  const missing=collected.coverage.excluded.find(item=>item.code==='baseline-lifecycle-incomplete');
  assert.ok(missing.count>=100);
  assert.equal(missing.examples.length,8,'全部缺口计数保留，仅限制例子数量');
});
