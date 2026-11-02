import {open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadQoderAttemptUsage} from './qoder-model-evidence.mjs';

export const QODER_DISABLED_TOOLS=Object.freeze(['Agent','EnterPlanMode','ExitPlanMode']);
export function qoderClientOptions(workspace,source=process.env){
  const env=Object.fromEntries(Object.entries(source).filter(([key])=>!key.startsWith('CODEX_')));
  return {command:'qodercli',cwd:resolve(workspace),env,args:[
    '--settings',JSON.stringify({general:{plan:{enabled:false}},tools:{exclude:QODER_DISABLED_TOOLS}}),
    '--disallowed-tools',QODER_DISABLED_TOOLS.join(','),'--max-model-request-retries','1',
  ]};
}

// Only the current native turn's explicit API-error record is read; no reasoning is exposed.
export async function qoderFailureDiagnostic({workspace,nativeSessionId,startedAt},options={}){
  if(!/^[a-f0-9-]{36}$/i.test(nativeSessionId||'')||!Number.isFinite(Date.parse(startedAt)))return null;
  const file=join(options.home||homedir(),'.qoder','projects',resolve(workspace).replace(/[^a-zA-Z0-9]/g,'-'),`${nativeSessionId}.jsonl`);
  let handle;try{handle=await open(file,'r')}catch(error){if(error.code==='ENOENT')return null;throw error}
  try{
    const info=await handle.stat(),start=Math.max(0,info.size-128000),bytes=Buffer.alloc(info.size-start);
    await handle.read(bytes,0,bytes.length,start);const lines=bytes.toString('utf8').split('\n');if(start)lines.shift();
    for(const line of lines.reverse()){
      let row;try{row=JSON.parse(line)}catch{continue}
      if(row.sessionId!==nativeSessionId||resolve(row.cwd||'')!==resolve(workspace)||(!Number.isFinite(Date.parse(row.timestamp))||Date.parse(row.timestamp)<Date.parse(startedAt))||!row.isApiErrorMessage)continue;
      if(typeof row.errorDetails==='string'&&/NetworkAttemptError.*response_headers/.test(row.errorDetails))return {
        code:'QODER_NETWORK_RESPONSE_HEADERS',stage:'model-request',
        message:'Qoder 模型请求在等待响应头时连接失败。请核对本机网络或代理，恢复后可沿原会话继续。',
      };
      return null;
    }
    return null;
  }finally{await handle.close()}
}

function token(value){
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.trunc(value):null;
}
function hasEvidence(usage){
  if(!usage||typeof usage!=='object')return false;
  return ['inputTokens','outputTokens','cachedInputTokens','totalTokens'].some(key=>token(usage[key])>0);
}

/**
 * A stopped or failed ACP prompt can report zero usage. Zeros are not evidence, so the
 * attempt-bounded native receipt fills them. A known ACP receipt stays authoritative;
 * native cache is only accepted for the same input identity, and cached never exceeds input.
 */
export function mergeAttemptUsage(reported,native){
  const receipt=hasEvidence(reported)?reported:null;
  const fallback=hasEvidence(native)?native:null;
  if(!receipt&&!fallback)return null;
  if(!receipt){
    const inputTokens=token(fallback.inputTokens);
    const outputTokens=token(fallback.outputTokens);
    const cached=token(fallback.cacheReadInputTokens);
    return {
      inputTokens,outputTokens,
      cachedInputTokens:cached!==null&&(inputTokens===null||cached<=inputTokens)?cached:null,
      totalTokens:inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:token(fallback.totalTokens),
    };
  }
  const inputTokens=token(receipt.inputTokens);
  const outputTokens=token(receipt.outputTokens);
  let cachedInputTokens=token(receipt.cachedInputTokens);
  if(cachedInputTokens===null&&fallback&&token(fallback.inputTokens)===inputTokens){
    const nativeCached=token(fallback.cacheReadInputTokens);
    if(nativeCached!==null&&(inputTokens===null||nativeCached<=inputTokens))cachedInputTokens=nativeCached;
  }
  if(cachedInputTokens!==null&&inputTokens!==null&&cachedInputTokens>inputTokens)cachedInputTokens=null;
  return {
    inputTokens,outputTokens,cachedInputTokens,
    totalTokens:inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:token(receipt.totalTokens),
  };
}

/** Native usage for exactly this attempt; null when no bounded evidence exists. */
export async function qoderAttemptUsage({workspace,nativeSessionId,startedAt,endedAt},options={}){
  if(!Number.isFinite(Date.parse(startedAt))||!Number.isFinite(Date.parse(endedAt)))return null;
  const nowMs=Date.parse(endedAt);
  const evidence=await loadQoderAttemptUsage({
    workspace,nativeSessionId,startedAt,endedAt,
    qoderHome:options.qoderHome??null,nowMs,readFileImpl:options.readFileImpl??null,
  });
  return evidence?.usage||null;
}
