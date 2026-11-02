import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {withBindingLock,normalizeUsage} from '../cli/lib/runtime.mjs';

test('a slow live owner retains its lock instead of being replaced after one minute',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'squad-lock-'));
  try{
    const id=randomUUID();await mkdir(join(dir,'bindings'));
    const file=join(dir,'bindings',`${id}.json.lock`);
    await writeFile(file,`${process.pid}\n`);
    await utimes(file,new Date(0),new Date(0));
    await assert.rejects(withBindingLock(id,()=>assert.fail('live lock replaced'),{home:dir,lockTimeoutMs:1}),{code:'SQUAD_BINDING_LOCKED'});
  }finally{await rm(dir,{recursive:true,force:true})}
});
test('missing usage remains unknown while explicit reported zero remains zero',()=>{
  assert.equal(normalizeUsage({inputTokens:null,outputTokens:null}),null);
  assert.deepEqual(normalizeUsage({inputTokens:null,outputTokens:2}),{inputTokens:null,outputTokens:2,cachedInputTokens:null,totalTokens:null});
  assert.equal(normalizeUsage({inputTokens:0,outputTokens:0,totalTokens:0}).totalTokens,0);
});
