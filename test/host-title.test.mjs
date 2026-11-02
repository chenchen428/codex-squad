import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hostThreadTitle,readHostThreadTitles,nativeThreadTitle} from '../cli/lib/host-title.mjs';
import {readBinding} from '../cli/lib/runtime.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
test('squad names follow the host title, including later user renames, without writing the host',async()=>{
  const codexHome=await mkdtemp(join(tmpdir(),'squad-title-'));
  const db=new DatabaseSync(join(codexHome,'state_5.sqlite'));
  try{
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,?,?)').run(A,'原始会话标题','用户改过的标题');
    db.prepare('INSERT INTO threads VALUES(?,?,?)').run(B,'另一会话标题',null);
    assert.equal(await hostThreadTitle(A,{codexHome}),'用户改过的标题');
    assert.equal(await hostThreadTitle(B,{codexHome}),'另一会话标题');
    db.prepare('UPDATE threads SET name=? WHERE id=?').run('刚刚修改的名称',A);
    assert.equal(await hostThreadTitle(A,{codexHome}),'刚刚修改的名称');
    await mkdir(join(codexHome,'bindings'));
    await writeFile(join(codexHome,'bindings',`${A}.json`),JSON.stringify({schemaVersion:1,threadId:A,workspace:codexHome,projectId:'p',parentWorkId:'w',title:'旧绑定名',tasks:[],attempts:{},workers:{}}));
    assert.equal((await readBinding(A,{home:codexHome,codexHome})).title,'刚刚修改的名称');
    const identity=await readBinding(A,{home:codexHome,codexHome,includeTitle:false});
    assert.equal(identity.title,'');
    assert.equal(identity.workspace,codexHome);
    assert.equal(identity.threadId,A);
    assert.deepEqual([...(await readHostThreadTitles([B,B,'invalid'],{codexHome})).keys()],[B]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM threads').get().n,2);
  }finally{db.close();await rm(codexHome,{recursive:true,force:true})}
});

test('missing host metadata stays unknown and never becomes a made-up directory name',async()=>{
  assert.equal(await hostThreadTitle(A,{codexHome:'/nonexistent-codex-home'}),null);
});

test('unnamed prompt bodies do not become session names, while explicit native names are preserved',()=>{
  assert.equal(nativeThreadTitle({name:null,title:'# Files mentioned by the user:\n\n/path/to/attachment.png'}),null);
  assert.equal(nativeThreadTitle({name:null,title:'x'.repeat(301)}),null);
  assert.equal(nativeThreadTitle({name:'费用一致性分析',title:'# Files mentioned by the user:\n附件'}),'费用一致性分析');
  assert.equal(nativeThreadTitle({title:'已生成的会话名称'}),'已生成的会话名称');
});
