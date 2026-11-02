import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';

const checkStatuses=new Set(['passed','failed','not_run','unknown']);
const statusAliases=Object.freeze({pass:'passed',success:'passed',succeeded:'passed',ok:'passed',fail:'failed',failure:'failed',error:'failed',not_run:'not_run',notrun:'not_run','not-run':'not_run',skipped:'not_run',unknown:'unknown'});
const MAX_LIST=50,MAX_ARTIFACT_LENGTH=500,MAX_HASH_BYTES=20*1024*1024;

function text(value){return typeof value==='string'?value.trim():'';}
function digest(value){return createHash('sha256').update(String(value)).digest('hex');}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function stringList(value,issues,field){
  if(value===undefined)return [];
  if(!Array.isArray(value)){issues.push(`${field} 必须是字符串数组`);return []}
  const list=[];
  for(const item of value.slice(0,MAX_LIST)){
    const candidate=text(item);
    if(!candidate){issues.push(`${field} 含空项`);continue}
    if(candidate.length>MAX_ARTIFACT_LENGTH)issues.push(`${field} 项过长，已截断`);
    list.push(candidate.slice(0,MAX_ARTIFACT_LENGTH));
  }
  if(value.length>MAX_LIST)issues.push(`${field} 超过 ${MAX_LIST} 项，已截断`);
  return list;
}
function normalizeCheck(value,index,issues){
  if(!isRecord(value)){issues.push(`checks[${index}] 必须是对象`);return null}
  const name=text(value.name).slice(0,300);
  if(!name){issues.push(`checks[${index}] 缺少 name`);return null}
  const raw=text(value.status).toLowerCase();
  const status=checkStatuses.has(raw)?raw:statusAliases[raw];
  if(!status){issues.push(`checks[${index}] status 只能是 passed|failed|not_run|unknown`);return null}
  return {
    name,status,source:'member_reported',
    evidence:text(value.evidence).slice(0,1000),
  };
}

function candidateBlocks(markdown){
  const value=String(markdown||'');
  const blocks=[];
  const fence=/```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g;
  for(const match of value.matchAll(fence))blocks.push({kind:'fence',json:match[1]});
  const line=/^[ \t]*SQUAD_DELIVERY:[ \t]*(\{.*\})[ \t]*$/gm;
  for(const match of value.matchAll(line))blocks.push({kind:'marker',json:match[1]});
  return blocks;
}
function deliveryShape(value){
  return isRecord(value)&&Number(value.schemaVersion)===1&&Boolean(text(value.conclusion))
    &&(Array.isArray(value.artifacts)||Array.isArray(value.checks)||Array.isArray(value.remaining));
}

/**
 * Members state delivery in their public final reply. Only an explicit structure counts;
 * a dedicated SQUAD_DELIVERY marker wins, otherwise the last delivery-shaped block does.
 * Prose and arbitrary business JSON are never converted into a claimed artifact or check.
 */
export function parseDeliveryChecklist(markdown){
  const issues=[];
  let invalid=false;
  const blocks=candidateBlocks(markdown);
  const ordered=[...blocks.filter((block)=>block.kind==='marker').reverse(),...blocks.filter((block)=>block.kind==='fence').reverse()];
  for(const candidate of ordered){
    let value;
    try{value=JSON.parse(candidate.json);}
    catch{invalid=true;issues.push('交付清单 JSON 无法解析');continue}
    if(!isRecord(value)||Number(value.schemaVersion)!==1){invalid=true;issues.push('交付清单必须包含 schemaVersion:1');continue}
    const conclusion=text(value.conclusion).slice(0,4000);
    if(!conclusion){invalid=true;issues.push('交付清单缺少 conclusion');continue}
    if(!deliveryShape(value)){invalid=true;issues.push('交付清单必须包含 artifacts、checks 或 remaining 中的至少一项');continue}
    const checks=[];
    if(value.checks!==undefined&&!Array.isArray(value.checks))issues.push('checks 必须是数组');
    if(Array.isArray(value.checks))for(const [index,item] of value.checks.slice(0,MAX_LIST).entries()){
      const check=normalizeCheck(item,index,issues);
      if(check)checks.push(check);
    }
    return {
      schemaVersion:1,source:'member_reported',available:true,conclusion,
      artifacts:stringList(value.artifacts,issues,'artifacts'),
      checks,remaining:stringList(value.remaining,issues,'remaining'),issues,
    };
  }
  return {schemaVersion:1,source:'member_reported',available:false,reason:invalid?'invalid':'missing',issues};
}

export function deliveryInstruction(){
  return [
    '',
    '本轮交付清单（必须写在最终公开回复末尾的独立 JSON 代码块中）：',
    '```json',
    '{"schemaVersion":1,"conclusion":"本轮结论","artifacts":["相对工作目录的产物路径"],"checks":[{"name":"检查项","status":"passed|failed|not_run|unknown","evidence":"实际输出摘要"}],"remaining":["剩余事项"]}',
    '```',
    '清单只写真实执行过的检查和真实存在的产物；没有执行或无法确认时写 not_run/unknown，不要补写未验证的结论。',
  ].join('\n');
}

function invalidPath(value){
  return typeof value!=='string'||!value.trim()||isAbsolute(value)||/[\0\r\n*?\[\]{}\\]/.test(value)||value.split('/').includes('..');
}
async function realTarget(file){
  try{return await realpath(file);}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=dirname(file);
    if(parent===file)throw error;
    return resolve(await realTarget(parent),relative(parent,file));
  }
}
function inScope(path,writePaths){
  const scopes=Array.isArray(writePaths)&&writePaths.length?writePaths:['.'];
  return scopes.some(scope=>scope==='.'||path===scope||path.startsWith(`${scope}/`));
}
function within(root,path){
  const value=relative(root,path);
  return value!==''&&value!=='.'&&value!=='..'&&!value.startsWith(`..${sep}`)&&!isAbsolute(value)?value.split(sep).join('/'):null;
}

async function inspectArtifact(workspace,root,declared,writePaths){
  if(invalidPath(declared))return {path:declared,exists:false,inScope:false,error:'invalid_path',source:'program_checked'};
  const target=await realTarget(resolve(root,declared)).catch(()=>null);
  if(!target)return {path:declared,exists:false,inScope:false,error:'unreadable',source:'program_checked'};
  const inside=within(root,target);
  if(inside===null)return {path:declared,exists:false,inScope:false,error:'outside_workspace',source:'program_checked'};
  const info=await stat(target).catch(()=>null);
  if(!info)return {path:declared,exists:false,inScope:inScope(inside,writePaths),error:'missing',source:'program_checked'};
  const record={path:declared,resolved:inside,exists:true,kind:info.isDirectory()?'directory':'file',size:Number(info.size||0),inScope:inScope(inside,writePaths),source:'program_checked'};
  if(info.isFile()&&info.size<=MAX_HASH_BYTES){
    try{record.sha256=createHash('sha256').update(await readFile(target)).digest('hex');}
    catch{record.error='unreadable';}
  }else if(info.isFile()){
    record.sha256=null;record.error='too_large_to_hash';
  }
  return record;
}

function splitChecks(checks,status){
  const executed=[],interrupted=[],unknown=[];
  for(const check of checks||[]){
    if(check.status==='passed'||check.status==='failed')executed.push(check);
    else if(status==='stopped'||status==='interrupted')interrupted.push(check);
    else unknown.push(check);
  }
  return {executed,interrupted,unknown};
}

function failurePhase({diagnostic,persistenceError,error}){
  if(persistenceError)return {phase:'record_save',phaseConfirmed:true};
  if(diagnostic?.stage==='model-request')return {phase:'model_request',phaseConfirmed:true};
  const message=String(error||'');
  if(/session\/(?:resume|load)|does not support loading sessions/i.test(message))return {phase:'native_resume',phaseConfirmed:true};
  if(/session\/new|model catalog|model discovery|模型目录/i.test(message))return {phase:'directory_discovery',phaseConfirmed:true};
  if(/session\/prompt/i.test(message))return {phase:'model_request',phaseConfirmed:true};
  return {phase:'unconfirmed',phaseConfirmed:false};
}
const recoveryByPhase=Object.freeze({
  directory_discovery:'确认工作目录与 Qoder 安装可用后，由主 Codex 决定是否重新交办。',
  native_resume:'原执行会话不可恢复，需要主 Codex 明确新交办；不要静默新建会话。',
  model_request:'确认网络、代理与模型目录可用后，由主 Codex 决定是否重新交办。',
  tool_execution:'检查失败工具的实际输出后，由主 Codex 决定是否续接。',
  record_save:'核对本地记录可用后，由主 Codex 重新读取并核验本轮产物。',
  unconfirmed:'读取原生会话与执行记录确认失败阶段后，再由主 Codex 决定下一步。',
});

export function buildFailureReceipt({checklist,status,error,nativeSessionId,diagnostic,persistenceError}){
  if(status!=='failed')return null;
  const {phase,phaseConfirmed}=failurePhase({diagnostic,persistenceError,error});
  const split=splitChecks(checklist?.available?checklist.checks:[],status);
  const checksWithoutEvidence=split.executed.filter(check=>!check.evidence).map(check=>({name:check.name,status:check.status}));
  const confirmedArtifacts=(checklist?.program?.artifacts||[]).filter(item=>item.exists&&item.inScope).map(item=>({path:item.path,sha256:item.sha256||null}));
  return {
    phase,phaseConfirmed,message:String(error||'执行器未返回完成回执。').slice(0,2000),
    confirmedArtifacts,
    checks:{...split,withoutEvidence:checksWithoutEvidence},
    recoveryConditions:[recoveryByPhase[phase]||recoveryByPhase.unconfirmed],
    nativeSessionId:nativeSessionId||null,
    retryable:false,autoRetry:false,
  };
}

export async function verifyDeliveryChecklist({
  markdown='',workspace,writePaths=['.'],status='completed',error=null,nativeSessionId=null,
  startedAt=null,endedAt=null,diagnostic=null,persistenceError=null,now=()=>new Date().toISOString(),
}={}){
  const parsed=parseDeliveryChecklist(markdown);
  const root=await realpath(workspace);
  const declared=parsed.available?parsed.artifacts:[];
  const artifacts=[];
  for(const path of declared)artifacts.push(await inspectArtifact(workspace,root,path,writePaths));
  const missing=artifacts.filter(item=>!item.exists&&(!item.error||item.error==='missing')).map(item=>item.path);
  const outOfScope=artifacts.filter(item=>item.exists&&!item.inScope).map(item=>item.path);
  const unreadable=artifacts.filter(item=>item.error&&item.error!=='missing').map(item=>({path:item.path,error:item.error}));
  const fingerprint=digest(JSON.stringify(artifacts.map(item=>[item.path,item.sha256||null]).sort(([left],[right])=>left.localeCompare(right))));
  const durationMs=startedAt&&endedAt?Math.max(0,Date.parse(endedAt)-Date.parse(startedAt)):null;
  const gaps=[];
  if(!parsed.available)gaps.push(parsed.reason==='missing'?'成员未在最终回复中提供结构化交付清单。':'成员提供的交付清单无法解析。');
  for(const path of missing)gaps.push(`清单产物不存在：${path}`);
  for(const path of outOfScope)gaps.push(`清单产物超出写入范围：${path}`);
  for(const item of unreadable)gaps.push(`清单产物无法核验：${item.path}（${item.error}）`);
  if(parsed.available&&!artifacts.length)gaps.push('清单未列出可核验产物。');
  for(const check of parsed.available?parsed.checks:[])if(check.status!=='passed')gaps.push(`检查未通过：${check.name}（${check.status}）`);
  const checksWithoutEvidence=(parsed.available?parsed.checks:[])
    .filter(check=>(check.status==='passed'||check.status==='failed')&&!check.evidence)
    .map(check=>({name:check.name,status:check.status}));
  for(const check of checksWithoutEvidence)gaps.push(`检查缺少可核验证据：${check.name}（${check.status}，仅成员声称）`);
  const record={
    schemaVersion:1,source:'member_reported',available:parsed.available,
    ...(parsed.available?{conclusion:parsed.conclusion,artifacts:declared,checks:parsed.checks,remaining:parsed.remaining}:{reason:parsed.reason}),
    ...(checksWithoutEvidence.length?{checksWithoutEvidence}:{}),
    ...(parsed.issues?.length?{issues:parsed.issues}:{}),
    program:{
      source:'program_checked',status,startedAt:startedAt||null,endedAt:endedAt||null,durationMs,
      artifacts,fingerprint,verifiedAt:now(),missing,outOfScope,unreadable,
    },
    gaps,
  };
  record.failure=buildFailureReceipt({checklist:record,status,error,nativeSessionId,diagnostic,persistenceError});
  return record;
}

/** Re-hash only the current round's declared artifacts; a read never rewrites the record. */
export async function reverifyDeliveryChecklist(workspace,checklist){
  if(!checklist?.available||!Array.isArray(checklist.program?.artifacts))return {checked:false,changedSinceVerification:false,artifacts:[]};
  const root=await realpath(workspace);
  const artifacts=[];
  for(const item of checklist.program.artifacts)artifacts.push(await inspectArtifact(workspace,root,item.path,['.']));
  const current=digest(JSON.stringify(artifacts.map(item=>[item.path,item.sha256||null]).sort(([left],[right])=>left.localeCompare(right))));
  return {checked:true,changedSinceVerification:current!==checklist.program.fingerprint,currentFingerprint:current,artifacts};
}
