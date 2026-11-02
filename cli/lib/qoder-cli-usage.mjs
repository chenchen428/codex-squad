import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {aggregateCliCalls,classifyCliCall,failureCategory,isSpecificMcpToolName} from './cli-metrics.mjs';
import {cliAttemptInputs} from './analytics.mjs';

const MAX_RECEIPT_CHARS=2_000_000;
const STATUS_WORD=/^[A-Za-z][A-Za-z_-]{0,23}$/;

function timeMs(value){
  if(typeof value!=='string'||!value.trim())return null;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?parsed:null;
}

/** Qoder names a project directory by replacing every non-alphanumeric character. */
export function qoderProjectKey(workspace){return resolve(workspace).replace(/[^A-Za-z0-9]/g,'-')}

export function qoderSessionPath({qoderHome,workspace,nativeSessionId}){
  if(!qoderHome||!workspace||!nativeSessionId)return null;
  return join(qoderHome,'projects',qoderProjectKey(workspace),`${nativeSessionId}.jsonl`);
}

/**
 * Only top-level machine-safe business tokens leave the native stdout payload.
 * Raw stdout/stderr and nested objects are never retained.
 */
function stdoutReceipt(stdout){
  if(typeof stdout!=='string')return null;
  const text=stdout.trim();
  if(text.length<2||text.length>MAX_RECEIPT_CHARS)return null;
  if(text[0]!=='{'||text[text.length-1]!=='}')return null;
  let json;
  try{json=JSON.parse(text);}
  catch{return null}
  if(!json||typeof json!=='object'||Array.isArray(json))return null;
  const safe={};
  if(typeof json.ok==='boolean')safe.ok=json.ok;
  if(typeof json.success==='boolean')safe.success=json.success;
  if(Number.isInteger(json.code))safe.code=json.code;
  if(typeof json.status==='string'&&STATUS_WORD.test(json.status))safe.status=json.status;
  if(typeof json.state==='string'&&STATUS_WORD.test(json.state))safe.state=json.state;
  if(json.error!==undefined){
    const present=json.error===true
      ||(typeof json.error==='string'&&json.error.trim())
      ||(json.error!==null&&typeof json.error==='object'&&Object.keys(json.error).length>0);
    if(present)safe.error=true;
  }
  return Object.keys(safe).length?safe:null;
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
  return [...picked.values()].sort((left,right)=>{
    const a=timeMs(left.startedAt),b=timeMs(right.startedAt);
    if(a!==null&&b!==null&&a!==b)return a-b;
    if(a===null&&b!==null)return 1;
    if(a!==null&&b===null)return -1;
    return String(left.attemptId).localeCompare(String(right.attemptId));
  });
}

function ownerOf(candidates,timestamp){
  let owner=null;
  for(const candidate of candidates){
    const started=timeMs(candidate.attempt.startedAt);
    if(started===null)continue;
    const ended=timeMs(candidate.attempt.endedAt);
    if(started>timestamp)break;
    if(ended===null||timestamp<=ended)owner=candidate;
  }
  return owner;
}

function nativeRecord(use,result,fromMs,nowMs){
  const timestamp=Number.isFinite(use.timestamp)?use.timestamp:(result?.timestamp??null);
  if(timestamp===null)return null;
  if(timestamp>nowMs||(fromMs!==null&&timestamp<fromMs))return null;
  const machine=result?.machine||null;
  const exitCode=Number.isInteger(machine?.exitCode)?machine.exitCode:null;
  const receipt=stdoutReceipt(machine?.stdout);
  const payload={};
  if(exitCode!==null)payload.exit_code=exitCode;
  if(receipt)Object.assign(payload,receipt);
  // Reduce diagnostics to the existing bounded taxonomy before leaving this
  // collector. Neither stderr nor the original stdout becomes report data.
  if((exitCode!==null&&exitCode!==0)||receipt?.ok===false||receipt?.success===false||receipt?.error===true){
    const category=failureCategory(`${String(machine?.stdout||'').slice(0,4000)}\n${String(machine?.stderr||'').slice(0,4000)}`,null);
    const hints={timeout:'timeout',permission:'permission denied',argument:'invalid argument',service:'service unavailable',execution:'command not found'};
    if(category&&hints[category])payload.diagnostic=hints[category];
  }
  const resultText=Object.keys(payload).length?JSON.stringify(payload):'';
  const classified=classifyCliCall({toolName:use.name,callText:use.callText,resultText});
  if(!classified)return null;
  return {
    id:use.id,
    toolName:use.name,
    callText:use.callText,
    resultText,
    status:null,
    timestamp,
    businessReceipt:Boolean(receipt),
    ...classified,
  };
}

async function readNativeSession({path,sessionId,workspace,readFileImpl}){
  let text;
  try{text=await readFileImpl(path,'utf8');}
  catch(error){
    return {status:error?.code==='ENOENT'?'missing':'unreadable',uses:[],results:new Map(),rejected:0};
  }
  const target=resolve(workspace);
  const uses=new Map(),results=new Map();
  let rejected=0;
  for(const line of String(text).split('\n')){
    if(!line.trim())continue;
    let row;
    try{row=JSON.parse(line);}
    catch{rejected+=1;continue}
    const content=Array.isArray(row?.message?.content)?row.message.content:[];
    const tools=content.filter(item=>item?.type==='tool_use'||item?.type==='tool_result');
    if(!tools.length)continue;
    const timestamp=typeof row?.timestamp==='string'?Date.parse(row.timestamp):NaN;
    let identity=row?.sessionId===sessionId&&typeof row?.cwd==='string'&&Number.isFinite(timestamp);
    if(identity){
      try{identity=resolve(row.cwd)===target;}
      catch{identity=false;}
    }
    if(!identity){rejected+=1;continue;}
    for(const item of tools){
      if(item.type==='tool_use'){
        const id=typeof item.id==='string'?item.id.trim():'';
        const name=typeof item.name==='string'?item.name.trim():'';
        if(!id||!name||uses.has(id))continue;
        uses.set(id,{id,name,callText:typeof item.input?.command==='string'?item.input.command:'',timestamp});
      }else{
        const id=typeof item.tool_use_id==='string'?item.tool_use_id.trim():'';
        if(!id||results.has(id))continue;
        const machine=row.toolUseResult&&typeof row.toolUseResult==='object'&&!Array.isArray(row.toolUseResult)?row.toolUseResult:null;
        results.set(id,{timestamp,machine});
      }
    }
  }
  // A matched file with no tool calls is authoritative; one whose every tool line was
  // rejected is not, so callers keep the public fallback instead of guessing.
  const status=uses.size>0||rejected===0?'ready':'mismatch';
  return {status,uses:[...uses.values()],results,rejected};
}

/**
 * Read native Qoder session receipts for the attempts present in the frozen views.
 * Each JSONL file is read once per call; duplicate tool_use ids are not recounted.
 */
export async function loadQoderCliUsage({inputs,qoderHome=null,readFileImpl=readFile}={}){
  const root=qoderHome||join(homedir(),'.qoder');
  const groups=new Map();
  for(const task of Array.isArray(inputs?.tasks)?inputs.tasks:[]){
    if(!task?.workspace)continue;
    const workspace=resolve(task.workspace);
    for(const attempt of Array.isArray(task.attempts)?task.attempts:[]){
      const sessionId=typeof attempt?.sessionId==='string'?attempt.sessionId.trim():'';
      if(!sessionId||attempt.executor==='codex'||!attempt.attemptId)continue;
      const path=qoderSessionPath({qoderHome:root,workspace,nativeSessionId:sessionId});
      if(!path)continue;
      const key=`${sessionId}\u0000${workspace}`;
      let group=groups.get(key);
      if(!group){group={sessionId,workspace,path,tasks:new Map()};groups.set(key,group);}
      group.tasks.set(`${task.threadId}\u0000${task.id}`,task);
    }
  }
  const sessions=[];
  const coverage={available:false,sessions:0,ready:0,missing:0,mismatch:0,unreadable:0,rejectedLines:0,coveredAttempts:0,records:0,businessReceipts:0,errorCode:null};
  // A resumed session can repeat the same native call; one tool id is one call.
  const seenUseIds=new Set();
  for(const group of groups.values()){
    const candidates=[];
    for(const task of group.tasks.values()){
      for(const attempt of chainAttempts(task,group.sessionId))candidates.push({task,attempt});
    }
    candidates.sort((left,right)=>{
      const a=timeMs(left.attempt.startedAt),b=timeMs(right.attempt.startedAt);
      if(a!==null&&b!==null&&a!==b)return a-b;
      if(a===null&&b!==null)return 1;
      if(a!==null&&b===null)return -1;
      return attemptKey(left.task.threadId,left.task.id,left.attempt.attemptId)
        .localeCompare(attemptKey(right.task.threadId,right.task.id,right.attempt.attemptId));
    });
    const read=await readNativeSession({path:group.path,sessionId:group.sessionId,workspace:group.workspace,readFileImpl});
    const assignments=new Map();
    const covered=new Set();
    let businessReceipts=0;
    for(const candidate of candidates)covered.add(attemptKey(candidate.task.threadId,candidate.task.id,candidate.attempt.attemptId));
    if(read.status==='ready'){
      for(const use of read.uses){
        if(seenUseIds.has(use.id))continue;
        seenUseIds.add(use.id);
        const record=nativeRecord(use,read.results.get(use.id),inputs?.fromMs??null,inputs?.nowMs??Date.now());
        if(!record)continue;
        if(record.businessReceipt)businessReceipts+=1;
        const owner=ownerOf(candidates,record.timestamp);
        if(!owner)continue;
        const key=attemptKey(owner.task.threadId,owner.task.id,owner.attempt.attemptId);
        let list=assignments.get(key);
        if(!list){list=[];assignments.set(key,list);}
        list.push({
          ...record,
          threadId:owner.task.threadId,
          taskId:owner.task.id,
          threadTitle:owner.task.threadTitle??null,
          taskTitle:owner.task.title??null,
        });
      }
    }
    const records=[...assignments.values()].reduce((sum,list)=>sum+list.length,0);
    coverage.sessions+=1;
    coverage[read.status]=(coverage[read.status]||0)+1;
    coverage.rejectedLines+=read.rejected;
    coverage.businessReceipts+=businessReceipts;
    if(read.status==='ready'){
      coverage.coveredAttempts+=covered.size;
      coverage.records+=records;
    }
    sessions.push({sessionId:group.sessionId,workspace:group.workspace,status:read.status,rejected:read.rejected,assignments,covered,businessReceipts});
  }
  // Without one usable native session the public fallback is authoritative.
  coverage.available=coverage.ready>0;
  return {available:coverage.available,sessions,coverage};
}

function publicRecord(record){
  return {
    id:record?.id??null,
    toolName:record?.toolName,
    callText:record?.callText,
    resultText:record?.resultText,
    outcome:record?.outcome,
  };
}

/**
 * Prefer native receipts for a covered attempt; public command records only fill attempts
 * without a usable native session. Specific MCP public records are kept unless the same
 * tool id already came from native.
 */
export function mergeQoderCliUsage(stats,{inputs,usage}={}){
  if(!stats?.capabilities?.cli)return stats;
  const base=stats.capabilities.cli;
  if(!usage?.available){
    stats.capabilities.cli={...base,coverage:{...(base.coverage||{}),qoderNative:usage?.coverage||{available:false}}};
    return stats;
  }
  const covered=new Set();
  const nativeByAttempt=new Map();
  for(const session of usage.sessions){
    if(session.status!=='ready')continue;
    for(const key of session.covered)covered.add(key);
    for(const [key,records] of session.assignments)nativeByAttempt.set(key,records);
  }
  const statsTasks=new Map(stats.tasks.map(task=>[`${task.threadId}\u0000${task.id}`,task]));
  const globalRecords=[];
  let fallbackRecords=0,nativeRecords=0;
  for(const input of inputs.tasks){
    const taskKey=`${input.threadId}\u0000${input.id}`;
    const records=[];
    for(const attempt of input.attempts){
      const key=attemptKey(input.threadId,input.id,attempt.attemptId);
      const coveredAttempt=covered.has(key);
      let attemptRecords;
      if(coveredAttempt){
        const native=nativeByAttempt.get(key)||[];
        const nativeIds=new Set(native.map(record=>record.id).filter(Boolean));
        // Public tool records carry no timestamp, so their attempt must be inside the window.
        const mcp=attempt.included
          ?attempt.records
            .filter(record=>isSpecificMcpToolName(record.toolName)&&!(record.id&&nativeIds.has(record.id)))
            .map(publicRecord)
          :[];
        attemptRecords=[...native,...mcp];
        nativeRecords+=native.length;
        fallbackRecords+=mcp.length;
      }else{
        attemptRecords=attempt.included?attempt.records.map(publicRecord):[];
        fallbackRecords+=attemptRecords.length;
      }
      for(const record of attemptRecords)records.push({...record,threadId:input.threadId,taskId:input.id,threadTitle:input.threadTitle??null,taskTitle:input.title??null});
    }
    const projected=statsTasks.get(taskKey);
    const aggregate=aggregateCliCalls(records);
    if(projected){
      projected.cli={
        calls:aggregate.rows.reduce((sum,row)=>sum+row.calls,0),
        unclassifiedCalls:aggregate.unclassifiedCalls,
        rows:aggregate.rows.map(({sessions,...row})=>row),
      };
    }
    globalRecords.push(...records);
  }
  const aggregate=aggregateCliCalls(globalRecords);
  stats.capabilities.cli={
    ...aggregate,
    coverage:{
      ...(base.coverage||{}),
      qoderNative:{...usage.coverage,nativeRecords,publicFallbackRecords:fallbackRecords},
    },
  };
  return stats;
}

export async function collectQoderCliUsage({stats,views,days,now,qoderHome=null,provider=loadQoderCliUsage}={}){
  if(!stats?.capabilities?.cli)return stats;
  const inputs=cliAttemptInputs(views,{now,days});
  let usage;
  try{usage=await provider({inputs,qoderHome});}
  catch(error){
    usage={available:false,coverage:{available:false,errorCode:String(error?.code||'QODER_NATIVE_UNAVAILABLE')}};
  }
  return mergeQoderCliUsage(stats,{inputs,usage});
}
