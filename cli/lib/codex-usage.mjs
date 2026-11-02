import {createHash} from 'node:crypto';
import {mkdir,open,readFile,readdir,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {dataRoot} from './storage-paths.mjs';

export const CODEX_USAGE_SCHEMA_VERSION=1;
export const CODEX_USAGE_PARSER_VERSION=5;
const MAX_LIFECYCLE_MESSAGE=4000;
const MAX_TURN_MODELS=5000;
export const CODEX_USAGE_NOTE='本机已记录用量；缓存包含在输入中，推理包含在输出中。Qoder 用量另列。未记录到用量的会话未计入数值，仅在覆盖信息中单列。';

const MODEL_UNREPORTED='未上报';
const HEAD_BYTES=4096;
const READ_CHUNK=256*1024;
const MAX_PENDING_BYTES=8*1024*1024;
const MAX_TITLE=300;
const MAX_USER_MESSAGES=8;
const MAX_USER_MESSAGE=1200;
const MAX_PUBLIC_GOALS=8;
const MAX_PUBLIC_GOAL=1200;
const DELEGATION_TOOLS=new Set(['create_thread','send_message_to_thread']);

function fail(code,message){return Object.assign(new Error(message),{code});}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function nonEmpty(value){return typeof value==='string'&&value.trim()?value.trim():null;}
function tokenCount(value){
  const number=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
  return Number.isFinite(number)&&number>0?Math.floor(number):0;
}
function finiteNumber(value){
  const number=typeof value==='number'?value:NaN;
  return Number.isFinite(number)?number:null;
}
function timestampOf(value){
  if(typeof value!=='string'||!value.trim())return null;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?parsed:null;
}
function dateOf(value){
  const date=value instanceof Date?new Date(value.getTime()):new Date(value??Date.now());
  return Number.isFinite(date.getTime())?date:new Date();
}
function nativeTitle(row){
  for(const value of [row?.name,row?.title]){
    if(typeof value==='string'&&value.trim())return value.trim().slice(0,MAX_TITLE);
  }
  return null;
}
function typeIn(head,name){
  return head.includes(`"type":"${name}"`)||head.includes(`"type": "${name}"`);
}

export function resolveCodexHome({codexHome=null,env=process.env}={}){
  if(typeof codexHome==='string'&&codexHome.trim())return codexHome;
  const fromEnv=env?.CODEX_HOME;
  if(typeof fromEnv==='string'&&fromEnv.trim())return fromEnv;
  return join(homedir(),'.codex');
}

export function codexUsageIndexPath({home}={}){
  return join(dataRoot({home}),'codex-usage','index.json');
}

export function emptyCodexUsage({now=new Date(),available=false,note=CODEX_USAGE_NOTE}={}){
  return {
    schemaVersion:CODEX_USAGE_SCHEMA_VERSION,
    available:Boolean(available),
    observedAt:dateOf(now).toISOString(),
    scope:'local',
    totals:{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0},
    sessions:[],
    models:[],
    coverage:{
      threads:0,readableThreads:0,missingThreads:0,
      usageThreads:0,unreportedThreads:0,unreportedWithTokens:0,
      undatedRecords:0,unattributedModelRecords:0,
    },
    note:String(note||CODEX_USAGE_NOTE),
  };
}

async function stateDatabase(codexHome){
  let files;
  try{files=(await readdir(codexHome)).filter(file=>/^state_\d+\.sqlite$/.test(file));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!files.length)return null;
  files.sort((left,right)=>Number(right.match(/\d+/)?.[0]||0)-Number(left.match(/\d+/)?.[0]||0));
  return join(codexHome,files[0]);
}

function columnSet(db){
  return new Set(db.prepare('PRAGMA table_info(threads)').all().map(row=>String(row.name)));
}

function parentThreadId(source){
  if(typeof source!=='string'||!source.trim().startsWith('{'))return null;
  try{
    const value=JSON.parse(source);
    return nonEmpty(value?.subagent?.thread_spawn?.parent_thread_id)
      ||nonEmpty(value?.subagent?.thread_spawn?.parentThreadId);
  }catch{return null}
}
function epochMs(value){
  const number=Number(value);
  if(!Number.isFinite(number)||number<=0)return null;
  return number<1e12?number*1000:number;
}
async function readThreadMetadata(codexHome){
  const file=await stateDatabase(codexHome);
  if(!file)return {available:false,threads:[]};
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const columns=columnSet(db);
    if(!columns.has('id'))return {available:true,threads:[]};
    const names=['id','title','name','rollout_path','model','tokens_used','updated_at','updated_at_ms','archived',
      'reasoning_effort','cwd','sandbox_policy','approval_mode','source','thread_source','created_at','created_at_ms']
      .filter(name=>columns.has(name));
    const rows=db.prepare(`SELECT ${names.join(',')} FROM threads`).all();
    const threads=rows.map(row=>{
      const updatedAtMs=Number(row.updated_at_ms);
      const updatedAt=Number(row.updated_at);
      const createdAtMs=Number(row.created_at_ms);
      const createdAt=Number(row.created_at);
      return {
        threadId:String(row.id),
        title:nativeTitle(row),
        rolloutPath:nonEmpty(row.rollout_path),
        model:nonEmpty(row.model),
        tokensUsed:tokenCount(row.tokens_used),
        updatedAtMs:Number.isFinite(updatedAtMs)?updatedAtMs:Number.isFinite(updatedAt)?updatedAt*1000:null,
        createdAtMs:Number.isFinite(createdAtMs)?createdAtMs:Number.isFinite(createdAt)?createdAt*1000:null,
        archived:Boolean(row.archived),
        reasoningEffort:nonEmpty(row.reasoning_effort),
        cwd:nonEmpty(row.cwd),
        sandbox:nonEmpty(row.sandbox_policy),
        approval:nonEmpty(row.approval_mode),
        source:nonEmpty(row.source),
        threadSource:nonEmpty(row.thread_source),
        parentThreadId:parentThreadId(row.source),
      };
    });
    return {available:true,threads};
  }finally{db.close();}
}

function emptyIndex(){
  return {schemaVersion:CODEX_USAGE_SCHEMA_VERSION,parserVersion:CODEX_USAGE_PARSER_VERSION,files:{}};
}

function normalizeRecord(value){
  if(!isRecord(value))return null;
  return {
    r:nonEmpty(value.r),
    t:Number.isFinite(value.t)?value.t:null,
    turn:nonEmpty(value.turn),
    i:tokenCount(value.i),
    c:tokenCount(value.c),
    o:tokenCount(value.o),
  };
}

function normalizeTotals(value){
  if(!isRecord(value))return null;
  return {i:tokenCount(value.i),c:tokenCount(value.c),o:tokenCount(value.o),t:tokenCount(value.t)};
}

function freshLifecycle(){
  return {turns:{},contexts:{},externalExecutors:[],starts:{},completes:{},aborted:{},lastKind:null,lastAt:null,lastCompleteAt:null,lastStartedAt:null,lastMessage:null,userMessages:[],publicGoals:[]};
}
function userMessageText(item){
  if(!isRecord(item)||item.type!=='UserMessage')return null;
  const parts=[];
  for(const content of Array.isArray(item.content)?item.content:[]){
    if(isRecord(content)&&content.type==='text'&&typeof content.text==='string')parts.push(content.text);
  }
  const text=parts.join(' ').replace(/\s+/g,' ').trim();
  return text?text.slice(0,MAX_USER_MESSAGE):null;
}
function addUserMessage(entry,text){
  if(!text)return;
  const list=entry.lifecycle.userMessages;
  if(Array.isArray(entry.lifecycle.publicGoals)&&entry.lifecycle.publicGoals.some(goal=>goal?.text===text))return;
  if(!Array.isArray(list))entry.lifecycle.userMessages=[text];
  else if(list.includes(text))return;
  else if(list.length<MAX_USER_MESSAGES)list.push(text);
  else{
    list.splice(MAX_USER_MESSAGES/2,1);
    list.push(text);
  }
}
function codePoint(value){
  return Number.isInteger(value)&&value>=0&&value<=0x10ffff?String.fromCodePoint(value):null;
}
function decodeXml(value){
  return value
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#(\d+);/g,(raw,code)=>codePoint(Number(code))??raw)
    .replace(/&#x([0-9a-f]+);/gi,(raw,code)=>codePoint(parseInt(code,16))??raw)
    .replace(/&amp;/g,'&');
}
function delegationGoal(item,turn,at){
  if(!isRecord(item)||item.type!=='FunctionCallOutput')return null;
  if(item.namespace!=='codex_app'||!DELEGATION_TOOLS.has(item.name))return null;
  if(typeof item.output!=='string'||!item.output.includes('<codex_delegation>'))return null;
  const open=item.output.indexOf('<input>');
  const close=item.output.lastIndexOf('</input>');
  if(open<0||close<=open)return null;
  const text=decodeXml(item.output.slice(open+'<input>'.length,close)).replace(/\s+/g,' ').trim();
  if(!text)return null;
  const source=item.output.match(/<source_thread_id>\s*([^<]+?)\s*<\/source_thread_id>/);
  return {
    text:text.slice(0,MAX_PUBLIC_GOAL),
    turn:nonEmpty(turn),
    at:finiteNumber(at),
    sourceThreadId:source?nonEmpty(decodeXml(source[1])):null,
  };
}
function addPublicGoal(entry,goal){
  if(!goal?.text)return;
  const list=entry.lifecycle.publicGoals;
  if(!Array.isArray(list)){entry.lifecycle.publicGoals=[goal];return;}
  if(list.some(item=>item?.text===goal.text))return;
  if(Array.isArray(entry.lifecycle.userMessages)&&entry.lifecycle.userMessages.includes(goal.text))return;
  if(list.length<MAX_PUBLIC_GOALS)list.push(goal);
  else{
    list.splice(Math.floor(MAX_PUBLIC_GOALS/2),1);
    list.push(goal);
  }
}
function normalizeLifecycle(value){
  const empty=freshLifecycle();
  if(!isRecord(value))return empty;
  const turns={};
  for(const [turn,model] of Object.entries(isRecord(value.turns)?value.turns:{})){
    if(turn&&typeof model==='string'&&model)turns[turn]=model;
  }
  const starts={},completes={};
  for(const [turn,entry] of Object.entries(isRecord(value.starts)?value.starts:{})){
    const startedAt=finiteNumber(entry?.startedAt);
    if(turn&&startedAt!==null)starts[turn]={startedAt};
  }
  for(const [turn,entry] of Object.entries(isRecord(value.completes)?value.completes:{})){
    const completedAt=finiteNumber(entry?.completedAt);
    const durationMs=finiteNumber(entry?.durationMs);
    const message=typeof entry?.message==='string'?entry.message.slice(0,MAX_LIFECYCLE_MESSAGE):null;
    if(turn)completes[turn]={completedAt,durationMs,message};
  }
  const aborted={};
  for(const [turn,flag] of Object.entries(isRecord(value.aborted)?value.aborted:{})){
    if(turn&&flag)aborted[turn]=true;
  }
  return {
    turns,contexts:isRecord(value.contexts)?value.contexts:{},
    externalExecutors:Array.isArray(value.externalExecutors)?[...new Set(value.externalExecutors.filter(v=>v==='qoder'))]:[],
    starts,completes,aborted,
    lastKind:['started','complete','aborted'].includes(value.lastKind)?value.lastKind:null,
    lastAt:finiteNumber(value.lastAt),
    lastCompleteAt:finiteNumber(value.lastCompleteAt),
    lastStartedAt:finiteNumber(value.lastStartedAt),
    lastMessage:typeof value.lastMessage==='string'?value.lastMessage.slice(0,MAX_LIFECYCLE_MESSAGE):null,
    userMessages:Array.isArray(value.userMessages)
      ?value.userMessages.filter(text=>typeof text==='string'&&text).slice(0,MAX_USER_MESSAGES).map(text=>text.slice(0,MAX_USER_MESSAGE))
      :[],
    publicGoals:Array.isArray(value.publicGoals)
      ?value.publicGoals.filter(goal=>isRecord(goal)&&typeof goal.text==='string'&&goal.text).slice(0,MAX_PUBLIC_GOALS).map(goal=>({
        text:goal.text.slice(0,MAX_PUBLIC_GOAL),
        turn:nonEmpty(goal.turn),
        at:finiteNumber(goal.at),
        sourceThreadId:nonEmpty(goal.sourceThreadId),
      }))
      :[],
  };
}
function normalizeEntry(value){
  if(!isRecord(value))return null;
  const offset=Number.isSafeInteger(value.offset)&&value.offset>=0?value.offset:0;
  return {
    ino:finiteNumber(value.ino),
    size:Math.max(0,finiteNumber(value.size)||0),
    mtimeMs:finiteNumber(value.mtimeMs),
    headHash:nonEmpty(value.headHash),
    offset,
    modernRecords:Array.isArray(value.modernRecords)?value.modernRecords.map(normalizeRecord).filter(Boolean):[],
    legacyRecords:Array.isArray(value.legacyRecords)?value.legacyRecords.map(normalizeRecord).filter(Boolean):[],
    baseline:normalizeTotals(value.baseline),
    baselineSource:value.baselineSource==='modern'||value.baselineSource==='legacy'?value.baselineSource:null,
    modernCumulative:normalizeTotals(value.modernCumulative),
    legacyLast:normalizeTotals(value.legacyLast),
    currentTurn:nonEmpty(value.currentTurn),
    modernNoCumulativeTurns:Array.isArray(value.modernNoCumulativeTurns)
      ?[...new Set(value.modernNoCumulativeTurns.map(nonEmpty).filter(Boolean))]
      :[],
    turns:isRecord(value.turns)
      ?Object.fromEntries(Object.entries(value.turns).filter(([turn,model])=>turn&&typeof model==='string'&&model).map(([turn,model])=>[turn,model]))
      :{},
    lifecycle:normalizeLifecycle(value.lifecycle),
  };
}

async function readUsageIndex(file){
  let raw;
  try{raw=await readFile(file,'utf8');}
  catch{return emptyIndex();}
  let value;
  try{value=JSON.parse(raw);}
  catch{return emptyIndex();}
  if(!isRecord(value)||value.schemaVersion!==CODEX_USAGE_SCHEMA_VERSION||value.parserVersion!==CODEX_USAGE_PARSER_VERSION||!isRecord(value.files))return emptyIndex();
  const files={};
  for(const [path,entry] of Object.entries(value.files)){
    if(typeof path!=='string'||!path)continue;
    const normalized=normalizeEntry(entry);
    if(normalized)files[path]=normalized;
  }
  return {schemaVersion:CODEX_USAGE_SCHEMA_VERSION,parserVersion:CODEX_USAGE_PARSER_VERSION,files};
}

function cleanEntry(entry){
  return {
    ino:entry.ino,size:entry.size,mtimeMs:entry.mtimeMs,headHash:entry.headHash,offset:entry.offset,
    modernRecords:entry.modernRecords,legacyRecords:entry.legacyRecords,
    baseline:entry.baseline,baselineSource:entry.baselineSource,modernCumulative:entry.modernCumulative,
    legacyLast:entry.legacyLast,currentTurn:entry.currentTurn,
    modernNoCumulativeTurns:entry.modernNoCumulativeTurns,turns:entry.turns,lifecycle:entry.lifecycle,
  };
}

async function writeUsageIndex(file,index){
  const directory=dirname(file);
  await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=`${file}.${process.pid}.${Date.now()}.tmp`;
  const value={
    schemaVersion:CODEX_USAGE_SCHEMA_VERSION,
    parserVersion:CODEX_USAGE_PARSER_VERSION,
    files:Object.fromEntries(Object.entries(index.files).map(([path,entry])=>[path,cleanEntry(entry)])),
  };
  try{
    await writeFile(temporary,`${JSON.stringify(value)}\n`,{mode:0o600});
    await rename(temporary,file);
  }catch(error){
    await unlink(temporary).catch(()=>{});
    throw error;
  }
}

function freshEntry(){
  return {
    ino:null,size:0,mtimeMs:null,headHash:null,offset:0,
    modernRecords:[],legacyRecords:[],
    baseline:null,baselineSource:null,modernCumulative:null,legacyLast:null,
    currentTurn:null,modernNoCumulativeTurns:[],turns:{},lifecycle:freshLifecycle(),
  };
}

async function readHead(file,size){
  const handle=await open(file,'r');
  try{
    const length=Math.min(HEAD_BYTES,size);
    const buffer=Buffer.alloc(length);
    const {bytesRead}=await handle.read(buffer,0,length,0);
    return bytesRead?createHash('sha256').update(buffer.subarray(0,bytesRead)).digest('hex'):null;
  }finally{await handle.close();}
}

function modernKeys(entry){
  if(!entry.modernKeySet)entry.modernKeySet=new Set(entry.modernRecords.map(record=>record.r).filter(Boolean));
  return entry.modernKeySet;
}

function turnOf(entry,payload){
  return nonEmpty(payload?.turn_id)||entry.currentTurn||null;
}
function normalizeCumulative(value){
  if(!isRecord(value))return null;
  return {
    i:tokenCount(value.input_tokens),
    c:tokenCount(value.cached_input_tokens),
    o:tokenCount(value.output_tokens),
    t:tokenCount(value.total_tokens)||tokenCount(value.input_tokens)+tokenCount(value.output_tokens),
  };
}
function noteMissingCumulativeTurn(entry,turn){
  if(!turn||entry.modernNoCumulativeTurns.includes(turn))return;
  entry.modernNoCumulativeTurns.push(turn);
}
function addModernRecord(entry,payload,ordinal,timestamp){
  if(!isRecord(payload)||!isRecord(payload.usage))return;
  const responseId=nonEmpty(payload.response_id);
  const key=responseId?`r:${responseId}`:ordinal!==null?`o:${ordinal}`:null;
  const keys=modernKeys(entry);
  if(key&&keys.has(key))return;
  const turn=turnOf(entry,payload);
  const usage=payload.usage;
  const record={
    r:key,t:timestamp,turn,
    i:tokenCount(usage.input_tokens),
    c:tokenCount(usage.cached_input_tokens),
    o:tokenCount(usage.output_tokens),
  };
  const cumulative=normalizeCumulative(payload.thread_token_usage);
  if(cumulative){
    const baseline=entry.baseline;
    // A paired legacy line may arrive first; its cumulative already covers this response.
    const alreadyCounted=Boolean(baseline&&cumulative.t===baseline.t);
    entry.baseline=cumulative;
    entry.baselineSource='modern';
    entry.modernCumulative=cumulative;
    if(alreadyCounted){
      if(key)keys.add(key);
      return;
    }
  }else{
    // Without a cumulative checkpoint, a turn with modern usage is resolved from the
    // modern record so a paired legacy line for the same turn is not counted twice.
    noteMissingCumulativeTurn(entry,turn);
  }
  entry.modernRecords.push(record);
  if(key)keys.add(key);
}

function addLegacyRecord(entry,payload,timestamp){
  const info=isRecord(payload.info)?payload.info:null;
  const current=normalizeCumulative(info?.total_token_usage);
  if(!current)return;
  const turn=turnOf(entry,payload);
  const baseline=entry.baseline;
  const previous=entry.legacyLast;
  let delta=null;
  if(previous&&current.t<previous.t){
    // A lower cumulative is a genuine reset unless it exactly matches the modern
    // checkpoint already accounted for (the paired line for that modern response).
    const pairedWithModern=Boolean(entry.baselineSource==='modern'
      &&entry.modernCumulative&&current.t===entry.modernCumulative.t);
    if(!pairedWithModern){
      delta=current;
      entry.baseline=current;
      entry.baselineSource='legacy';
      entry.modernCumulative=null;
    }
  }else if(baseline&&current.t>baseline.t){
    delta={
      i:Math.max(0,current.i-baseline.i),
      c:Math.max(0,current.c-baseline.c),
      o:Math.max(0,current.o-baseline.o),
      t:current.t-baseline.t,
    };
    entry.baseline=current;
    entry.baselineSource='legacy';
  }else if(!baseline){
    delta=current;
    entry.baseline=current;
    entry.baselineSource='legacy';
  }
  entry.legacyLast=current;
  if(!delta)return;
  if(!delta.i&&!delta.c&&!delta.o&&!delta.t)return;
  entry.legacyRecords.push({
    r:null,
    t:timestamp,
    turn,
    i:delta.i,
    c:delta.c,
    o:delta.o,
  });
}

function externalExecution(payload){
  if(!isRecord(payload)||!['function_call','custom_tool_call','FunctionCall'].includes(payload.type))return null;
  const name=String(payload.name||'');
  if(!/(?:exec|command|shell|execute)/i.test(name))return null;
  let input=payload.arguments??payload.input;
  if(typeof input==='string'){try{input=JSON.parse(input)}catch{input={code:input}}}
  const code=typeof input?.cmd==='string'?input.cmd:typeof input?.code==='string'?input.code:'';
  if(/(?:^|[\s'"`])qoder(?:cli)?\s+(?!--(?:help|version)\b)(?:acp\b|-p\b|--prompt\b|--yes\b|--dangerously|[^\n]*\s(?:-p\b|--prompt\b|--yes\b|--dangerously))/i.test(code)
    ||/codex-squad[^\n]{0,240}(?:index\.mjs|codex-squad)\s+(?:dispatch|continue)\b/.test(code))return 'qoder';
  return null;
}
function processLine(buffer,entry){
  const head=buffer.subarray(0,1024).toString('utf8');
  if(typeIn(head,'response_item')){
    if(!typeIn(head,'function_call')&&!typeIn(head,'custom_tool_call'))return;
    let value;try{value=JSON.parse(buffer.toString('utf8'))}catch{return}
    const executor=externalExecution(value.payload);
    if(executor&&!entry.lifecycle.externalExecutors.includes(executor))entry.lifecycle.externalExecutors.push(executor);
    return;
  }
  let kind=null;
  if(typeIn(head,'token_usage_record'))kind='usage';
  else if(typeIn(head,'turn_context'))kind='turn';
  else if(typeIn(head,'event_msg'))kind='event';
  if(!kind)return;
  let value;
  try{value=JSON.parse(buffer.toString('utf8'));}
  catch{return;}
  if(!isRecord(value)||!isRecord(value.payload))return;
  const timestamp=timestampOf(value.timestamp);
  if(kind==='turn'){
    const turn=nonEmpty(value.payload.turn_id);
    const model=nonEmpty(value.payload.model);
    if(turn)entry.currentTurn=turn;
    if(turn&&model){
      entry.turns[turn]=model;
      if(Object.keys(entry.lifecycle.turns).length<MAX_TURN_MODELS)entry.lifecycle.turns[turn]=model;
    }
    if(turn)entry.lifecycle.contexts[turn]={
      reasoning:nonEmpty(value.payload.effort)||nonEmpty(value.payload.reasoning_effort),
      sandbox:isRecord(value.payload.sandbox_policy)?JSON.stringify(value.payload.sandbox_policy):nonEmpty(value.payload.sandbox_policy),
      approval:nonEmpty(value.payload.approval_policy),
    };
    return;
  }
  if(kind==='usage'){
    const ordinal=Number.isFinite(Number(value.ordinal))?Number(value.ordinal):null;
    addModernRecord(entry,value.payload,ordinal,timestamp);
    return;
  }
  const type=value.payload.type;
  if(type==='task_started'){
    const turn=nonEmpty(value.payload.turn_id)||entry.currentTurn;
    const startedAt=epochMs(value.payload.started_at)??timestamp;
    if(turn&&startedAt!==null)entry.lifecycle.starts[turn]={startedAt};
    entry.lifecycle.lastKind='started';
    entry.lifecycle.lastAt=timestamp??startedAt;
    entry.lifecycle.lastStartedAt=startedAt;
    return;
  }
  if(type==='task_complete'){
    const turn=nonEmpty(value.payload.turn_id)||entry.currentTurn;
    const completedAt=epochMs(value.payload.completed_at)??timestamp;
    const durationMs=finiteNumber(Number(value.payload.duration_ms));
    const message=typeof value.payload.last_agent_message==='string'
      ?value.payload.last_agent_message.trim().slice(0,MAX_LIFECYCLE_MESSAGE)
      :null;
    if(turn)entry.lifecycle.completes[turn]={completedAt,durationMs,message};
    entry.lifecycle.lastKind='complete';
    entry.lifecycle.lastAt=completedAt??timestamp;
    entry.lifecycle.lastCompleteAt=completedAt??timestamp;
    if(message)entry.lifecycle.lastMessage=message;
    return;
  }
  if(type==='turn_aborted'){
    const turn=nonEmpty(value.payload.turn_id)||entry.currentTurn;
    if(turn)entry.lifecycle.aborted[turn]=true;
    entry.lifecycle.lastKind='aborted';
    entry.lifecycle.lastAt=timestamp;
    return;
  }
  if(type==='item_completed'){
    addUserMessage(entry,userMessageText(value.payload.item));
    addPublicGoal(entry,delegationGoal(value.payload.item,entry.currentTurn,timestamp));
    const executor=externalExecution(value.payload.item);
    if(executor&&!entry.lifecycle.externalExecutors.includes(executor))entry.lifecycle.externalExecutors.push(executor);
    return;
  }
  if(type==='user_message'){
    const text=typeof value.payload.message==='string'
      ?value.payload.message.replace(/\s+/g,' ').trim().slice(0,MAX_USER_MESSAGE)
      :null;
    addUserMessage(entry,text||null);
    return;
  }
  if(type!=='token_count')return;
  addLegacyRecord(entry,value.payload,timestamp);
}

async function consume(file,start,end,entry){
  const handle=await open(file,'r');
  let position=start;
  let consumed=start;
  let pending=Buffer.alloc(0);
  let discarding=false;
  try{
    const chunk=Buffer.allocUnsafe(READ_CHUNK);
    while(position<end){
      const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,end-position),position);
      if(!bytesRead)break;
      position+=bytesRead;
      pending=pending.length?Buffer.concat([pending,chunk.subarray(0,bytesRead)]):Buffer.from(chunk.subarray(0,bytesRead));
      let index;
      while((index=pending.indexOf(0x0a))>=0){
        const line=pending.subarray(0,index);
        pending=pending.subarray(index+1);
        consumed+=index+1;
        if(discarding){
          discarding=false;
          continue;
        }
        if(line.length)processLine(line,entry);
      }
      if(pending.length>MAX_PENDING_BYTES){
        consumed+=pending.length;
        pending=Buffer.alloc(0);
        discarding=true;
      }
    }
  }finally{
    await handle.close();
  }
  entry.offset=consumed;
}

async function scanFile(file,previous){
  let info;
  try{info=await stat(file);}
  catch(error){
    if(error.code==='ENOENT')return {entry:previous||null,readable:false};
    throw error;
  }
  const headHash=await readHead(file,info.size);
  const previousEntry=previous?normalizeEntry(previous):null;
  const replaced=Boolean(previousEntry&&(
    (previousEntry.ino!==null&&Number(info.ino)!==previousEntry.ino)
    ||(previousEntry.headHash&&previousEntry.headHash!==headHash)
    ||info.size<previousEntry.size
    ||info.size<previousEntry.offset
  ));
  const entry=!previousEntry||replaced?freshEntry():previousEntry;
  if(!replaced&&entry.ino===Number(info.ino)&&entry.size===info.size
    &&entry.mtimeMs===info.mtimeMs&&entry.headHash===headHash){
    return {entry,readable:true};
  }
  entry.ino=Number(info.ino);
  entry.size=info.size;
  entry.mtimeMs=info.mtimeMs;
  entry.headHash=headHash;
  await consume(file,entry.offset,info.size,entry);
  return {entry,readable:true};
}

async function scanThreads({home,threads}){
  const indexPath=codexUsageIndexPath({home});
  const previous=await readUsageIndex(indexPath);
  const files={};
  const readable=new Set();
  const scanned=new Set();
  for(const thread of threads){
    const file=thread.rolloutPath;
    if(!file||scanned.has(file))continue;
    scanned.add(file);
    try{
      const result=await scanFile(file,previous.files[file]||null);
      if(result.entry)files[file]=result.entry;
      if(result.readable)readable.add(file);
    }catch{
      if(previous.files[file])files[file]=previous.files[file];
    }
  }
  await writeUsageIndex(indexPath,{files}).catch(()=>{});
  return {index:{files},readable};
}

let scanQueue=Promise.resolve();
function serializeScan(task){
  const run=scanQueue.then(task,task);
  scanQueue=run.then(()=>undefined,()=>undefined);
  return run;
}

function emptyTotals(){
  return {inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0};
}

function addModel(target,model,record){
  let entry=target.get(model);
  if(!entry){
    entry={model,inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0};
    target.set(model,entry);
  }
  entry.inputTokens+=record.i;
  entry.cachedInputTokens+=record.c;
  entry.outputTokens+=record.o;
  entry.totalTokens+=record.i+record.o;
}

function sortModels(values){
  return [...values].sort((left,right)=>right.totalTokens-left.totalTokens||left.model.localeCompare(right.model));
}

function entryRecords(entry){
  const suppressed=new Set(entry?.modernNoCumulativeTurns||[]);
  return [
    ...(Array.isArray(entry?.modernRecords)?entry.modernRecords:[]),
    ...(Array.isArray(entry?.legacyRecords)?entry.legacyRecords:[]).filter(record=>!(record.turn&&suppressed.has(record.turn))),
  ];
}

/**
 * Bounded per-thread usage export for the benefits collector. It reuses the
 * incremental index instead of reparsing rollouts. `toMs` defaults to now for
 * the caller; no window means the complete recorded lifecycle.
 */
export function entryUsage(entry,{fromMs=null,toMs=null}={}){
  const records=entryRecords(entry);
  const selected=records.filter(record=>
    record.t!==null&&(toMs===null||record.t<=toMs)&&(fromMs===null||record.t>=fromMs));
  const models=new Map(),turns=new Map();
  let unknownModelRecords=0,undatedRecords=0;
  for(const record of records)if(record.t===null)undatedRecords+=1;
  for(const record of selected){
    const model=nonEmpty(record.turn&&entry.turns?.[record.turn])||null;
    if(!model)unknownModelRecords+=1;
    const key=model??'';
    let group=models.get(key);
    if(!group){
      group={model,inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0,records:0};
      models.set(key,group);
    }
    group.inputTokens+=record.i;
    group.cachedInputTokens+=record.c;
    group.outputTokens+=record.o;
    group.totalTokens+=record.i+record.o;
    group.records+=1;
    if(record.turn){
      let turn=turns.get(record.turn);
      if(!turn){
        turn={turnId:record.turn,model,inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0,records:0,firstAt:null,lastAt:null};
        turns.set(record.turn,turn);
      }
      if(!turn.model&&model)turn.model=model;
      turn.inputTokens+=record.i;
      turn.cachedInputTokens+=record.c;
      turn.outputTokens+=record.o;
      turn.totalTokens+=record.i+record.o;
      turn.records+=1;
      if(record.t!==null){
        if(turn.firstAt===null||record.t<turn.firstAt)turn.firstAt=record.t;
        if(turn.lastAt===null||record.t>turn.lastAt)turn.lastAt=record.t;
      }
    }
  }
  const modelList=[...models.values()]
    .map(group=>({...group}))
    .sort((left,right)=>right.totalTokens-left.totalTokens||String(left.model??'').localeCompare(String(right.model??'')));
  const totals=modelList.reduce((sum,model)=>{
    sum.inputTokens+=model.inputTokens;
    sum.cachedInputTokens+=model.cachedInputTokens;
    sum.outputTokens+=model.outputTokens;
    sum.totalTokens+=model.totalTokens;
    return sum;
  },{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0});
  return {
    records:selected,
    models:modelList,
    turns:[...turns.values()].sort((left,right)=>(left.firstAt??0)-(right.firstAt??0)||left.turnId.localeCompare(right.turnId)),
    totals,
    unknownModelRecords,
    undatedRecords,
    coverage:{records:records.length,selected:selected.length},
  };
}

function aggregateCodexUsage({threads,index,readable,days,now,squadThreadIds,analysisThreads}){
  const at=dateOf(now);
  const nowMs=at.getTime();
  const fromMs=days===null||days===undefined?null:nowMs-Number(days)*86400000;
  const squad=new Set((Array.isArray(squadThreadIds)?squadThreadIds:[]).map(nonEmpty).filter(Boolean));
  const analysis=new Map();
  for(const item of Array.isArray(analysisThreads)?analysisThreads:[]){
    const threadId=nonEmpty(item?.realCodexThreadId);
    if(!threadId)continue;
    const requestedBy=nonEmpty(item?.requestedByThreadId);
    if(!analysis.has(threadId)||(!analysis.get(threadId)&&requestedBy))analysis.set(threadId,requestedBy);
  }
  const sessions=[];
  const allModels=new Map();
  const usedPaths=new Set();
  let unattributedModelRecords=0;
  let usageThreads=0,unreportedThreads=0,unreportedWithTokens=0,undatedRecords=0;
  for(const thread of threads){
    const path=thread.rolloutPath;
    if(!path||usedPaths.has(path))continue;
    const entry=index.files[path];
    if(!entry)continue;
    usedPaths.add(path);
    const source=entryRecords(entry);
    for(const record of source)if(record.t===null)undatedRecords+=1;
    // Every window obeys the frozen cutoff. Undated records stay outside totals and
    // are reported as unconfirmed instead of silently joining the all-time view.
    const selected=source.filter(record=>
      record.t!==null&&record.t<=nowMs&&(fromMs===null||record.t>=fromMs));
    if(!selected.length){
      if(readable.has(path)){
        unreportedThreads+=1;
        if(thread.tokensUsed>0)unreportedWithTokens+=1;
      }
      continue;
    }
    usageThreads+=1;
    const sessionModels=new Map();
    const turns=new Set();
    let inputTokens=0,cachedInputTokens=0,outputTokens=0;
    selected.forEach((record,position)=>{
      const model=(record.turn&&entry.turns[record.turn])||MODEL_UNREPORTED;
      if(model===MODEL_UNREPORTED)unattributedModelRecords+=1;
      addModel(sessionModels,model,record);
      addModel(allModels,model,record);
      inputTokens+=record.i;
      cachedInputTokens+=record.c;
      outputTokens+=record.o;
      turns.add(record.turn?`t:${record.turn}`:`r:${record.r||position}`);
    });
    const kind=analysis.has(thread.threadId)?'analysis':squad.has(thread.threadId)?'squad':'unassigned';
    sessions.push({
      threadId:thread.threadId,
      title:thread.title,
      kind,
      squadThreadId:kind==='analysis'?analysis.get(thread.threadId):kind==='squad'?thread.threadId:null,
      models:sortModels(sessionModels.values()),
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens:inputTokens+outputTokens,
      turnCount:turns.size,
    });
  }
  sessions.sort((left,right)=>right.totalTokens-left.totalTokens||left.threadId.localeCompare(right.threadId));
  const totals=emptyTotals();
  for(const session of sessions){
    totals.inputTokens+=session.inputTokens;
    totals.cachedInputTokens+=session.cachedInputTokens;
    totals.outputTokens+=session.outputTokens;
    totals.totalTokens+=session.totalTokens;
  }
  const readableThreads=threads.filter(thread=>thread.rolloutPath&&readable.has(thread.rolloutPath)).length;
  return {
    schemaVersion:CODEX_USAGE_SCHEMA_VERSION,
    available:true,
    observedAt:at.toISOString(),
    scope:'local',
    totals,
    sessions,
    models:sortModels(allModels.values()),
    coverage:{
      threads:threads.length,
      readableThreads,
      missingThreads:Math.max(0,threads.length-readableThreads),
      usageThreads,
      unreportedThreads,
      unreportedWithTokens,
      undatedRecords,
      unattributedModelRecords,
    },
    note:CODEX_USAGE_NOTE,
  };
}

function emptyInventory(reason){
  return {available:false,reason,threads:[],index:{files:{}},readable:new Set()};
}
/**
 * One bounded pass over native Codex metadata plus the incremental rollout
 * index. Callers can share this inventory between the usage window and the
 * benefits collector so token records are parsed only once per cutoff.
 */
export async function collectCodexInventory({home=null,codexHome=null,env=process.env}={}){
  let metadata;
  try{metadata=await readThreadMetadata(resolveCodexHome({codexHome,env}));}
  catch{return emptyInventory('unreadable')}
  if(!metadata.available)return emptyInventory('missing');
  let scanned;
  try{scanned=await serializeScan(()=>scanThreads({home,threads:metadata.threads}));}
  catch{return emptyInventory('scan-failed')}
  return {available:true,threads:metadata.threads,index:scanned.index,readable:scanned.readable};
}

export async function loadCodexUsage({
  home=null,codexHome=null,days=null,now=new Date(),
  squadThreadIds=[],analysisThreads=[],env=process.env,inventory=null,
}={}){
  const at=dateOf(now);
  const current=inventory&&inventory.available?inventory:await collectCodexInventory({home,codexHome,env});
  if(!current.available){
    const note=current.reason==='unreadable'
      ?'本机 Codex 用量记录不可读，未计入 Codex 消耗。'
      :current.reason==='missing'
        ?'未找到本机 Codex 用量记录，未计入 Codex 消耗。'
        :'本机 Codex 用量读取失败，未计入 Codex 消耗。';
    return emptyCodexUsage({now:at,available:false,note});
  }
  return aggregateCodexUsage({
    threads:current.threads,index:current.index,readable:current.readable,
    days,now:at,squadThreadIds,analysisThreads,
  });
}

function fileStamp(info){
  if(!info)return null;
  return {ino:Number(info.ino),size:info.size,mtimeMs:info.mtimeMs};
}

export async function codexMetadataStamp({codexHome=null,env=process.env,excludeThreadIds=[]}={}){
  const stamp={
    schemaVersion:CODEX_USAGE_SCHEMA_VERSION,
    parserVersion:CODEX_USAGE_PARSER_VERSION,
    database:null,main:null,wal:null,userVersion:null,
    rowCount:null,maxUpdatedAtMs:null,maxTokensUsed:null,totalTokensUsed:null,readable:false,
  };
  const root=resolveCodexHome({codexHome,env});
  let file;
  try{file=await stateDatabase(root);}
  catch{return stamp;}
  if(!file)return stamp;
  stamp.database=basename(file);
  try{stamp.main=fileStamp(await stat(file));}catch{}
  try{stamp.wal=fileStamp(await stat(`${file}-wal`));}catch{}
  let db;
  try{
    const {DatabaseSync}=await import('node:sqlite');
    db=new DatabaseSync(file,{readOnly:true});
    stamp.userVersion=Number(db.prepare('PRAGMA user_version').get()?.user_version)||0;
    const columns=columnSet(db);
    const parts=['COUNT(*) AS rowCount'];
    if(columns.has('updated_at_ms'))parts.push('MAX(updated_at_ms) AS maxUpdatedAtMs');
    if(columns.has('tokens_used'))parts.push('MAX(tokens_used) AS maxTokensUsed','TOTAL(tokens_used) AS totalTokensUsed');
    const excluded=[...new Set(excludeThreadIds)].filter(id=>typeof id==='string'&&id);
    const where=columns.has('id')&&excluded.length?` WHERE id NOT IN (${excluded.map(()=>'?').join(',')})`:'';
    const row=db.prepare(`SELECT ${parts.join(',')} FROM threads${where}`).get(...(where?excluded:[]));
    stamp.rowCount=Number(row?.rowCount)||0;
    stamp.maxUpdatedAtMs=Number.isFinite(Number(row?.maxUpdatedAtMs))?Number(row.maxUpdatedAtMs):null;
    stamp.maxTokensUsed=Number.isFinite(Number(row?.maxTokensUsed))?Number(row.maxTokensUsed):null;
    stamp.totalTokensUsed=Number.isFinite(Number(row?.totalTokensUsed))?Number(row.totalTokensUsed):null;
    stamp.readable=true;
  }catch{
    stamp.readable=false;
  }finally{
    db?.close();
  }
  return stamp;
}
