import assert from 'node:assert/strict';
import test from 'node:test';
import {get} from 'node:http';
import {readFile,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createViewer} from '../cli/lib/viewer.mjs';
import {createViewerData} from '../cli/lib/viewer-data.mjs';
import {fingerprintCandidate} from '../cli/lib/evidence.mjs';
import {boundAcceptance,laneOf,reviewPhase} from '../cli/lib/task-lifecycle.mjs';
const id='01a162b5-bd96-7440-90a3-e422ae74d358',other='01a16481-1434-7501-b11e-c671c476ed8e';
const token='a'.repeat(48),second='b'.repeat(48);
const parentId='11111111-1111-4111-8111-111111111111';
const at=minute=>`2026-10-20T09:${String(minute).padStart(2,'0')}:00.000Z`;

function attemptEvents(attemptId,{index=1,goal,handoff,startedAt=at(0),endedAt=at(10),status='completed',usage=null,acceptance=null,extra=[]}={}){
  const sessionId=`session-${attemptId}`,events=[{sequence:1,type:'SQUAD_ATTEMPT_STARTED',occurredAt:startedAt,
    payload:{attemptId,index,requestId:`req-${attemptId}`,nativeSessionId:sessionId,...(handoff||goal?{handoff:handoff||{goal,scope:['实现'],criteria:['通过测试']}}:{})}}];
  for(const event of extra)events.push({sequence:events.length+1,occurredAt:endedAt,...event});
  events.push({sequence:events.length+1,type:'SQUAD_ATTEMPT_COMPLETED',occurredAt:endedAt,
    payload:{status,endedAt,nativeSessionId:sessionId,usage}});
  if(acceptance)events.push({sequence:events.length+1,type:'SQUAD_ACCEPTANCE',occurredAt:acceptance.at,payload:acceptance});
  return events;
}
function ref(attemptId,index,generation=index){return {attemptId,index,generation,requestId:`req-${attemptId}`,worker:null}}
function squadClient({threadId=id,parentWorkId=parentId,tasks,executions}){
  const parent={id:parentWorkId,projectId:'project-1',title:'小队父任务',description:'',status:'in_progress',
    harness:{sourceType:'codex-squad',sourceRef:`squad:v2:${threadId}:parent`}};
  const owned=new Map(tasks.map(task=>[task.id,{id:task.id,projectId:parent.projectId,title:task.title,status:task.status,
    version:task.version||1,harness:{sourceType:'codex-squad',activeGeneration:task.activeGeneration||0,
      sourceRef:`squad:v2:${threadId}:${encodeURIComponent(parentWorkId)}:implementer:${task.requestId}`,
      ...(task.reason?{blocker:{summary:task.reason}}:{})}}]));
  const latest=events=>(events||[]).at(-1)?.sequence||0;
  return {
    home:'fake-home',databasePath:'fake-store.db',
    async operate(method,params){
      if(method==='work.get')return {task:params.workId===parentWorkId?parent:owned.get(params.workId)};
      const events=executions[params.workId]?.[params.generation]||[];
      if(method==='work.execution.digest')return {events:events.map(event=>({sequence:event.sequence,event})),highWaterSequence:latest(events),activeSessionId:null};
      if(method==='work.execution.get')return {events:events.filter(event=>Number(event.sequence)>Number(params.afterSequence||0)),highWaterSequence:latest(events)};
      if(method==='work.execution.watermark')return {highWaterSequence:latest(events),activeSessionId:null};
      throw new Error(`unexpected operation ${method}`);
    },
  };
}
test('one origin isolates two chat capabilities, summaries and all read-only routes',async()=>{
  const bindings=[{threadId:id},{threadId:other}];
  const view=await createViewer({loadScope:async key=>key===token?{binding:bindings[0]}:key===second?{binding:bindings[1]}:null,snapshot:async binding=>({binding,connected:true}),readSummary:async binding=>binding.threadId===id?{threadId:id,content:'own notes'}:null});
  const url=`${view.origin}/${token}/`;
  try{
    const response=await fetch(`${url}api/snapshot?threadId=${other}`);assert.equal(response.status,200);assert.equal((await response.json()).binding.threadId,id);
    assert.equal((await (await fetch(`${view.origin}/${second}/api/snapshot`)).json()).binding.threadId,other);
    assert.equal((await (await fetch(`${url}summary/api`)).json()).content,'own notes');assert.equal(await (await fetch(`${view.origin}/${second}/summary/api`)).json(),null);
    assert.equal((await fetch(`${view.origin}/api/snapshot`)).status,404);assert.equal((await fetch(`${view.origin}/${'c'.repeat(48)}/api/snapshot`)).status,404);
    assert.equal((await fetch(`${url}api/snapshot`,{method:'POST'})).status,405);assert.equal((await fetch(`${url}summary/api`,{method:'PUT'})).status,405);
    assert.equal((await fetch(`${url}api/snapshot`,{headers:{Origin:'https://example.com'}})).status,403);
    assert.equal(await new Promise((ok,fail)=>get(`${url}api/health`,{headers:{Host:'attacker.local'}},res=>{res.resume();ok(res.statusCode)}).on('error',fail)),403);
    assert.equal((await fetch(`${url}anything`)).status,404);assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
    for(const route of ['','summary/','summary/summary.js','summary/summary.css'])assert.equal((await fetch(url+route)).status,200,route);
    const head=await fetch(`${url}summary/api`,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }finally{await view.close()}
});
test('unavailable or mismatched fact sources do not produce healthy snapshots',async()=>{
  const view=await createViewer({loadScope:async()=>({binding:{threadId:id}}),snapshot:async()=>({connected:true,binding:{threadId:'another'}}),readSummary:async()=>{throw new Error('broken summary')}});
  try{for(const route of ['api/snapshot','summary/api']){const response=await fetch(`${view.origin}/${token}/${route}`);assert.equal(response.status,503);assert.equal((await response.json()).connected,false)}}finally{await view.close()}
});
test('review resources are scoped to the registered workspace and cannot escape by path or symlink',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'squad-view-')),outside=await mkdtemp(join(tmpdir(),'squad-out-')),directory=join(workspace,'review');await mkdir(directory);
 await writeFile(join(directory,'index.html'),'<h1>review</h1>');await writeFile(join(directory,'app.js'),'// app');await writeFile(join(outside,'secret.txt'),'private');await symlink(join(outside,'secret.txt'),join(directory,'escape.txt'));await symlink(outside,join(workspace,'outside'));
 const view=await createViewer({loadScope:async key=>({binding:{threadId:id,workspace},reviewDirectory:key===token?directory:join(workspace,'outside')}),snapshot:async()=>({}),readSummary:async()=>null});
 try{
  const url=`${view.origin}/${token}/`;assert.match(await (await fetch(url+'review/')).text(),/review/);assert.equal((await fetch(url+'review/app.js')).status,200);
  for(const route of ['review/escape.txt','review/%2e%2e%2fsecret.txt','review/absent','review/%00','review/%zz'])assert.equal((await fetch(url+route)).status,404,route);
  assert.equal((await fetch(`${view.origin}/${second}/review/`)).status,503);
  const links=await (await fetch(url+'api/links')).json();assert.equal(links.version,JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json',import.meta.url),'utf8')).version);assert.deepEqual({squad:links.squad,analysis:links.analysis,intro:links.intro,summary:links.summary,review:links.review},{squad:'./',analysis:'./#analysis',intro:JSON.parse(await readFile(new URL('../skills/codex-squad/references/introduction.json',import.meta.url),'utf8')).url,summary:'./summary/',review:'./review/'});
 }finally{await view.close();await rm(workspace,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
});
test('analytics ranges stay read-only and identity comes from the page binding',async()=>{
 const calls=[];
 const view=await createViewer({loadScope:async()=>({binding:{threadId:id}}),snapshot:async()=>({}),analytics:async(binding,range)=>{calls.push([binding.threadId,range]);return {schemaVersion:1,scope:range.scope,coverage:{sources:{loaded:2}}}}});
 try{
  const url=`${view.origin}/${token}/api/analytics`;
  for(const query of ['?threadId='+other,'?scope=other','?days=90','?scope=global&days=-7'])assert.equal((await fetch(url+query)).status,400);
  assert.equal((await fetch(url,{method:'POST'})).status,405);
  assert.equal((await fetch(url+'?scope=global&days=7')).status,200);
  assert.equal((await fetch(url+'?days=all')).status,200);
  assert.deepEqual(calls,[[id,{scope:'global',days:7}],[id,{scope:'global',days:null}]]);
 }finally{await view.close()}
});
test('the board read model carries each round verification facts, retirement and the intake inbox',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'squad-data-'));
 try{
  await writeFile(join(workspace,'candidate.ts'),'export const value=1;\n');
  const candidate=await fingerprintCandidate(workspace,['candidate.ts']);
  const usage=()=>({inputTokens:80,outputTokens:20,cachedInputTokens:40,totalTokens:100});
  const tasks=[
    {id:'wait',title:'等待核验',status:'in_review',requestId:'req-wait',activeGeneration:1},
    {id:'verify',title:'核验中',status:'in_review',requestId:'req-verify',activeGeneration:1},
    {id:'accepted',title:'已验收',status:'accepted',requestId:'req-accepted',activeGeneration:1},
    {id:'retired',title:'已取消',status:'stopped',requestId:'req-retired',activeGeneration:1},
    {id:'legacy',title:'历史完成',status:'done',requestId:'req-legacy',activeGeneration:0},
  ];
  const executions={
    wait:{1:attemptEvents('wait-a1',{usage:usage()})},
    verify:{1:attemptEvents('verify-a1',{usage:usage()})},
    accepted:{1:attemptEvents('accepted-a1',{usage:usage(),acceptance:{attemptId:'accepted-a1',fingerprint:candidate.fingerprint,note:'测试与实现一致',at:at(10),files:candidate.files}})},
    retired:{1:attemptEvents('retired-a1',{status:'stopped',endedAt:at(5),usage:usage()})},
  };
  const binding={schemaVersion:1,threadId:id,workspace,projectId:'project-1',parentWorkId:parentId,title:'小队',
    tasks:tasks.map(task=>task.id),
    attempts:{wait:[ref('wait-a1',1)],verify:[ref('verify-a1',1)],accepted:[ref('accepted-a1',1)],retired:[ref('retired-a1',1)]},
    workers:{},reviews:{verify:{'verify-a1':{attemptId:'verify-a1',at:at(11),generation:1}}},
    retirements:{retired:{outcome:'cancelled',reason:'方案调整',at:at(6)}}};
  const data=createViewerData({client:squadClient({tasks,executions})});
  const view=await data.board(binding);
  assert.equal(view.connected,true);assert.equal(view.binding.threadId,id);
  assert.deepEqual(view.tasks.map(task=>task.id),binding.tasks);
  const [wait,verify,accepted,retired,legacy]=view.tasks;
  assert.equal(reviewPhase(wait),'waiting');assert.equal(laneOf(wait),'review');assert.equal(wait.attempts[0].verification,null);
  assert.equal(reviewPhase(verify),'verifying');
  assert.deepEqual(verify.attempts[0].verification,{attemptId:'verify-a1',generation:1,at:at(11)});
  assert.equal(reviewPhase(accepted),'accepted');assert.equal(laneOf(accepted),'completed');
  assert.equal(accepted.attempts[0].acceptance.fingerprint,candidate.fingerprint);
  assert.equal(accepted.attempts[0].acceptance.changedSinceVerification,false);
  assert.equal(accepted.attempts[0].acceptance.note,'测试与实现一致');
  assert.equal(laneOf(retired),null);assert.equal(retired.retirement.outcome,'cancelled');assert.equal(retired.attempts[0].status,'stopped');
  assert.equal(reviewPhase(legacy),'awaiting_record');assert.equal(laneOf(legacy),'review');assert.equal(boundAcceptance(legacy),null);
  assert.deepEqual(view.inbox.pending.map(entry=>[entry.taskId,entry.phase,entry.recordMissing]),[['wait','waiting',false],['legacy','awaiting_record',true]]);
  assert.deepEqual(view.inbox.verifying.map(entry=>entry.taskId),['verify']);
  assert.deepEqual(view.inbox.verifying[0].verification,{attemptId:'verify-a1',at:at(11),generation:1});
  assert.equal(view.inbox.pending[0].returnedAt,at(10));assert.equal(view.inbox.pending[0].sessionId,'session-wait-a1');
  assert.equal(view.inbox.count,3);
  assert.deepEqual({totalAttempts:view.usage.totalAttempts,reportedAttempts:view.usage.reportedAttempts,totalTokens:view.usage.totalTokens},
    {totalAttempts:4,reportedAttempts:4,totalTokens:400});
 }finally{await rm(workspace,{recursive:true,force:true})}
});
test('task detail keeps every round record while later file changes only mark the old acceptance',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'squad-detail-'));
 try{
  await writeFile(join(workspace,'candidate.ts'),'export const value=1;\n');
  const candidate=await fingerprintCandidate(workspace,['candidate.ts']);
  await writeFile(join(workspace,'candidate.ts'),'export const value=2;\n');
  const tasks=[{id:'rounds',title:'两轮交付',status:'in_review',requestId:'req-rounds',activeGeneration:2}];
  const executions={rounds:{
    1:attemptEvents('a1',{goal:'第一轮完成',handoff:{goal:'第一轮完成',context:'首轮背景：保留草稿',scope:['src/report.ts'],criteria:['npm test 通过']},endedAt:at(10),usage:{inputTokens:80,outputTokens:20,cachedInputTokens:40,totalTokens:100},
      acceptance:{attemptId:'a1',fingerprint:candidate.fingerprint,note:'第一轮通过',at:at(10),files:candidate.files},
      extra:[{type:'SQUAD_PROMPT_SUBMITTED',occurredAt:at(1),payload:{attemptId:'a1',at:at(1),nativeSessionId:'session-a1'}},
        {type:'SQUAD_ATTEMPT_EVENT',payload:{eventId:'m1',kind:'message',role:'assistant',text:'第一轮实现完成',status:'completed',revision:1,time:at(9)}}]}),
    2:attemptEvents('a2',{index:2,goal:'验收后补充',handoff:{goal:'验收后补充',context:'只处理空值边界的增量',scope:['src/report.ts'],writePaths:['src/report.ts'],criteria:['回归通过'],reason:'用户补充'},startedAt:at(15),endedAt:at(20),usage:{inputTokens:50,outputTokens:30,cachedInputTokens:10,totalTokens:80},
      extra:[{type:'SQUAD_PROMPT_SUBMITTED',occurredAt:at(16),payload:{attemptId:'a2',at:at(16),nativeSessionId:'session-a2'}},
        {type:'SQUAD_ATTEMPT_EVENT',payload:{eventId:'u2',kind:'message',role:'user',text:'普通补充消息',status:'completed',revision:1,time:at(17)}},
        {type:'SQUAD_ATTEMPT_EVENT',payload:{eventId:'t1',kind:'tool',toolName:'Bash',text:'npm test',status:'completed',time:at(19)}},
        {type:'SQUAD_ATTEMPT_EVENT',payload:{eventId:'m2',kind:'message',role:'assistant',text:'补充完成',status:'completed',revision:1,time:at(19)}}]}),
  }};
  const binding={schemaVersion:1,threadId:id,workspace,projectId:'project-1',parentWorkId:parentId,title:'小队',
    tasks:['rounds'],attempts:{rounds:[ref('a1',1,1),ref('a2',2,2)]},workers:{},
    reviews:{rounds:{a2:{attemptId:'a2',at:at(21),generation:2}}},retirements:{}};
  const data=createViewerData({client:squadClient({tasks,executions})});
  const detail=await data.task(binding,new URLSearchParams({id:'rounds',processLimit:'30'}));
  assert.equal(detail.connected,true);assert.equal(detail.taskCount,1);assert.equal(detail.taskIndex,1);
  assert.deepEqual(detail.task.attempts.map(attempt=>attempt.id),['a1','a2']);
  const [first,second]=detail.task.attempts;
  assert.equal(first.acceptance.note,'第一轮通过');
  assert.equal(first.acceptance.fingerprint,candidate.fingerprint);
  assert.equal(first.acceptance.changedSinceVerification,true);
  assert.notEqual(first.acceptance.currentFingerprint,candidate.fingerprint);
  assert.equal(first.verification,null);assert.equal(second.acceptance,null);
  assert.deepEqual(second.verification,{attemptId:'a2',at:at(21),generation:2});
  assert.equal(detail.task.acceptance,null);assert.deepEqual(detail.task.verification,{attemptId:'a2',at:at(21),generation:2});
  assert.equal(detail.task.status,'waiting_review');assert.equal(reviewPhase(detail.task),'verifying');assert.equal(laneOf(detail.task),'review');
  assert.deepEqual(detail.task.attempts.map(attempt=>attempt.id),['a1','a2']);
  assert.deepEqual(detail.task.attempts.map(attempt=>attempt.usage.outputTokens),[20,30]);
  assert.ok(detail.conversation.items.some(item=>item.text==='第一轮实现完成'));
  assert.ok(detail.conversation.items.some(item=>item.text==='补充完成'));
  const handoffs=detail.conversation.items.filter(item=>item.kind==='handoff');
  assert.equal(handoffs.length,2);
  assert.deepEqual(handoffs.map(item=>[item.role,item.handoff.kind,item.handoff.attemptIndex]),[['user','initial',1],['user','supplementary',2]]);
  assert.match(handoffs[0].text,/第1轮 · 首次交办/);assert.match(handoffs[0].text,/目标\n第一轮完成/);assert.match(handoffs[0].text,/补充背景\n首轮背景：保留草稿/);
  assert.match(handoffs[1].text,/第2轮 · 补充交办/);assert.match(handoffs[1].text,/补充背景\n只处理空值边界的增量/);
  assert.match(handoffs[1].text,/必要写入路径\n- src\/report\.ts/);assert.match(handoffs[1].text,/验收要求\n- 回归通过/);assert.match(handoffs[1].text,/检查原因\n用户补充/);
  assert.deepEqual(handoffs.map(item=>item.handoff.delivery.state),['received','received']);
  assert.deepEqual(detail.task.attempts.map(attempt=>attempt.delivery.submittedAt),[at(1),at(16)]);
  const ordinary=detail.conversation.items.find(item=>item.text==='普通补充消息');
  assert.equal(ordinary.kind,'message');assert.equal(ordinary.handoff,undefined);assert.equal(ordinary.role,'user');
  assert.equal(detail.task.currentRound,2);assert.equal(detail.task.currentGoal,'验收后补充');
  assert.deepEqual(handoffs.map(item=>item.handoff.attemptIndex),[1,2]);
  assert.ok(detail.process.items.some(item=>item.toolName==='Bash'&&item.text.includes('npm test')));
  const again=await data.task(binding,new URLSearchParams({id:'rounds',processLimit:'30'}));
  assert.deepEqual(again.conversation.items.map(item=>item.id),detail.conversation.items.map(item=>item.id));
  await assert.rejects(data.task(binding,new URLSearchParams({id:'missing'})),error=>error.code==='TASK_SCOPE_MISMATCH');
 }finally{await rm(workspace,{recursive:true,force:true})}
});

test('identical artifact fingerprints keep separate task acceptance identities and timestamps',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'squad-acceptance-cache-'));
 try{
  await writeFile(join(workspace,'candidate.ts'),'same verified artifact');
  const candidate=await fingerprintCandidate(workspace,['candidate.ts']);
  const tasks=[{id:'one',title:'一',status:'in_review',requestId:'r1',activeGeneration:1},{id:'two',title:'二',status:'in_review',requestId:'r2',activeGeneration:1}];
  const executions=Object.fromEntries(tasks.map((task,index)=>[task.id,{1:attemptEvents(task.id+'-attempt',{acceptance:{...candidate,attemptId:task.id+'-attempt',note:task.title+'已核验',at:at(index+10)}})}]));
  const binding={schemaVersion:1,threadId:id,workspace,projectId:'project-1',parentWorkId:parentId,title:'QA',tasks:tasks.map(t=>t.id),attempts:Object.fromEntries(tasks.map(task=>[task.id,[ref(task.id+'-attempt',1)]])),workers:{},reviews:{},retirements:{}};
  const reader=createViewerData({client:squadClient({tasks,executions})});
  const board=await reader.board(binding);
  assert.equal(board.inbox.count,0);
  for(const [index,task] of board.tasks.entries()){
   assert.equal(task.acceptance.attemptId,task.id+'-attempt');
   assert.equal(task.acceptance.note,tasks[index].title+'已核验');
   assert.equal(task.acceptance.at,at(index+10));
   assert.equal(laneOf(task),'completed');
  }
 }finally{await rm(workspace,{recursive:true,force:true})}
});
