import {readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

export function nativeThreadTitle(row){
  if(typeof row?.name==='string'&&row.name.trim())return row.name.trim();
  const title=typeof row?.title==='string'?row.title.trim():'';
  // Before naming, Codex can retain the full first prompt in title.
  return title&&title.length<=300&&!/[\r\n]/.test(title)?title:null;
}

// Host thread metadata owns the name. Never infer it from a workspace or prompt text.
export async function readHostThreadTitles(threadIds,{env=process.env,codexHome=env.CODEX_HOME||join(homedir(),'.codex')}={}){
  const ids=[...new Set(threadIds)].filter(id=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id));
  if(!ids.length)return new Map();
  let db;
  try{
    const files=(await readdir(codexHome)).filter(file=>/^state_\d+\.sqlite$/.test(file)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]));
    if(!files.length)return new Map();
    const {DatabaseSync}=await import('node:sqlite');
    db=new DatabaseSync(join(codexHome,files[0]),{readOnly:true});
    const columns=db.prepare('PRAGMA table_info(threads)').all().map(row=>row.name);
    if(!columns.includes('id')||!columns.includes('title'))return new Map();
    const query=db.prepare(`SELECT id,title${columns.includes('name')?',name':''} FROM threads WHERE id=?`);
    const names=new Map();
    for(const id of ids){
      const row=query.get(id);
      const title=nativeThreadTitle(row);
      if(title)names.set(id,title.trim());
    }
    return names;
  }catch{return new Map()}
  finally{db?.close()}
}

export async function hostThreadTitle(threadId,options={}){
  return (await readHostThreadTitles([threadId],options)).get(threadId)||null;
}
