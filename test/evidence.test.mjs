import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm,symlink,rename,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fingerprintCandidate,inspectAcceptance} from '../cli/lib/evidence.mjs';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'squad-evidence-'));
  await writeFile(join(dir,'a.txt'),'one');
  await writeFile(join(dir,'b.txt'),'bee');
  return dir;
}

test('a verified candidate reports later changes without revoking the historical acceptance',async()=>{
  const dir=await fixture();
  try{
    const receipt=await fingerprintCandidate(dir,['a.txt','b.txt']);
    const first=await inspectAcceptance(dir,receipt);
    assert.equal(first.changedSinceVerification,false);
    assert.equal(first.fingerprint,receipt.fingerprint);
    assert.equal(first.stale,undefined);
    assert.deepEqual(first.files,receipt.files);

    await writeFile(join(dir,'a.txt'),'two');
    const changed=await inspectAcceptance(dir,receipt);
    assert.equal(changed.changedSinceVerification,true);
    assert.notEqual(changed.currentFingerprint,receipt.fingerprint);
    assert.equal(changed.fingerprint,receipt.fingerprint);
    assert.equal(changed.at,receipt.at);
    assert.equal(changed.stale,undefined);

    const again=await inspectAcceptance(dir,receipt);
    assert.equal(again.changedSinceVerification,true);
    assert.equal(again.fingerprint,receipt.fingerprint);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('deleting or moving a verified file is a later change, not a failed acceptance',async()=>{
  const dir=await fixture();
  try{
    const receipt=await fingerprintCandidate(dir,['a.txt']);
    await unlink(join(dir,'a.txt'));
    const deleted=await inspectAcceptance(dir,receipt);
    assert.equal(deleted.changedSinceVerification,true);
    assert.equal(deleted.fingerprint,receipt.fingerprint);

    await writeFile(join(dir,'a.txt'),'one');
    assert.equal((await inspectAcceptance(dir,receipt)).changedSinceVerification,false);

    await rename(join(dir,'a.txt'),join(dir,'moved.txt'));
    const moved=await inspectAcceptance(dir,receipt);
    assert.equal(moved.changedSinceVerification,true);
    assert.equal(moved.fingerprint,receipt.fingerprint);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('a file missing at verification time keeps an explicit null fingerprint and can appear later',async()=>{
  const dir=await fixture();
  try{
    const receipt=await fingerprintCandidate(dir,['a.txt','removed.txt']);
    assert.equal(receipt.files.find(f=>f.path==='removed.txt').sha256,null);
    assert.equal((await inspectAcceptance(dir,receipt)).changedSinceVerification,false);
    await writeFile(join(dir,'removed.txt'),'now-present');
    const appeared=await inspectAcceptance(dir,receipt);
    assert.equal(appeared.changedSinceVerification,true);
    assert.notEqual(appeared.currentFingerprint,receipt.fingerprint);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('an acceptance without candidate references is still historical but cannot be rechecked',async()=>{
  const dir=await fixture();
  try{
    const records=await inspectAcceptance(dir,{at:'2026-01-10T00:00:00.000Z',note:'当时已核对'});
    assert.equal(records.at,'2026-01-10T00:00:00.000Z');
    assert.equal(records.note,'当时已核对');
    assert.equal(records.changedSinceVerification,true);
    assert.match(records.checkError,/候选文件/);
    assert.equal(await inspectAcceptance(dir,null),null);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('candidate references stay inside the workspace and reject symlink escapes',async()=>{
  const dir=await fixture();
  try{
    await assert.rejects(fingerprintCandidate(dir,[]));
    await assert.rejects(fingerprintCandidate(dir,['../outside']));
    await symlink('/etc/passwd',join(dir,'outside-link'));
    await assert.rejects(fingerprintCandidate(dir,['outside-link']));
  }finally{await rm(dir,{recursive:true,force:true})}
});
