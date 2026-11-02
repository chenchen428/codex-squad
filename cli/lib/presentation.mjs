/** @typedef {{inputTokens?:number|null,outputTokens?:number|null,cachedInputTokens?:number|null,totalTokens?:number|null}} PublicUsage */
const busy=new Set(['starting','running','stopping','in_progress']);
export const active=status=>busy.has(status);
export const statusLabel=status=>({idle:'待命',backlog:'待执行',todo:'待执行',queued:'排队中',starting:'启动中',running:'处理中',in_progress:'处理中',stopping:'停止中',completed:'已返回',waiting_review:'待核验',in_review:'待核验',waiting:'待核验',verifying:'Codex核验中',awaiting_record:'待核对',accepted:'已完成',done:'已完成',cancelled:'已取消',superseded:'已被替代',failed:'执行失败',blocked:'等待处理',stopped:'已停止',interrupted:'已中断',unknown:'状态待核实'}[status]||'状态待核实');
/** Relative within 24h, then the recorded local date; invalid or missing values render nothing. */
export function relativeTimeLabel(value,now=Date.now()){
  const time=Date.parse(value||'');
  if(!Number.isFinite(time)||!Number.isFinite(now))return '';
  const elapsed=Math.max(0,now-time);
  if(elapsed<60000)return '刚刚';
  if(elapsed<3600000)return `${Math.floor(elapsed/60000)}分钟前`;
  if(elapsed<86400000)return `${Math.floor(elapsed/3600000)}小时前`;
  return new Date(time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
const UNREPORTED='未上报';
/**
 * One decimal unit system for every recorded token count (board, detail, navigation and analysis).
 * Promotion happens after rounding so 999.95K never renders as 1000.0K and 999.999M becomes 1.00B.
 */
export function tokenParts(value){
  if(typeof value!=='number'||!Number.isFinite(value))return {value:UNREPORTED,unit:''};
  if(value>=1e9)return {value:(value/1e9).toFixed(2),unit:'B'};
  if(value>=1e6){
    if(Number((value/1e6).toFixed(2))>=1000)return {value:(value/1e9).toFixed(2),unit:'B'};
    return {value:(value/1e6).toFixed(2),unit:'M'};
  }
  if(value>=1e3){
    if(Number((value/1e3).toFixed(1))>=1000)return {value:(value/1e6).toFixed(2),unit:'M'};
    return {value:(value/1e3).toFixed(1),unit:'K'};
  }
  return {value:String(value),unit:''};
}
export function tokenLabel(value){
  const parts=tokenParts(value);
  return `${parts.value}${parts.unit}`;
}
export const number=tokenLabel;
/** Elapsed execution time, including continuations; an unknown worker is never treated as running. */
export function durationOf(task,now=Date.now()){
  let milliseconds=0,known=false,running=false;
  for(const attempt of task.attempts){
    const start=Date.parse(attempt.startedAt),end=Date.parse(attempt.endedAt);
    if(!Number.isFinite(start))continue;
    if(Number.isFinite(end)&&end>=start){milliseconds+=end-start;known=true}
    else if(active(task.status)&&active(attempt.status)&&now>=start){milliseconds+=now-start;known=true;running=true}
  }
  return {milliseconds:known?milliseconds:null,running};
}
export function durationLabel(value){
  if(value==null)return '耗时未记录';
  const seconds=Math.max(0,Math.floor(value/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
  return hours?`${hours}:${String(minutes).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${minutes}:${String(seconds%60).padStart(2,'0')}`;
}
/** @param {Array<any>} attempts @returns {PublicUsage & {partial:boolean;reported:number;count:number}} */
export function usageOf(attempts){
  const keys=['inputTokens','outputTokens','cachedInputTokens','totalTokens'];
  const values=Object.fromEntries(keys.map(key=>{const reported=attempts.map(a=>a.usage?.[key]).filter(v=>typeof v==='number');return [key,reported.length?reported.reduce((sum,v)=>sum+v,0):null]}));
  return {...values,partial:attempts.some(a=>!a.usage||keys.slice(0,2).some(k=>typeof a.usage[k]!=='number')),reported:attempts.filter(a=>a.usage).length,count:attempts.length};
}

const secretMask='[secret]';
/** Browser-safe public redaction for transferred handoff text; never expose credentials in the shared conversation. */
export function publicSafeText(value){
  return String(value??'')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,secretMask)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gi,secretMask)
    .replace(/(\b(?:set-cookie|cookie)["']?\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^"'\r\n]+)/gi,`$1${secretMask}`)
    .replace(/(\bauthorization["']?\s*:\s*)(?:"(?:basic|bearer)\s+[^"\r\n]*"|'(?:basic|bearer)\s+[^'\r\n]*'|(?:basic|bearer)\s+[^\s"'`,;]+)/gi,`$1${secretMask}`)
    .replace(/\bbearer\s+[^\s"'`,;]+/gi,secretMask)
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|RUN[_-]?TICKET)[A-Z0-9_]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;}]+)/gi,`$1${secretMask}`)
    .replace(/((?:^|\s)--?(?:token|secret|password|passwd|api[-_]?key|access[-_]?key)(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;}]+)/gi,`$1${secretMask}`)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,secretMask)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,secretMask)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,secretMask)
    .replace(/(?:\bbearer\s+|\brun[_ -]?ticket\s*[=:]\s*|\baccess[_ -]?token\s*[=:]\s*|\bclient[_ -]?secret\s*[=:]\s*|--?(?:token|password|secret|api[-_]?key)\s+)[^\s"'`]+/gi,secretMask)
    .replace(/\b(?:access[_ -]?token|client[_ -]?secret|token|secret|password|api[-_]?key)["']?\s*[:=]\s*["']?[^\s"'`,}]+/gi,secretMask)
    .replace(/\b(?:sk|ak|token|secret|password)[-_=:][A-Za-z0-9._-]{8,}\b/gi,secretMask);
}
function handoffValue(value){return publicSafeText(String(value??'').replace(/\0/g,'')).trim()}
function handoffList(value){
  return (Array.isArray(value)?value:[]).filter(item=>typeof item==='string')
    .map(item=>handoffValue(item)).filter(Boolean).map(item=>`- ${item}`).join('\n');
}
const handoffLabels={initial:'首次交办',supplementary:'补充交办'};
/** Exact handoff role labels; ordinary messages must never reuse them. */
export function handoffRoleLabel(handoff){
  return `Codex · ${handoffLabels[handoff?.kind==='supplementary'?'supplementary':'initial']}`;
}
function handoffMeta(attempt,first,position=0){
  const reported=Number(attempt.index);
  const index=Number.isSafeInteger(reported)&&reported>0?reported:position+1;
  return {kind:index===1||first?'initial':'supplementary',attemptIndex:index,attemptId:String(attempt.id||'')};
}
function handoffText(attempt,meta){
  const handoff=attempt.handoff||{};
  const sections=[
    ['目标',handoffValue(handoff.goal)],
    ['补充背景',handoffValue(handoff.context)],
    ['允许范围与变化',handoffList(handoff.scope)],
    ['必要写入路径',handoffList(handoff.writePaths)],
    ['验收要求',handoffList(handoff.criteria)],
    ['检查原因',handoffValue(handoff.reason)],
  ].filter(([,value])=>value);
  return [`第${meta.attemptIndex}轮 · ${handoffLabels[meta.kind]}`,...sections.map(([label,value])=>`${label}\n${value}`)].join('\n\n');
}

const responseKinds=new Set(['tool','tool_use','tool_result']);
function publicResponse(event){
  if(!event)return false;
  return responseKinds.has(event.kind)||event.kind==='message'&&event.role==='assistant'&&Boolean(String(event.text||'').trim());
}
function responseEvent(event){
  if(!event)return false;
  if(event.type==='SQUAD_ATTEMPT_EVENT')return publicResponse(event.payload);
  if(event.type)return false;
  return publicResponse(event);
}
function attemptTerminal(status,endedAt,activeAttempt){
  if(endedAt)return true;
  if(['completed','failed','stopped','interrupted'].includes(String(status||'')))return true;
  return activeAttempt!==true;
}
/**
 * Delivery is only claimed from protocol evidence: an actual prompt write that
 * completed, and a public assistant/tool response from this attempt. A result
 * string is never proof — it may be an executor error, cancellation or summary.
 */
export function deliveryFromEvents(events,{status='',endedAt=null,activeAttempt=false}={}){
  const list=(Array.isArray(events)?events:[]).filter(Boolean);
  const submitted=list.find(event=>event.type==='SQUAD_PROMPT_SUBMITTED');
  const responded=list.find(responseEvent);
  const terminal=attemptTerminal(status,endedAt,activeAttempt);
  return {
    state:responded?'received':submitted?'sent':terminal?'unconfirmed':'pending',
    terminal,
    submittedAt:submitted?String(submitted.payload?.at||submitted.occurredAt||'')||null:null,
    respondedAt:responded?String(responded.time||responded.occurredAt||'')||null:null,
  };
}
export const deliveryLabel=delivery=>({received:'已收到',sent:'已发送',pending:'送达待确认',unconfirmed:'未确认送达'}[delivery?.state]||'送达待确认');

function hasHandoff(handoff){
  if(!handoff)return false;
  if([handoff.goal,handoff.context,handoff.reason].some(value=>handoffValue(value)))return true;
  return [handoff.scope,handoff.criteria,handoff.writePaths].some(list=>Array.isArray(list)&&list.length>0);
}
/** Only explicit public messages and real handoffs; tool events and private reasoning are never dialogue. @param {any} task */
export function dialogue(task){
  const messages=[],attempts=Array.isArray(task.attempts)?task.attempts:[];
  const indexed=attempts.some(attempt=>Number(attempt.index)===1);
  let handoffSeen=false;
  for(const [position,attempt] of attempts.entries()){
    if(hasHandoff(attempt.handoff)){
      const meta=handoffMeta(attempt,!indexed&&!handoffSeen,position);
      const delivery=attempt.delivery||deliveryFromEvents(attempt.events,{status:attempt.status,endedAt:attempt.endedAt,activeAttempt:active(task.status)&&active(attempt.status)});
      messages.push({
        id:`${attempt.id}:handoff`,role:'user',text:handoffText(attempt,meta),time:attempt.startedAt,summary:null,
        kind:'handoff',handoff:{...meta,delivery},
      });
      handoffSeen=true;
    }
    const events=(attempt.events||[]).filter(e=>e.kind==='message'&&!e.toolName&&['assistant','user'].includes(e.role||'')&&e.text.trim());
    for(const event of events)messages.push({id:event.id,role:event.role,text:event.text,time:event.time,summary:null,kind:'message'});
    const result=attempt.result?.trim();
    const publicReplies=events.filter(e=>e.role==='assistant').map(e=>e.text.trim());
    // Protocol messages carry revision/status; their result is an aggregate of the same replies, redacted per chunk.
    const protocolReply=events.some(e=>e.role==='assistant'&&typeof e.revision==='number'&&e.status==='completed');
    // Some runners report a final result after the same message, others combine progress + final.
    if(result&&!protocolReply&&result!==publicReplies.join('\n').trim()&&result!==publicReplies.join('')){
      const matching=events.find(e=>e.role==='assistant'&&(e.text.trim()===result||e.text.length>=4000&&result.startsWith(e.text.trim())));
      if(matching){const message=messages.find(m=>m.id===matching.id);message.text=result;}
      else messages.push({id:`${attempt.id}:result`,role:'assistant',text:result,time:attempt.endedAt,summary:null,kind:'message'});
    }
  }
  return messages;
}

const toolKinds=new Set(['tool','tool_use','tool_result']);
const processKinds=new Set([...toolKinds,'progress']);
/** Public execution status and bounded tool details; raw reasoning never enters this projection. @param {any} task */
function processEvents(task){return task.attempts.flatMap(attempt=>(attempt.events||[]).filter(event=>processKinds.has(event.kind)).map(event=>({...event,attemptId:attempt.id})))}
/** Only real tool records are listed; progress updates stay out of the command list. @param {any} task */
export function processOf(task){return processEvents(task).filter(event=>toolKinds.has(event.kind))}
/** @param {any} task */
export function latestProcess(task){return processEvents(task).sort((a,b)=>String(a.updatedAt||a.time||'').localeCompare(String(b.updatedAt||b.time||''))).at(-1)}

const processStates={running:'running',in_progress:'running',starting:'running',streaming:'running',pending:'waiting',queued:'waiting',completed:'done',succeeded:'done',success:'done',ok:'done',failed:'failed',error:'failed',stopped:'stopped',canceled:'stopped',cancelled:'stopped',interrupted:'stopped'};
const processStatusLabels={running:'执行中',waiting:'等待中',done:'完成',failed:'失败',stopped:'已停止'};
const SUMMARY_LIMIT=120;
function clipSummary(text,limit=SUMMARY_LIMIT){if(text.length<=limit)return text;let cut=limit-1;const code=text.charCodeAt(cut);if(code>=0xDC00&&code<=0xDFFF&&text.charCodeAt(cut-1)>=0xD800&&text.charCodeAt(cut-1)<=0xDBFF)cut--;return text.slice(0,cut).trimEnd()+'…'}
function firstLine(value){const lines=String(value??'').replace(/\0/g,'').replace(/^\uFEFF/,'').split(/\r\n|\r|\n/);return lines.map(line=>line.trim()).find(Boolean)||''}
function plainLine(value){return firstLine(value).replace(/\s+/g,' ').trim()}
function stripHeredoc(line){
  let value=line;
  for(;;){
    let quote='',found=-1;
    for(let i=0;i<value.length;i++){
      const ch=value[i];
      if(quote){if(ch==='\\'&&quote==='"'){i++;continue}if(ch===quote)quote='';continue}
      if(ch==="'"||ch==='"'){quote=ch;continue}
      if(ch==='<'&&value[i+1]==='<'&&value[i+2]!=='<'&&value[i-1]!=='<'&&(i===0||/\s/.test(value[i-1]))){found=i;break}
    }
    if(found<0)break;
    const match=/^<<-?\s*(?:'[^']*'|"[^"]*"|[^\s;&|<>]+)/.exec(value.slice(found));
    if(!match)break;
    value=value.slice(0,found)+value.slice(found+match[0].length);
  }
  return value;
}
function beforeRedirect(line){
  let quote='';
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quote){if(ch==='\\'&&quote==='"'){i++;continue}if(ch===quote)quote='';continue}
    if(ch==="'"||ch==='"'){quote=ch;continue}
    if(ch!=='>'||line[i-1]==='<'||line[i-1]==='-'||line[i-1]==='=')continue;
    const before=line[i-1]||'',before2=line[i-2]||'';
    const fd=/\d/.test(before)&&(i-1===0||/\s/.test(before2));
    const both=before==='&'&&(i-1===0||/\s/.test(before2));
    if(i===0||/\s/.test(before)||fd||both)return line.slice(0,i).replace(/[\s\d&]+$/,'').trim();
  }
  return line;
}
function commandSummary(value){return beforeRedirect(stripHeredoc(plainLine(value))).replace(/\s+/g,' ').trim()}
/** Subdued one-line state for a tool record; outputs and full scripts never enter the summary. */
export function processState(event){
  const status=processStates[String(event?.status||'').trim().toLowerCase()];
  if(status)return status;
  if(event?.ok===false)return 'failed';
  if(event?.ok===true)return 'done';
  return '';
}
export function processStatus(event){
  const state=processState(event),raw=String(event?.status||'').replace(/\s+/g,' ').trim();
  return processStatusLabels[state]||(raw?clipSummary(raw,24):'');
}
export function processSummary(event){
  const tool=String(event?.toolName||'').trim(),toolLabel=tool&&tool!=='tool'?tool:'';
  const detail=event?.kind==='tool_result'?'':commandSummary(event?.text);
  return {action:clipSummary([toolLabel,detail].filter(Boolean).join(' · ')||'未记录操作'),state:processState(event),status:processStatus(event)};
}
/** Running hint and overview reuse the same short summary instead of dumping the script. */
export function processHint(event){
  if(!event)return '';
  if(event.kind==='progress')return clipSummary(plainLine(event.text)||processStatus(event)||'执行中');
  const {action,status}=processSummary(event);
  return [action,status].filter(Boolean).join(' · ');
}
