import {createHash} from 'node:crypto';
import {inspectAcceptance} from './evidence.mjs';
import {projectConversation,createConversationProjection} from './conversation.mjs';
import {dialogue,deliveryFromEvents,processOf,publicSafeText} from './presentation.mjs';
import {
  attemptDiagnostic,attemptView,acceptanceFrom,membersView,
  normalizeUsage,memberFromTask,ownedTask,readExecutionDelta,readExecutionDigest,refFromEvents,
  taskStatusView,usageView,verifyParent,workerAlive,stopView,
} from './runtime.mjs';
import {boardVisible,inboxOf} from './task-lifecycle.mjs';

const MESSAGE_LIMIT=20;
const MESSAGE_LIMIT_MAX=50;
const PROCESS_LIMIT=30;
const PROCESS_LIMIT_MAX=100;
const MESSAGE_TEXT_LIMIT=12000;
const PROCESS_TEXT_LIMIT=4096;
const PAGE_BUDGET=64*1024;
const PROCESS_PAGE_BUDGET=64*1024;
const CHANGE_LOG_LIMIT=512;
function safeGoal(value,limit){const goal=publicSafeText(String(value||'')).trim();return goal?goal.slice(0,limit):null}
const TOOL_KINDS=new Set(['tool','tool_use','tool_result']);

function protocolError(code,message,status=400){return Object.assign(new Error(message),{code,status});}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function digest(value){return createHash('sha256').update(String(value)).digest('hex');}
function textHash(value){return createHash('sha256').update(String(value??'')).digest('base64url');}
function nowIso(now){return new Date(now()).toISOString();}
function clampInteger(raw,field,{min=1,max=Number.MAX_SAFE_INTEGER,fallback=null}={}){
  if(raw===null||raw===undefined||raw==='')return fallback;
  if(!/^\d+$/.test(String(raw)))throw protocolError('PARAM_INVALID',`${field} 必须是整数。`);
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw protocolError('PARAM_INVALID',`${field} 超出允许范围。`);
  return value;
}
function encodeCursor(taskId,kind,id){
  return Buffer.from(JSON.stringify({v:1,t:taskId,k:kind,b:id}),'utf8').toString('base64url');
}
function decodeCursor(raw,taskId,kind){
  let value;
  try{value=JSON.parse(Buffer.from(String(raw),'base64url').toString('utf8'));}catch{value=null}
  if(!isRecord(value)||value.v!==1||value.t!==taskId||value.k!==kind||typeof value.b!=='string'||!value.b){
    throw protocolError('CURSOR_INVALID','分页游标无效或与当前任务不一致。');
  }
  return value.b;
}
function normalizeRefs(value){
  return (Array.isArray(value)?value:[]).filter(ref=>ref&&ref.attemptId&&Number.isSafeInteger(Number(ref.generation)))
    .map(ref=>({...ref,generation:Number(ref.generation),index:Number(ref.index)||Number(ref.generation)}));
}
function normalizeLegacyEvent(event){
  const payload=isRecord(event?.payload)?event.payload:{};
  return {
    id:String(payload.eventId||event?.eventId||''),time:payload.time||event?.occurredAt,
    kind:String(payload.kind||'event'),...(payload.role?{role:String(payload.role)}:{}),
    text:String(payload.text||''),...(payload.revision!==undefined?{revision:payload.revision}:{}),
    ...(payload.status?{status:String(payload.status)}:{}),...(payload.result?{result:String(payload.result)}:{}),
    ...(payload.updatedAt?{updatedAt:String(payload.updatedAt)}:{}),...(payload.toolName?{toolName:String(payload.toolName)}:{}),
  };
}
function publicActivity(event){
  if(!isRecord(event))return null;
  if(event.schemaVersion==='agent-bridge.conversation/v1')return projectConversation([{payload:{events:[event]}}])[0]||null;
  if(event.type==='SQUAD_ATTEMPT_EVENT'){
    const value=normalizeLegacyEvent(event);
    return value.kind==='tool'||value.kind==='tool_use'||value.kind==='tool_result'||value.kind==='progress'?value:null;
  }
  return null;
}
function latestDigestActivity(digest){
  return digest?.latestActivity?publicActivity(digest.latestActivity.event):null;
}
function compactAttempt(ref,digest,task,worker,alive,latest){
  const events=(digest?.events||[]).map(row=>row.event);
  const started=events.find(event=>event?.type==='SQUAD_ATTEMPT_STARTED');
  const completed=[...events].reverse().find(event=>event?.type==='SQUAD_ATTEMPT_COMPLETED');
  const sessionEvent=[...events].reverse().find(event=>event?.type==='SQUAD_ATTEMPT_SESSION');
  const usageEvent=[...events].reverse().find(event=>event?.type==='SQUAD_USAGE_REPORTED');
  let status='unknown';
  if(completed){
    const reported=String(completed.payload?.status||'').toLowerCase();
    status=['completed','failed','stopped','interrupted'].includes(reported)?reported:'unknown';
  }else if(latest&&task.status==='in_progress'&&alive&&worker){
    status=worker.stopRequestedAt?'stopping':sessionEvent||ref.nativeSessionId?'running':'starting';
  }
  const activity=latestDigestActivity(digest);
  const endedAt=completed?.payload?.endedAt||completed?.occurredAt||null;
  return {
    id:ref.attemptId,index:ref.index,status,
    startedAt:started?.occurredAt||ref.startedAt||null,
    endedAt,
    sessionId:completed?.payload?.nativeSessionId||sessionEvent?.payload?.sessionId||ref.nativeSessionId||null,
    usage:normalizeUsage(completed?.payload?.usage)||normalizeUsage(usageEvent?.payload?.usage)||null,
    handoff:started?.payload?.handoff?{goal:safeGoal(started.payload.handoff.goal,4000)}:null,
    delivery:deliveryFromEvents(events,{status,endedAt,activeAttempt:Boolean(latest&&task.status==='in_progress')}),
    events:activity?[{...activity,text:String(activity.text||'').slice(0,4096),result:''}]:[],
  };
}
function messageSignature(item){
  const handoff=item.handoff?JSON.stringify({kind:item.handoff.kind,attemptIndex:item.handoff.attemptIndex,attemptId:item.handoff.attemptId,state:item.handoff.delivery?.state,terminal:item.handoff.delivery?.terminal,submittedAt:item.handoff.delivery?.submittedAt,respondedAt:item.handoff.delivery?.respondedAt}):'';
  return `${item.kind||'message'}|${item.role||''}|${item.time||''}|${handoff}|${textHash(item.text)}`;
}
function processSignature(item){
  return `${item.kind||''}|${item.toolName||''}|${item.status||''}|${item.time||''}|${item.updatedAt||''}|${textHash(item.text)}|${textHash(item.result)}`;
}
function createStream(signatureOf){
  return {items:[],revision:0,log:[],logFrom:1,revisions:new Map(),signatures:new Map(),signatureOf};
}
function reconcileStream(stream,next){
  const previous=stream.signatures,nextSignatures=new Map(),seen=new Set();
  for(const item of next){
    seen.add(item.id);
    const signature=stream.signatureOf(item);
    nextSignatures.set(item.id,signature);
    const old=previous.get(item.id);
    if(old===undefined||old!==signature){
      const revision=++stream.revision;
      stream.revisions.set(item.id,revision);
      stream.log.push({revision,id:item.id,removed:false});
    }
  }
  for(const id of previous.keys()){
    if(seen.has(id))continue;
    const revision=++stream.revision;
    stream.revisions.set(id,revision);
    stream.log.push({revision,id,removed:true});
  }
  if(stream.log.length>CHANGE_LOG_LIMIT)stream.log=stream.log.slice(-CHANGE_LOG_LIMIT);
  stream.logFrom=stream.log.length?stream.log[0].revision:stream.revision+1;
  stream.items=next;
  stream.signatures=nextSignatures;
}
function itemRevision(stream,id){return stream.revisions.get(id)||0;}
function segmentsOf(value,limit=MESSAGE_TEXT_LIMIT){
  const text=String(value??''),segments=[];let from=0,fence='';
  do{
    let end=Math.min(text.length,from+limit);
    if(end<text.length){const boundary=text.lastIndexOf('\n',end);if(boundary>from+limit/2)end=boundary+1;}
    const part=text.slice(from,end),before=fence;
    for(const line of part.split('\n')){const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);if(match){if(!fence)fence=match[1]+match[2];else if(match[1][0]===fence[0])fence='';}}
    segments.push({from,to:end,fence:before,hash:textHash(part)});from=end;
  }while(from<text.length);
  return segments;
}
function chunked(value,limit){const text=String(value??'');return {text:text.slice(0,limit),textOffset:0,textTotal:text.length,textComplete:text.length<=limit};}
function messageItem(stream,item){
  const segments=item.segments||(item.segments=segmentsOf(item.text)),last=segments.at(-1);
  return {id:item.id,kind:item.kind||'message',role:item.role||'assistant',time:item.time||null,
    ...(item.kind==='handoff'&&item.handoff?{handoff:item.handoff}:{}),
    revision:itemRevision(stream,item.id),text:String(item.text).slice(last.from,last.to),textOffset:last.from,textTotal:item.text.length,textComplete:segments.length===1,segments};
}
function processItem(stream,item){
  return {id:item.id,kind:item.kind,role:'tool',toolName:item.toolName||'',time:item.time||null,
    updatedAt:item.updatedAt||null,status:item.status||'',revision:itemRevision(stream,item.id),
    ...chunked(item.text,PROCESS_TEXT_LIMIT)};
}
function pageOf(stream,before,limit,budget,shape,newer=false){
  const items=stream.items;let edge=items.length;
  if(before){edge=items.findIndex(item=>item.id===before);if(edge<0)throw protocolError('CURSOR_INVALID','分页游标指向的消息已不存在。');}
  const page=[];let bytes=0,start,end;
  if(newer){start=edge+1;end=start;
    while(end<items.length&&page.length<limit){const item=shape(items[end]),size=byteSize(item);if(page.length&&bytes+size>budget)break;page.push(item);bytes+=size;end++;}
  }else{end=edge;start=end;
    while(start>0&&page.length<limit){const item=shape(items[start-1]),size=byteSize(item);if(page.length&&bytes+size>budget)break;page.unshift(item);bytes+=size;start--;}
  }
  return {revision:stream.revision,items:page,before:start>0&&page.length?encodeCursor(stream.taskId,stream.kind,page[0].id):null,hasMore:start>0,hasNewer:end<items.length,newer:page.length?encodeCursor(stream.taskId,stream.kind,page.at(-1).id):null,reset:false,removed:[]};
}

function changesOf(stream,after){
  if(after>stream.revision||after<stream.logFrom-1){
    return {revision:stream.revision,items:[],before:null,hasMore:false,reset:true,removed:[]};
  }
  const ids=new Set();
  for(const entry of stream.log)if(entry.revision>after)ids.add(entry.id);
  if(ids.size>MESSAGE_LIMIT_MAX)return {revision:stream.revision,items:[],removed:[],reset:true};
  const present=new Map(stream.items.map(item=>[item.id,item]));
  const items=stream.items.filter(item=>ids.has(item.id)).map(item=>stream.kind==='message'?messageItem(stream,item):processItem(stream,item));
  if(byteSize(items)>PAGE_BUDGET)return {revision:stream.revision,items:[],removed:[],reset:true};
  const removed=[...ids].filter(id=>!present.has(id));
  return {revision:stream.revision,items,removed,reset:false};
}
function byteSize(value){return Buffer.byteLength(JSON.stringify(value),'utf8');}
function remember(map,key,value,maxEntries,maxBytes){
  map.delete(key);map.set(key,value);
  while(map.size>maxEntries)map.delete(map.keys().next().value);
  let total=0;
  for(const entry of map.values())total+=entry.bytes||0;
  while(map.size>1&&total>maxBytes){
    const oldest=map.keys().next().value;
    total-=map.get(oldest)?.bytes||0;
    map.delete(oldest);
  }
}

export function createViewerData(options={}){
  const now=options.now||Date.now;
  const acceptanceTtlMs=Number.isFinite(options.acceptanceTtlMs)?options.acceptanceTtlMs:1000;
  const detailEntries=Math.max(1,Number(options.detailEntries)||6);
  const detailBytes=Math.max(1024*1024,Number(options.detailBytes)||32*1024*1024);
  const boardEntries=Math.max(1,Number(options.boardEntries)||64);
  const boardBytes=Math.max(256*1024,Number(options.boardBytes)||4*1024*1024);
  const boardTtlMs=Number.isFinite(options.boardTtlMs)?options.boardTtlMs:1200;
  const clientFor=options.client?async()=>options.client:options.loadClient;
  if(typeof clientFor!=='function')throw new Error('viewer data requires a client loader');
  const acceptanceCache=new Map();
  const boardCache=new Map();
  const detailCache=new Map();

  function storeKey(client){return `${client.home||''}\u0000${client.databasePath||''}`}
  function scopeKey(client,binding,suffix){return `${storeKey(client)}\u0000${binding.threadId}\u0000${binding.workspace}\u0000${binding.parentWorkId}\u0000${binding.title}\u0000${suffix}`}
  async function acceptanceView(workspace,acceptance){
    if(!acceptance)return null;
    const key=`${workspace}\u0000${JSON.stringify(acceptance)}`;
    const hit=acceptanceCache.get(key);
    if(hit&&now()-hit.at<acceptanceTtlMs)return hit.value;
    const value=await inspectAcceptance(workspace,acceptance);
    acceptanceCache.set(key,{at:now(),value});
    if(acceptanceCache.size>256)acceptanceCache.delete(acceptanceCache.keys().next().value);
    return value;
  }

  async function board(binding){
    const client=await clientFor(binding),key=scopeKey(client,binding,'board');
    const hit=boardCache.get(key);
    if(hit&&now()-hit.at<boardTtlMs)return hit.value;
    const parent=await verifyParent(binding,client);
    const tasks=[],cursorParts=[];
    for(const taskId of binding.tasks){
      const task=await ownedTask(binding,taskId,client);
      const owner=memberFromTask(binding,task).member;
      const maxGeneration=Math.max(0,Math.min(Number(task.harness?.activeGeneration||0),100));
      const known=normalizeRefs(binding.attempts?.[taskId]),byGeneration=new Map();
      for(const ref of known)byGeneration.set(ref.generation,ref);
      const generations=[];
      for(let generation=1;generation<=maxGeneration;generation+=1)generations.push(generation);
      for(const ref of known)if(!generations.includes(ref.generation))generations.push(ref.generation);
      generations.sort((left,right)=>left-right);
      const digests=new Map();
      for(const generation of generations){
        const value=await readExecutionDigest(client,task.id,generation);
        digests.set(generation,value);
        if(!byGeneration.has(generation)){
          const recovered=refFromEvents((value.events||[]).map(row=>row.event),generation);
          if(recovered)byGeneration.set(generation,recovered);
        }
      }
      const refs=[...byGeneration.values()].sort((left,right)=>left.index-right.index||left.generation-right.generation);
      const worker=binding.workers?.[taskId]||refs.at(-1)?.worker||null;
      const alive=worker?await workerAlive(worker):false;
      const attempts=refs.map((ref,index)=>compactAttempt(ref,digests.get(ref.generation),task,worker,alive,index===refs.length-1));
      for(let index=0;index<attempts.length;index+=1){
        const attempt=attempts[index],ref=refs[index],current=digests.get(ref.generation);
        const rawAcceptance=acceptanceFrom(current?{events:(current.events||[]).map(row=>row.event)}:null);
        attempt.acceptance=rawAcceptance&&rawAcceptance.attemptId===attempt.id?await acceptanceView(binding.workspace,rawAcceptance):null;
        attempt.verification=binding.reviews?.[taskId]?.[attempt.id]||null;
      }
      const latest=attempts.at(-1);
      const acceptance=latest?.acceptance||null;
      const verification=latest?.verification||null;
      const retirement=binding.retirements?.[taskId]||null;
      const stop=stopView(worker,latest?.status||null);
      tasks.push({
        id:task.id,title:String(task.title||''),memberId:owner.id,
        status:taskStatusView(task,attempts,worker,alive),sessionId:latest?.sessionId||null,
        currentRound:latest?.index??null,currentGoal:safeGoal(latest?.handoff?.goal,4000),
        reason:String(task.harness?.blocker?.summary||task.harness?.blocker?.title||'')||null,
        attempts,acceptance,verification,retirement,stop,
      });
      cursorParts.push({id:task.id,version:Number(task.version||0),status:task.status,acceptance,verification,retirement,stop,
        attempts:attempts.map(attempt=>({id:attempt.id,status:attempt.status,endedAt:attempt.endedAt,usage:attempt.usage,activity:attempt.events.at(-1)?.id||null,
          acceptance:attempt.acceptance?.fingerprint||null,verification:attempt.verification?.at||null})),
        worker:worker?{pid:worker.pid,stopRequestedAt:worker.stopRequestedAt||null,exitedAt:worker.exitedAt||null}:null});
    }
    const value={
      schemaVersion:1,connected:true,observedAt:nowIso(now),
      binding:{threadId:binding.threadId,workspace:binding.workspace,projectId:binding.projectId,parentWorkId:binding.parentWorkId,title:binding.title},
      parent:{id:parent.id,title:String(parent.title||''),description:String(parent.description||''),status:String(parent.status||'unknown')},
      members:membersView(tasks),tasks,usage:usageView(tasks),inbox:inboxOf(tasks),
      cursor:digest(JSON.stringify({title:binding.title,updatedAt:binding.updatedAt,cursorParts})),
    };
    remember(boardCache,key,{at:now(),value,bytes:byteSize(value)},boardEntries,boardBytes);
    return value;
  }

  function emptyEntry(key,taskId){
    return {
      key,taskId,generations:new Map(),refs:[],attempts:[],task:null,taskVersion:null,taskStatus:null,
      messageStream:createStream(messageSignature),processStream:createStream(processSignature),
      acceptance:null,cursor:'',bytes:0,changed:true,
    };
  }

  async function refreshEntry(entry,binding,task,client){
    const maxGeneration=Math.max(0,Math.min(Number(task.harness?.activeGeneration||0),100));
    const known=normalizeRefs(binding.attempts?.[task.id]);
    const byGeneration=new Map();
    for(const ref of known)byGeneration.set(ref.generation,ref);
    const generations=new Set();
    for(let generation=1;generation<=maxGeneration;generation+=1)generations.add(generation);
    for(const ref of known)generations.add(ref.generation);
    const nextGenerations=new Map();
    let changed=false;
    for(const generation of [...generations].sort((left,right)=>left-right)){
      const current=entry.generations.get(generation);
      let digest;
      try{digest=current?await client.operate('work.execution.watermark',{workId:task.id,generation}):await readExecutionDigest(client,task.id,generation);}
      catch(error){
        if(error?.code!=='EXECUTION_GENERATION_STALE')throw error;
        continue;
      }
      if(!byGeneration.has(generation)){
        const recovered=current?entry.refs.find(ref=>ref.generation===generation):refFromEvents((digest.events||[]).map(row=>row.event),generation);
        if(recovered)byGeneration.set(generation,recovered);
      }
      let state=current;
      const reset=!current||digest.highWaterSequence<current.highWaterSequence;
      if(reset)state={events:[],metadata:new Map(),legacy:new Map(),projection:createConversationProjection(),highWaterSequence:0};
      if(reset||digest.highWaterSequence>state.highWaterSequence){
        const delta=await readExecutionDelta(client,task.id,generation,state.highWaterSequence);
        state.projection.push(delta.events||[]);
        for(const event of delta.events||[]){
          if(['SQUAD_ATTEMPT_STARTED','SQUAD_ATTEMPT_COMPLETED','SQUAD_ATTEMPT_SESSION','SQUAD_PROMPT_SUBMITTED','SQUAD_USAGE_REPORTED','SQUAD_ACCEPTANCE'].includes(event.type)){
            if(event.type!=='SQUAD_ATTEMPT_STARTED'||!state.metadata.has(event.type))state.metadata.set(event.type,event);
          }else if(event.type==='SQUAD_ATTEMPT_EVENT'){
            const item=normalizeLegacyEvent(event),old=state.legacy.get(item.id);
            if(!old||Number(item.revision||0)>=Number(old.revision||0))state.legacy.set(item.id,item);
          }
        }
        state.events=[...state.metadata.values()];state.highWaterSequence=Number(delta.highWaterSequence||0);changed=true;
      }
      state.activeSessionId=digest.activeSessionId||state.activeSessionId||null;
      nextGenerations.set(generation,state);
    }
    const refs=[...byGeneration.values()].sort((left,right)=>left.index-right.index||left.generation-right.generation);
    const refsChanged=JSON.stringify(refs.map(ref=>[ref.attemptId,ref.generation,ref.index]))!==JSON.stringify(entry.refs.map(ref=>[ref.attemptId,ref.generation,ref.index]));
    const taskChanged=entry.taskVersion!==Number(task.version||0)||entry.taskStatus!==String(task.status||'');
    entry.generations=nextGenerations;
    entry.refs=refs;
    entry.taskVersion=Number(task.version||0);
    entry.taskStatus=String(task.status||'');
    if(changed||refsChanged||taskChanged||!entry.task||entry.attempts.length!==refs.length)entry.changed=true;
  }

  async function projectEntry(entry,binding,task){
    if(!entry.task||entry.changed){
      const worker=binding.workers?.[task.id]||entry.refs.at(-1)?.worker||null;
      const alive=worker?await workerAlive(worker):false;
      const attempts=entry.refs.map((ref,index)=>attemptView(ref,entry.generations.get(ref.generation),task,
        memberFromTask(binding,task).member,
        worker,alive,index===entry.refs.length-1,{allEvents:true,publicEvents:[...entry.generations.get(ref.generation).legacy.values(),...entry.generations.get(ref.generation).projection.items()]}));
      entry.attempts=attempts;
      entry.task=task;
      entry.changed=false;
      const messages=dialogue({attempts:entry.attempts}),process=processOf({attempts:entry.attempts});
      reconcileStream(entry.messageStream,messages);reconcileStream(entry.processStream,process);
      entry.bytes=Buffer.byteLength(JSON.stringify(entry.attempts));
    }
    const latest=entry.attempts.at(-1);
    const ownedMember=memberFromTask(binding,task).member;
    for(let index=0;index<entry.attempts.length;index+=1){
      const attempt=entry.attempts[index],ref=entry.refs[index];
      const rawAcceptance=acceptanceFrom(entry.generations.get(ref.generation));
      attempt.acceptance=rawAcceptance&&rawAcceptance.attemptId===attempt.id
        ?await acceptanceView(binding.workspace,rawAcceptance):null;
      attempt.verification=binding.reviews?.[task.id]?.[attempt.id]||null;
    }
    if(latest){
      const diagnostic=await attemptDiagnostic(binding,ownedMember,latest);
      if(diagnostic)latest.diagnostic=diagnostic;
    }
    entry.acceptance=latest?.acceptance||null;
    entry.verification=latest?.verification||null;
    entry.retirement=binding.retirements?.[task.id]||null;
    const worker=binding.workers?.[task.id]||entry.refs.at(-1)?.worker||null;
    const alive=worker?await workerAlive(worker):false;
    entry.stop=stopView(worker,latest?.status||null);
    entry.status=taskStatusView(task,entry.attempts,worker,alive);
    if(latest&&!latest.endedAt&&['running','starting','stopping','unknown'].includes(entry.status))latest.status=entry.status;
    entry.sessionId=entry.attempts.at(-1)?.sessionId||null;
    entry.reason=String(task.harness?.blocker?.summary||task.harness?.blocker?.title||'')||null;
    entry.cursor=digest(JSON.stringify({id:task.id,version:Number(task.version||0),status:task.status,
      generations:entry.refs.map(ref=>[ref.attemptId,ref.generation,entry.generations.get(ref.generation)?.highWaterSequence]),
      messages:entry.messageStream.revision,process:entry.processStream.revision,
      acceptance:entry.acceptance,verification:entry.verification,retirement:entry.retirement,stop:entry.stop}));

  }

  function compactTask(entry){
    const latestProcessEvent=attempt=>{
      const events=(attempt.events||[]).filter(event=>TOOL_KINDS.has(event.kind)||event.kind==='progress');
      return events.at(-1)||null;
    };
    const latest=entry.attempts.at(-1);
    return {
      id:entry.task.id,title:String(entry.task.title||''),memberId:entry.memberId,
      status:entry.status,sessionId:entry.sessionId,reason:entry.reason,
      currentRound:latest?.index??null,
      currentGoal:safeGoal(latest?.handoff?.goal,4000),
      attempts:entry.attempts.map((attempt,index)=>({
        id:attempt.id,index:attempt.index,status:attempt.status,startedAt:attempt.startedAt,
        endedAt:attempt.endedAt,sessionId:attempt.sessionId,usage:attempt.usage,
        handoff:index===0&&attempt.handoff?{goal:safeGoal(attempt.handoff.goal,4000)}:null,
        delivery:attempt.delivery||null,
        error:typeof attempt.error==='string'?attempt.error.slice(0,4000):null,
        acceptance:attempt.acceptance||null,verification:attempt.verification||null,
        ...(attempt.diagnostic?{diagnostic:attempt.diagnostic}:{}),
        events:index===entry.attempts.length-1&&latestProcessEvent(attempt)?[{...latestProcessEvent(attempt),text:String(latestProcessEvent(attempt).text||'').slice(0,4096),result:''}]:[],
      })),
      acceptance:entry.acceptance,verification:entry.verification,retirement:entry.retirement,stop:entry.stop,
    };
  }

  async function task(binding,params=new URLSearchParams()){
    const client=await clientFor(binding);
    const allowed=new Set(['id','limit','before','newer','after','processLimit','processBefore','processNewer','processAfter','item','offset']);
    for(const key of params.keys())if(!allowed.has(key))throw protocolError('PARAM_UNKNOWN',`不支持的任务参数：${key}`);
    const taskId=String(params.get('id')||'').trim();
    if(!taskId||taskId.length>200)throw protocolError('TASK_ID_INVALID','任务标识无效。');
    if(!binding.tasks.includes(taskId))throw protocolError('TASK_SCOPE_MISMATCH','该任务不属于当前会话。');
    const hasItem=params.has('item');
    const limit=clampInteger(params.get('limit'),'limit',{min:1,max:MESSAGE_LIMIT_MAX,fallback:MESSAGE_LIMIT});
    const processLimit=clampInteger(params.get('processLimit'),'processLimit',{min:1,max:PROCESS_LIMIT_MAX,fallback:PROCESS_LIMIT});
    const after=clampInteger(params.get('after'),'after',{min:0,max:Number.MAX_SAFE_INTEGER,fallback:null});
    const processAfter=clampInteger(params.get('processAfter'),'processAfter',{min:0,max:Number.MAX_SAFE_INTEGER,fallback:null});
    const from=clampInteger(params.get('offset'),'offset',{min:0,max:1000000000,fallback:null});
    if(params.has('before')&&params.has('newer'))throw protocolError('PARAM_CONFLICT','不能同时向前和向后分页。');
    if(from!==null&&!hasItem)throw protocolError('PARAM_CONFLICT','分段位置必须指定消息。');
    if(params.has('processBefore')&&params.has('processNewer'))throw protocolError('PARAM_CONFLICT','不能同时向前和向后读取过程。');
    if(hasItem&&(after!==null||params.has('before')||processAfter!==null||params.has('processBefore')||params.has('processLimit'))){
      throw protocolError('PARAM_CONFLICT','分段读取不能与其他分页参数同时使用。');
    }
    if(after!==null&&(params.has('before')||params.has('newer')))throw protocolError('PARAM_CONFLICT','增量读取不能同时指定历史游标。');
    if(processAfter!==null&&params.has('processBefore'))throw protocolError('PARAM_CONFLICT','执行过程增量读取不能同时指定历史游标。');

    const parent=await verifyParent(binding,client);
    const cachedBoard=boardCache.get(scopeKey(client,binding,'board'))?.value;
    const boardData=cachedBoard||{binding:{threadId:binding.threadId,workspace:binding.workspace,projectId:binding.projectId,parentWorkId:binding.parentWorkId,title:binding.title},parent,members:[],usage:usageView([])};
    const taskIdIndex=binding.tasks.indexOf(taskId);
    const owned=await ownedTask(binding,taskId,client);
    const key=scopeKey(client,binding,`task:${taskId}`);
    let entry=detailCache.get(key);
    if(!entry){entry=emptyEntry(key,taskId);detailCache.set(key,entry);entry.changed=true;}
    else{detailCache.delete(key);detailCache.set(key,entry);}
    entry.memberId=memberFromTask(binding,owned).member.id;
    for(const [kind,stream]of [['message',entry.messageStream],['process',entry.processStream]]){stream.taskId=taskId;stream.kind=kind}
    await refreshEntry(entry,binding,owned,client);
    await projectEntry(entry,binding,owned);

    if(hasItem){
      const itemId=String(params.get('item')||'').trim();
      if(!itemId||itemId.length>400)throw protocolError('ITEM_INVALID','消息标识无效。');
      if(from===null)throw protocolError('FROM_REQUIRED','分段读取需要提供起始位置。');
      const message=entry.messageStream.items.find(item=>item.id===itemId);
      const process=entry.processStream.items.find(item=>item.id===itemId);
      const source=message||process;
      if(!source)throw protocolError('ITEM_NOT_FOUND','该消息已不在当前任务记录中。');
      const total=String(source.text||'').length;
      if(from>total)throw protocolError('FROM_INVALID','分段起始位置超出消息长度。');
      const segments=message?(message.segments||(message.segments=segmentsOf(source.text))):segmentsOf(source.text,PROCESS_TEXT_LIMIT);
      const segment=segments.find(item=>item.from===from);
      if(!segment)throw protocolError('FROM_INVALID','分段位置不是消息边界。');
      const stream=message?entry.messageStream:entry.processStream;
      return {schemaVersion:1,taskId,chunk:{id:itemId,kind:source.kind||'message',role:source.role||'assistant',
        ...(source.kind==='handoff'&&source.handoff?{handoff:source.handoff}:{}),
        from,next:segment.to,total,done:segment.to>=total,text:String(source.text||'').slice(from,segment.to),
        fence:segment.fence,revision:itemRevision(stream,itemId)}};
    }

    const conversation=after!==null
      ?changesOf(entry.messageStream,after)
      :params.has('newer')?pageOf(entry.messageStream,decodeCursor(params.get('newer'),taskId,'message'),limit,PAGE_BUDGET,item=>messageItem(entry.messageStream,item),true)
      :params.has('before')
        ?pageOf(entry.messageStream,decodeCursor(params.get('before'),taskId,'message'),limit,PAGE_BUDGET,item=>messageItem(entry.messageStream,item))
        :pageOf(entry.messageStream,null,limit,PAGE_BUDGET,item=>messageItem(entry.messageStream,item));
    if(conversation.reset&&after!==null){
      Object.assign(conversation,pageOf(entry.messageStream,null,limit,PAGE_BUDGET,item=>messageItem(entry.messageStream,item)),{reset:true});
    }

    let process={revision:entry.processStream.revision,count:entry.processStream.items.length};
    if(processAfter!==null){
      process={...changesOf(entry.processStream,processAfter),count:entry.processStream.items.length};
      if(process.reset)Object.assign(process,pageOf(entry.processStream,null,processLimit,PROCESS_PAGE_BUDGET,item=>processItem(entry.processStream,item)),{reset:true});
    }else if(params.has('processNewer')){
      process={...pageOf(entry.processStream,decodeCursor(params.get('processNewer'),taskId,'process'),processLimit,PROCESS_PAGE_BUDGET,item=>processItem(entry.processStream,item),true),count:entry.processStream.items.length};
    }else if(params.has('processBefore')){
      process={...pageOf(entry.processStream,decodeCursor(params.get('processBefore'),taskId,'process'),processLimit,PROCESS_PAGE_BUDGET,item=>processItem(entry.processStream,item)),count:entry.processStream.items.length};
    }else if(params.has('processLimit')){
      process={...pageOf(entry.processStream,null,processLimit,PROCESS_PAGE_BUDGET,item=>processItem(entry.processStream,item)),count:entry.processStream.items.length};
    }

    const value={
      schemaVersion:1,connected:true,observedAt:nowIso(now),
      binding:boardData.binding,parent:boardData.parent,members:boardData.members.length?boardData.members:membersView([compactTask(entry)]),usage:boardData.usage,
      taskCount:binding.tasks.length,boardTaskCount:cachedBoard?cachedBoard.tasks.filter(boardVisible).length:null,taskIndex:taskIdIndex+1,
      task:compactTask(entry),conversation,process,cursor:digest(`${entry.cursor}\u0000${binding.title}`),
    };
    const bytes=byteSize(value);
    const existing=detailCache.get(key)||entry;
    existing.bytes=Math.max(existing.bytes||0,bytes);
    remember(detailCache,key,existing,detailEntries,detailBytes);
    return value;
  }

  return {board,task};
}
