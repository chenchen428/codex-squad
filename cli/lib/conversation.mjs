import {createConversationEventNormalizer} from './bridge-conversation/event-normalizer.mjs';
import {appServerExecutionEvent} from './bridge-conversation/agent-server-events.mjs';

// Batch protocol deltas, not full transcripts, to keep Taskboard writes bounded.
export function createConversationRecorder(job,emit,{interval=500,now=()=>new Date().toISOString()}={}){
  const normalizer=createConversationEventNormalizer({runId:job.attemptId,sessionId:job.sessionId,
    taskRef:{scope:'PERSONAL',taskId:job.taskId},origin:{providerId:job.executor},visibility:'SHARED_SAFE',now});
  let batch=[],size=0,timer=null,chain=Promise.resolve();
  function flush(){
    clearTimeout(timer);timer=null;if(!batch.length)return chain;
    const events=batch;batch=[];size=0;
    chain=chain.then(()=>emit('SQUAD_CONVERSATION_BATCH',{events}));return chain;
  }
  function push(value){
    for(const event of normalizer.push(value)){
      const bytes=Buffer.byteLength(JSON.stringify(event));
      if(size+bytes>60000)void flush();batch.push(event);size+=bytes;
    }
    if(!timer&&batch.length){timer=setTimeout(()=>{void flush().catch(()=>{})},interval);timer.unref?.()}
  }
  return {
    frame(frame){const native=appServerExecutionEvent(frame);if(native)push(native)},
    async finish(status){push({type:status==='completed'?'run_completed':status==='stopped'?'run_canceled':'run_failed'});await flush()},
  };
}

// Project the same entity/revision/operation contract used by Agent Bridge.
export function createConversationProjection(){
  const items=new Map();
  function push(envelopes){
  for(const envelope of envelopes)for(const event of envelope.payload?.events||[]){
    if(event.schemaVersion!=='agent-bridge.conversation/v1')continue;
    const {type,entityId:id,entityRevision:revision,occurredAt:time,payload:p={}}=event,current=items.get(id);
    if(current&&current.revision>=revision)continue;
    if(type.startsWith('MESSAGE_')){
      const content=event.operation==='APPEND'?(current?.text||'')+(p.content||''):p.content??current?.text??'';
      items.set(id,{id,revision,time:current?.time||time,updatedAt:time,kind:'message',role:p.role||current?.role||'assistant',text:content,status:type==='MESSAGE_COMPLETED'?'completed':'streaming'});
    }else if(type.startsWith('TOOL_')){
      items.set(id,{id,revision,time:current?.time||time,updatedAt:time,kind:'tool',role:'tool',toolName:p.toolName||current?.toolName||'tool',text:p.content||current?.text||'',result:p.result||current?.result||'',status:p.status||'RUNNING'});
    }else if(type==='PROGRESS_UPDATED'||type.startsWith('AUTHORIZATION_')){
      items.set(id,{id,revision,time:current?.time||time,updatedAt:time,kind:'progress',text:p.summary||'',status:p.status||'RUNNING'});
    }
  }
  }
  return {push,items:()=>[...items.values()].filter(item=>item.text||item.kind==='tool')};
}
export function projectConversation(envelopes){const projection=createConversationProjection();projection.push(envelopes);return projection.items()}
