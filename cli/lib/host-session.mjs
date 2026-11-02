import {readdir,open,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';

const HEADER_LIMIT=128*1024;
const TAIL_CHUNK=64*1024;
const TAIL_LIMIT=1024*1024;
const WATCH_CHUNK=256*1024;
const UNVERIFIED='未在本机 Codex 会话记录中核实当前会话与工作目录。';
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rolloutPattern(threadId){
  return new RegExp(`^rollout-.+-${threadId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:_[A-Za-z0-9-]+)?\\.jsonl$`);
}

// Read a bounded metadata prefix and parse only its first line.
async function readIdentityLine(file){
  const handle=await open(file,'r');
  try{
    const bytes=Buffer.alloc(HEADER_LIMIT),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
    return bytes.subarray(0,bytesRead).toString('utf8').split('\n')[0];
  }finally{await handle.close()}
}

async function matchesIdentity(file,threadId,expected){
  let line;try{line=await readIdentityLine(file)}catch(error){if(error.code==='ENOENT')return false;throw error}
  let meta;try{meta=JSON.parse(line)}catch{return false}
  const id=meta?.payload?.id||meta?.payload?.session_id,cwd=meta?.payload?.cwd;
  if(meta?.type!=='session_meta'||id!==threadId||typeof cwd!=='string')return false;
  let actual;try{actual=await realpath(cwd)}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error}
  return actual===expected;
}

async function collect(folder,depth,pattern,candidates){
  let entries;try{entries=await readdir(folder,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return;throw error}
  for(const entry of entries)if(entry.isFile()&&pattern.test(entry.name))candidates.push(join(folder,entry.name));
  if(depth<3)for(const entry of entries.filter(e=>e.isDirectory()))await collect(join(folder,entry.name),depth+1,pattern,candidates);
}

// Locate rollout candidates by their observed filenames, then trust only the identity header.
export async function verifyHostSession({threadId,cwd,options={}}){
  const env=options.env||process.env;
  const root=resolve(options.sessionsDir||join(env.CODEX_HOME||join(homedir(),'.codex'),'sessions'));
  const expected=await realpath(cwd),candidates=[];
  await collect(root,0,rolloutPattern(threadId),candidates);
  for(const file of candidates.sort((a,b)=>a<b?1:a>b?-1:0))
    if(await matchesIdentity(file,threadId,expected))return {threadId,cwd:expected,rolloutPath:file};
  throw Object.assign(new Error(UNVERIFIED),{code:'SQUAD_HOST_THREAD_UNVERIFIED'});
}

// Keep only fully persisted records: a trailing fragment is still being written, and the
// first line of a window that starts mid-line may have lost its beginning.
function completeRecords(text,startsAtLine){
  const lines=text.split('\n');
  lines.pop();
  if(!startsAtLine)lines.shift();
  const records=[];
  for(const line of lines){
    if(!line)continue;
    // Skip message-shaped records before parsing: only lifecycle carriers are relevant.
    if(!line.includes('"event_msg"')&&!line.includes('"turn_context"')&&!line.includes('"token_usage_record"'))continue;
    try{records.push(JSON.parse(line))}catch{}
  }
  return records;
}

async function startsLine(handle,position){
  if(position<=0)return true;
  const buffer=Buffer.alloc(1),{bytesRead}=await handle.read(buffer,0,1,position-1);
  return bytesRead===1&&buffer[0]===0x0a;
}

async function readTailRecords(file,options={}){
  const chunkBytes=Math.max(1024,Number(options.tailChunkBytes)||TAIL_CHUNK);
  const maxBytes=Math.max(chunkBytes,Number(options.tailMaxBytes)||TAIL_LIMIT);
  const handle=await open(file,'r');
  try{
    const {size}=await handle.stat();
    let scanned=0,parts=[],records=null;
    while(scanned<maxBytes&&scanned<size){
      const step=Math.min(chunkBytes,maxBytes-scanned,size-scanned),from=size-scanned-step;
      const buffer=Buffer.alloc(step),{bytesRead}=await handle.read(buffer,0,step,from);
      if(bytesRead<=0)break;
      parts.unshift(buffer.subarray(0,bytesRead));scanned+=bytesRead;
      const boundary=await startsLine(handle,size-scanned);
      const candidate=completeRecords(Buffer.concat(parts).toString('utf8'),boundary);
      if(candidate.length||scanned>=size){records=candidate;break;}
    }
    return {records:records||[],size,scanned,fromStart:scanned>=size};
  }finally{await handle.close()}
}

function turnKey(value){return uuidPattern.test(String(value||''))?String(value):null}

// Only lifecycle metadata is parsed: turn ownership, never message or reasoning content.
function turnMarker(record){
  if(!record||typeof record!=='object')return null;
  const payload=record.payload!==null&&typeof record.payload==='object'?record.payload:null;
  const ordinal=Number.isSafeInteger(Number(record.ordinal))?Number(record.ordinal):null;
  if(record.type==='turn_context'||record.type==='token_usage_record')return {kind:'activity',turnId:turnKey(payload?.turn_id),ordinal};
  if(record.type!=='event_msg'||!payload)return null;
  if(payload.type==='task_started')return {kind:'started',turnId:turnKey(payload.turn_id),ordinal};
  if(payload.type==='task_complete')return {kind:'completed',turnId:turnKey(payload.turn_id),ordinal};
  if(payload.type==='turn_aborted')return {kind:'aborted',turnId:turnKey(payload.turn_id),reason:typeof payload.reason==='string'?payload.reason.trim()||null:null,ordinal};
  if(payload.type==='item_completed')return {kind:'activity',turnId:turnKey(payload.turn_id),ordinal};
  return null;
}

export async function readHostTurn({rolloutPath,options={}}={}){
  if(!rolloutPath)throw Object.assign(new Error('缺少宿主会话记录路径，无法确认当前轮次。'),{code:'SQUAD_HOST_ROLLOUT_MISSING'});
  const {records,size,fromStart}=await readTailRecords(rolloutPath,options);
  const markers=records.map(turnMarker).filter(marker=>marker?.turnId);
  // Lifecycle records win over activity: a late activity record for an already completed
  // turn must not make that turn look active again.
  const lifecycle=markers.filter(marker=>marker.kind!=='activity');
  const latest=lifecycle.at(-1)||markers.at(-1);
  if(!latest)return {
    state:'unknown',turnId:null,evidence:null,reason:fromStart?'宿主会话记录中没有可识别的轮次生命周期。':'宿主会话记录尾部没有可识别的轮次生命周期。',bytes:size,
  };
  const ended=latest.kind==='aborted'||latest.kind==='completed';
  return {state:ended?'ended':'active',turnId:latest.turnId,evidence:latest.kind,reason:latest.reason||null,ordinal:latest.ordinal,bytes:size};
}

export async function readHostTurnAbort({rolloutPath,turnId,options={}}={}){
  const expected=turnKey(turnId);
  if(!expected)throw Object.assign(new Error('缺少可核实的宿主轮次标识。'),{code:'SQUAD_HOST_TURN_INVALID'});
  if(!rolloutPath)throw Object.assign(new Error('缺少宿主会话记录路径，无法核实本轮是否中断。'),{code:'SQUAD_HOST_ROLLOUT_MISSING'});
  const {records,size}=await readTailRecords(rolloutPath,options);
  let matched=null;
  for(const record of records){
    const marker=turnMarker(record);
    if(marker?.kind==='aborted'&&marker.turnId===expected)matched=marker;
  }
  if(!matched)return {aborted:false,turnId:expected,bytes:size,scanned:records.length};
  return {aborted:true,turnId:expected,reason:matched.reason||'interrupted',ordinal:matched.ordinal,bytes:size};
}

// Watch only bytes appended after the dispatch-verified offset. The cursor persists across
// polls, each poll reads a bounded amount, and an unfinished line stays buffered so chunked
// writes, UTF-8 boundaries and long log lines cannot hide a later turn_aborted record.
// Read failures and log truncation/replacement are reported once as unconfirmed, never as a stop.
export function watchHostTurn({rolloutPath,turnId,offset=0,onAbort=()=>{},onUnconfirmed=()=>{},intervalMs=500,maxBytesPerPoll=WATCH_CHUNK}={}){
  if(!rolloutPath||!turnKey(turnId))return ()=>{};
  const numeric=Number(offset);
  let cursor=Number.isSafeInteger(numeric)&&numeric>=0?numeric:0;
  let closed=false,reported=false,polling=false,identity=null,pending=Buffer.alloc(0),skipLine=false;
  let timer=null,catchup=null;
  const fail=message=>{
    if(closed||reported)return;
    reported=true;
    onUnconfirmed(Object.assign(new Error(message),{code:'SQUAD_HOST_ROLLOUT_UNCONFIRMED'}));
  };
  const scan=chunk=>{
    let from=0;
    while(from<chunk.length){
      const index=chunk.indexOf(0x0a,from),end=index<0?chunk.length:index;
      const piece=chunk.subarray(from,end);
      if(!skipLine){
        // Lifecycle records are small. Discard an oversized non-lifecycle line while
        // retaining its newline boundary, instead of buffering tool output without limit.
        if(pending.length+piece.length>64*1024){pending=Buffer.alloc(0);skipLine=true;}
        else pending=pending.length?Buffer.concat([pending,piece]):Buffer.from(piece);
      }
      if(index<0)break;
      const line=pending;pending=Buffer.alloc(0);
      const skipped=skipLine;skipLine=false;from=index+1;
      if(skipped)continue;
      if(!line.includes('"event_msg"')||!line.includes('"turn_aborted"'))continue;
      let record;
      try{record=JSON.parse(line.toString('utf8'))}catch{continue}
      const payload=record?.payload;
      if(record?.type!=='event_msg'||payload?.type!=='turn_aborted'||String(payload.turn_id||'')!==turnId)continue;
      return {aborted:true,turnId,reason:typeof payload.reason==='string'&&payload.reason.trim()?payload.reason.trim():'interrupted'};
    }
    return null;
  };
  const poll=async()=>{
    if(closed||polling)return;
    polling=true;let more=false;
    try{
      const handle=await open(rolloutPath,'r');
      try{
        const info=await handle.stat();
        if(!identity)identity={dev:info.dev,ino:info.ino};
        else if(info.dev!==identity.dev||info.ino!==identity.ino)return fail('宿主会话记录已被替换，无法确认本轮中断。');
        if(info.size<cursor)return fail('宿主会话记录已截断，无法确认本轮中断。');
        if(info.size===cursor)return;
        const budget=Math.max(1024,Math.min(Number(maxBytesPerPoll)||WATCH_CHUNK,info.size-cursor));
        const chunk=Buffer.alloc(budget);
        const {bytesRead}=await handle.read(chunk,0,budget,cursor);
        if(bytesRead<=0)return;
        cursor+=bytesRead;
        more=cursor<info.size;
        const found=scan(chunk.subarray(0,bytesRead));
        if(!found)return;
        closed=true;
        if(timer)clearInterval(timer);
        onAbort(found);
      }finally{await handle.close()}
    }catch(error){fail(`宿主会话记录不可读：${error.message}`)}
    finally{
      polling=false;
      // Catch up cooperatively after a burst instead of adding one poll interval
      // per chunk to the user's stop latency.
      if(more&&!closed){catchup=setTimeout(()=>void poll(),0);catchup.unref?.();}
    }
  };
  timer=setInterval(()=>void poll(),Math.max(25,Number(intervalMs)||500));
  timer.unref?.();
  void poll();
  return ()=>{closed=true;if(timer)clearInterval(timer);if(catchup)clearTimeout(catchup)};
}
