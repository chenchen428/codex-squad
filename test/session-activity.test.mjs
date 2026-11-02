import test from 'node:test';
import assert from 'node:assert/strict';
import {executionActivityOf,executionMetricsOf,executionStatusOf} from '../cli/ui/session-activity.mjs';

test('running stays active when messages and tools have already completed',()=>{
  const task={id:'build',status:'running',attempts:[{
    id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z',
    events:[
      {id:'m1',kind:'message',role:'assistant',text:'已完成修改',status:'completed'},
      {id:'t1',kind:'tool',toolName:'Bash',text:'npm test',status:'completed'},
      {id:'t2',kind:'tool_result',toolName:'Bash',text:'tests passed',status:'SUCCEEDED'}
    ]
  }]};
  assert.deepEqual(executionActivityOf(task),{label:'处理中'});
});

test('active task statuses use stable Chinese loading labels',()=>{
  const labels={starting:'启动中',running:'处理中',in_progress:'处理中',stopping:'停止中'};
  for(const [status,label] of Object.entries(labels)){
    const task={status,attempts:[{id:'a1',status,startedAt:'2026-01-10T00:00:00.000Z'}]};
    assert.deepEqual(executionActivityOf(task),{label},status);
  }
});

test('only starting is active before any attempt exists',()=>{
  assert.deepEqual(executionActivityOf({status:'starting',attempts:[]}),{label:'启动中'});
  for(const status of ['running','in_progress','stopping']){
    assert.equal(executionActivityOf({status,attempts:[]}),null,status);
  }
});

test('terminal task states never animate, even with a live-looking attempt',()=>{
  for(const status of ['waiting_review','completed','accepted','done','failed','stopped','interrupted','cancelled','superseded','unknown']){
    const task={status,attempts:[{id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z'}]};
    assert.equal(executionActivityOf(task),null,status);
  }
});

test('a disconnected snapshot stops activity',()=>{
  const task={status:'running',attempts:[{id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z'}]};
  assert.deepEqual(executionActivityOf(task),{label:'处理中'});
  assert.equal(executionActivityOf(task,{connected:false}),null);
  assert.equal(executionActivityOf({status:'starting',attempts:[]},{connected:false}),null);
});

test('a recorded acceptance suppresses activity even when files changed afterwards',()=>{
  const attempt={id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z'};
  const accepted={...attempt,acceptance:{attemptId:'a1',at:'2026-01-10T00:01:00.000Z',changedSinceVerification:false}};
  const changed={...attempt,acceptance:{attemptId:'a1',at:'2026-01-10T00:01:00.000Z',changedSinceVerification:true}};
  assert.equal(executionActivityOf({status:'running',attempts:[accepted]}),null);
  assert.equal(executionActivityOf({status:'running',attempts:[changed]}),null);
  assert.deepEqual(executionActivityOf({status:'running',attempts:[attempt]}),{label:'处理中'});
  assert.equal(executionActivityOf({status:'accepted',attempts:[attempt]}),null);
  assert.equal(executionActivityOf({status:'done',attempts:[attempt]}),null);
});

test('an ended or terminal latest attempt stops activity',()=>{
  const withLatest=attempt=>({status:'running',attempts:[
    {id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z'},
    attempt
  ]});
  const ended=[
    {id:'a2',status:'running',endedAt:'2026-01-10T00:01:00.000Z'},
    {id:'a2',status:'completed',endedAt:'2026-01-10T00:01:00.000Z'},
    {id:'a2',status:'failed'},
    {id:'a2',status:'stopped'},
    {id:'a2',status:'interrupted'},
    {id:'a2',status:'unknown'}
  ];
  for(const attempt of ended)assert.equal(executionActivityOf(withLatest(attempt)),null,JSON.stringify(attempt));
});

test('a later live attempt keeps activity after an earlier terminal one',()=>{
  const task={status:'running',attempts:[
    {id:'a1',status:'failed',endedAt:'2026-01-10T00:00:30.000Z'},
    {id:'a2',status:'running',startedAt:'2026-01-10T00:01:00.000Z'}
  ]};
  assert.deepEqual(executionActivityOf(task),{label:'处理中'});
});

test('reported attempts accumulate retry duration, usage and wall-clock output speed',()=>{
  const task={status:'completed',attempts:[
    {id:'a1',status:'failed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:00:05.000Z',
      usage:{inputTokens:80,outputTokens:10,cachedInputTokens:40,totalTokens:90}},
    {id:'a2',status:'completed',startedAt:'2026-01-10T00:01:00.000Z',endedAt:'2026-01-10T00:01:25.000Z',
      usage:{inputTokens:200,outputTokens:30,cachedInputTokens:150,totalTokens:230}}
  ]};
  const metrics=executionMetricsOf(task,{now:Date.parse('2026-01-10T02:00:00.000Z')});
  assert.equal(metrics.state,'idle');
  assert.equal(metrics.running,false);
  assert.equal(metrics.duration.milliseconds,30000);
  assert.equal(metrics.tokens.totalTokens,320);
  assert.equal(metrics.tokens.cachedInputTokens,190);
  assert.equal(metrics.tokens.partial,false);
  assert.equal(metrics.speed.outputTokens,40);
  assert.equal(metrics.speed.seconds,30);
  assert.ok(Math.abs(metrics.speed.tokensPerSecond-40/30)<1e-9);
  assert.equal(metrics.command,'待核验');
});

test('per-round duration stays independent from cumulative duration',()=>{
  const task={status:'running',attempts:[
    {id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:00:05.000Z',usage:{inputTokens:10,outputTokens:5,totalTokens:15}},
    {id:'a2',status:'running',startedAt:'2026-01-10T00:01:00.000Z'}
  ]};
  const now=Date.parse('2026-01-10T00:01:30.000Z');
  const live=executionMetricsOf(task,{now});
  assert.equal(live.duration.milliseconds,35000);assert.equal(live.duration.running,true);
  assert.equal(live.current.milliseconds,30000);assert.equal(live.current.running,true);
  const terminal=executionMetricsOf({...task,status:'completed',attempts:[task.attempts[0],{...task.attempts[1],status:'completed',endedAt:'2026-01-10T00:01:20.000Z'}]},{now});
  assert.equal(terminal.duration.milliseconds,25000);assert.equal(terminal.duration.running,false);
  assert.equal(terminal.current.milliseconds,20000);assert.equal(terminal.current.running,false);
  const unterminated=executionMetricsOf({status:'failed',attempts:task.attempts},{now});
  assert.equal(unterminated.state,'idle');assert.equal(unterminated.duration.milliseconds,5000);assert.equal(unterminated.current.milliseconds,null);
  const frozen=executionMetricsOf(task,{connected:false,now:Date.parse('2026-01-10T04:00:00.000Z'),observedAt:'2026-01-10T00:01:10.000Z'});
  assert.equal(frozen.state,'disconnected');assert.equal(frozen.duration.milliseconds,15000);assert.equal(frozen.current.milliseconds,10000);
  assert.equal(frozen.duration.running,false);assert.equal(frozen.current.running,false);
});

test('unreported attempts keep tokens and speed unreported without zero filling',()=>{
  const task={status:'failed',attempts:[
    {id:'a1',status:'failed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:00:10.000Z'},
    {id:'a2',status:'failed',startedAt:'2026-01-10T00:01:00.000Z',endedAt:'2026-01-10T00:01:20.000Z',usage:null}
  ]};
  const metrics=executionMetricsOf(task);
  assert.equal(metrics.tokens.totalTokens,null);
  assert.equal(metrics.tokens.reported,0);
  assert.equal(metrics.tokens.partial,true);
  assert.equal(metrics.speed,null);
  assert.equal(metrics.duration.milliseconds,30000);
  assert.equal(metrics.command,'执行失败');
});

test('partial usage keeps reported tokens but withholds an exact average speed',()=>{
  const task={status:'completed',attempts:[
    {id:'a1',status:'failed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:00:10.000Z',
      usage:{inputTokens:20,outputTokens:20,totalTokens:40}},
    {id:'a2',status:'completed',startedAt:'2026-01-10T00:01:00.000Z',endedAt:'2026-01-10T00:01:20.000Z'}
  ]};
  const metrics=executionMetricsOf(task);
  assert.equal(metrics.tokens.totalTokens,40);
  assert.equal(metrics.tokens.reported,1);
  assert.equal(metrics.tokens.count,2);
  assert.equal(metrics.tokens.partial,true);
  assert.equal(metrics.speed,null);
});

test('terminal tasks retain metrics but show the terminal status instead of a stale tool hint',()=>{
  const task={status:'waiting_review',attempts:[
    {id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:01:00.000Z',
      usage:{inputTokens:100,outputTokens:50,totalTokens:150},
      events:[{id:'t1',kind:'tool',toolName:'Bash',text:'npm test',status:'completed',time:'2026-01-10T00:00:30.000Z'}]}
  ]};
  const metrics=executionMetricsOf(task,{now:Date.parse('2026-01-10T03:00:00.000Z')});
  assert.equal(metrics.state,'idle');
  assert.equal(metrics.running,false);
  assert.equal(metrics.duration.milliseconds,60000);
  assert.equal(metrics.tokens.totalTokens,150);
  assert.equal(metrics.speed.tokensPerSecond,50/60);
  assert.equal(metrics.command,'待核验');
  assert.equal(metrics.status.icon,'clock');
  assert.notEqual(metrics.status.icon,'loader');
  assert.equal(metrics.status.changedSinceVerification,false);
});

test('a stopped task ignores an unclosed RUNNING tool and reports the terminal status',()=>{
  const task={id:'qa-stopped',status:'stopped',attempts:[{
    id:'a1',status:'stopped',startedAt:'2026-10-25T12:00:00.000Z',endedAt:'2026-10-25T12:01:00.000Z',
    events:[{id:'tool1',kind:'tool',toolName:'execute',text:'grep -rIn "catchMove" node_modules/@tarojs',status:'RUNNING',time:'2026-10-25T12:00:45.000Z'}]
  }]};
  const metrics=executionMetricsOf(task,{executor:'Qoder',now:Date.parse('2026-10-25T12:05:00.000Z'),observedAt:'2026-10-25T12:01:00.000Z'});
  assert.equal(executionActivityOf(task),null);
  assert.equal(metrics.state,'idle');
  assert.equal(metrics.running,false);
  assert.equal(metrics.command,'已停止');
  assert.doesNotMatch(metrics.command,/执行中|grep/);
  assert.equal(metrics.duration.milliseconds,60000);
  assert.deepEqual(
    {label:metrics.status.label,tone:metrics.status.tone,icon:metrics.status.icon,active:metrics.status.active},
    {label:'已停止',tone:'stopped',icon:'stop',active:false},
  );
});

test('a stopped task never grows duration even while its attempt still looks running',()=>{
  const task={id:'qa-stopped',status:'stopped',attempts:[{
    id:'a1',status:'running',startedAt:'2026-10-25T12:00:00.000Z',
    events:[{id:'tool1',kind:'tool',toolName:'execute',text:'grep -rIn "catchMove"',status:'RUNNING',time:'2026-10-25T12:00:45.000Z'}]
  }]};
  const first=executionMetricsOf(task,{now:Date.parse('2026-10-25T12:05:00.000Z')});
  const later=executionMetricsOf(task,{now:Date.parse('2026-10-25T13:05:00.000Z')});
  assert.equal(first.command,'已停止');
  assert.equal(first.running,false);
  assert.equal(first.duration.milliseconds,null);
  assert.deepEqual(later.duration,first.duration);
});

test('a retry that returns to running restores the live status and loader icon',()=>{
  const task={id:'qa-retry',status:'stopped',attempts:[
    {id:'a1',status:'stopped',startedAt:'2026-10-25T12:00:00.000Z',endedAt:'2026-10-25T12:01:00.000Z',
      events:[{id:'tool1',kind:'tool',toolName:'execute',text:'grep -rIn "catchMove"',status:'RUNNING',time:'2026-10-25T12:00:45.000Z'}]}
  ]};
  const stopped=executionMetricsOf(task,{now:Date.parse('2026-10-25T12:05:00.000Z')});
  assert.equal(stopped.status.icon,'stop');
  task.status='running';
  task.attempts.push({id:'a2',status:'running',startedAt:'2026-10-25T12:10:00.000Z',events:[
    {id:'tool2',kind:'tool',toolName:'Bash',text:'npm test',status:'RUNNING',time:'2026-10-25T12:10:05.000Z'}
  ]});
  const retried=executionMetricsOf(task,{now:Date.parse('2026-10-25T12:10:08.000Z')});
  assert.equal(retried.state,'running');
  assert.equal(retried.running,true);
  assert.equal(retried.command,'Bash · npm test · 执行中');
  assert.deepEqual(
    {label:retried.status.label,tone:retried.status.tone,icon:retried.status.icon,active:retried.status.active},
    {label:'处理中',tone:'active',icon:'loader',active:true},
  );
});

test('terminal statuses keep semantic tones and never reuse the loader icon',()=>{
  const completed={id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:01:00.000Z'};
  const verified={...completed,verification:{attemptId:'a1',at:'2026-01-10T00:02:00.000Z'}};
  const accepted={...completed,acceptance:{attemptId:'a1',at:'2026-01-10T00:02:00.000Z',changedSinceVerification:false}};
  const cases=[
    ['completed','waiting',[{...completed}],'待核验','waiting','clock'],
    ['waiting_review','waiting',[{...completed}],'待核验','waiting','clock'],
    ['verifying','verifying',[{...verified}],'Codex核验中','waiting','clock'],
    ['accepted','accepted',[{...accepted}],'已完成','success','check'],
    ['done','awaiting_record',[],'待核对','waiting','clock'],
    ['blocked','blocked',[{id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z'}],'等待处理','waiting','clock'],
    ['stopped','stopped',[{...completed,status:'stopped'}],'已停止','stopped','stop'],
    ['cancelled','cancelled',[{...completed,status:'stopped'}],'已取消','stopped','stop'],
    ['superseded','superseded',[{...completed,status:'stopped'}],'已被替代','stopped','stop'],
    ['interrupted','interrupted',[{...completed,status:'interrupted'}],'已中断','stopped','stop'],
    ['failed','failed',[{...completed,status:'failed'}],'执行失败','failed','error'],
    ['unknown','unknown',[{id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z'}],'状态待核实','neutral','dot']
  ];
  for(const [status,key,attempts,label,tone,icon] of cases){
    const projection=executionStatusOf({status,attempts});
    assert.deepEqual(projection,{key,label,tone,icon,active:false,changedSinceVerification:false},status);
    assert.notEqual(projection.icon,'loader',status);
  }
  const changed=executionStatusOf({status:'accepted',attempts:[{...completed,acceptance:{attemptId:'a1',at:'2026-01-10T00:02:00.000Z',changedSinceVerification:true}}]});
  assert.deepEqual(changed,{key:'accepted',label:'已完成',tone:'success',icon:'check',active:false,changedSinceVerification:true});
});

test('the footer metrics reuse the same status projection as the detail title',()=>{
  const task={status:'stopped',attempts:[{
    id:'a1',status:'running',startedAt:'2026-10-25T12:00:00.000Z',
    events:[{id:'tool1',kind:'tool',toolName:'execute',text:'grep -rIn "catchMove"',status:'RUNNING',time:'2026-10-25T12:00:45.000Z'}]
  }]};
  const metrics=executionMetricsOf(task,{now:Date.parse('2026-10-25T12:05:00.000Z')});
  assert.deepEqual(metrics.status,executionStatusOf(task));
  assert.equal(metrics.label,metrics.status.label);
});

test('an accepted task reports the accepted label instead of a pending-review state',()=>{
  const attempt={id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:01:00.000Z',
    usage:{inputTokens:100,outputTokens:50,totalTokens:150},
    acceptance:{attemptId:'a1',at:'2026-01-10T00:02:00.000Z',changedSinceVerification:false}};
  const metrics=executionMetricsOf({status:'waiting_review',attempts:[attempt]});
  assert.equal(metrics.state,'idle');
  assert.equal(metrics.label,'已完成');
  assert.equal(metrics.command,'已完成');
  assert.equal(metrics.status.changedSinceVerification,false);
});

test('a disconnected snapshot freezes elapsed time at observedAt and never looks live',()=>{
  const task={status:'running',attempts:[{
    id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z',
    usage:{outputTokens:10,totalTokens:10}
  }]};
  const observedAt='2026-01-10T00:00:10.000Z';
  const first=executionMetricsOf(task,{connected:false,now:Date.parse('2026-01-10T00:01:00.000Z'),observedAt});
  const later=executionMetricsOf(task,{connected:false,now:Date.parse('2026-01-10T01:00:00.000Z'),observedAt});
  assert.equal(first.state,'disconnected');
  assert.equal(first.running,false);
  assert.equal(first.command,'处理中 · 暂未更新');
  assert.equal(first.note,'暂未更新');
  assert.deepEqual(
    {label:first.status.label,tone:first.status.tone,icon:first.status.icon,active:first.status.active},
    {label:'处理中',tone:'neutral',icon:'dot',active:false},
  );
  assert.doesNotMatch(first.command,/连接中断|timed out|执行中/);
  assert.equal(first.duration.milliseconds,10000);
  assert.equal(later.duration.milliseconds,10000);
  assert.equal(later.note,'暂未更新');
  assert.equal(first.speed,null);
  assert.equal(later.speed,null);
  assert.equal(first.tokens.totalTokens,10);
});

test('a transient disconnect keeps confirmed terminal states instead of turning them unknown',()=>{
  const observedAt='2026-01-10T00:01:00.000Z';
  const completed=executionMetricsOf({status:'completed',attempts:[{
    id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:01:00.000Z',
    usage:{inputTokens:100,outputTokens:50,totalTokens:150}
  }]},{connected:false,now:Date.parse('2026-01-10T03:00:00.000Z'),observedAt});
  assert.equal(completed.state,'disconnected');
  assert.equal(completed.running,false);
  assert.equal(completed.label,'待核验');
  assert.equal(completed.command,'待核验');
  assert.equal(completed.duration.milliseconds,60000);
  assert.equal(completed.duration.running,false);

  const accepted=executionMetricsOf({status:'accepted',attempts:[{
    id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:01:00.000Z',
    acceptance:{attemptId:'a1',at:observedAt,changedSinceVerification:false}
  }]},{connected:false,now:Date.parse('2026-01-10T03:00:00.000Z'),observedAt});
  assert.equal(accepted.label,'已完成');
  assert.equal(accepted.command,'已完成');
  assert.equal(accepted.duration.milliseconds,60000);
});

test('a stale running snapshot is labelled as not updated without a connection error',()=>{
  const task={status:'running',attempts:[{
    id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z',
    events:[{id:'t1',kind:'tool',toolName:'Bash',text:'npm test',status:'RUNNING',time:'2026-01-10T00:00:05.000Z'}]
  }]};
  const metrics=executionMetricsOf(task,{connected:false,now:Date.parse('2026-01-10T01:00:00.000Z'),observedAt:'2026-01-10T00:00:10.000Z'});
  assert.equal(metrics.command,'处理中 · 暂未更新');
  assert.equal(metrics.running,false);
  assert.equal(metrics.note,'暂未更新');
  assert.equal(metrics.status.icon,'dot');
  assert.equal(metrics.duration.milliseconds,10000);
  assert.doesNotMatch(metrics.command,/连接中断|signal timed out|npm test/);
});

test('zero or incomplete attempt windows withhold average speed',()=>{
  const zero=executionMetricsOf({status:'completed',attempts:[{
    id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:00:00.000Z',
    usage:{inputTokens:5,outputTokens:5,totalTokens:10}
  }]});
  assert.equal(zero.duration.milliseconds,0);
  assert.equal(zero.tokens.totalTokens,10);
  assert.equal(zero.speed,null);

  const mixed=executionMetricsOf({status:'completed',attempts:[
    {id:'a1',status:'completed',startedAt:'2026-01-10T00:00:00.000Z',endedAt:'2026-01-10T00:00:00.000Z',
      usage:{inputTokens:5,outputTokens:5,totalTokens:10}},
    {id:'a2',status:'completed',startedAt:'2026-01-10T00:01:00.000Z',endedAt:'2026-01-10T00:01:20.000Z',
      usage:{inputTokens:15,outputTokens:15,totalTokens:30}}
  ]});
  assert.equal(mixed.duration.milliseconds,20000);
  assert.equal(mixed.tokens.totalTokens,40);
  assert.equal(mixed.speed,null);

  const incomplete=executionMetricsOf({status:'completed',attempts:[{
    id:'a1',status:'completed',endedAt:'2026-01-10T00:00:10.000Z',
    usage:{inputTokens:5,outputTokens:5,totalTokens:10}
  }]});
  assert.equal(incomplete.duration.milliseconds,null);
  assert.equal(incomplete.tokens.totalTokens,10);
  assert.equal(incomplete.speed,null);

  const running=executionMetricsOf({status:'running',attempts:[{
    id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z',
    usage:{inputTokens:5,outputTokens:5,totalTokens:10}
  }]},{now:Date.parse('2026-01-10T00:00:08.000Z')});
  assert.equal(running.state,'running');
  assert.equal(running.duration.milliseconds,8000);
  assert.equal(running.tokens.totalTokens,10);
  assert.equal(running.speed,null);
});

test('the footer command prefers bounded process hints and falls back to the generic executor copy',()=>{
  const running={status:'running',attempts:[{
    id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z',
    events:[{id:'t1',kind:'tool',toolName:'Bash',text:"node <<'EOF'\nconsole.log(1);\nEOF",status:'RUNNING',time:'2026-01-10T00:00:05.000Z'}]
  }]};
  assert.equal(executionMetricsOf(running,{executor:'Qoder',now:Date.parse('2026-01-10T00:00:08.000Z')}).command,'Bash · node · 执行中');
  assert.equal(executionMetricsOf(running,{executor:'Qoder',now:Date.parse('2026-01-10T00:00:08.000Z')}).state,'running');

  const quiet={status:'running',attempts:[{id:'a1',status:'running',startedAt:'2026-01-10T00:00:00.000Z'}]};
  assert.equal(executionMetricsOf(quiet,{executor:'Qoder',now:Date.parse('2026-01-10T00:00:08.000Z')}).command,'Qoder 正在执行…');
  assert.equal(executionMetricsOf({status:'starting',attempts:[]},{executor:'Codex'}).command,'正在启动 Codex…');
});

test('a disconnected snapshot without an observation time never advances a live duration',()=>{
  const task={status:'running',attempts:[{id:'a',status:'running',startedAt:'2026-01-10T00:00:00.000Z'}]};
  const metrics=executionMetricsOf(task,{connected:false,now:Date.parse('2026-01-10T01:00:00Z')});
  assert.equal(metrics.duration.milliseconds,null);
  assert.equal(metrics.state,'disconnected');
});
