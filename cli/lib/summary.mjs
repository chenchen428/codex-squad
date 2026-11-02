import {dataRoot} from './storage-paths.mjs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {withBindingLock} from './runtime.mjs';

function location(binding,options){
  if(!/^[a-f0-9-]{36}$/i.test(binding?.threadId||'')||!binding.workspace)throw Object.assign(new Error('总结需要有效的当前会话绑定。'),{code:'SQUAD_SUMMARY_BINDING_INVALID'});
  return join(dataRoot(options),'summaries',`${binding.threadId}.json`);
}
export async function readSummary(binding,options={}){
  let value;try{value=JSON.parse(await readFile(location(binding,options),'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}
  if(value.schemaVersion!==1||value.threadId!==binding.threadId||value.workspace!==binding.workspace||!Array.isArray(value.stages)||!value.stages.length)throw Object.assign(new Error('总结与当前会话归属不符或记录损坏。'),{code:'SQUAD_SUMMARY_BINDING_MISMATCH'});
  const current=value.stages.at(-1);return {schemaVersion:1,threadId:value.threadId,workspace:value.workspace,...current,history:value.stages.slice(0,-1)};
}
export async function writeSummary(binding,input,options={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['title','content'].includes(key)))throw Object.assign(new Error('总结只接受 title 与 content。'),{code:'SQUAD_SUMMARY_INPUT_INVALID'});
  if(typeof input.title!=='string'||!input.title.trim()||input.title.length>200||/[\r\n\0]/.test(input.title)||typeof input.content!=='string'||!input.content.trim()||Buffer.byteLength(input.content,'utf8')>180000)throw Object.assign(new Error('请提供不超过200字的标题与不超过180000字节的总结正文。'),{code:'SQUAD_SUMMARY_INPUT_INVALID'});
  location(binding,options);
  return withBindingLock(binding.threadId,async()=>{
    const previous=await readSummary(binding,options);
    if(previous?.title===input.title.trim()&&previous.content===input.content)return {threadId:binding.threadId,revision:previous.revision,updatedAt:previous.updatedAt,duplicate:true};
    const current={revision:(previous?.revision||0)+1,title:input.title.trim(),content:input.content,updatedAt:new Date(options.now?options.now():Date.now()).toISOString()};
    const stages=previous?[...previous.history,{revision:previous.revision,title:previous.title,content:previous.content,updatedAt:previous.updatedAt},current]:[current];
    const file=location(binding,options);await mkdir(dirname(file),{recursive:true,mode:0o700});const temporary=`${file}.${process.pid}.tmp`;
    await writeFile(temporary,JSON.stringify({schemaVersion:1,threadId:binding.threadId,workspace:binding.workspace,stages},null,2)+'\n',{mode:0o600});await rename(temporary,file);
    return {threadId:binding.threadId,revision:current.revision,updatedAt:current.updatedAt,duplicate:false};
  },options);
}
