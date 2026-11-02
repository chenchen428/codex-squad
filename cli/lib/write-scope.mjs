import {realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';

function invalid(){throw Object.assign(new Error('writePaths 必须为工作目录内的确切相对文件或目录子树，不接受越界路径、glob 或空数组。'),{code:'SQUAD_WRITE_PATHS_INVALID'})}
async function realTarget(file){
  try{return await realpath(file)}catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=dirname(file);if(parent===file)throw error;
    return resolve(await realTarget(parent),relative(parent,file));
  }
}
export async function normalizeWritePaths(workspace,value){
  if(value===undefined)return ['.'];
  if(!Array.isArray(value)||!value.length||value.length>50)invalid();
  const root=await realpath(workspace),paths=[];
  for(const item of value){
    if(typeof item!=='string'||!item.trim()||isAbsolute(item)||/[\0\r\n*?\[\]{}\\]/.test(item)||item.split('/').includes('..'))invalid();
    const target=await realTarget(resolve(root,item.trim()));
    let name=relative(root,target);
    if(name==='..'||name.startsWith(`..${sep}`)||isAbsolute(name))invalid();
    name=(name||'.').split(sep).join('/');if(process.platform==='darwin')name=name.toLowerCase();
    paths.push(name);
  }
  return [...new Set(paths)].sort();
}
export function writeConflict(left=['.'],right=['.']){
  for(const a of left)for(const b of right)if(a==='.'||b==='.'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/'))return `${a} ↔ ${b}`;
  return null;
}
