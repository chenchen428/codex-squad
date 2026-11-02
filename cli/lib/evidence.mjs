import {createHash} from 'node:crypto';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute,sep} from 'node:path';

export async function fingerprintCandidate(workspace,files) {
  if(!Array.isArray(files)||!files.length||files.length>50||files.some(p=>typeof p!=='string'||!p.trim()))throw new Error('验收需提供 1–50 个候选文件路径。');
  const base=await realpath(workspace);
  const sources=[];
  for(const supplied of [...new Set(files)].sort()){
    const path=resolve(base,supplied);
    const name=relative(base,path);
    if(!name||name==='..'||name.startsWith(`..${sep}`)||isAbsolute(name))throw new Error('验收文件必须位于当前工作目录。');
    let bytes;
    try{
      const actual=await realpath(path);
      const rel=relative(base,actual);
      if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('验收文件不能通过软链接跳出工作目录。');
      if(!(await lstat(actual)).isFile())throw new Error('验收引用必须是文件。');
      bytes=await readFile(actual);
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      const parent=await realpath(dirname(path));
      const rel=relative(base,parent);
      if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('验收引用超出工作目录。');
      bytes=null;
    }
    sources.push({path:name,sha256:bytes===null?null:createHash('sha256').update(bytes).digest('hex')});
  }
  return {fingerprint:createHash('sha256').update(JSON.stringify(sources)).digest('hex'),files:sources};
}

/**
 * The acceptance remains the historical fact that the candidate passed at that
 * time. Current files are only compared to surface later changes; they never
 * revoke the record or move the task back to review.
 */
export async function inspectAcceptance(workspace,acceptance) {
  if(!acceptance)return null;
  if(!Array.isArray(acceptance.files)||!acceptance.files.length){
    return {...acceptance,changedSinceVerification:true,checkError:'验收没有可核对的候选文件引用。'};
  }
  try{
    const current=await fingerprintCandidate(workspace,acceptance.files.map(f=>f.path));
    const changed=current.fingerprint!==acceptance.fingerprint;
    return {...acceptance,changedSinceVerification:changed,...(changed?{currentFingerprint:current.fingerprint}:{})};
  }catch(error){
    return {...acceptance,changedSinceVerification:true,checkError:`候选内容无法复核：${error.message}`};
  }
}
