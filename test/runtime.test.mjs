import {createConversationRecorder} from '../cli/lib/conversation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {
  MEMBERS,acceptTask,appendSquadEvent,bindCurrent,continueTask,dispatch,finalizeAttempt,
  readBinding,removeWorkspaceWrite,retireTask,snapshot,stopTask,updateBinding,verifyTask,withBindingLock,
} from '../cli/lib/runtime.mjs';
import {waitForTasks} from '../cli/lib/task-read.mjs';
import {buildBrief,runWorkerJob,validateJob} from '../cli/lib/worker.mjs';

function clone(value){return structuredClone(value);}
function fakeStore(workspace){
  const state={projects:new Map(),tasks:new Map(),executions:new Map(),claims:new Map(),agents:new Map(),sequences:new Set(),failGet:false,failAppend:false,instanceId:'instance-test'};
  let nextTask=0;
  const execution=(taskId,generation)=>{
    const key=`${taskId}:${generation}`;
    if(!state.executions.has(key))state.executions.set(key,{generation,events:[],highWaterSequence:0,activeSessionId:null});
    return state.executions.get(key);
  };
  const bump=task=>{task.version=Number(task.version||0)+1;};
  const taskOf=id=>{
    const task=state.tasks.get(id);
    if(!task)throw Object.assign(new Error(`Task '${id}' not found`),{code:'TASK_NOT_FOUND'});
    return task;
  };
  const api={
    state,
    async operate(operation,input={}){
      if(operation==='project.create'){
        if(!state.projects.has('project-1'))state.projects.set('project-1',{id:'project-1',name:input.name});
        return {project:clone(state.projects.get('project-1'))};
      }
      if(operation==='work.create'){
        const existing=[...state.tasks.values()].find(task=>task.harness.sourceType===input.sourceType&&task.harness.sourceRef===input.sourceRef);
        if(existing)return {task:clone(existing)};
        const id=`task-${++nextTask}`;
        const task={
          id,projectId:input.projectId,title:input.title,description:input.description,status:input.status||'backlog',version:1,
          harness:{sourceType:input.sourceType,sourceRef:input.sourceRef,activeGeneration:0,activeSessionId:null,worktreePath:workspace,blocker:null},
        };
        state.tasks.set(id,task);
        return {task:clone(task)};
      }
      if(operation==='work.get'){
        if(state.failGet)throw Object.assign(new Error('小队存储 offline'),{code:'LOCAL_STORE_UNAVAILABLE'});
        return {task:clone(taskOf(input.workId))};
      }
      if(operation==='work.find'){
        const found=[...state.tasks.values()].find(task=>task.harness.sourceType===input.sourceType&&task.harness.sourceRef===input.sourceRef);
        return {task:found?clone(found):null};
      }
      if(operation==='work.update'){
        const task=taskOf(input.workId);
        if(input.expectedVersion!==undefined&&Number(input.expectedVersion)!==task.version){
          throw Object.assign(new Error('conflict'),{code:'TASK_VERSION_CONFLICT'});
        }
        if(input.status)task.status=input.status;
        bump(task);
        return {task:clone(task)};
      }
      if(operation==='work.agent.save'){
        state.agents.set(input.workId,{...input});
        return {task:clone(taskOf(input.workId))};
      }
      if(operation==='work.execution.get'){
        const task=taskOf(input.workId);
        if(Number(input.generation)>Number(task.harness.activeGeneration)){
          throw Object.assign(new Error('stale generation'),{code:'EXECUTION_GENERATION_STALE'});
        }
        const found=execution(input.workId,Number(input.generation));
        return {events:clone(found.events),highWaterSequence:found.highWaterSequence,activeSessionId:found.activeSessionId,generation:found.generation};
      }
      if(operation==='work.execution.digest'){
        const task=taskOf(input.workId);
        if(Number(input.generation)>Number(task.harness.activeGeneration))throw Object.assign(new Error('stale generation'),{code:'EXECUTION_GENERATION_STALE'});
        const found=execution(input.workId,Number(input.generation));
        const types=new Set(['SQUAD_ATTEMPT_STARTED','SQUAD_ATTEMPT_COMPLETED','SQUAD_ATTEMPT_SESSION','SQUAD_PROMPT_SUBMITTED','SQUAD_USAGE_REPORTED','SQUAD_ACCEPTANCE']);
        return {
          events:clone(found.events.filter(event=>types.has(event.type))).map(event=>({sequence:event.sequence,event})),
          highWaterSequence:found.highWaterSequence,activeSessionId:found.activeSessionId,generation:found.generation,latestActivity:null,
        };
      }
      throw new Error(`unexpected operation ${operation}`);
    },
    async reserveExecution(input={}){
      const task=state.tasks.get(input.cardId);
      if(!task||task.status!=='todo')return {claims:[],skipped:[{cardId:input.cardId,reason:'not_ready'}]};
      const generation=Number(task.harness.activeGeneration)+1;
      const claimKey=`${task.id}:${generation}`;
      state.claims.set(claimKey,{cardId:task.id,generation});
      return {claims:[{claimKey,cardId:task.id}]};
    },
    async startExecution(claimKey){
      const claim=state.claims.get(claimKey);
      if(!claim)throw new Error('unknown claim');
      const task=taskOf(claim.cardId);
      if(task.status!=='todo')throw new Error('task is not ready');
      task.status='in_progress';
      task.harness.activeGeneration=claim.generation;
      task.harness.activeSessionId=task.harness.activeSessionId||`session-${task.id}-1`;
      bump(task);
      const found=execution(task.id,claim.generation);
      found.activeSessionId=task.harness.activeSessionId;
      return {context:{version:1,storeInstanceId:state.instanceId,cardId:task.id,generation:claim.generation,activeSessionId:found.activeSessionId,worktreePath:workspace}};
    },
    async failExecution(claimKey,error){
      const claim=state.claims.get(claimKey);
      const task=claim?state.tasks.get(claim.cardId):null;
      if(task){task.status='blocked';task.harness.blocker={summary:String(error||'failed')};bump(task);}
      return {ok:true};
    },
    async appendExecutionEvent(taskId,input={}){
      if(state.failAppend)throw Object.assign(new Error('小队存储 offline'),{code:'LOCAL_STORE_UNAVAILABLE'});
      const task=taskOf(taskId);
      if(Number(input.generation)!==task.harness.activeGeneration){
        throw Object.assign(new Error('stale generation'),{code:'EXECUTION_GENERATION_STALE'});
      }
      const found=execution(taskId,Number(input.generation));
      if(input.event?.sessionId!==input.sessionId||Number(input.event?.sequence)!==Number(input.sequence)){
        throw new Error('event identity mismatch');
      }
      const identity=`${input.sessionId}:${input.sequence}`;
      if(state.sequences.has(identity))return {accepted:true,eventId:input.event.eventId};
      state.sequences.add(identity);
      found.events.push(clone(input.event));
      found.highWaterSequence=Math.max(found.highWaterSequence,Number(input.sequence));
      found.activeSessionId=input.sessionId;
      task.harness.activeSessionId=input.sessionId;
      if(input.nativeSessionId)task.harness.nativeSessionId=input.nativeSessionId;
      bump(task);
      return {accepted:true,eventId:input.event.eventId};
    },
    async applyExecutionOutcome(context,event={}){
      const task=taskOf(context.cardId);
      if(context.storeInstanceId!==state.instanceId)throw Object.assign(new Error('instance mismatch'),{code:'LOCAL_INSTANCE_MISMATCH'});
      if(Number(context.generation)!==task.harness.activeGeneration)throw Object.assign(new Error('stale generation'),{code:'EXECUTION_GENERATION_STALE'});
      if(event.eventKind==='idle_success')task.status='in_review';
      else{task.status='blocked';task.harness.blocker={summary:event.errorSummary||'failed'};}
      bump(task);
      return {applied:true};
    },
  };
  return api;
}

async function makeSquad(t,{workspace}={}){
  const dir=await mkdtemp(join(tmpdir(),'codex-squad-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ws=workspace||join(dir,'workspace');
  await mkdir(ws,{recursive:true});
  const client=fakeStore(ws);
  const live=new Set();
  const jobs=[];
  const workerPids=new Map();
  let nextPid=5200;
  const threadId=randomUUID();
  const env={...process.env,CODEX_THREAD_ID:threadId,PLUGIN_DATA:dir};
  const options={
    env,client,machineFingerprint:'machine-test',
    verifyHost:async()=>({}),verifyModel:async()=>({modelId:'verified'}),
    startWorker:async job=>{jobs.push(job);const pid=nextPid++;live.add(pid);workerPids.set(job.taskId,pid);return {pid};},
    isWorkerProcess:pid=>live.has(Number(pid)),
    terminate:pid=>{live.delete(Number(pid));},
    sleep:async()=>{await new Promise(resolve=>setTimeout(resolve,0));},
    stopTimeoutMs:1000,
  };
  const binding=await bindCurrent({...options,cwd:ws});
  return {
    dir,ws,client,live,jobs,workerPids,threadId,env,options,binding,
    workerOptions(extra={}){
      return {
        client,
        read:threadId=>readBinding(threadId,{env}),
        updateState:(threadId,mutate)=>updateBinding(threadId,mutate,{env}),
        releaseWorkspace:entry=>removeWorkspaceWrite(entry,{env}),
        ...extra,
        ...(extra.modules?{modules:{qoderClient:{QoderAcpClient:class {constructor(options){this.options=options}}},...extra.modules}}:{}),
      };
    },
    envFor(otherThread){return {...env,CODEX_THREAD_ID:otherThread};},
  };
}
function handoff(requestId='req-1',overrides={}){
  return {
    requestId,memberId:'implementer',title:'修复报表筛选',goal:'修复筛选并完成聚焦验证',
    scope:['src/report.ts','只处理筛选问题'],criteria:['npm test 通过','给出实际输出'],
    context:'已确认目标与范围。',...overrides,
  };
}
function taskOptions(squad,overrides={}){return {...squad.options,...overrides};}
function occupancyFile(squad){
  return join(squad.dir,'workspaces',`${createHash('sha256').update(realpathSync(squad.ws)).digest('hex').slice(0,24)}.json`);
}
async function readOccupancy(squad){
  try{return JSON.parse(await readFile(occupancyFile(squad),'utf8')).entries;}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
}
async function writeOccupancy(squad,entries){
  await mkdir(join(squad.dir,'workspaces'),{recursive:true});
  await writeFile(occupancyFile(squad),JSON.stringify({schemaVersion:1,workspace:squad.ws,entries}));
}
async function writeNativeQoderUsage({qoderHome,workspace,sessionId,rows}){
  const directory=join(qoderHome,'projects',workspace.replace(/[^a-zA-Z0-9]/g,'-'));
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`${sessionId}.jsonl`),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
}
function qoderUsageRow({sessionId,workspace,id,timestamp,usage}){
  return {type:'assistant',sessionId,cwd:workspace,timestamp,message:{id,role:'assistant',model:'dfmodel',content:[],usage}};
}
async function finish(squad,result,{status='completed',usage=null,nativeSessionId=null,text=null,error=null,actualModel=null,attemptId=result.attemptId}={}){
  const task=squad.client.state.tasks.get(result.taskId);
  const generation=Number(task.harness.activeGeneration);
  const found=squad.client.state.executions.get(`${result.taskId}:${generation}`);
  const sequence=found.highWaterSequence+1;
  await appendSquadEvent(squad.client,{
    taskId:result.taskId,generation,sessionId:found.activeSessionId,sequence,type:'SQUAD_ATTEMPT_COMPLETED',attemptId,
    payload:{attemptId,status,endedAt:new Date().toISOString(),nativeSessionId,usage,result:status==='completed'?text:null,error,actualModel},
  });
  await finalizeAttempt(squad.client,{
    taskId:result.taskId,generation,storeInstanceId:'instance-test',executor:'qoder',sessionId:found.activeSessionId,
    eventKind:status==='completed'?'idle_success':'failed',eventSequence:sequence,errorSummary:error||undefined,
  });
  for(const pid of [...squad.live])if(Number(squad.workerPids.get(result.taskId))===pid)squad.live.delete(pid);
  await removeWorkspaceWrite({workspace:squad.ws,threadId:squad.threadId,taskId:result.taskId,attemptId},{env:squad.env});
}

test('bind isolates the host session, persists only private binding data, and refuses another workspace',async t=>{
  const squad=await makeSquad(t);
  const bindingPath=join(squad.dir,'bindings',`${squad.threadId}.json`);
  const mode=(await stat(bindingPath)).mode&0o777;
  assert.equal(mode,0o600);
  const saved=JSON.parse(await readFile(bindingPath,'utf8'));
  assert.equal(saved.threadId,squad.threadId);
  assert.equal(saved.workspace,squad.ws);
  assert.deepEqual(saved.tasks,[]);
  assert.ok(saved.projectId&&saved.parentWorkId);
  assert.equal(await readBinding(randomUUID(),{env:squad.env}),null);

  const again=await bindCurrent({...squad.options,cwd:squad.ws});
  assert.equal(again.threadId,squad.threadId);
  const other=join(squad.dir,'other-workspace');
  await mkdir(other,{recursive:true});
  await assert.rejects(bindCurrent({...squad.options,cwd:other}),error=>error.code==='SQUAD_BINDING_WORKSPACE_MISMATCH');
  await assert.rejects(bindCurrent({...squad.options,cwd:squad.ws,env:{...squad.env,CODEX_THREAD_ID:''}}),error=>error.code==='SQUAD_HOST_THREAD_MISSING');
});

test('host verification failure leaves no binding',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-squad-host-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ws=join(dir,'workspace');
  await mkdir(ws,{recursive:true});
  const threadId=randomUUID();
  const env={...process.env,CODEX_THREAD_ID:threadId,PLUGIN_DATA:dir};
  const client=fakeStore(ws);
  await assert.rejects(bindCurrent({
    env,client,cwd:ws,verifyHost:async()=>{throw Object.assign(new Error('unverified'),{code:'SQUAD_HOST_THREAD_UNVERIFIED'});},
  }),error=>error.code==='SQUAD_HOST_THREAD_UNVERIFIED');
  assert.equal(await readBinding(threadId,{env}),null);
});

test('dispatch rejects unknown members, unknown fields and reviewer without a reason',async t=>{
  const squad=await makeSquad(t);
  await assert.rejects(dispatch(handoff('req-a',{foo:'x'}),squad.options),error=>error.code==='SQUAD_INPUT_UNKNOWN_FIELD');
  await assert.rejects(dispatch(handoff('req-b',{memberId:'other'}),squad.options),error=>error.code==='SQUAD_MEMBER_FIXED');
  await assert.rejects(dispatch(handoff('req-c',{memberId:'reviewer',reason:undefined}),squad.options),error=>error.code==='SQUAD_MAIN_SESSION_ONLY');
  await assert.rejects(dispatch(handoff('req-d'),taskOptions(squad,{verifyModel:async()=>{throw Object.assign(new Error('missing'),{code:'SQUAD_MODEL_UNAVAILABLE'});}})),error=>error.code==='SQUAD_MODEL_UNAVAILABLE');
  assert.equal(squad.client.state.tasks.size,1);
  assert.equal(squad.jobs.length,0);
});

test('dispatch deduplicates requestId without starting a second attempt',async t=>{
  const squad=await makeSquad(t);
  const first=await dispatch(handoff('req-dup'),squad.options);
  const second=await dispatch(handoff('req-dup'),squad.options);
  assert.equal(second.duplicate,true);
  assert.equal(second.taskId,first.taskId);
  assert.equal(second.attemptId,first.attemptId);
  assert.equal(squad.client.state.tasks.size,2);
  assert.equal(squad.jobs.length,1);
  assert.match(first.taskId,/^task-/);
});

test('snapshot reports real running and unknown states, never a fabricated connection',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-run'),squad.options);
  let view=await snapshot(squad.binding,squad.options);
  assert.equal(view.connected,true);
  assert.equal(view.schemaVersion,1);
  assert.equal(view.binding.threadId,squad.threadId);
  assert.equal(view.tasks[0].status,'starting');
  assert.equal(view.tasks[0].attempts[0].model,'DeepSeek-Flash');
  assert.equal(view.tasks[0].attempts[0].status,'starting');
  assert.equal(view.members.find(member=>member.id==='implementer').status,'starting');
  assert.equal(view.members.some(member=>member.id==='reviewer'),false);
  assert.equal(view.usage.inputTokens,null);
  assert.equal(view.usage.reportedAttempts,0);
  assert.equal(view.usage.totalAttempts,1);
  assert.equal(view.usage.mainSession,'unavailable');
  assert.equal(view.usage.currency,null);
  assert.match(view.cursor,/^[a-f0-9]{64}$/);

  const job=squad.jobs[0];
  const before=await squad.client.operate('work.execution.get',{workId:result.taskId,generation:job.generation});
  await appendSquadEvent(squad.client,{taskId:result.taskId,generation:job.generation,sessionId:job.sessionId,sequence:before.highWaterSequence+1,type:'SQUAD_ATTEMPT_SESSION',attemptId:result.attemptId,payload:{attemptId:result.attemptId,sessionId:'native-confirmed'}});
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].status,'running');
  assert.equal(view.tasks[0].sessionId,'native-confirmed');

  squad.live.clear();
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].status,'unknown');
  assert.equal(view.tasks[0].attempts[0].status,'unknown');
  assert.equal(view.members.find(member=>member.id==='implementer').status,'unknown');

  squad.client.state.failGet=true;
  await assert.rejects(snapshot(squad.binding,squad.options),error=>error.code==='LOCAL_STORE_UNAVAILABLE');
  assert.equal(result.attemptId,view.tasks[0].attempts[0].id);
});

test('executor failure is propagated into the task reason and attempt error',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-fail'),squad.options);
  await finish(squad,result,{status:'failed',error:'模型拒绝执行：缺少授权'});
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].status,'failed');
  assert.equal(view.tasks[0].reason,'模型拒绝执行：缺少授权');
  assert.equal(view.tasks[0].attempts[0].status,'failed');
  assert.equal(view.tasks[0].attempts[0].error,'模型拒绝执行：缺少授权');
});

test('continuation uses the original task and native session, keeps old usage and adds one attempt',async t=>{
  const squad=await makeSquad(t);
  const first=await dispatch(handoff('req-1'),squad.options);
  await finish(squad,first,{nativeSessionId:'native-1',usage:{inputTokens:100,outputTokens:20,cachedInputTokens:60,totalTokens:120},text:'首轮完成'});
  let view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].status,'waiting_review');
  assert.equal(view.tasks[0].sessionId,'native-1');
  assert.equal(view.usage.totalTokens,120);
  assert.equal(view.usage.inputTokens,100);

  const second=await continueTask({
    taskId:first.taskId,requestId:'req-2',goal:'补上空值边界',scope:['src/report.ts'],criteria:['npm test 通过'],
    context:'只处理空值边界的增量，不重复首轮背景。',
  },squad.options);
  assert.equal(second.taskId,first.taskId);
  assert.notEqual(second.attemptId,first.attemptId);
  assert.equal(second.generation,2);
  const job=squad.jobs.at(-1);
  assert.equal(job.taskId,first.taskId);
  assert.equal(job.nativeSessionId,'native-1');
  assert.equal(job.resumedFrom,first.attemptId);
  assert.equal(job.handoff.context,'只处理空值边界的增量，不重复首轮背景。');
  assert.equal(job.handoff.goal,'补上空值边界');

  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].attempts.length,2);
  assert.equal(view.tasks[0].attempts[0].status,'completed');
  assert.equal(view.tasks[0].attempts[1].status,'running');
  assert.equal(view.tasks[0].attempts[1].resumedFrom,first.attemptId);
  assert.equal(view.tasks[0].attempts[0].handoff.goal,'修复筛选并完成聚焦验证');
  assert.equal(view.tasks[0].attempts[1].handoff.goal,'补上空值边界');
  assert.equal(view.tasks[0].attempts[1].handoff.context,'只处理空值边界的增量，不重复首轮背景。');
  assert.deepEqual(view.tasks[0].attempts[1].handoff.scope,['src/report.ts']);
  assert.deepEqual(view.tasks[0].attempts[1].handoff.criteria,['npm test 通过']);
  assert.equal(view.tasks[0].attempts[0].delivery.state,'unconfirmed');
  assert.equal(view.tasks[0].attempts[1].delivery.state,'pending');
  assert.equal(view.usage.totalTokens,120);
  assert.equal(view.usage.reportedAttempts,1);
  assert.equal(view.usage.totalAttempts,2);
  assert.equal(view.tasks[0].acceptance,null);

  await finish(squad,second,{nativeSessionId:'native-1',usage:{inputTokens:10,outputTokens:2,cachedInputTokens:5,totalTokens:12},text:'边界修复完成'});
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.usage.inputTokens,110);
  assert.equal(view.usage.outputTokens,22);
  assert.equal(view.usage.cachedInputTokens,65);
  assert.equal(view.usage.totalTokens,132);
  assert.equal(view.usage.reportedAttempts,2);
  assert.equal(view.usage.totalAttempts,2);

  await finish(squad,second,{nativeSessionId:'native-1',usage:{inputTokens:10,outputTokens:2,cachedInputTokens:5,totalTokens:12},text:'重复回执'});
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.usage.totalTokens,132);
  assert.equal(view.usage.inputTokens,110);
  assert.equal(view.usage.reportedAttempts,2);
});

test('continuation refuses to silently replace a missing native session',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-no-session'),squad.options);
  await finish(squad,result,{status:'failed',error:'执行器未建立会话'});
  await assert.rejects(continueTask({
    taskId:result.taskId,requestId:'req-no-session-2',goal:'继续',scope:['src/report.ts'],criteria:['测试'],
  },squad.options),error=>error.code==='SQUAD_NATIVE_SESSION_UNAVAILABLE');
});

test('verify starts the main-Codex review and acceptance keeps the historical round records',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-accept'),squad.options);
  await assert.rejects(acceptTask({taskId:result.taskId,files:['candidate.ts']},squad.options),error=>error.code==='SQUAD_ACCEPTANCE_NOT_READY');
  await assert.rejects(verifyTask({taskId:result.taskId},squad.options),error=>error.code==='SQUAD_VERIFICATION_NOT_READY');
  await finish(squad,result,{nativeSessionId:'native-accept',usage:{inputTokens:5,outputTokens:1},text:'完成'});
  await assert.rejects(acceptTask({taskId:result.taskId,files:['candidate.ts']},squad.options),error=>error.code==='SQUAD_VERIFICATION_REQUIRED');

  const verified=await verifyTask({taskId:result.taskId},squad.options);
  assert.equal(verified.verified,true);
  assert.equal(verified.duplicate,false);
  assert.equal(verified.phase,'verifying');
  assert.equal(verified.attemptId,result.attemptId);
  const duplicateVerify=await verifyTask({taskId:result.taskId},squad.options);
  assert.equal(duplicateVerify.duplicate,true);
  assert.equal(duplicateVerify.verifiedAt,verified.verifiedAt);
  let view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].verification.attemptId,result.attemptId);
  assert.equal(view.tasks[0].verification.at,verified.verifiedAt);
  assert.equal(view.inbox.count,1);
  assert.equal(view.inbox.verifying.length,1);
  assert.equal(view.inbox.pending.length,0);

  const accepted=await acceptTask({taskId:result.taskId,files:['candidate.ts'],note:'负责人已核对实际测试输出'},squad.options);
  assert.equal(accepted.accepted,true);
  assert.equal(accepted.verification.at,verified.verifiedAt);
  const duplicate=await acceptTask({taskId:result.taskId,files:['candidate.ts']},squad.options);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.verification.at,verified.verifiedAt);
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].acceptance.fingerprint,accepted.acceptance.fingerprint);
  assert.equal(view.tasks[0].acceptance.changedSinceVerification,false);
  assert.equal(view.tasks[0].acceptance.note,'负责人已核对实际测试输出');
  assert.equal(view.tasks[0].verification.at,verified.verifiedAt);
  assert.equal(view.inbox.count,0);

  const next=await continueTask({taskId:result.taskId,requestId:'req-accept-2',goal:'处理评审意见',scope:['src/report.ts'],criteria:['npm test 通过']},squad.options);
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].attempts.length,2);
  assert.equal(view.tasks[0].acceptance,null);
  assert.equal(view.tasks[0].verification,null);
  assert.equal(view.tasks[0].attempts[0].acceptance.fingerprint,accepted.acceptance.fingerprint);
  assert.equal(view.tasks[0].attempts[0].verification.at,verified.verifiedAt);
  assert.equal(view.tasks[0].attempts[1].verification,undefined);
  assert.equal(view.inbox.count,0);
  assert.equal(next.taskId,result.taskId);

  await finish(squad,next,{nativeSessionId:'native-accept',text:'返工完成'});
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.inbox.count,1);
  assert.equal(view.inbox.pending[0].taskId,result.taskId);
  assert.equal(view.inbox.pending[0].phase,'waiting');
  assert.equal(view.inbox.pending[0].attemptId,next.attemptId);
  assert.equal(view.inbox.pending[0].recordMissing,false);
  assert.equal(view.tasks[0].attempts[0].verification.at,verified.verifiedAt);
  await verifyTask({taskId:result.taskId},squad.options);
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.inbox.verifying[0].attemptId,next.attemptId);
  assert.equal(view.tasks[0].attempts[0].verification.at,verified.verifiedAt);
});

test('inbox and wait receipts expose unhandled returns from the same compact snapshot',async t=>{
  const squad=await makeSquad(t);
  const first=await dispatch(handoff('req-inbox-one',{writePaths:['src/one.ts']}),squad.options);
  const second=await dispatch(handoff('req-inbox-two',{writePaths:['src/two.ts']}),squad.options);
  await finish(squad,first,{nativeSessionId:'native-inbox',text:'已完成'});
  let view=await snapshot(squad.binding,squad.options);
  assert.equal(view.inbox.schemaVersion,1);
  assert.equal(view.inbox.count,1);
  assert.deepEqual(view.inbox.pending.map(entry=>entry.taskId),[first.taskId]);
  assert.equal(view.inbox.pending[0].returnedAt!==null,true);
  assert.equal(view.inbox.pending[0].sessionId,'native-inbox');

  await finish(squad,second,{status:'failed',error:'执行失败'});
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.inbox.count,1,'failed returns still need a disposition record');
  assert.equal(view.inbox.pending[0].taskId,first.taskId);

  const binding=await readBinding(squad.threadId,{env:squad.env});
  const baseline=await waitForTasks(binding,{taskIds:[first.taskId,second.taskId],seconds:0},taskOptions(squad));
  const unchanged=await waitForTasks(binding,{taskIds:[first.taskId,second.taskId],seconds:1,after:baseline.cursor},taskOptions(squad,{sleep:async()=>{await new Promise(resolve=>setTimeout(resolve,20));}}));
  assert.equal(unchanged.changed,false);
  assert.deepEqual(unchanged.tasks.map(task=>task.id).sort(),[first.taskId,second.taskId].sort());
});

test('retire requires a real stop receipt and keeps cancelled work read-only in history',async t=>{
  const squad=await makeSquad(t);
  const running=await dispatch(handoff('req-retire-running'),squad.options);
  await assert.rejects(retireTask({taskId:running.taskId,outcome:'cancelled',reason:'需求撤回'},squad.options),error=>error.code==='SQUAD_TASK_RUNNING');
  await assert.rejects(retireTask({taskId:running.taskId,outcome:'merged',reason:'需求撤回'},squad.options),error=>error.code==='SQUAD_RETIREMENT_OUTCOME_INVALID');
  await assert.rejects(retireTask({taskId:running.taskId,outcome:'cancelled',reason:''},squad.options),error=>error.code==='SQUAD_INPUT_INVALID');

  const workerPid=squad.workerPids.get(running.taskId);
  squad.live.delete(workerPid);
  await updateBinding(squad.threadId,binding=>{
    delete binding.workers[running.taskId];
    for(const ref of binding.attempts[running.taskId]||[])delete ref.worker;
  },squad.options);
  await assert.rejects(retireTask({taskId:running.taskId,outcome:'cancelled',reason:'进程失联'},squad.options),error=>error.code==='SQUAD_STOP_NOT_CONFIRMED');

  await finish(squad,running,{status:'stopped',error:'已按请求停止。'});
  const retired=await retireTask({taskId:running.taskId,outcome:'cancelled',reason:'用户撤回需求'},squad.options);
  assert.equal(retired.retired,true);
  assert.equal(retired.duplicate,false);
  assert.equal(retired.outcome,'cancelled');
  const duplicate=await retireTask({taskId:running.taskId,outcome:'cancelled',reason:'用户撤回需求'},squad.options);
  assert.equal(duplicate.duplicate,true);
  await assert.rejects(retireTask({taskId:running.taskId,outcome:'superseded',reason:'改用其他方案'},squad.options),error=>error.code==='SQUAD_TASK_RETIRED');

  let view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].retirement.outcome,'cancelled');
  assert.equal(view.tasks[0].retirement.reason,'用户撤回需求');
  assert.equal(view.tasks[0].retirement.attemptStatus,'stopped');
  assert.equal(view.inbox.count,0);
  await assert.rejects(continueTask({taskId:running.taskId,requestId:'req-retire-resume',goal:'继续',scope:['src/report.ts'],criteria:['测试']},squad.options),error=>error.code==='SQUAD_TASK_RETIRED');
  await assert.rejects(verifyTask({taskId:running.taskId},squad.options),error=>error.code==='SQUAD_TASK_RETIRED');
  await assert.rejects(acceptTask({taskId:running.taskId,files:['candidate.ts']},squad.options),error=>error.code==='SQUAD_TASK_RETIRED');

  const supersededTask=await dispatch(handoff('req-supersede',{writePaths:['src/superseded.ts']}),squad.options);
  await finish(squad,supersededTask,{status:'failed',error:'实现方向不可行'});
  const superseded=await retireTask({taskId:supersededTask.taskId,outcome:'superseded',reason:'范围调整',replacedBy:'方案 B'},squad.options);
  assert.equal(superseded.outcome,'superseded');
  view=await snapshot(squad.binding,squad.options);
  const record=view.tasks.find(task=>task.id===supersededTask.taskId).retirement;
  assert.equal(record.replacedBy,'方案 B');
  assert.equal(record.attemptStatus,'failed');
});

test('retirement rechecks the latest attempt after a concurrent continuation releases the binding',async t=>{
  const squad=await makeSquad(t);
  const first=await dispatch(handoff('req-retire-race'),squad.options);
  await finish(squad,first,{nativeSessionId:'native-retire-race',text:'已返回'});
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve});
  const acquired=new Promise(resolve=>{entered=resolve});
  const holder=withBindingLock(squad.threadId,async()=>{entered();await gate},squad.options);
  await acquired;
  const next=continueTask({taskId:first.taskId,requestId:'req-retire-race-next',goal:'新一轮执行',scope:['src/report.ts'],criteria:['测试通过']},squad.options);
  const retiring=retireTask({taskId:first.taskId,outcome:'cancelled',reason:'并发处置'},squad.options);
  release();await holder;
  const results=await Promise.allSettled([next,retiring]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const current=(await snapshot(squad.binding,squad.options)).tasks[0];
  if(results[0].status==='fulfilled'){
    assert.equal(current.retirement,null);
    assert.equal(current.attempts.length,2);
    assert.equal(current.status,'running');
    assert.equal(results[1].reason.code,'SQUAD_TASK_RUNNING');
  }else{
    assert.equal(current.retirement.outcome,'cancelled');
    assert.equal(current.attempts.length,1);
    assert.equal(results[0].reason.code,'SQUAD_TASK_RETIRED');
  }
});

test('accepted work cannot be retired and a passive disconnect never becomes a cancellation',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-retire-accepted'),squad.options);
  await finish(squad,result,{nativeSessionId:'native-accepted',text:'完成'});
  await verifyTask({taskId:result.taskId},squad.options);
  await acceptTask({taskId:result.taskId,files:['candidate.ts'],note:'已核对'},squad.options);
  await assert.rejects(retireTask({taskId:result.taskId,outcome:'cancelled',reason:'想取消'},squad.options),error=>error.code==='SQUAD_TASK_ACCEPTED');

  const pending=await dispatch(handoff('req-retire-pending',{writePaths:['src/pending.ts']}),squad.options);
  squad.live.delete(squad.workerPids.get(pending.taskId));
  const view=await snapshot(squad.binding,squad.options);
  const task=view.tasks.find(item=>item.id===pending.taskId);
  assert.equal(task.status,'unknown');
  assert.equal(task.retirement,null);
  await assert.rejects(retireTask({taskId:pending.taskId,outcome:'cancelled',reason:'进程不见了'},squad.options),error=>error.code==='SQUAD_STOP_NOT_CONFIRMED');
  assert.equal((await snapshot(squad.binding,squad.options)).tasks.find(item=>item.id===pending.taskId).retirement,null);
});

test('stop reports unknown until the executor returns a real terminal receipt',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-stop'),squad.options);
  const workerPid=squad.workerPids.get(result.taskId);
  const stopped=await stopTask({taskId:result.taskId,reason:'用户要求停止'},taskOptions(squad,{stopTimeoutMs:3000,terminate:()=>{squad.live.delete(workerPid);}}));
  assert.equal(stopped.stopped,false);
  assert.equal(stopped.status,'unknown');
  assert.equal(stopped.stop.state,'unconfirmed');
  await finish(squad,result,{status:'stopped',error:'执行进程已退出，未收到终止回执。'});

  const receipt=await dispatch(handoff('req-stop-receipt'),squad.options);
  const receiptPid=squad.workerPids.get(receipt.taskId);
  let delivered=false;
  const pending=stopTask({taskId:receipt.taskId,reason:'用户要求停止'},taskOptions(squad,{
    stopTimeoutMs:3000,
    terminate:()=>{squad.live.delete(receiptPid);},
    sleep:async()=>{
      await new Promise(resolve=>setTimeout(resolve,5));
      if(!delivered){delivered=true;await finish(squad,receipt,{status:'stopped',error:'执行已按请求停止。'});}
    },
  }));
  const confirmation=await pending;
  assert.equal(confirmation.stopped,true);
  assert.equal(confirmation.status,'stopped');
  assert.equal(confirmation.stop.state,'stopped');

  const missing=await dispatch(handoff('req-stop-missing'),squad.options);
  await updateBinding(squad.threadId,binding=>{
    delete binding.workers[missing.taskId];
    for(const ref of binding.attempts[missing.taskId]||[])delete ref.worker;
  },squad.options);
  const unknown=await stopTask({taskId:missing.taskId,reason:'检查进程'},squad.options);
  assert.equal(unknown.stopped,false);
  assert.equal(unknown.status,'unknown');
});

test('disjoint scopes run concurrently while overlaps and unscoped writes stay exclusive across chats',async t=>{
  const squad=await makeSquad(t);
  const first=await dispatch(handoff('scope-one',{writePaths:['src/one.ts']}),squad.options);
  await dispatch(handoff('scope-two',{writePaths:['src/two.ts']}),squad.options);
  await assert.rejects(dispatch(handoff('scope-parent',{writePaths:['src']}),squad.options),e=>e.code==='SQUAD_WORKSPACE_BUSY'&&e.message.includes(first.taskId));
  await assert.rejects(dispatch(handoff('scope-default'),squad.options),e=>e.code==='SQUAD_WORKSPACE_BUSY');
  const otherOptions={...squad.options,env:squad.envFor(randomUUID())};
  await bindCurrent({...otherOptions,cwd:squad.ws});
  await dispatch(handoff('scope-other',{writePaths:['test/other.ts']}),otherOptions);
  await assert.rejects(dispatch(handoff('scope-collision',{writePaths:['src/one.ts']}),otherOptions),e=>e.code==='SQUAD_WORKSPACE_BUSY');
  const view=await snapshot(squad.binding,squad.options);assert.equal(view.members[0].activeCount,2);
  await finish(squad,first,{nativeSessionId:'original-native'});
  const next=await continueTask({taskId:first.taskId,requestId:'scope-resume',goal:'继续',scope:['src/one.ts'],criteria:['验证']},squad.options);
  assert.deepEqual(squad.jobs.at(-1).handoff.writePaths,['src/one.ts']);assert.equal(next.status,'starting');
});

test('one main chat admits 19 executions and refuses the twentieth before creating work',async t=>{
  const squad=await makeSquad(t);
  for(let i=0;i<19;i++)await dispatch(handoff('limit-'+i,{writePaths:['src/'+i+'.ts']}),squad.options);
  await assert.rejects(dispatch(handoff('limit-20',{writePaths:['src/20.ts']}),squad.options),e=>e.code==='SQUAD_CONCURRENCY_LIMIT');
  assert.equal(squad.jobs.length,19);assert.equal(squad.client.state.tasks.size,20);
});

test('wait returns a compact changed view only for a terminal change',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-wait'),squad.options);
  const binding=await readBinding(squad.threadId,{env:squad.env});
  const baseline=await waitForTasks(binding,{taskIds:[result.taskId],seconds:0},squad.options);
  const pending=waitForTasks(binding,{taskIds:[result.taskId],seconds:5,after:baseline.cursor},taskOptions(squad,{sleep:async()=>{await new Promise(resolve=>setTimeout(resolve,5));}}));
  setTimeout(()=>{void finish(squad,result,{nativeSessionId:'native-wait',text:'完成'});},20);
  const changed=await pending;
  assert.equal(changed.changed,true);
  assert.notEqual(changed.cursor,baseline.cursor);
  assert.equal(changed.tasks[0].status,'waiting_review');
  assert.equal(changed.tasks[0].latest.result,'完成');

  const current=await waitForTasks(binding,{taskIds:[result.taskId],seconds:0},squad.options);
  const unchanged=await waitForTasks(binding,{taskIds:[result.taskId],seconds:1,after:current.cursor},taskOptions(squad,{sleep:async()=>{await new Promise(resolve=>setTimeout(resolve,20));}}));
  assert.equal(unchanged.changed,false);
  assert.equal(unchanged.cursor,current.cursor);
  assert.equal(unchanged.tasks[0].latest.result,'完成');
});

test('worker validates the fixed member model and required reviewer reason',async ()=>{
  const base={
    version:1,threadId:randomUUID(),taskId:'task-1',attemptId:'att-1',attemptIndex:1,requestId:'req-1',
    memberId:'implementer',memberName:'实现成员',executor:'qoder',model:'DeepSeek-Flash',
    workspace:'/tmp/workspace',generation:1,storeInstanceId:'instance',sessionId:'session',
    claimKey:'task-1:1',nativeSessionId:null,resumedFrom:null,nextSequence:2,nonce:randomUUID(),
    handoff:{title:'任务',goal:'目标',scope:['范围'],criteria:['条件'],context:'',reason:null},
  };
  const valid=validateJob({...base},base.nonce);
  assert.equal(valid.member.id,'implementer');
  assert.match(buildBrief(valid,valid.member),/不要递归组队/);
  assert.throws(()=>validateJob({...base,model:'gpt-5.6-sol'},base.nonce),error=>error.code==='SQUAD_MODEL_SUBSTITUTION');
  assert.throws(()=>validateJob({...base,memberId:'reviewer',memberName:'检查成员',executor:'codex',model:'gpt-5.6-sol'},base.nonce),error=>error.code==='SQUAD_MAIN_SESSION_ONLY');
  assert.throws(()=>validateJob({...base},randomUUID()),error=>error.code==='SQUAD_WORKER_NONCE_MISMATCH');
  assert.equal(validateJob({...base,hostRolloutOffset:42},base.nonce).hostRolloutOffset,42);
  assert.equal(validateJob({...base},base.nonce).hostRolloutOffset,null);
  assert.throws(()=>validateJob({...base,hostRolloutOffset:-1},base.nonce),error=>error.code==='SQUAD_WORKER_JOB_INVALID');
  assert.throws(()=>validateJob({...base,hostRolloutState:'linked'},base.nonce),error=>error.code==='SQUAD_WORKER_JOB_INVALID');
});

test('worker persists public events, native session, usage and terminal through the real runtime contract',async t=>{
  const squad=await makeSquad(t);
  const started=await dispatch(handoff('req-worker'),squad.options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  let captured=null;
  const qoderRunner={
    async runQoderAcpCommand(config){
      captured=config;
      config.onSessionEvent({sessionId:config.sessionId,kind:'session.prompt_submitted',payload:{at:'2026-10-20T09:00:01.000Z',metadata:{eventId:'prompt-1',turnId:'turn-1'},cliSessionId:'native-worker'}});
      config.onSessionEvent({sessionId:config.sessionId,kind:'session.reasoning',payload:{content:'内部推理'}});
      config.onSessionEvent({sessionId:config.sessionId,kind:'session.assistant_message',payload:{content:'流式片段',metadata:{streamState:'streaming'}}});
      config.onSessionEvent({sessionId:config.sessionId,kind:'session.assistant_message',payload:{content:'筛选已修复',metadata:{streamState:'completed',turnId:'turn-1'},cliSessionId:'native-worker'}});
      config.onSessionEvent({sessionId:config.sessionId,kind:'session.tool_use',payload:{content:'',toolName:'Bash',input:{command:'npm test'},metadata:{itemId:'tool-1',turnId:'turn-1'},cliSessionId:'native-worker'}});
      config.onSessionEvent({sessionId:config.sessionId,kind:'session.tool_result',payload:{content:'tests passed',toolName:'Bash',metadata:{itemId:'tool-1',turnId:'turn-1'},cliSessionId:'native-worker'}});
      return {status:'completed',text:'筛选已修复',cliSessionId:'native-worker',turnId:'turn-1',usage:{inputTokens:10,outputTokens:2,cachedInputTokens:4,totalTokens:12}};
    },
  };
  const outcome=await runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},log:()=>{}}));
  assert.equal(outcome.terminalApplied,true);
  assert.equal(outcome.status,'completed');
  assert.equal(outcome.exitCode,0);
  assert.equal(captured.qoderAcpModel,'DeepSeek-Flash');
  const launch=captured.qoderAcpClient.options;assert.equal(JSON.parse(launch.args[1]).general.plan.enabled,false);assert.deepEqual(JSON.parse(launch.args[1]).tools.exclude,['Agent','EnterPlanMode','ExitPlanMode']);assert.equal(launch.args[3],'Agent,EnterPlanMode,ExitPlanMode');assert.equal(captured.appServerCollaborationMode,'default');
  assert.equal(captured.appServerApprovalPolicy,'never');
  assert.equal(captured.appServerSandbox,'danger-full-access');
  assert.equal(captured.cliSessionId,undefined);

  const view=await snapshot(squad.binding,squad.options);
  const attempt=view.tasks[0].attempts[0];
  assert.equal(view.tasks[0].status,'waiting_review');
  assert.equal(attempt.status,'completed');
  assert.equal(attempt.sessionId,'native-worker');
  assert.equal(attempt.result,'筛选已修复');
  assert.equal(attempt.usage.totalTokens,12);
  assert.equal(attempt.usage.cachedInputTokens,4);
  assert.equal(attempt.delivery.state,'received');
  assert.equal(attempt.delivery.submittedAt,'2026-10-20T09:00:01.000Z');
  assert.ok(attempt.delivery.respondedAt);
  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  assert.ok(execution.events.some(event=>event.type==='SQUAD_PROMPT_SUBMITTED'&&event.payload.attemptId===attempt.id&&event.payload.nativeSessionId==='native-worker'));
  assert.ok(attempt.events.some(event=>event.kind==='message'&&event.role==='assistant'&&event.text==='筛选已修复'&&event.status==='completed'));
  assert.ok(attempt.events.some(event=>event.kind==='tool'&&event.toolName==='Bash'&&event.text==='npm test'&&event.status==='SUCCEEDED'));
  assert.equal(attempt.events.some(event=>String(event.text||'').includes('流式片段')),false);
  assert.equal(attempt.events.some(event=>String(event.text||'').includes('内部推理')||String(event.result||'').includes('内部推理')),false);
  assert.equal(started.taskId,view.tasks[0].id);
});

test('historical Codex task and usage remain readable but cannot be dispatched or continued',async t=>{
  const squad=await makeSquad(t);
  const old=await dispatch(handoff('legacy-record'),squad.options);
  await finish(squad,old,{nativeSessionId:'legacy-codex-thread',text:'历史检查结论',usage:{inputTokens:7,outputTokens:1}});
  squad.client.state.tasks.get(old.taskId).harness.sourceRef=squad.client.state.tasks.get(old.taskId).harness.sourceRef.replace(':implementer:',':reviewer:');
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].memberId,'reviewer');assert.equal(view.tasks[0].attempts[0].model,'gpt-5.6-sol');assert.equal(view.tasks[0].attempts[0].result,'历史检查结论');assert.equal(view.usage.inputTokens,7);
  await assert.rejects(continueTask({taskId:old.taskId,requestId:'legacy-resume',goal:'继续',scope:['范围'],criteria:['条件'],reason:'review'},squad.options),e=>e.code==='SQUAD_MAIN_SESSION_ONLY');
  await assert.rejects(dispatch(handoff('new-review',{memberId:'reviewer',reason:'review'}),squad.options),e=>e.code==='SQUAD_MAIN_SESSION_ONLY');
  assert.equal(squad.jobs.length,1);
});

test('worker turns a stop request into a stopped terminal only after the runner returns',async t=>{
  const squad=await makeSquad(t);
  await dispatch(handoff('req-worker-stop'),squad.options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  let announce;
  const started=new Promise(resolve=>{announce=resolve;});
  const qoderRunner={
    runQoderAcpCommand(config){
      return new Promise(resolve=>{
        announce();
        config.signal.addEventListener('abort',()=>resolve({status:'interrupted',error:'已取消'}),{once:true});
      });
    },
  };
  const controller=new AbortController();
  const running=runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},signal:controller.signal,log:()=>{}}));
  await started;
  controller.abort();
  const outcome=await running;
  assert.equal(outcome.status,'stopped');
  assert.equal(outcome.terminalApplied,true);
  assert.equal(outcome.exitCode,1);
  const found=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  assert.ok(found.events.some(event=>event.type==='SQUAD_STOP_REQUESTED'));
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].attempts[0].status,'stopped');
  assert.equal(view.tasks[0].status,'stopped');
});

test('worker saves real stopped consumption from the attempt-bounded native receipt',async t=>{
  const squad=await makeSquad(t);
  await dispatch(handoff('req-worker-stop-usage'),squad.options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const binding=await readBinding(squad.threadId,{env:squad.env});
  const startedAt=binding.workers[job.taskId].startedAt;
  const qoderHome=await mkdtemp(join(tmpdir(),'squad-qoder-native-'));
  t.after(()=>rm(qoderHome,{recursive:true,force:true}));
  const nativeSessionId=randomUUID();
  const base={sessionId:nativeSessionId,workspace:squad.ws};
  await writeNativeQoderUsage({qoderHome,workspace:squad.ws,sessionId:nativeSessionId,rows:[
    qoderUsageRow({...base,id:'previous-attempt',timestamp:new Date(Date.parse(startedAt)-60000).toISOString(),
      usage:{input_tokens:900,cache_read_input_tokens:800,output_tokens:90}}),
    qoderUsageRow({...base,id:'response-1',timestamp:startedAt,
      usage:{input_tokens:100,cache_read_input_tokens:40,output_tokens:10}}),
    qoderUsageRow({...base,id:'response-2',timestamp:startedAt,
      usage:{input_tokens:50,cache_read_input_tokens:30,output_tokens:5}}),
  ]});
  const qoderRunner={
    async runQoderAcpCommand(){
      return {status:'interrupted',cliSessionId:nativeSessionId,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:null,totalTokens:0}};
    },
  };
  const outcome=await runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},qoderHome,log:()=>{}}));
  assert.equal(outcome.status,'stopped');
  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  const terminals=execution.events.filter(event=>event.type==='SQUAD_ATTEMPT_COMPLETED');
  assert.equal(terminals.length,1,'同一尝试只保留一个终态，重复回执不累计');
  assert.deepEqual(terminals[0].payload.usage,{
    inputTokens:150,outputTokens:15,cachedInputTokens:70,totalTokens:165,
  },'停止任务的真实消费按时段归入本次尝试，缓存不重复相加');
  const view=await snapshot(squad.binding,squad.options);
  assert.deepEqual(view.tasks[0].attempts[0].usage,terminals[0].payload.usage);
  assert.equal(view.usage.totalTokens,165);
  assert.equal(view.usage.reportedAttempts,1);
});

test('worker saves real failed consumption from the attempt-bounded native receipt',async t=>{
  const squad=await makeSquad(t);
  await dispatch(handoff('req-worker-failed-usage'),squad.options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const binding=await readBinding(squad.threadId,{env:squad.env});
  const startedAt=binding.workers[job.taskId].startedAt;
  const qoderHome=await mkdtemp(join(tmpdir(),'squad-qoder-native-'));
  t.after(()=>rm(qoderHome,{recursive:true,force:true}));
  const nativeSessionId=randomUUID();
  const base={sessionId:nativeSessionId,workspace:squad.ws};
  await writeNativeQoderUsage({qoderHome,workspace:squad.ws,sessionId:nativeSessionId,rows:[
    qoderUsageRow({...base,id:'previous-attempt',timestamp:new Date(Date.parse(startedAt)-60000).toISOString(),
      usage:{input_tokens:900,cache_read_input_tokens:800,output_tokens:90}}),
    qoderUsageRow({...base,id:'response-1',timestamp:startedAt,
      usage:{input_tokens:120,cache_read_input_tokens:50,output_tokens:12}}),
    qoderUsageRow({...base,id:'response-2',timestamp:startedAt,
      usage:{input_tokens:30,cache_read_input_tokens:10,output_tokens:3}}),
  ]});
  const qoderRunner={
    async runQoderAcpCommand(){
      return {status:'failed',error:'模型请求失败',cliSessionId:nativeSessionId,
        usage:{inputTokens:0,outputTokens:0,cachedInputTokens:null,totalTokens:0}};
    },
  };
  const outcome=await runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},qoderHome,log:()=>{}}));
  assert.equal(outcome.status,'failed');
  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  const terminals=execution.events.filter(event=>event.type==='SQUAD_ATTEMPT_COMPLETED');
  assert.equal(terminals.length,1,'同一尝试只保留一个终态，重复回执不累计');
  assert.deepEqual(terminals[0].payload.usage,{
    inputTokens:150,outputTokens:15,cachedInputTokens:60,totalTokens:165,
  },'失败任务的真实消费按时段归入本次尝试');
  const view=await snapshot(squad.binding,squad.options);
  assert.deepEqual(view.tasks[0].attempts[0].usage,terminals[0].payload.usage);
  assert.equal(view.usage.totalTokens,165);
  assert.equal(view.usage.reportedAttempts,1);
});

test('worker keeps an all-zero startup failure without a session unknown',async t=>{
  const squad=await makeSquad(t);
  await dispatch(handoff('req-worker-no-session'),squad.options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const qoderHome=await mkdtemp(join(tmpdir(),'squad-qoder-native-'));
  t.after(()=>rm(qoderHome,{recursive:true,force:true}));
  const qoderRunner={
    async runQoderAcpCommand(){
      return {status:'failed',error:'执行器启动失败',
        usage:{inputTokens:0,outputTokens:0,cachedInputTokens:null,totalTokens:0}};
    },
  };
  const outcome=await runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},qoderHome,log:()=>{}}));
  assert.equal(outcome.status,'failed');
  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  const terminal=execution.events.find(event=>event.type==='SQUAD_ATTEMPT_COMPLETED');
  assert.equal(terminal.payload.usage,null,'无 session 的全零占位回执没有消费证据，保持 null');
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].attempts[0].usage,null);
  assert.equal(view.usage.reportedAttempts,0);
});

test('worker fills completed cache from native evidence and keeps missing evidence unknown',async t=>{
  const squad=await makeSquad(t);
  const qoderHome=await mkdtemp(join(tmpdir(),'squad-qoder-native-'));
  t.after(()=>rm(qoderHome,{recursive:true,force:true}));

  await dispatch(handoff('req-worker-completed-cache'),squad.options);
  const completedJob=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const completedBinding=await readBinding(squad.threadId,{env:squad.env});
  const completedStarted=completedBinding.workers[completedJob.taskId].startedAt;
  const completedSession=randomUUID();
  await writeNativeQoderUsage({qoderHome,workspace:squad.ws,sessionId:completedSession,rows:[
    qoderUsageRow({sessionId:completedSession,workspace:squad.ws,id:'response-1',timestamp:completedStarted,
      usage:{input_tokens:100,cache_read_input_tokens:40,output_tokens:10}}),
  ]});
  const completed=await runWorkerJob(completedJob,squad.workerOptions({
    modules:{qoderRunner:{async runQoderAcpCommand(){
      return {status:'completed',text:'完成',cliSessionId:completedSession,
        usage:{inputTokens:100,outputTokens:10,cachedInputTokens:null,totalTokens:110}};
    }},appServerRunner:{}},
    qoderHome,log:()=>{},
  }));
  assert.equal(completed.status,'completed');
  const completedExecution=squad.client.state.executions.get(`${completedJob.taskId}:${completedJob.generation}`);
  const completedTerminal=completedExecution.events.find(event=>event.type==='SQUAD_ATTEMPT_COMPLETED');
  assert.deepEqual(completedTerminal.payload.usage,{
    inputTokens:100,outputTokens:10,cachedInputTokens:40,totalTokens:110,
  },'回执缺少 cache 时用同一 input 身份的原生证据补齐');

  await dispatch(handoff('req-worker-failed-unknown'),squad.options);
  const failedJob=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const failed=await runWorkerJob(failedJob,squad.workerOptions({
    modules:{qoderRunner:{async runQoderAcpCommand(){
      return {status:'failed',error:'执行器启动失败',cliSessionId:randomUUID(),
        usage:{inputTokens:0,outputTokens:0,cachedInputTokens:null,totalTokens:0}};
    }},appServerRunner:{}},
    qoderHome,log:()=>{},
  }));
  assert.equal(failed.status,'failed');
  const failedExecution=squad.client.state.executions.get(`${failedJob.taskId}:${failedJob.generation}`);
  const failedTerminal=failedExecution.events.find(event=>event.type==='SQUAD_ATTEMPT_COMPLETED');
  assert.equal(failedTerminal.payload.usage,null,'没有消费证据时保持 null，不落 0');
});

test('worker refuses to report success when 小队存储 rejects the terminal receipt',async t=>{
  const squad=await makeSquad(t);
  await dispatch(handoff('req-stale-terminal'),squad.options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const qoderRunner={async runQoderAcpCommand(){return {status:'completed',text:'执行完成'};}};
  const outcome=await runWorkerJob(job,squad.workerOptions({
    client:{...squad.client,applyExecutionOutcome:async()=>({applied:false,stale:true})},
    modules:{qoderRunner,appServerRunner:{}},sleep:async()=>{},log:()=>{},
  }));
  assert.equal(outcome.status,'completed');
  assert.equal(outcome.terminalApplied,false);
  assert.equal(outcome.exitCode,1);
});

test('worker refuses a binding record that does not contain its attempt and nonce',async t=>{
  const squad=await makeSquad(t);
  await dispatch(handoff('req-worker-unregistered'),squad.options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  await assert.rejects(
    runWorkerJob({...job,nonce:randomUUID()},{client:squad.client,modules:{qoderRunner:{},appServerRunner:{}},log:()=>{},registrationTimeoutMs:50,sleep:async()=>{await new Promise(resolve=>setTimeout(resolve,5));}}),
    error=>error.code==='SQUAD_WORKER_NOT_REGISTERED',
  );
});


test('concurrent chats cannot both reserve a write in the same working directory',{timeout:5000},async t=>{
  const squad=await makeSquad(t);
  const secondOptions={...squad.options,env:{...squad.env,CODEX_THREAD_ID:randomUUID()}};
  await bindCurrent({...secondOptions,cwd:squad.ws});
  let arrivals=0,release;
  const gate=new Promise(resolve=>{release=resolve});
  const original=squad.options.startWorker;
  const startWorker=async job=>{const receipt=await original(job);if(++arrivals===2)release();await Promise.race([gate,new Promise(resolve=>setTimeout(resolve,100))]);return receipt};
  const results=await Promise.allSettled([
    dispatch(handoff('race-first'),{...squad.options,startWorker}),
    dispatch(handoff('race-second'),{...secondOptions,startWorker}),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'SQUAD_WORKSPACE_BUSY');
});

test('dispatch refuses escaping and glob scopes before creating member work',async t=>{
  const squad=await makeSquad(t);
  const outside=join(squad.dir,'outside');await mkdir(outside,{recursive:true});
  await symlink(outside,join(squad.ws,'escaped-link'));
  const cases=[['scope-escape',['../outside/a.ts']],['scope-symlink',['escaped-link/a.ts']],['scope-glob',['src/*.ts']],['scope-empty',[]]];
  for(const [requestId,writePaths] of cases){
    await assert.rejects(dispatch(handoff(requestId,{writePaths}),squad.options),error=>error.code==='SQUAD_WRITE_PATHS_INVALID');
  }
  assert.equal(squad.jobs.length,0);
  assert.equal(squad.client.state.tasks.size,1);
});

test('continuation inherits the prior write scope and only admits a changed disjoint scope',async t=>{
  const squad=await makeSquad(t);
  const original=await dispatch(handoff('scope-inherit-first',{writePaths:['src/shared.ts']}),squad.options);
  await finish(squad,original,{nativeSessionId:'native-scope'});
  const blocker=await dispatch(handoff('scope-inherit-blocker',{writePaths:['src/shared.ts']}),squad.options);
  const storedTask=()=>squad.client.state.tasks.get(original.taskId);
  const generation=storedTask().harness.activeGeneration;
  const jobs=squad.jobs.length;
  for(const [requestId,writePaths] of [['scope-inherit-default',undefined],['scope-inherit-explicit',['src/shared.ts']]]){
    await assert.rejects(continueTask({
      taskId:original.taskId,requestId,goal:'继续',scope:['src/shared.ts'],criteria:['验证'],...(writePaths?{writePaths}:{}),
    },squad.options),error=>error.code==='SQUAD_WORKSPACE_BUSY'&&error.message.includes(blocker.taskId)&&error.message.includes('src/shared.ts'));
  }
  assert.equal(squad.jobs.length,jobs);
  assert.equal(storedTask().harness.activeGeneration,generation);
  assert.equal(storedTask().status,'in_review');

  const moved=await continueTask({
    taskId:original.taskId,requestId:'scope-inherit-moved',goal:'继续',scope:['docs/notes.md'],criteria:['验证'],writePaths:['docs/notes.md'],
  },squad.options);
  assert.equal(moved.taskId,original.taskId);
  assert.deepEqual(squad.jobs.at(-1).handoff.writePaths,['docs/notes.md']);
  let view=await snapshot(squad.binding,squad.options);
  assert.deepEqual(view.tasks.find(task=>task.id===original.taskId).attempts.at(-1).handoff.writePaths,['docs/notes.md']);
  await finish(squad,moved,{nativeSessionId:'native-scope'});
  const inherited=await continueTask({taskId:original.taskId,requestId:'scope-inherit-again',goal:'继续',scope:['docs/notes.md'],criteria:['验证']},squad.options);
  assert.equal(inherited.taskId,original.taskId);
  assert.deepEqual(squad.jobs.at(-1).handoff.writePaths,['docs/notes.md']);
  await finish(squad,inherited,{nativeSessionId:'native-scope'});
});

test('one main chat admits concurrent disjoint scopes and lets exactly one overlapping admission create work',async t=>{
  const squad=await makeSquad(t);
  const disjoint=await Promise.all([
    dispatch(handoff('same-chat-a',{writePaths:['src/a.ts']}),squad.options),
    dispatch(handoff('same-chat-b',{writePaths:['src/b.ts']}),squad.options),
  ]);
  assert.equal(disjoint.length,2);
  assert.equal(squad.jobs.length,2);
  const tasksBefore=squad.client.state.tasks.size;
  const results=await Promise.allSettled([
    dispatch(handoff('same-chat-parent',{writePaths:['src/shared']}),squad.options),
    dispatch(handoff('same-chat-child',{writePaths:['src/shared/deep.ts']}),squad.options),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected');
  assert.equal(rejected.reason.code,'SQUAD_WORKSPACE_BUSY');
  assert.equal(squad.jobs.length,3);
  assert.equal(squad.client.state.tasks.size,tasksBefore+1);
});

test('racing admissions stop at 19 active executions in one main chat',async t=>{
  const squad=await makeSquad(t);
  const results=await Promise.allSettled(Array.from({length:20},(_,index)=>
    dispatch(handoff('limit-race-'+index,{writePaths:[`src/race/${index}.ts`]}),squad.options)));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,19);
  const rejected=results.filter(result=>result.status==='rejected');
  assert.equal(rejected.length,1);
  assert.equal(rejected[0].reason.code,'SQUAD_CONCURRENCY_LIMIT');
  assert.equal(squad.jobs.length,19);
  assert.equal(squad.client.state.tasks.size,20);
});

test('worker spawn failure leaves no write reservation and records a failed attempt',async t=>{
  const squad=await makeSquad(t);
  const failing={...squad.options,startWorker:async()=>{throw Object.assign(new Error('无法创建执行进程'),{code:'SQUAD_WORKER_START_FAILED'});}};
  await assert.rejects(dispatch(handoff('start-fail',{writePaths:['src/start-fail.ts']}),failing),error=>error.code==='SQUAD_WORKER_START_FAILED');
  const task=[...squad.client.state.tasks.values()].find(item=>item.harness?.sourceRef?.endsWith(':implementer:start-fail'));
  assert.ok(task);
  assert.equal(task.status,'blocked');
  const execution=squad.client.state.executions.get(`${task.id}:1`);
  assert.ok(execution.events.some(event=>event.type==='SQUAD_ATTEMPT_COMPLETED'&&event.payload.status==='failed'&&event.payload.error.includes('无法创建执行进程')));
  assert.deepEqual(await readOccupancy(squad),[]);
  const retry=await dispatch(handoff('start-fail-retry',{writePaths:['src/start-fail.ts']}),squad.options);
  assert.equal(retry.status,'starting');
});

test('a reservation conflict after spawn terminates that worker and keeps only the foreign owner',async t=>{
  const squad=await makeSquad(t);
  const foreign={threadId:randomUUID(),taskId:'foreign-task',attemptId:'foreign-attempt',pid:4242,nonce:'foreign-nonce',startedAt:new Date().toISOString(),writePaths:['src/contested.ts']};
  const options={
    ...squad.options,
    isWorkerProcess:pid=>squad.live.has(Number(pid))||Number(pid)===foreign.pid,
    startWorker:async job=>{const receipt=await squad.options.startWorker(job);await writeOccupancy(squad,[foreign]);return receipt;},
  };
  await assert.rejects(dispatch(handoff('post-spawn-conflict',{writePaths:['src/contested.ts']}),options),
    error=>error.code==='SQUAD_WORKSPACE_BUSY'&&error.message.includes('foreign-task')&&error.message.includes('src/contested.ts'));
  const attempted=squad.jobs.at(-1);
  assert.equal(squad.live.has(squad.workerPids.get(attempted.taskId)),false);
  assert.deepEqual(await readOccupancy(squad),[foreign]);
  const task=[...squad.client.state.tasks.values()].find(item=>item.harness?.sourceRef?.endsWith(':implementer:post-spawn-conflict'));
  assert.equal(task.status,'blocked');
  await writeOccupancy(squad,[]);
  const retry=await dispatch(handoff('post-spawn-retry',{writePaths:['src/contested.ts']}),squad.options);
  assert.equal(retry.status,'starting');
});

test('worker releases its write reservation after completed and failed terminals',async t=>{
  const squad=await makeSquad(t);
  await dispatch(handoff('release-completed',{writePaths:['src/release.ts']}),squad.options);
  const completedJob=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const completed=await runWorkerJob(completedJob,squad.workerOptions({
    modules:{qoderRunner:{async runQoderAcpCommand(){return {status:'completed',text:'完成'};}},appServerRunner:{}},log:()=>{},
  }));
  assert.equal(completed.terminalApplied,true);
  assert.equal(completed.exitCode,0);
  assert.deepEqual(await readOccupancy(squad),[]);

  await dispatch(handoff('release-failed',{writePaths:['src/release.ts']}),squad.options);
  const failedJob=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  const failed=await runWorkerJob(failedJob,squad.workerOptions({
    modules:{qoderRunner:{async runQoderAcpCommand(){return {status:'failed',error:'模型拒绝执行'};}},appServerRunner:{}},log:()=>{},
  }));
  assert.equal(failed.terminalApplied,true);
  assert.equal(failed.exitCode,1);
  assert.deepEqual(await readOccupancy(squad),[]);

  const next=await dispatch(handoff('release-next',{writePaths:['src/release.ts']}),squad.options);
  assert.equal(next.status,'starting');
});

 test('parent status and content are authoritative snapshot facts and invalidate the cursor',async t=>{
 const squad=await makeSquad(t);const before=await snapshot(squad.binding,squad.options);const parent=squad.client.state.tasks.get(squad.binding.parentWorkId);parent.status='stopped';parent.title='目标已停止';parent.version++;const after=await snapshot(squad.binding,squad.options);assert.equal(after.parent.title,'目标已停止');assert.equal(after.parent.status,'stopped');assert.notEqual(before.cursor,after.cursor);
});

test('a growing public message changes the snapshot cursor before the worker completes without adding duplicate messages',async t=>{
  const squad=await makeSquad(t);const started=await dispatch(handoff('stream-cursor'),squad.options);const job=squad.jobs.at(-1);
  const recorder=createConversationRecorder(job,async(type,payload)=>{
    const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
    await appendSquadEvent(squad.client,{taskId:job.taskId,generation:job.generation,sessionId:job.sessionId,sequence:execution.highWaterSequence+1,type,attemptId:job.attemptId,payload});
  },{interval:5});
  const frame=content=>({kind:'session.assistant_message',payload:{content,persistedMessageId:'same-native-message',metadata:{streamState:'streaming'}}});
  recorder.frame(frame('正在'));await new Promise(resolve=>setTimeout(resolve,20));const before=await snapshot(squad.binding,squad.options);
  recorder.frame(frame('正在验证，尚未结束'));await new Promise(resolve=>setTimeout(resolve,20));const after=await snapshot(squad.binding,squad.options);
  assert.notEqual(before.cursor,after.cursor);assert.equal(after.tasks[0].attempts[0].endedAt,null);
  assert.equal(after.tasks[0].attempts[0].events.filter(e=>e.kind==='message').length,1);assert.equal(after.tasks[0].attempts[0].events[0].text,'正在验证，尚未结束');
  await recorder.finish('completed');await finish(squad,started);
});

const hostRecord=value=>`${JSON.stringify(value)}\n`;
const hostStarted=turnId=>hostRecord({type:'event_msg',payload:{type:'task_started',turn_id:turnId}});
const hostCompleted=turnId=>hostRecord({type:'event_msg',payload:{type:'task_complete',turn_id:turnId}});
const hostAborted=(turnId,reason='interrupted')=>hostRecord({type:'event_msg',payload:{type:'turn_aborted',turn_id:turnId,reason}});
const hostActivity=turnId=>hostRecord({type:'token_usage_record',payload:{turn_id:turnId,total_tokens:1}});
const hostOptions=(squad,rolloutPath)=>({verifyHost:async()=>({rolloutPath})});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function within(promise,ms=4000){
  let timer;
  try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('execution did not settle in time')),ms)})])}
  finally{clearTimeout(timer)}
}
async function hostRollout(squad,name,turnId){
  const file=join(squad.dir,name);
  await writeFile(file,hostStarted(turnId)+hostActivity(turnId));
  return file;
}

test('dispatch links the verified host turn and continuation relinks the new turn',async t=>{
  const squad=await makeSquad(t);
  const firstTurn=randomUUID(),secondTurn=randomUUID();
  const file=await hostRollout(squad,'host-link.jsonl',firstTurn);
  const options=taskOptions(squad,hostOptions(squad,file));
  const first=await dispatch(handoff('req-host-link'),options);
  assert.equal(first.hostTurn.state,'linked');
  assert.equal(first.hostTurn.turnId,firstTurn);
  const firstJob=squad.jobs.at(-1);
  assert.equal(firstJob.hostTurnState,'linked');
  assert.equal(firstJob.hostTurnId,firstTurn);
  assert.equal(firstJob.hostRolloutPath,file);
  assert.equal(firstJob.hostRolloutOffset,Buffer.byteLength(hostStarted(firstTurn)+hostActivity(firstTurn)));

  await finish(squad,first,{nativeSessionId:'native-link',text:'首轮完成'});
  let view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].hostTurn.state,'linked');
  assert.equal(view.tasks[0].hostTurn.turnId,firstTurn);
  assert.equal(view.tasks[0].stop,null);

  await appendFile(file,hostCompleted(firstTurn)+hostStarted(secondTurn)+hostActivity(secondTurn));
  const second=await continueTask({taskId:first.taskId,requestId:'req-host-link-2',goal:'继续本轮',scope:['src/report.ts'],criteria:['测试通过']},options);
  assert.equal(second.hostTurn.state,'linked');
  assert.equal(second.hostTurn.turnId,secondTurn);
  assert.equal(squad.jobs.at(-1).hostTurnId,secondTurn);
  assert.equal(squad.jobs.at(-1).hostRolloutOffset,firstJob.hostRolloutOffset+Buffer.byteLength(hostCompleted(firstTurn)+hostStarted(secondTurn)+hostActivity(secondTurn)));
  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].hostTurn.turnId,secondTurn);
});

test('unverified host association still allows dispatch and a manual stop is labelled as such',async t=>{
  const squad=await makeSquad(t);
  const result=await dispatch(handoff('req-host-unverified'),taskOptions(squad,{verifyHost:async()=>{throw Object.assign(new Error('未核实'),{code:'SQUAD_HOST_THREAD_UNVERIFIED'});}}));
  assert.equal(result.hostTurn.state,'unverified');
  assert.equal(result.hostTurn.turnId,null);
  const job=squad.jobs.at(-1);
  assert.equal(job.hostTurnState,'unverified');
  assert.equal(job.hostTurnId,null);
  assert.equal(job.hostRolloutPath,null);
  let view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].hostTurn.state,'unverified');
  assert.equal(view.tasks[0].stop,null);

  const pid=squad.workerPids.get(result.taskId);
  const stopped=await stopTask({taskId:result.taskId,reason:'手动停止'},taskOptions(squad,{stopTimeoutMs:2000,terminate:()=>squad.live.delete(pid)}));
  assert.equal(stopped.stopped,false);
  assert.equal(stopped.status,'unknown');
  assert.equal(stopped.stop.source,'manual');
  assert.equal(stopped.stop.association,'unverified');
  assert.equal(stopped.stop.hostTurnId,null);

  view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].stop.source,'manual');
});

test('an ended host turn without a new lifecycle stays unlinked instead of guessing',async t=>{
  const squad=await makeSquad(t);
  const ended=randomUUID();
  const file=join(squad.dir,'host-ended.jsonl');
  await writeFile(file,hostStarted(ended)+hostActivity(ended)+hostCompleted(ended)+hostActivity(ended));
  const result=await dispatch(handoff('req-host-unknown'),taskOptions(squad,hostOptions(squad,file)));
  assert.equal(result.hostTurn.state,'unknown');
  assert.equal(result.hostTurn.turnId,ended);
  assert.equal(squad.jobs.at(-1).hostTurnState,'unknown');
  assert.equal(squad.jobs.at(-1).hostRolloutPath,file);
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].hostTurn.state,'unknown');
  assert.equal(view.tasks[0].stop,null);
});

test('only the linked host turn abort stops the member and its partial results stay readable',async t=>{
  const squad=await makeSquad(t);
  const turn=randomUUID(),otherTurn=randomUUID();
  const file=await hostRollout(squad,'host-abort.jsonl',turn);
  const options=taskOptions(squad,hostOptions(squad,file));
  const result=await dispatch(handoff('req-host-abort'),options);
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  let announce;
  const runnerStarted=new Promise(resolve=>{announce=resolve;});
  const qoderRunner={
    async runQoderAcpCommand(config){
      await writeFile(join(squad.ws,'partial-result.txt'),'部分结果');
      config.onSessionEvent({sessionId:config.sessionId,kind:'session.assistant_message',payload:{content:'部分结果已写入',metadata:{streamState:'completed'},cliSessionId:'native-host'}});
      announce();
      await new Promise(resolve=>config.signal.addEventListener('abort',resolve,{once:true}));
      return {status:'interrupted',error:'宿主本轮已终止',cliSessionId:'native-host'};
    },
  };
  const controller=new AbortController();
  const running=runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},signal:controller.signal,hostWatchIntervalMs:25,abortHost:()=>controller.abort(),log:()=>{}}));
  await runnerStarted;

  await appendFile(file,hostCompleted(turn));
  await delay(120);
  assert.equal(controller.signal.aborted,false,'task_complete must not stop the member');
  await appendFile(file,hostStarted(otherTurn)+hostAborted(otherTurn,'interrupted'));
  await delay(120);
  assert.equal(controller.signal.aborted,false,'another turn abort must not stop the member');

  await appendFile(file,hostAborted(turn,'interrupted'));
  const outcome=await within(running);
  assert.equal(outcome.status,'stopped');
  assert.equal(outcome.terminalApplied,true);

  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  const requested=execution.events.find(event=>event.type==='SQUAD_STOP_REQUESTED');
  assert.equal(requested.payload.source,'host_turn_aborted');
  assert.equal(requested.payload.hostTurnId,turn);
  assert.equal(requested.payload.turnAbort.reason,'interrupted');

  const binding=await readBinding(squad.threadId,{env:squad.env});
  const worker=binding.workers[result.taskId];
  assert.equal(worker.stopSource,'host_turn_aborted');
  assert.equal(worker.hostTurnId,turn);
  assert.equal(worker.turnAbort.reason,'interrupted');
  assert.equal(worker.hostTurn.state,'linked');

  const view=await snapshot(squad.binding,squad.options);
  const task=view.tasks[0],attempt=task.attempts[0];
  assert.equal(task.status,'stopped');
  assert.equal(task.stop.source,'host_turn_aborted');
  assert.equal(task.stop.hostTurnId,turn);
  assert.equal(task.stop.association,'linked');
  assert.equal(task.stop.terminal,'stopped');
  assert.equal(task.hostTurn.turnId,turn);
  assert.equal(attempt.status,'stopped');
  assert.ok(attempt.events.some(event=>event.kind==='message'&&event.text==='部分结果已写入'));
  assert.equal(await readFile(join(squad.ws,'partial-result.txt'),'utf8'),'部分结果');
});

test('a host abort followed by large logs is caught from the dispatch offset before the runner settles',async t=>{
  const squad=await makeSquad(t);
  const turn=randomUUID();
  const file=await hostRollout(squad,'host-abort-catchup.jsonl',turn);
  const result=await dispatch(handoff('req-host-catchup'),taskOptions(squad,hostOptions(squad,file)));
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  assert.equal(Number.isSafeInteger(job.hostRolloutOffset),true);
  const logs=Array.from({length:140},(_,index)=>hostRecord({type:'event_msg',payload:{type:'agent_message',turn_id:turn,message:`${index}:${'x'.repeat(2048)}`}})).join('');
  assert.ok(Buffer.byteLength(logs)>280*1024);
  await appendFile(file,hostAborted(turn,'interrupted')+logs);
  const qoderRunner={runQoderAcpCommand(config){return new Promise(resolve=>config.signal.addEventListener('abort',()=>resolve({status:'interrupted',error:'宿主中断'}),{once:true}))}};
  const controller=new AbortController();
  const outcome=await within(runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},signal:controller.signal,hostWatchIntervalMs:25,hostWatchOptions:{maxBytesPerPoll:2048},abortHost:()=>controller.abort(),log:()=>{}})));
  assert.equal(outcome.status,'stopped');
  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  const requested=execution.events.find(event=>event.type==='SQUAD_STOP_REQUESTED');
  assert.equal(requested.payload.source,'host_turn_aborted');
  assert.equal(requested.payload.hostTurnId,turn);
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].status,'stopped');
  assert.equal(view.tasks[0].stop.source,'host_turn_aborted');
  assert.equal(view.tasks[0].stop.terminal,'stopped');
  assert.equal(result.hostTurn.state,'linked');
});

test('a normal host turn completion never stops the running member',async t=>{
  const squad=await makeSquad(t);
  const turn=randomUUID();
  const file=await hostRollout(squad,'host-complete.jsonl',turn);
  const result=await dispatch(handoff('req-host-complete'),taskOptions(squad,hostOptions(squad,file)));
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  let announce,finish;
  const runnerStarted=new Promise(resolve=>{announce=resolve;});
  const qoderRunner={runQoderAcpCommand(){return new Promise(resolve=>{announce();finish=()=>resolve({status:'completed',text:'正常完成',cliSessionId:'native-normal'});})}};
  const controller=new AbortController();
  const running=runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},signal:controller.signal,hostWatchIntervalMs:25,abortHost:()=>controller.abort()}));
  await runnerStarted;
  await appendFile(file,hostCompleted(turn));
  await delay(150);
  assert.equal(controller.signal.aborted,false);
  finish();
  const outcome=await within(running);
  assert.equal(outcome.status,'completed');

  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  assert.equal(execution.events.some(event=>event.type==='SQUAD_STOP_REQUESTED'),false);
  const binding=await readBinding(squad.threadId,{env:squad.env});
  assert.equal(binding.workers[result.taskId].stopRequestedAt,undefined);
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].status,'waiting_review');
  assert.equal(view.tasks[0].stop,null);
  assert.equal(view.tasks[0].hostTurn.state,'linked');
});

test('an unreadable host rollout reports an unconfirmed watch instead of a fabricated stop',async t=>{
  const squad=await makeSquad(t);
  const turn=randomUUID();
  const file=await hostRollout(squad,'host-vanish.jsonl',turn);
  const result=await dispatch(handoff('req-host-vanish'),taskOptions(squad,hostOptions(squad,file)));
  const job=validateJob(squad.jobs.at(-1),squad.jobs.at(-1).nonce);
  await rm(file);
  const qoderRunner={async runQoderAcpCommand(){await delay(300);return {status:'completed',text:'完成'};}};
  const controller=new AbortController();
  const outcome=await within(runWorkerJob(job,squad.workerOptions({modules:{qoderRunner,appServerRunner:{}},signal:controller.signal,hostWatchIntervalMs:25,abortHost:()=>controller.abort(),log:()=>{}})));
  assert.equal(outcome.status,'completed');
  assert.equal(controller.signal.aborted,false);

  const binding=await readBinding(squad.threadId,{env:squad.env});
  assert.equal(binding.workers[result.taskId].hostWatch.state,'unconfirmed');
  const execution=squad.client.state.executions.get(`${job.taskId}:${job.generation}`);
  assert.equal(execution.events.some(event=>event.type==='SQUAD_STOP_REQUESTED'),false);
  const view=await snapshot(squad.binding,squad.options);
  assert.equal(view.tasks[0].hostTurn.watch.state,'unconfirmed');
  assert.equal(view.tasks[0].stop,null);
});
