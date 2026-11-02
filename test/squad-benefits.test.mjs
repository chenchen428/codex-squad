import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSquadBenefits} from '../cli/lib/squad-benefits.mjs';

const NOW=new Date('2026-01-10T12:00:00.000Z');
const DAY=86400000;
const HOUR=3600000;

function stamp(offsetMs){return new Date(NOW.getTime()+offsetMs).toISOString()}
function close(actual,expected,epsilon=1e-9){
  assert.ok(Math.abs(actual-expected)<epsilon,`${actual} 应接近 ${expected}`);
}
function conditions(overrides={}){
  return {
    workType:'feature',
    scale:'medium',
    model:'gpt-5',
    reasoning:'high',
    acceptance:'tests-and-review',
    permissions:'workspace-write',
    tools:'same-tools',
    ...overrides
  };
}
function model(name,inputTokens,outputTokens,cachedInputTokens=null){
  const value={model:name,source:'actual',inputTokens,outputTokens};
  if(cachedInputTokens!==null)value.cachedInputTokens=cachedInputTokens;
  return value;
}
function codex(models,overrides={}){
  return {
    sourceRef:'codex:rollout-a',
    complete:true,
    includesMain:true,
    includesSubagents:true,
    models,
    ...overrides
  };
}
function qoder(models=[],overrides={}){
  return {used:true,sourceRef:'qoder:session-a',complete:true,models,...overrides};
}
function baseline(models,overrides={}){
  return {
    sourceRef:'codex:baseline-a',
    pureCodex:true,
    complete:true,
    includesMain:true,
    includesSubagents:true,
    completedAt:'2025-12-01T10:00:00.000Z',
    conditions:conditions(),
    models,
    ...overrides
  };
}
function evidence(overrides={}){
  const threadId=overrides.threadId??'thread-a';
  const parentWorkId=overrides.parentWorkId??'work-a';
  const value={
    deliveryId:`${parentWorkId}:${threadId}`,
    threadId,
    parentWorkId,
    title:'交付 A',
    completedAt:stamp(-DAY),
    accepted:true,
    conditions:conditions(),
    actual:{
      codex:codex([model('gpt-5',200,300)]),
      qoder:qoder([model('qwen',30,10)])
    },
    baseline:baseline([model('gpt-5',300,700)]),
    ...overrides
  };
  if(value.actual.codex.sourceRef==='codex:rollout-a')value.actual.codex={...value.actual.codex,sourceRef:`codex:${threadId}`};
  if(value.actual.qoder.sourceRef==='qoder:session-a')value.actual.qoder={...value.actual.qoder,sourceRef:`qoder:${threadId}`};
  return value;
}
function speed(modelName,outputTokens,durationMs,endedAt=stamp(-DAY),scope='model'){
  return {
    model:modelName,
    source:'actual',
    scope,
    sourceRef:`speed:${modelName??'run'}:${outputTokens}:${durationMs}:${endedAt}`,
    outputTokens,
    durationMs,
    endedAt
  };
}
function attempt(id,{
  executor='qoder',
  usage={inputTokens:0,outputTokens:0},
  startedAt=stamp(-HOUR),
  endedAt=stamp(-HOUR/2),
  status='completed',
  ...rest
}={}){
  return {id,index:1,status,startedAt,endedAt,usage,executor,...rest};
}
function acceptance(at=stamp(-HOUR)){return {attemptId:'a1',fingerprint:'fp-a',note:'',at,files:[]}}
function task(id,{title=id,status='in_progress',attempts=[],acceptance:accepted=null,memberId='implementer'}={}){
  return {id,title,memberId,status,attempts,acceptance:accepted};
}
function view({
  threadId='thread-a',
  parentWorkId='work-a',
  title='交付 A',
  observedAt=stamp(0),
  tasks=[],
  members=[{id:'implementer',executor:'qoder'}],
  schemaVersion=1,
  parentStatus='done',
  parentCompletedAt=null
}={}){
  return {
    schemaVersion,
    connected:true,
    observedAt,
    binding:{threadId,workspace:'/workspace',projectId:'project',parentWorkId,title},
    parent:{id:parentWorkId,status:parentStatus,completedAt:parentCompletedAt??(tasks.some(t=>t.acceptance?.at)?tasks.map(t=>t.acceptance?.at).filter(Boolean).sort().at(-1):stamp(-HOUR))},
    members,
    tasks
  };
}
function codexUsage({
  threadId='thread-a',
  available=true,
  inputTokens=100,
  outputTokens=50,
  sessionModels=[{model:'gpt-5',inputTokens:100,outputTokens:50,cachedInputTokens:0}]
}={}){
  return {
    schemaVersion:1,
    available,
    observedAt:stamp(0),
    scope:'local',
    totals:{inputTokens,cachedInputTokens:0,outputTokens,totalTokens:inputTokens+outputTokens},
    sessions:[{
      threadId,
      title:'宿主会话',
      kind:'squad',
      squadThreadId:threadId,
      models:sessionModels,
      inputTokens,
      cachedInputTokens:0,
      outputTokens,
      totalTokens:inputTokens+outputTokens,
      turnCount:2
    }],
    models:[],
    coverage:{threads:1,readableThreads:1,missingThreads:0,usageThreads:1,unreportedThreads:0,unreportedWithTokens:0,undatedRecords:0,unattributedModelRecords:0},
    note:'本机窗口用量'
  };
}
function byId(result,deliveryId){return result.deliveries.find(delivery=>delivery.deliveryId===deliveryId)}
function reasonCodes(delivery){return delivery.excludedReasons.map(reason=>reason.code)}
function reasonOf(delivery,code){return delivery.excludedReasons.find(reason=>reason.code===code)}

test('aggregate ratio uses summed baseline and not the average of delivery rates',()=>{
  const positive=evidence({
    threadId:'thread-positive',
    actual:{codex:codex([model('gpt-5',200,300)]),qoder:{used:false}},
    baseline:baseline([model('gpt-5',300,700)])
  });
  const negative=evidence({
    threadId:'thread-negative',
    actual:{codex:codex([model('gpt-5',100,20)]),qoder:{used:false}},
    baseline:baseline([model('gpt-5',80,20)])
  });
  const result=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[positive,negative]
  });

  assert.equal(result.coverage.tokenEstimatedDeliveries,2);
  assert.equal(result.summary.baselineCodexTokens,1100);
  assert.equal(result.summary.actualCodexTokens,620);
  assert.equal(result.summary.codexTokensSaved,480);
  close(result.summary.tokenSavingRate,480/1100,1e-6);
  assert.notEqual(result.summary.tokenSavingRate,0.15,'不能按每个交付费率取平均');

  const positiveDelivery=byId(result,'work-a:thread-positive');
  const negativeDelivery=byId(result,'work-a:thread-negative');
  assert.equal(positiveDelivery.estimate.codexTokensSaved,500);
  assert.equal(negativeDelivery.estimate.codexTokensSaved,-20,'负收益必须保留');
  assert.equal(negativeDelivery.estimate.tokenSavingRate,-0.2);
  assert.deepEqual(result.summary.baselineSeconds,null);
  assert.deepEqual(result.summary.secondsSaved,null);
  assert.equal(result.coverage.timeEstimatedDeliveries,0);
});

test('cached input is never added twice and Qoder tokens never reduce Codex savings',()=>{
  const delivery=evidence({
    actual:{
      codex:codex([model('gpt-5',100,20,80)]),
      qoder:qoder([model('qwen',30,10)])
    },
    baseline:baseline([model('gpt-5',100,50,50)])
  });
  const result=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[delivery],
    speedSamples:[
      speed('gpt-5',50,5000),
      speed('qwen',10,2000)
    ]
  });
  const row=result.deliveries[0];

  assert.equal(row.actual.codex.tokens,120,'cached 输入已包含在 input 中，不额外相加');
  assert.equal(row.actual.codex.cachedInputTokens,80);
  assert.equal(row.actual.qoder.tokens,40);
  assert.equal(result.summary.baselineCodexTokens,150);
  assert.equal(result.summary.actualCodexTokens,120);
  assert.equal(result.summary.qoderTokens,40);
  assert.equal(result.summary.codexTokensSaved,30,'Qoder 只列实际，不从节省中抵扣');
  assert.equal(result.summary.tokenSavingRate,0.2);

  close(row.estimate.baselineSeconds,5);
  close(row.estimate.squadSeconds,4);
  close(row.estimate.secondsSaved,1);
  close(row.estimate.timeSavingRate,0.2);
});

test('main session, subagents, failures and rework all stay inside one delivery',()=>{
  const delivery=evidence({
    actual:{
      codex:codex([
        model('gpt-5-main',100,50),
        model('gpt-5-subagent',50,25),
        model('gpt-5-rework',25,25)
      ]),
      qoder:qoder([model('qwen',10,5)])
    },
    baseline:baseline([model('gpt-5-main',100,300)])
  });
  const result=buildSquadBenefits({views:[],codexUsage:null,now:NOW,days:null,deliveryEvidence:[delivery]});
  const row=result.deliveries[0];

  assert.equal(result.deliveries.length,1,'主控、子 Agent 和返工不拆成多个收益交付');
  assert.equal(row.actual.codex.tokens,275);
  assert.equal(row.actual.codex.complete,true);
  assert.equal(row.actual.codex.models.length,3);
  assert.equal(row.estimate.codexTokensSaved,125);
  assert.equal(result.summary.codexTokensSaved,125);
  assert.ok(!reasonCodes(row).includes('actual-incomplete'));
});

test('time uses per-model output speed for baseline, actual Codex and Qoder',()=>{
  const delivery=evidence({
    actual:{
      codex:codex([model('model-a',0,400),model('model-b',0,200)]),
      qoder:qoder([model('model-c',0,300)])
    },
    baseline:baseline([model('model-a',0,1000),model('model-b',0,500)])
  });
  const result=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[delivery],
    speedSamples:[
      speed('model-a',1000,10000),
      speed('model-b',500,10000),
      speed('model-c',400,2000)
    ]
  });
  const row=result.deliveries[0];

  assert.deepEqual(row.estimate.processing.map(part=>[part.side,part.model,part.outputTokens,part.tokensPerSecond,part.seconds]),[
    ['baseline','model-a',1000,100,10],['baseline','model-b',500,50,10],
    ['actual-codex','model-a',400,100,4],['actual-codex','model-b',200,50,4],['qoder','model-c',300,200,1.5],
  ]);
  close(row.estimate.baselineSeconds,20);
  close(row.estimate.squadSeconds,9.5);
  close(row.estimate.secondsSaved,10.5);
  close(row.estimate.timeSavingRate,0.525,1e-6);
  assert.equal(row.estimate.timeBasis,'model');
  assert.equal(row.estimate.timeRough,false);
  assert.equal(result.coverage.timeEstimatedDeliveries,1);
  assert.equal(result.summary.baselineSeconds,20);
  assert.equal(result.summary.squadSeconds,9.5);
  assert.equal(result.summary.secondsSaved,10.5);
});

test('speed uses the recent per-model median and skips stale or configured samples',()=>{
  const delivery=evidence({
    actual:{codex:codex([model('gpt-5',0,200)]),qoder:{used:false}},
    baseline:baseline([model('gpt-5',0,400)])
  });
  const configuredSample={
    model:'gpt-5',
    scope:'model',
    sourceRef:'speed:configured',
    outputTokens:100,
    durationMs:1000,
    endedAt:stamp(-DAY),
    source:'configured'
  };
  const result=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[delivery],
    speedSamples:[
      speed('gpt-5',100,1000),
      speed('gpt-5',300,1000),
      speed('gpt-5',100,10000,stamp(-40*DAY)),
      configuredSample
    ]
  });
  const measured=result.speeds.find(sample=>sample.model==='gpt-5');
  const row=result.deliveries[0];

  assert.equal(measured.samples,2);
  assert.equal(measured.tokensPerSecond,200);
  assert.equal(result.coverage.speeds.staleSamples,1);
  assert.equal(result.coverage.speeds.invalidSamples,1);
  close(row.estimate.baselineSeconds,2);
  close(row.estimate.squadSeconds,1);
  close(row.estimate.secondsSaved,1);
});

test('whole-run speed is an explicit rough fallback only when model samples are absent',()=>{
  const delivery=evidence({
    actual:{codex:codex([model('model-a',0,500)]),qoder:qoder([model('model-c',0,300)])},
    baseline:baseline([model('model-a',0,1000)])
  });
  const result=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[delivery],
    speedSamples:[speed('model-a',600,6000,stamp(-DAY),'run'),speed('model-c',600,6000,stamp(-DAY),'run')]
  });
  const row=result.deliveries[0];
  const run=result.speeds.find(sample=>sample.basis==='run');

  assert.equal(run.rough,true);
  assert.equal(run.tokensPerSecond,100);
  assert.equal(row.estimate.timeBasis,'run');
  assert.equal(row.estimate.timeRough,true);
  close(row.estimate.baselineSeconds,10);
  close(row.estimate.squadSeconds,8);
  close(row.estimate.secondsSaved,2);
  assert.equal(result.coverage.timeRough,true);
  assert.deepEqual(reasonOf(row,'speed-run-basis').detail,{models:['model-a','model-c']});
});

test('a missing model speed removes time but keeps the token estimate and coverage',()=>{
  const delivery=evidence({
    actual:{codex:codex([model('model-b',0,50)]),qoder:{used:false}},
    baseline:baseline([model('model-a',0,100)])
  });
  const result=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[delivery],
    speedSamples:[speed('model-a',100,1000)]
  });
  const row=result.deliveries[0];

  assert.equal(row.estimate.codexTokensSaved,50);
  assert.equal(row.estimate.baselineSeconds,null);
  assert.equal(row.estimate.squadSeconds,null);
  assert.equal(row.estimate.secondsSaved,null);
  assert.equal(row.estimate.timeSavingRate,null);
  assert.deepEqual(reasonOf(row,'speed-missing-model').detail,{model:'model-b',unit:'actual-codex'});
  assert.equal(result.coverage.tokenEstimatedDeliveries,1);
  assert.equal(result.coverage.timeEstimatedDeliveries,0);
  assert.equal(result.summary.codexTokensSaved,50);
  assert.equal(result.summary.baselineSeconds,null);
  assert.equal(result.summary.secondsSaved,null);
});

test('a missing baseline shows investment but never fabricates a saving',()=>{
  const delivery=evidence({
    baseline:null,
    actual:{
      codex:codex([model('gpt-5',100,100)]),
      qoder:qoder([model('qwen',20,10)])
    }
  });
  const result=buildSquadBenefits({views:[],codexUsage:null,now:NOW,days:null,deliveryEvidence:[delivery]});
  const row=result.deliveries[0];

  assert.equal(row.actual.codex.tokens,200);
  assert.equal(row.actual.qoder.tokens,30);
  assert.equal(row.baseline,null);
  assert.equal(row.estimate,null);
  assert.ok(reasonCodes(row).includes('baseline-missing'));
  assert.equal(result.summary.baselineCodexTokens,null);
  assert.equal(result.summary.codexTokensSaved,null);
  assert.equal(result.coverage.tokenEstimatedDeliveries,0);
  assert.match(result.observation,/暂无法估算/);
});

test('baseline conditions must match with evidence and the baseline must be historical',()=>{
  const mismatch=evidence({
    threadId:'thread-mismatch',
    conditions:conditions({scale:'large'})
  });
  const missingField=evidence({
    threadId:'thread-missing',
    conditions:{...conditions(),permissions:undefined}
  });
  const notHistorical=evidence({
    threadId:'thread-future-baseline',
    baseline:baseline([model('gpt-5',300,700)],{completedAt:stamp(-DAY+HOUR)})
  });
  const result=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[mismatch,missingField,notHistorical]
  });

  const mismatchRow=byId(result,'work-a:thread-mismatch');
  const missingRow=byId(result,'work-a:thread-missing');
  const futureRow=byId(result,'work-a:thread-future-baseline');

  assert.equal(mismatchRow.estimate,null);
  assert.deepEqual(reasonOf(mismatchRow,'baseline-conditions-mismatch').detail,{fields:['scale']});
  assert.equal(mismatchRow.baseline.conditionsMatched,false);

  assert.equal(missingRow.estimate,null);
  assert.deepEqual(reasonOf(missingRow,'baseline-conditions-missing').detail,{fields:['permissions']});

  assert.equal(futureRow.estimate,null);
  assert.ok(reasonCodes(futureRow).includes('baseline-not-historical'));
  assert.equal(result.summary.codexTokensSaved,null);
});

test('incomplete, failed and stopped view deliveries expose investment only',()=>{
  const incomplete=view({
    threadId:'thread-incomplete',
    parentWorkId:'work-incomplete',
    tasks:[task('task-incomplete',{
      status:'in_progress',
      attempts:[attempt('a1',{usage:{inputTokens:100,outputTokens:50}})]
    })]
  });
  const failed=view({
    threadId:'thread-failed',
    parentWorkId:'work-failed',
    tasks:[task('task-failed',{
      status:'failed',
      attempts:[attempt('a1',{status:'failed',usage:{inputTokens:10,outputTokens:5}})]
    })]
  });
  const stopped=view({
    threadId:'thread-stopped',
    parentWorkId:'work-stopped',
    tasks:[task('task-stopped',{
      status:'stopped',
      attempts:[attempt('a1',{status:'stopped',usage:{inputTokens:20,outputTokens:10}})]
    })]
  });
  const result=buildSquadBenefits({views:[incomplete,failed,stopped],codexUsage:null,now:NOW,days:null});

  const incompleteRow=byId(result,'work-incomplete:thread-incomplete');
  const failedRow=byId(result,'work-failed:thread-failed');
  const stoppedRow=byId(result,'work-stopped:thread-stopped');

  assert.equal(incompleteRow.status,'incomplete');
  assert.equal(incompleteRow.actual.qoder.tokens,150);
  assert.ok(reasonCodes(incompleteRow).includes('delivery-incomplete'));
  assert.equal(incompleteRow.estimate,null);

  assert.equal(failedRow.status,'failed');
  assert.equal(failedRow.actual.qoder.tokens,15);
  assert.ok(reasonCodes(failedRow).includes('delivery-failed'));

  assert.equal(stoppedRow.status,'stopped');
  assert.equal(stoppedRow.actual.qoder.tokens,30);
  assert.ok(reasonCodes(stoppedRow).includes('delivery-stopped'));

  assert.equal(result.summary.codexTokensSaved,null);
  assert.equal(result.coverage.completedDeliveries,0);
  assert.match(result.observation,/观察到 3 项工作/);
});

test('cross-period completed delivery keeps its full lifecycle and lands in the completion period',()=>{
  const inPeriod=view({
    threadId:'thread-late-finish',
    parentWorkId:'work-late-finish',
    tasks:[task('task-late-finish',{
      status:'accepted',
      acceptance:acceptance(stamp(-DAY)),
      attempts:[
        attempt('a1',{startedAt:stamp(-10*DAY),endedAt:stamp(-10*DAY+HOUR),usage:{inputTokens:100,outputTokens:10}}),
        attempt('a2',{index:2,startedAt:stamp(-2*DAY),endedAt:stamp(-2*DAY+HOUR),usage:{inputTokens:200,outputTokens:20}})
      ]
    })]
  });
  const oldFinish=view({
    threadId:'thread-old-finish',
    parentWorkId:'work-old-finish',
    tasks:[task('task-old-finish',{
      status:'accepted',
      acceptance:acceptance(stamp(-9*DAY)),
      attempts:[attempt('a1',{startedAt:stamp(-10*DAY),endedAt:stamp(-9*DAY),usage:{inputTokens:10,outputTokens:1}})]
    })]
  });
  const result=buildSquadBenefits({views:[inPeriod,oldFinish],codexUsage:null,now:NOW,days:7});
  const row=byId(result,'work-late-finish:thread-late-finish');

  assert.ok(row);
  assert.equal(row.status,'completed');
  assert.equal(row.actual.qoder.tokens,330,'完整生命周期内两次尝试都计入，不按窗口截断');
  assert.equal(row.range.startedAt,stamp(-10*DAY));
  assert.equal(row.range.completedAt,stamp(-DAY));
  assert.equal(byId(result,'work-old-finish:thread-old-finish'),undefined,'完成后不在周期的交付不进入本期');
  assert.equal(result.coverage.outsidePeriodDeliveries,1);
});

test('duplicate snapshots, subtasks and duplicate evidence count one real unit once',()=>{
  const snapshot=view({
    tasks:[
      task('subtask-1',{
        status:'accepted',
        acceptance:acceptance(),
        attempts:[
          attempt('same-attempt',{usage:{inputTokens:10,outputTokens:1}}),
          attempt('same-attempt',{usage:{inputTokens:10,outputTokens:1}})
        ]
      }),
      task('subtask-2',{
        status:'accepted',
        acceptance:acceptance(),
        attempts:[attempt('other-attempt',{usage:{inputTokens:20,outputTokens:2}})]
      })
    ]
  });
  const viewResult=buildSquadBenefits({views:[snapshot,snapshot,snapshot],codexUsage:null,now:NOW,days:null});

  assert.equal(viewResult.deliveries.length,1,'子任务不拆成多个收益交付');
  assert.equal(viewResult.deliveries[0].actual.qoder.tokens,33);
  assert.equal(viewResult.deliveries[0].actual.qoder.attempts,2,'重复尝试按身份去重');

  const entry=evidence({
    actual:{codex:codex([model('gpt-5',200,300)]),qoder:{used:false}},
    baseline:baseline([model('gpt-5',300,700)])
  });
  const evidenceResult=buildSquadBenefits({
    views:[],codexUsage:null,now:NOW,days:null,
    deliveryEvidence:[entry,entry]
  });

  assert.equal(evidenceResult.deliveries.length,1);
  assert.equal(evidenceResult.coverage.deliveryEvidence.duplicate,1);
  assert.equal(evidenceResult.summary.baselineCodexTokens,1000);
  assert.equal(evidenceResult.summary.codexTokensSaved,500);
});

test('real views report observed investment and concrete gaps without leaking work records',()=>{
  const snapshot=view({
    tasks:[task('task-real',{
      status:'accepted',
      acceptance:acceptance(),
      attempts:[attempt('a1',{
        usage:{inputTokens:40,outputTokens:8,cachedInputTokens:5},
        handoff:{goal:'SECRET-WORK-NOTE'},
        events:[{kind:'tool',text:'SECRET-WORK-NOTE'}]
      })]
    })]
  });
  const result=buildSquadBenefits({
    views:[snapshot],
    codexUsage:codexUsage(),
    now:NOW,
    days:null
  });
  const row=result.deliveries[0];

  assert.equal(row.status,'completed');
  assert.equal(row.actual.qoder.tokens,48);
  assert.equal(row.actual.qoder.cachedInputTokens,5);
  assert.equal(row.actual.codex.tokens,150);
  assert.equal(row.actual.codex.complete,false);
  assert.equal(row.actual.codex.scope,'host-thread-window');
  assert.equal(row.actual.codex.models[0].source,'measured');
  assert.ok(reasonCodes(row).includes('codex-attribution-missing'));
  assert.ok(reasonCodes(row).includes('baseline-missing'));
  assert.equal(row.estimate,null);

  assert.equal(result.summary.codexTokensSaved,null);
  assert.equal(result.summary.actualCodexTokens,null);
  assert.equal(result.coverage.codexUsage.available,true);
  assert.equal(result.coverage.codexUsage.sessions,1);
  assert.equal(result.coverage.viewDeliveries,1);
  assert.match(result.observation,/暂无法估算/);
  assert.ok(!JSON.stringify(result).includes('SECRET-WORK-NOTE'),'公开结果不包含工作记录原文');
  assert.ok(!JSON.stringify(result).includes('fp-a'),'公开结果不包含验收指纹');
});

test('compact snapshots resolve the member executor and keep pending deliveries observable',()=>{
  const activeAttempt=attempt('a1',{executor:undefined,usage:{inputTokens:10,outputTokens:2}});
  const earlier=view({
    observedAt:stamp(-2*HOUR),
    tasks:[task('task-a',{status:'in_progress',attempts:[activeAttempt]})],
    members:[{id:'implementer',executor:'qoder'}]
  });
  const pending=view({
    threadId:'thread-pending',
    parentWorkId:'work-pending',
    observedAt:stamp(-HOUR),
    tasks:[task('task-pending',{status:'in_progress',attempts:[]})],
    members:[]
  });
  const result=buildSquadBenefits({views:[earlier,pending],codexUsage:null,now:NOW,days:null});
  const row=byId(result,'work-a:thread-a');
  const pendingRow=byId(result,'work-pending:thread-pending');

  assert.equal(row.actual.qoder.tokens,12,'成员配置应解析出 qoder 执行器');
  assert.ok(pendingRow,'没有尝试的待办交付也应保留在观察范围');
  assert.equal(pendingRow.status,'incomplete');
  assert.equal(pendingRow.actual.qoder.tokens,null);
  assert.equal(pendingRow.range.lastActivityAt,stamp(-HOUR));
});

test('invalid structured evidence is ignored and invalid options fail fast',()=>{
  assert.throws(()=>buildSquadBenefits({views:'nope',now:NOW}),/views/);
  assert.throws(()=>buildSquadBenefits({views:[],now:NOW,days:14}),/days/);
  assert.throws(()=>buildSquadBenefits({views:[],now:new Date('nope')}),/now/);
  assert.throws(()=>buildSquadBenefits({views:[],now:NOW,codexUsage:'nope'}),/codexUsage/);
  assert.throws(()=>buildSquadBenefits({views:[],now:NOW,deliveryEvidence:{}}),/deliveryEvidence/);
  assert.throws(()=>buildSquadBenefits({views:[],now:NOW,speedSamples:{}}),/speedSamples/);
  assert.throws(()=>buildSquadBenefits({views:[],now:NOW,speedWindowDays:0}),/speedWindowDays/);

  const invalid=[
    evidence({actual:{codex:codex([model('gpt-5',1,1)],{sourceRef:''}),qoder:{used:false}}}),
    evidence({actual:{codex:codex([model('gpt-5',1,1),model('gpt-5',2,2)]),qoder:{used:false}}}),
    evidence({accepted:false}),
    evidence({threadId:'thread-x',parentWorkId:'work-x',deliveryId:'work-x:wrong-thread'})
  ];
  const result=buildSquadBenefits({views:[],codexUsage:null,now:NOW,days:null,deliveryEvidence:invalid});

  assert.equal(result.deliveries.length,0);
  assert.deepEqual(result.coverage.deliveryEvidence,{provided:4,valid:0,invalid:4,duplicate:0});
  assert.equal(result.summary.codexTokensSaved,null);
  assert.equal(result.observation,'本期没有观察到可归集的完整交付，暂无法估算收益。');
});

test('one completed child cannot declare an unfinished root delivery complete',()=>{
  const snapshot=view({parentStatus:'backlog',tasks:[task('accepted',{status:'accepted',acceptance:acceptance(),attempts:[attempt('a1')]})]});
  const result=buildSquadBenefits({views:[snapshot],now:NOW,days:7,codexUsage:codexUsage()});
  assert.equal(result.coverage.completedDeliveries,0);
  assert.equal(result.deliveries[0].status,'incomplete');
  assert.equal(result.summary.codexTokensSaved,null);
});

test('whole-run observations only supply speeds for their actual model',()=>{
  const result=buildSquadBenefits({views:[],now:NOW,days:null,deliveryEvidence:[evidence()],
    speedSamples:[speed('gpt-5',600,6000,stamp(-DAY),'run')]});
  assert.equal(result.summary.codexTokensSaved,500);
  assert.equal(result.summary.secondsSaved,null,'Qoder model has no speed; Codex speed cannot substitute');
  assert.ok(result.deliveries[0].excludedReasons.some(reason=>reason.code==='speed-missing-model'&&reason.detail.model==='qwen'));
  const unknown=buildSquadBenefits({views:[],now:NOW,days:null,deliveryEvidence:[evidence()],
    speedSamples:[{...speed('gpt-5',600,6000),source:undefined}]});
  assert.equal(unknown.speeds.length,0);
});

test('time total is unavailable when the comparable token cohort is only partly timed',()=>{
  const a=evidence({threadId:'a',actual:{codex:codex([model('gpt-5',100,100)]),qoder:{used:false}}});
  const b=evidence({threadId:'b',actual:{codex:codex([model('other',100,100)]),qoder:{used:false}}});
  const result=buildSquadBenefits({views:[],now:NOW,days:null,deliveryEvidence:[a,b],speedSamples:[speed('gpt-5',100,1000)]});
  assert.equal(result.coverage.tokenEstimatedDeliveries,2);
  assert.equal(result.coverage.timeEstimatedDeliveries,1);
  assert.equal(result.summary.codexTokensSaved,1600);
  assert.equal(result.summary.baselineSeconds,null);
  assert.equal(result.summary.secondsSaved,null);
});

test('native pending evidence is complete investment even when the view root is a backlog placeholder',()=>{
  const hard={values:{model:'gpt-5',reasoning:'high',tools:'same-tools',permissions:'workspace-write'}};
  const pending=evidence({
    native:true,matchRequired:true,
    conditions:null,
    hardConditions:hard,
    baseline:null,
    nativeSummary:{tasks:3}
  });
  const snapshot=view({
    parentStatus:'backlog',
    tasks:[task('task-native',{status:'accepted',acceptance:acceptance(),attempts:[attempt('a1')]})]
  });
  const result=buildSquadBenefits({
    views:[snapshot],codexUsage:null,now:NOW,days:null,deliveryEvidence:[pending]
  });
  const row=result.deliveries[0];

  assert.equal(row.deliveryId,'work-a:thread-a');
  assert.equal(row.status,'completed','原生生命周期结束优先于 backlog 占位');
  assert.equal(row.native,true);
  assert.equal(row.matchPending,true);
  assert.equal(row.taskCount,3);
  assert.equal(row.estimate,null);
  assert.ok(reasonCodes(row).includes('baseline-match-pending'));
  assert.ok(!reasonCodes(row).includes('evidence-view-conflict'));
  assert.equal(result.coverage.completedDeliveries,1);
  assert.equal(result.coverage.nativeDeliveries,1);
  assert.equal(result.coverage.pendingMatchDeliveries,1);
  assert.match(result.observation,/尚未确认与历史基线/);
});

test('native matched evidence compares hard conditions while keeping the semantic basis',()=>{
  const hard={values:{model:'gpt-5',reasoning:'high',tools:'same-tools',permissions:'workspace-write'}};
  const semantic={
    workType:'feature',scale:'medium',acceptance:'tests-and-review'
  };
  const semanticMatch={source:'model',basis:[
    {aspect:'workType',deliveryText:'新增登录',baselineText:'重构登录',deliveryRef:'benefit-delivery:work-a:thread-a',baselineRef:'benefit-baseline:codex-session:baseline-native'},
    {aspect:'scale',deliveryText:'单模块',baselineText:'单模块',deliveryRef:'benefit-delivery:work-a:thread-a',baselineRef:'benefit-baseline:codex-session:baseline-native'},
    {aspect:'acceptance',deliveryText:'测试通过',baselineText:'测试通过',deliveryRef:'benefit-delivery:work-a:thread-a',baselineRef:'benefit-baseline:codex-session:baseline-native'}
  ]};
  const nativeBaseline=baseline([model('gpt-5',300,700)],{
    native:true,
    sourceRef:'codex:baseline-native',
    completedAt:'2025-12-01T10:00:00.000Z',
    hardConditions:hard,
    conditions:conditions({workType:'refactor',scale:'large',acceptance:'manual-review'}),
    semanticConditions:{workType:'refactor',scale:'large',acceptance:'manual-review'},
    semanticMatch
  });
  const delivery=evidence({
    native:true,matchRequired:true,
    conditions:conditions(),
    hardConditions:hard,
    semanticConditions:semantic,
    semanticMatch,
    nativeSummary:{tasks:2},
    actual:{codex:codex([model('gpt-5',200,300)]),qoder:{used:false}},
    baseline:nativeBaseline
  });
  const result=buildSquadBenefits({views:[],now:NOW,days:null,deliveryEvidence:[delivery]});
  const row=result.deliveries[0];

  assert.equal(row.baseline.native,true);
  assert.equal(row.baseline.conditionsMatched,true,'语义匹配由冻结的依据承载，不再要求两侧摘录文本相等');
  assert.deepEqual(row.semanticMatch.source,'model');
  assert.equal(row.taskCount,2);
  assert.equal(row.estimate.codexTokensSaved,500);
  assert.equal(row.estimate.baselineSeconds,null);
  assert.equal(row.estimate.secondsSaved,null);
  assert.equal(result.summary.codexTokensSaved,500);
  assert.equal(result.coverage.tokenEstimatedDeliveries,1);
  assert.deepEqual(reasonOf(row,'speed-missing-model').detail,{model:'gpt-5',unit:'actual-codex'});
});

test('different delivery ids cannot attribute one actual receipt twice and tools must match',()=>{
  const first=evidence({threadId:'one',actual:{codex:codex([model('gpt-5',100,100)],{sourceRef:'shared-main'}),qoder:{used:false}}});
  const second=evidence({threadId:'two',actual:{codex:codex([model('gpt-5',100,100)],{sourceRef:'shared-main'}),qoder:{used:false}}});
  const result=buildSquadBenefits({views:[],now:NOW,days:null,deliveryEvidence:[first,second]});
  assert.equal(result.coverage.tokenEstimatedDeliveries,1);
  assert.equal(result.coverage.deliveryEvidence.duplicate,1);
  const mismatch=evidence({conditions:conditions({tools:'different-toolset'})});
  const excluded=buildSquadBenefits({views:[],now:NOW,days:null,deliveryEvidence:[mismatch]});
  assert.equal(excluded.summary.codexTokensSaved,null);
  assert.ok(excluded.deliveries[0].excludedReasons.some(reason=>reason.code==='baseline-conditions-mismatch'));
});
