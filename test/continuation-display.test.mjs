import assert from 'node:assert/strict';
import test from 'node:test';
import {createViewerData} from '../cli/lib/viewer-data.mjs';
import {deliveryFromEvents,handoffRoleLabel} from '../cli/lib/presentation.mjs';
import {executionMetricsOf} from '../cli/ui/session-activity.mjs';

const threadId='11111111-1111-4111-8111-111111111111',parentWorkId='22222222-2222-4222-8222-222222222222';
const at=minute=>`2026-10-26T09:${String(minute).padStart(2,'0')}:00.000Z`;
const taskId='rounds',sourceRef=`squad:v2:${threadId}:${encodeURIComponent(parentWorkId)}:implementer:req-rounds`;

function fakeClient(tasks,executions){
  const parent={id:parentWorkId,projectId:'project-1',title:'小队父任务',description:'',status:'in_progress',
    harness:{sourceType:'codex-squad',sourceRef:`squad:v2:${threadId}:parent`}};
  const byId=new Map(tasks.map(task=>[task.id,task]));
  const highWater=events=>events.at(-1)?.sequence||0;
  return {
    async operate(method,params){
      if(method==='work.get')return {task:params.workId===parentWorkId?parent:byId.get(params.workId)};
      const events=executions[params.workId]?.[params.generation]||[];
      if(method==='work.execution.digest')return {events:events.map(event=>({sequence:event.sequence,event})),highWaterSequence:highWater(events),activeSessionId:null};
      if(method==='work.execution.watermark')return {highWaterSequence:highWater(events),activeSessionId:null};
      if(method==='work.execution.get')return {events:events.filter(event=>Number(event.sequence)>Number(params.afterSequence||0)),highWaterSequence:highWater(events)};
      throw new Error(`unexpected operation ${method}`);
    },
  };
}
function attemptEvents(id,index,handoff,{startedAt,endedAt=null,usage=null,userText=null,assistantText=null}={}){
  const events=[{sequence:1,type:'SQUAD_ATTEMPT_STARTED',occurredAt:startedAt,
    payload:{attemptId:id,index,requestId:`req-${id}`,nativeSessionId:'native-shared',...(index>1?{resumedFrom:`a${index-1}`}:{}),handoff}}];
  const add=event=>events.push({sequence:events.length+1,occurredAt:endedAt||startedAt,...event});
  add({type:'SQUAD_PROMPT_SUBMITTED',occurredAt:startedAt,payload:{attemptId:id,at:startedAt,nativeSessionId:'native-shared'}});
  if(userText)add({type:'SQUAD_ATTEMPT_EVENT',payload:{eventId:`user-${id}`,kind:'message',role:'user',text:userText,status:'completed',revision:1,time:startedAt}});
  if(assistantText)add({type:'SQUAD_ATTEMPT_EVENT',payload:{eventId:`assistant-${id}`,kind:'message',role:'assistant',text:assistantText,status:'completed',revision:1,time:endedAt}});
  if(endedAt)add({type:'SQUAD_ATTEMPT_COMPLETED',occurredAt:endedAt,payload:{status:'completed',endedAt,nativeSessionId:'native-shared',usage}});
  return events;
}
const ref=(id,index)=>({attemptId:id,index,generation:index,requestId:`req-${id}`,worker:null});

test('first handoff and two supplements form one ordered, redacted, paged stream',async()=>{
  const background=`背景起点\n${'A'.repeat(13000)}\n背景终点`;
  const events={
    1:attemptEvents('a1',1,{goal:'完成第一轮列表',context:'首轮背景：保留列表顺序',scope:['src/list.ts'],criteria:['单测通过']},
      {startedAt:at(0),endedAt:at(5),usage:{inputTokens:10,outputTokens:5,cachedInputTokens:2,totalTokens:15},assistantText:'第一轮完成'}),
    2:attemptEvents('a2',2,{goal:'补充分页边界',context:'只处理空页和尾页',scope:['src/list.ts'],writePaths:['src/list.ts'],criteria:['边界回归通过'],reason:'用户追加边界场景'},
      {startedAt:at(10),endedAt:at(22),usage:{inputTokens:15,outputTokens:10,cachedInputTokens:3,totalTokens:25},assistantText:'第二轮完成'}),
    3:attemptEvents('a3',3,{goal:'第三轮收口 TOKEN=supersecret-value',context:background,scope:['src/list.ts'],criteria:['完整回归']},
      {startedAt:at(30),userText:'补充：请继续处理分页边界'}),
  };
  const tasks=[{id:taskId,title:'原标题·三轮续接',status:'in_progress',version:1,harness:{sourceType:'codex-squad',sourceRef,activeGeneration:3}}];
  const binding={schemaVersion:1,threadId,workspace:process.cwd(),projectId:'project-1',parentWorkId,title:'小队',
    tasks:[taskId],attempts:{[taskId]:[ref('a1',1),ref('a2',2),ref('a3',3)]},workers:{},reviews:{},retirements:{}};
  const data=createViewerData({client:fakeClient(tasks,{[taskId]:events})});

  const board=await data.board(binding);
  assert.equal(board.tasks[0].title,'原标题·三轮续接');
  assert.equal(board.tasks[0].currentRound,3);
  assert.equal(board.tasks[0].currentGoal,'第三轮收口 [secret]');

  const detail=await data.task(binding,new URLSearchParams({id:taskId,processLimit:'30'}));
  assert.equal(detail.task.title,'原标题·三轮续接');
  assert.equal(detail.boardTaskCount,board.tasks.filter((await import('../cli/lib/task-lifecycle.mjs')).boardVisible).length);
  assert.deepEqual(detail.task.attempts.map(attempt=>attempt.id),['a1','a2','a3']);
  assert.deepEqual(detail.task.attempts.map(attempt=>attempt.usage?.totalTokens??null),[15,25,null]);
  assert.deepEqual(detail.task.attempts.map(attempt=>attempt.delivery.state),['received','received','sent']);
  assert.equal(detail.task.attempts[2].delivery.submittedAt,at(30));

  const handoffs=detail.conversation.items.filter(item=>item.kind==='handoff');
  assert.equal(handoffs.length,3);
  assert.deepEqual(handoffs.map(item=>item.handoff.attemptIndex),[1,2,3]);
  assert.deepEqual(handoffs.map(item=>handoffRoleLabel(item.handoff)),['Codex · 首次交办','Codex · 补充交办','Codex · 补充交办']);
  assert.ok(handoffs.every(item=>item.role==='user'));
  assert.match(handoffs[0].text,/第1轮 · 首次交办/);
  assert.match(handoffs[0].text,/目标\n完成第一轮列表/);
  assert.match(handoffs[0].text,/补充背景\n首轮背景：保留列表顺序/);
  assert.match(handoffs[0].text,/允许范围与变化\n- src\/list\.ts/);
  assert.match(handoffs[0].text,/验收要求\n- 单测通过/);
  assert.match(handoffs[1].text,/第2轮 · 补充交办/);
  assert.match(handoffs[1].text,/必要写入路径\n- src\/list\.ts/);
  assert.match(handoffs[1].text,/检查原因\n用户追加边界场景/);
  const ordinary=detail.conversation.items.find(item=>item.text==='补充：请继续处理分页边界');
  assert.equal(ordinary.kind,'message');
  assert.equal(ordinary.handoff,undefined);
  assert.doesNotMatch(JSON.stringify(handoffs),/supersecret-value/);

  let offset=0,full='',chunks=0;
  for(;;){
    const response=await data.task(binding,new URLSearchParams({id:taskId,item:handoffs[2].id,offset:String(offset)}));
    assert.equal(response.chunk.from,offset);
    assert.equal(response.chunk.kind,'handoff');
    assert.equal(response.chunk.role,'user');
    assert.deepEqual([response.chunk.handoff.kind,response.chunk.handoff.attemptIndex,response.chunk.handoff.attemptId],['supplementary',3,'a3']);
    assert.equal(response.chunk.handoff.delivery.state,'sent');
    assert.equal(response.chunk.handoff.delivery.submittedAt,at(30));
    assert.equal(response.chunk.handoff.delivery.respondedAt,null);
    assert.ok(response.chunk.text.length>0&&response.chunk.text.length<=12000);
    full+=response.chunk.text;chunks+=1;
    if(response.chunk.done)break;
    assert.ok(response.chunk.next>offset);
    offset=response.chunk.next;
  }
  assert.ok(chunks>=2);
  assert.match(full,/^第3轮 · 补充交办/);
  assert.match(full,/目标\n第三轮收口 \[secret\]/);
  assert.match(full,/背景起点/);
  assert.match(full,/背景终点/);
  assert.match(full,/验收要求\n- 完整回归/);
  assert.doesNotMatch(full,/supersecret-value|undefined/);

  const tail=await data.task(binding,new URLSearchParams({id:taskId,limit:'2'}));
  assert.deepEqual(tail.conversation.items.map(item=>item.id),['a3:handoff','user-a3']);
  assert.deepEqual([tail.conversation.items[0].handoff.kind,tail.conversation.items[0].handoff.attemptIndex,tail.conversation.items[0].handoff.attemptId],['supplementary',3,'a3']);
  const earlier=await data.task(binding,new URLSearchParams({id:taskId,limit:'2',before:tail.conversation.before}));
  assert.deepEqual(earlier.conversation.items.map(item=>item.id),['a2:handoff','assistant-a2']);
  assert.deepEqual([earlier.conversation.items[0].handoff.kind,earlier.conversation.items[0].handoff.attemptIndex,earlier.conversation.items[0].handoff.attemptId],['supplementary',2,'a2']);
  const newer=await data.task(binding,new URLSearchParams({id:taskId,limit:'2',newer:earlier.conversation.newer}));
  assert.deepEqual(newer.conversation.items.map(item=>item.id),['a3:handoff','user-a3']);
  assert.deepEqual(newer.conversation.items[0].handoff,tail.conversation.items[0].handoff);

  const revision=detail.conversation.revision;
  events[3].push({sequence:events[3].length+1,type:'SQUAD_ATTEMPT_EVENT',occurredAt:at(35),
    payload:{eventId:'assistant-a3',kind:'message',role:'assistant',text:'第三轮完成',status:'completed',revision:1,time:at(35)}});
  events[3].push({sequence:events[3].length+1,type:'SQUAD_ATTEMPT_COMPLETED',occurredAt:at(36),
    payload:{status:'completed',endedAt:at(36),nativeSessionId:'native-shared',usage:{inputTokens:20,outputTokens:5,totalTokens:25}}});
  tasks[0].status='waiting_review';tasks[0].version=2;
  const change=await data.task(binding,new URLSearchParams({id:taskId,after:String(revision)}));
  assert.equal(change.conversation.reset,false);
  assert.equal(change.task.status,'waiting_review');
  assert.equal(change.task.currentRound,3);
  assert.equal(change.task.currentGoal,'第三轮收口 [secret]');
  const refreshed=change.conversation.items.find(item=>item.id===handoffs[2].id);
  assert.equal(refreshed.handoff.delivery.state,'received');
  assert.deepEqual([refreshed.handoff.kind,refreshed.handoff.attemptIndex,refreshed.handoff.attemptId],['supplementary',3,'a3']);
  assert.equal(refreshed.handoff.delivery.respondedAt,at(35));
  assert.ok(change.conversation.items.some(item=>item.kind==='message'&&item.text==='第三轮完成'));
  assert.doesNotMatch(JSON.stringify(change),/undefined/);

  const reopened=await data.task(binding,new URLSearchParams({id:taskId,processLimit:'30'}));
  assert.deepEqual(reopened.task.attempts.map(attempt=>attempt.usage?.totalTokens??null),[15,25,25]);
  assert.equal(reopened.conversation.items.some(item=>String(item.text||'').includes('undefined')),false);
  assert.equal(reopened.task.currentRound,3);
});

test('delivery requires a real prompt receipt and a public protocol response',()=>{
  const started={type:'SQUAD_ATTEMPT_STARTED',occurredAt:at(0),payload:{attemptId:'a1'}};
  const prompt={type:'SQUAD_PROMPT_SUBMITTED',occurredAt:at(1),payload:{attemptId:'a1',at:at(1)}};
  const reply={kind:'message',role:'assistant',text:'已修复',status:'completed',time:at(4)};
  const tool={type:'SQUAD_ATTEMPT_EVENT',occurredAt:at(3),payload:{kind:'tool',toolName:'Bash',text:'npm test',time:at(3)}};
  assert.equal(deliveryFromEvents([started],{status:'running',activeAttempt:true}).state,'pending');
  assert.equal(deliveryFromEvents([started,prompt],{status:'running',activeAttempt:true}).state,'sent');
  assert.equal(deliveryFromEvents([started],{status:'failed',endedAt:at(5)}).state,'unconfirmed');
  assert.equal(deliveryFromEvents([started,prompt],{status:'failed',endedAt:at(5)}).state,'sent');
  assert.equal(deliveryFromEvents([started,prompt,reply],{status:'completed',endedAt:at(5)}).state,'received');
  assert.equal(deliveryFromEvents([started,tool],{status:'completed',endedAt:at(5)}).state,'received');
  assert.equal(deliveryFromEvents([started],{status:'completed',endedAt:at(5),result:'已修复'}).state,'unconfirmed');
  assert.equal(deliveryFromEvents([started,prompt],{status:'completed',endedAt:at(5),result:'执行器报错：连接中断'}).state,'sent');
});

test('current round duration stays independent from cumulative duration and unreported tokens',()=>{
  const second=value=>`2026-10-26T09:00:${String(value).padStart(2,'0')}.000Z`;
  const task={status:'running',attempts:[
    {id:'a1',status:'completed',startedAt:second(0),endedAt:second(5),usage:{inputTokens:10,outputTokens:5,totalTokens:15}},
    {id:'a2',status:'completed',startedAt:second(10),endedAt:second(22),usage:{inputTokens:15,outputTokens:10,totalTokens:25}},
    {id:'a3',status:'running',startedAt:second(30),usage:null},
  ]};
  const live=executionMetricsOf(task,{now:Date.parse(second(40))});
  assert.equal(live.duration.milliseconds,27000);assert.equal(live.duration.running,true);
  assert.equal(live.current.milliseconds,10000);assert.equal(live.current.running,true);
  assert.equal(live.tokens.totalTokens,40);assert.equal(live.tokens.reported,2);assert.equal(live.tokens.partial,true);
  assert.equal(live.speed,null);
  const frozen=executionMetricsOf(task,{connected:false,now:Date.parse(second(50)),observedAt:second(35)});
  assert.equal(frozen.duration.milliseconds,22000);assert.equal(frozen.duration.running,false);
  assert.equal(frozen.current.milliseconds,5000);assert.equal(frozen.current.running,false);
  const ended=executionMetricsOf({status:'completed',attempts:[...task.attempts.slice(0,2),{...task.attempts[2],status:'completed',endedAt:second(36),usage:{inputTokens:20,outputTokens:5,totalTokens:25}}]},{now:Date.parse(second(40))});
  assert.equal(ended.duration.milliseconds,23000);assert.equal(ended.current.milliseconds,6000);
  assert.equal(ended.duration.running,false);assert.equal(ended.current.running,false);
  assert.equal(ended.tokens.totalTokens,65);assert.equal(ended.tokens.partial,false);
});


test('SQLite digest preserves real prompt submission and bounded current goals',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const {createLocalStore}=await import('../cli/lib/local-store.mjs');
  const home=await mkdtemp(join(tmpdir(),'squad-handoff-digest-'));
  const store=createLocalStore({home,workspace:process.cwd()});t.after(async()=>{store.close();await rm(home,{recursive:true,force:true})});
  const goal='当前目标'.repeat(180),b={schemaVersion:1,threadId,workspace:process.cwd(),projectId:'p',parentWorkId:'parent',title:'真实存储',tasks:['stored'],attempts:{},workers:{}};
  await store.importSnapshot({binding:b,tasks:[{id:'stored',title:'stored',memberId:'implementer',status:'failed',attempts:[{id:'a1',index:1,status:'failed',startedAt:at(0),endedAt:at(2),handoff:{goal},events:[],usage:null}]}]});
  const meta=await store.operate('work.execution.watermark',{workId:'stored',generation:1});
  const event={eventId:'submitted-stored',sessionId:'native',sequence:meta.highWaterSequence+1,type:'SQUAD_PROMPT_SUBMITTED',occurredAt:at(1),payload:{attemptId:'a1',at:at(1)}};
  await store.appendExecutionEvent('stored',{generation:1,sequence:event.sequence,sessionId:'native',event});
  const reader=createViewerData({client:store});const board=await reader.board(b);
  assert.equal(board.tasks[0].currentGoal,goal);
  assert.equal(board.tasks[0].attempts[0].delivery.state,'sent');
  assert.equal(board.tasks[0].attempts[0].delivery.submittedAt,at(1));
});
