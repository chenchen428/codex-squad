import {open,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {qoderSessionPath} from './qoder-cli-usage.mjs';

const MAX_MODEL_CHARS=80;
// One attempt's rows sit at the end of the current session. Capping the tail keeps a
// terminal receipt read bounded even when the native session has grown very large.
const MAX_ATTEMPT_EVIDENCE_BYTES=64*1024*1024;
const USAGE_KEYS=Object.freeze(['inputTokens','outputTokens','cacheReadInputTokens']);

function timeMs(value){
  if(typeof value!=='string'||!value.trim())return null;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?parsed:null;
}

function cleanModel(value){
  if(typeof value!=='string')return null;
  const cleaned=value
    .replace(/[\u0000-\u001f\u007f]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  if(!cleaned||cleaned.length>MAX_MODEL_CHARS)return null;
  return cleaned;
}

function attemptKey(threadId,taskId,attemptId){return `${threadId}\u0000${taskId}\u0000${attemptId}`}

function chainAttempts(task,sessionId){
  const attempts=task.attempts.filter(attempt=>typeof attempt.attemptId==='string'&&attempt.attemptId);
  const byId=new Map(attempts.map(attempt=>[attempt.attemptId,attempt]));
  const picked=new Map();
  for(const attempt of attempts){
    if(attempt.sessionId!==sessionId)continue;
    picked.set(attempt.attemptId,attempt);
    let current=attempt;
    const seen=new Set();
    while(current?.resumedFrom&&!seen.has(current.resumedFrom)){
      seen.add(current.resumedFrom);
      const parent=byId.get(current.resumedFrom);
      if(!parent)break;
      if(parent.sessionId&&parent.sessionId!==sessionId)break;
      picked.set(parent.attemptId,parent);
      current=parent;
    }
  }
  return [...picked.values()];
}

function normalizeUsage(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const input=Number.isFinite(value.input_tokens)&&value.input_tokens>=0?value.input_tokens:null;
  const output=Number.isFinite(value.output_tokens)&&value.output_tokens>=0?value.output_tokens:null;
  const cacheRead=Number.isFinite(value.cache_read_input_tokens)&&value.cache_read_input_tokens>=0
    ?value.cache_read_input_tokens:null;
  if(input===null&&output===null&&cacheRead===null)return null;
  return {inputTokens:input,outputTokens:output,cacheReadInputTokens:cacheRead};
}

function addUsage(total,usage){
  if(!usage)return false;
  let reported=false;
  for(const key of ['inputTokens','outputTokens','cacheReadInputTokens']){
    if(usage[key]===null||usage[key]===undefined)continue;
    total[key]+=usage[key];
    reported=true;
  }
  return reported;
}

function usageTotal(usage){
  if(!usage)return null;
  return {
    inputTokens:usage.inputTokens,
    outputTokens:usage.outputTokens,
    cacheReadInputTokens:usage.cacheReadInputTokens,
    // A partial sum is not a total. Unknown input or output keeps the total unknown.
    // Native input_tokens already includes cache_read_input_tokens; never add it again.
    totalTokens:usage.inputTokens===null||usage.outputTokens===null
      ?null
      :usage.inputTokens+usage.outputTokens,
    inputIncludesCacheRead:true,
  };
}

/**
 * Sums one attempt's records only for fields every response reported. A response that
 * omits a field makes that field unknown; the known part is never presented as complete.
 */
function completeUsage(records){
  const totals={inputTokens:0,outputTokens:0,cacheReadInputTokens:0};
  const known={inputTokens:0,outputTokens:0,cacheReadInputTokens:0};
  for(const record of records){
    if(!record.usage)continue;
    for(const key of USAGE_KEYS){
      if(record.usage[key]===null||record.usage[key]===undefined)continue;
      totals[key]+=record.usage[key];
      known[key]+=1;
    }
  }
  const usage={};
  for(const key of USAGE_KEYS)usage[key]=records.length>0&&known[key]===records.length?totals[key]:null;
  return USAGE_KEYS.some(key=>usage[key]!==null)?usageTotal(usage):null;
}

/**
 * Read only machine metadata from native assistant rows. Content, thinking blocks and
 * tool payloads are intentionally never accessed, returned or retained.
 */
function readModelRows({text,sessionId,workspace,nowMs}){
  const target=resolve(workspace);
  const responses=new Map();
  let rejectedLines=0,rejectedRows=0;
  for(const line of String(text).split('\n')){
    if(!line.trim())continue;
    let row;
    try{row=JSON.parse(line);}
    catch{rejectedLines+=1;continue}
    if(row?.type!=='assistant')continue;
    const timestamp=typeof row?.timestamp==='string'?Date.parse(row.timestamp):NaN;
    let identity=row?.sessionId===sessionId&&typeof row?.cwd==='string'&&Number.isFinite(timestamp);
    if(identity){
      try{identity=resolve(row.cwd)===target;}
      catch{identity=false;}
    }
    const id=typeof row?.message?.id==='string'?row.message.id.trim():'';
    if(!identity||!id){rejectedRows+=1;continue;}
    let entry=responses.get(id);
    if(!entry){
      entry={id,models:new Set(),missingModel:false,timestamps:[],usage:null,rows:0};
      responses.set(id,entry);
    }
    entry.rows+=1;
    entry.timestamps.push(timestamp);
    const model=cleanModel(row.message.model);
    if(model)entry.models.add(model);
    else entry.missingModel=true;
    const usage=normalizeUsage(row.message.usage);
    // The final repeated segment carries the completed usage; dedupe never sums segments.
    if(usage)entry.usage=usage;
  }
  const records=[];
  let futureResponses=0,duplicateRows=0;
  for(const entry of responses.values()){
    duplicateRows+=Math.max(0,entry.rows-1);
    // A response still being written at the freeze cutoff is not evidence yet.
    if(entry.timestamps.some(timestamp=>timestamp>nowMs)){futureResponses+=1;continue}
    const conflict=entry.models.size>1;
    records.push({
      id:entry.id,
      model:!entry.missingModel&&entry.models.size===1?[...entry.models][0]:null,
      conflict,
      missingModel:entry.missingModel,
      timestamps:entry.timestamps,
      usage:entry.usage,
    });
  }
  return {
    status:records.length>0?'ready':(rejectedRows>0?'mismatch':'ready'),
    records,
    rejectedLines,
    rejectedRows,
    futureResponses,
    duplicateRows,
  };
}

function intervalOf(attempt,nowMs){
  const start=timeMs(attempt.startedAt);
  if(start===null)return null;
  const rawEnd=timeMs(attempt.endedAt);
  if(rawEnd!==null&&rawEnd<start)return null;
  const end=rawEnd===null?null:Math.min(rawEnd,nowMs);
  if(end!==null&&end<start)return null;
  return {start,end};
}

/**
 * One attempt's usage from native assistant rows inside its execution interval.
 * Repeated response segments collapse by message id, so a resumed session is never
 * counted from its whole-history cumulative value. No evidence stays null.
 */
export function nativeAttemptUsage({text,sessionId,workspace,startedAt,endedAt,nowMs=Date.now(),truncated=false}){
  const read=readModelRows({text,sessionId,workspace,nowMs});
  const base={
    status:read.status,responses:0,usage:null,
    duplicateRows:read.duplicateRows,rejectedLines:read.rejectedLines,rejectedRows:read.rejectedRows,
  };
  const interval=intervalOf({startedAt,endedAt},nowMs);
  if(!interval)return {...base,status:'invalid_interval'};
  // A bounded tail is only complete when it proves it reaches this attempt's start.
  const earliest=read.records.reduce((min,record)=>Math.min(min,...record.timestamps),Infinity);
  if(truncated&&!(earliest<=interval.start))return {...base,status:'truncated'};
  const records=read.records.filter(record=>record.timestamps.every(timestamp=>timestamp>=interval.start&&timestamp<=interval.end));
  return {...base,responses:records.length,usage:completeUsage(records)};
}

async function readBoundedSession(path,maxBytes){
  const handle=await open(path,'r');
  try{
    const info=await handle.stat();
    const start=Math.max(0,info.size-maxBytes);
    const bytes=Buffer.alloc(info.size-start);
    let offset=0;
    while(offset<bytes.length){
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,start+offset);
      if(!bytesRead)break;
      offset+=bytesRead;
    }
    const text=bytes.subarray(0,offset).toString('utf8');
    if(!start)return {text,truncated:false};
    const newline=text.indexOf('\n');
    return {text:newline<0?'':text.slice(newline+1),truncated:true};
  }finally{
    await handle.close();
  }
}

/** Reads one native session tail once; identity and execution interval stay enforced. */
export async function loadQoderAttemptUsage({
  workspace,nativeSessionId,startedAt,endedAt,qoderHome=null,nowMs=Date.now(),readFileImpl=null,
  maxBytes=MAX_ATTEMPT_EVIDENCE_BYTES,
}={}){
  if(!workspace||!/^[a-f0-9-]{36}$/i.test(String(nativeSessionId||'')))return {status:'invalid',responses:0,usage:null};
  let path;
  try{
    path=qoderSessionPath({qoderHome:qoderHome||join(homedir(),'.qoder'),workspace,nativeSessionId});
  }catch{
    return {status:'invalid',responses:0,usage:null};
  }
  if(!path)return {status:'invalid',responses:0,usage:null};
  let read;
  try{read=readFileImpl?{text:await readFileImpl(path,'utf8'),truncated:false}:await readBoundedSession(path,maxBytes);}
  catch(error){return {status:error?.code==='ENOENT'?'missing':'unreadable',responses:0,usage:null};}
  return nativeAttemptUsage({text:read.text,sessionId:nativeSessionId,workspace,startedAt,endedAt,nowMs,truncated:read.truncated});
}

function assignGroup({candidates,records,nowMs}){
  const ambiguous=new Set();
  let ambiguousResponses=0,unassignedResponses=0;
  const ordered=[...candidates].sort((left,right)=>{
    if(left.interval.start!==right.interval.start)return left.interval.start-right.interval.start;
    return left.key.localeCompare(right.key);
  });
  // An attempt without endedAt stays open until the next chained attempt starts.
  for(let index=0;index<ordered.length;index+=1){
    const candidate=ordered[index];
    if(candidate.interval.end!==null)continue;
    const next=ordered.slice(index+1).find(item=>item.interval.start>candidate.interval.start);
    candidate.interval.end=next?next.interval.start-1:nowMs;
  }
  for(const record of records){
    const owners=ordered.filter(candidate=>record.timestamps.every(timestamp=>
      timestamp>=candidate.interval.start&&timestamp<=candidate.interval.end));
    if(owners.length===0){unassignedResponses+=1;continue}
    if(owners.length>1){
      ambiguousResponses+=1;
      for(const owner of owners)ambiguous.add(owner.key);
      continue;
    }
    owners[0].records.push(record);
  }
  return {ambiguous,ambiguousResponses,unassignedResponses};
}

function attemptReason({groups,records,conflict,ambiguous,missingModel,modelCount,sessionId}){
  if(conflict)return 'model_conflict';
  if(ambiguous)return 'overlap';
  if(records===0){
    if(!sessionId)return 'no_session';
    const statuses=new Set(groups.map(group=>group.status));
    if(statuses.size&&[...statuses].every(status=>status==='missing'))return 'missing_file';
    if(statuses.size&&[...statuses].every(status=>status==='invalid_interval'))return 'invalid_interval';
    if(statuses.has('unreadable'))return 'unreadable';
    if(statuses.has('mismatch'))return 'mismatch';
    return 'no_records';
  }
  if(missingModel)return 'missing_model';
  if(modelCount>1)return 'mixed_models';
  return null;
}

/**
 * Attribute actual native model identities to Qoder attempts without falling back to a
 * configured model. Each native JSONL file is read at most once per call.
 */
export async function loadQoderModelEvidence({inputs,qoderHome=null,readFileImpl=readFile}={}){
  const root=qoderHome||join(homedir(),'.qoder');
  const nowMs=Number.isFinite(inputs?.nowMs)?inputs.nowMs:Date.now();
  const fromMs=Number.isFinite(inputs?.fromMs)?inputs.fromMs:null;
  const registry=new Map();
  const groups=new Map();

  for(const task of Array.isArray(inputs?.tasks)?inputs.tasks:[]){
    if(!task?.workspace)continue;
    let workspace;
    try{workspace=resolve(task.workspace);}
    catch{continue}
    for(const attempt of Array.isArray(task.attempts)?task.attempts:[]){
      const attemptId=typeof attempt?.attemptId==='string'?attempt.attemptId.trim():'';
      if(!attemptId||attempt.executor==='codex')continue;
      const key=attemptKey(task.threadId,task.id,attemptId);
      const started=timeMs(attempt.startedAt);
      const included=typeof attempt.included==='boolean'
        ?attempt.included
        :(fromMs===null||(started!==null&&started>=fromMs&&started<=nowMs));
      const sessionId=typeof attempt.sessionId==='string'?attempt.sessionId.trim():'';
      registry.set(key,{key,threadId:task.threadId,taskId:task.id,attemptId,sessionId,workspace,attempt,included,groups:[]});
    }
  }
  for(const task of Array.isArray(inputs?.tasks)?inputs.tasks:[]){
    if(!task?.workspace)continue;
    let workspace;
    try{workspace=resolve(task.workspace);}
    catch{continue}
    for(const attempt of Array.isArray(task.attempts)?task.attempts:[]){
      const attemptId=typeof attempt?.attemptId==='string'?attempt.attemptId.trim():'';
      if(!attemptId||attempt.executor==='codex')continue;
      const entry=registry.get(attemptKey(task.threadId,task.id,attemptId));
      if(!entry?.included||!entry.sessionId)continue;
      const path=qoderSessionPath({qoderHome:root,workspace,nativeSessionId:entry.sessionId});
      if(!path)continue;
      let group=groups.get(path);
      if(!group){group={path,sessionId:entry.sessionId,workspace,candidates:new Map()};groups.set(path,group);}
      for(const chained of chainAttempts(task,entry.sessionId)){
        const chainedKey=attemptKey(task.threadId,task.id,chained.attemptId);
        const target=registry.get(chainedKey);
        if(!target)continue;
        group.candidates.set(chainedKey,target);
      }
    }
  }

  const coverage={
    available:false,
    attempts:0,
    matched:0,
    unknown:0,
    byReason:{},
    sessions:groups.size,
    ready:0,
    missing:0,
    mismatch:0,
    unreadable:0,
    rejectedLines:0,
    rejectedRows:0,
    duplicateRows:0,
    responses:0,
    futureResponses:0,
    ambiguousResponses:0,
    unassignedResponses:0,
    conflicts:0,
    models:{},
    responsesByModel:{},
    usage:{inputTokens:0,outputTokens:0,cacheReadInputTokens:0},
  };

  for(const group of groups.values()){
    let read;
    try{
      const text=await readFileImpl(group.path,'utf8');
      read=readModelRows({text,sessionId:group.sessionId,workspace:group.workspace,nowMs});
    }catch(error){
      read=error?.code==='ENOENT'
        ?{status:'missing',records:[],rejectedLines:0,rejectedRows:0,futureResponses:0,duplicateRows:0}
        :{status:'unreadable',records:[],rejectedLines:0,rejectedRows:0,futureResponses:0,duplicateRows:0};
    }
    coverage[read.status]=(coverage[read.status]||0)+1;
    coverage.rejectedLines+=read.rejectedLines;
    coverage.rejectedRows+=read.rejectedRows;
    coverage.duplicateRows+=read.duplicateRows;
    coverage.futureResponses+=read.futureResponses;
    coverage.responses+=read.records.length;
    for(const record of read.records)if(record.conflict)coverage.conflicts+=1;

    const candidates=[];
    for(const entry of group.candidates.values()){
      const interval=intervalOf(entry.attempt,nowMs);
      if(!interval)continue;
      candidates.push({key:entry.key,entry,interval,records:[]});
    }
    const assigned=read.records.length?assignGroup({candidates,records:read.records,nowMs}):{ambiguous:new Set(),ambiguousResponses:0,unassignedResponses:0};
    coverage.ambiguousResponses+=assigned.ambiguousResponses;
    coverage.unassignedResponses+=assigned.unassignedResponses;
    for(const candidate of candidates){
      candidate.entry.groups.push({
        sessionId:group.sessionId,
        status:read.status,
        records:candidate.records,
        ambiguous:assigned.ambiguous.has(candidate.key),
      });
    }
    // Attempts in this file without a usable interval stay unknown explicitly.
    for(const entry of group.candidates.values()){
      if(candidates.some(candidate=>candidate.key===entry.key))continue;
      entry.groups.push({sessionId:group.sessionId,status:'invalid_interval',records:[],ambiguous:false});
    }
  }

  const attempts=[];
  for(const entry of registry.values()){
    if(!entry.included)continue;
    const groupsForAttempt=entry.groups;
    let records=0,conflict=false,ambiguous=false,missingModel=false,modelCount=0;
    const modelCounts={};
    const usage={inputTokens:0,outputTokens:0,cacheReadInputTokens:0};
    let usageReported=false;
    for(const group of groupsForAttempt){
      if(group.ambiguous)ambiguous=true;
      for(const record of group.records){
        records+=1;
        if(record.conflict){conflict=true;continue}
        if(record.model===null){missingModel=true;continue}
        modelCounts[record.model]=(modelCounts[record.model]||0)+1;
        if(addUsage(usage,record.usage))usageReported=true;
      }
    }
    modelCount=Object.keys(modelCounts).length;
    const reason=attemptReason({
      groups:groupsForAttempt,records,conflict,ambiguous,missingModel,modelCount,sessionId:entry.sessionId,
    });
    const model=reason===null?Object.keys(modelCounts)[0]:null;
    const sessionId=entry.sessionId||groupsForAttempt.find(group=>group.sessionId)?.sessionId||null;
    const result={
      threadId:entry.threadId,
      taskId:entry.taskId,
      attemptId:entry.attemptId,
      sessionId,
      model,
      source:model?'actual':null,
      sourceRef:sessionId?`qoder-native:${sessionId}`:null,
      records,
      modelCounts,
      startedAt:entry.attempt.startedAt??null,
      endedAt:entry.attempt.endedAt??null,
      reason:reason||null,
      usage:usageReported?usageTotal(usage):null,
    };
    attempts.push(result);
    coverage.attempts+=1;
    if(model){
      coverage.matched+=1;
      coverage.models[model]=(coverage.models[model]||0)+1;
      for(const [name,count] of Object.entries(modelCounts)){
        coverage.responsesByModel[name]=(coverage.responsesByModel[name]||0)+count;
      }
      if(usageReported){
        for(const key of ['inputTokens','outputTokens','cacheReadInputTokens'])coverage.usage[key]+=usage[key];
      }
    }else{
      coverage.unknown+=1;
      coverage.byReason[reason]=(coverage.byReason[reason]||0)+1;
    }
  }

  coverage.available=coverage.ready>0;
  return {attempts,coverage};
}
