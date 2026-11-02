import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {reclaimOrphanedAcp,sweepOrphanedAcp} from '../cli/lib/orphan-recovery.mjs';

const worker={pid:2147000001,pgid:2147000001,ppid:1,command:'/fixture/worker',startToken:'linux:fixture:100',supported:true};
const acp={pid:2147000002,pgid:2147000002,ppid:1,command:'/fixture/acp',startToken:'linux:fixture:200',supported:true};
async function fixture(t){
  const home=await mkdtemp(join(tmpdir(),'squad-guard-')),nonce=randomUUID();
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'workers'));
  const file=join(home,'workers',nonce+'.json');
  const receipt={nonce,pid:worker.pid,identity:worker,updatedAt:1,acp:{pid:acp.pid,pgid:acp.pgid,ownerPid:worker.pid,ownerNonce:nonce,identity:acp,exited:false}};
  await writeFile(file,JSON.stringify(receipt));
  return {home,nonce,file,receipt};
}
test('unreadable identity after TERM prevents KILL and does not claim cleanup',async t=>{
  const f=await fixture(t),signals=[];
  const report=await reclaimOrphanedAcp({home:f.home,graceMs:0,
    readIdentity:async pid=>pid===worker.pid?null:signals.length?{supported:false}:acp,
    processGroupExists:()=>true,sendSignal:(_pgid,signal)=>signals.push(signal),
  });
  assert.deepEqual(signals,['SIGTERM']);
  assert.equal(report.reclaimed[0].result,'unconfirmed');
  const saved=JSON.parse(await readFile(f.file));
  assert.equal(saved.acp.exited,false);
  assert.equal(saved.reclaim.result,'unconfirmed');
});
test('PID reused during TERM grace is never sent KILL',async t=>{
  const f=await fixture(t),signals=[];
  const report=await reclaimOrphanedAcp({home:f.home,graceMs:0,
    readIdentity:async pid=>pid===worker.pid?null:signals.length?{...acp,startToken:'linux:fixture:201'}:acp,
    processGroupExists:()=>true,sendSignal:(_pgid,signal)=>signals.push(signal),
  });
  assert.deepEqual(signals,['SIGTERM']);
  assert.equal(report.reclaimed[0].reason,'acp_identity_mismatch');
});
test('an owner confirmed alive before escalation protects its ACP',async t=>{
  const f=await fixture(t),signals=[];
  const report=await reclaimOrphanedAcp({home:f.home,graceMs:0,
    readIdentity:async pid=>pid===worker.pid?(signals.length?worker:null):acp,
    processGroupExists:()=>true,sendSignal:(_pgid,signal)=>signals.push(signal),
  });
  assert.deepEqual(signals,['SIGTERM']);
  assert.equal(report.reclaimed[0].reason,'worker_alive');
});
test('ownership, process-group mismatch and legacy identity never permit a signal',async t=>{
  const f=await fixture(t);let signals=0;
  for(const mutate of [r=>{r.acp.ownerNonce='other'},r=>{r.acp.pgid++},r=>{delete r.identity.startToken}]){
    const value=structuredClone(f.receipt);mutate(value);await writeFile(f.file,JSON.stringify(value));
    const result=await reclaimOrphanedAcp({home:f.home,readIdentity:async pid=>pid===worker.pid?null:acp,
      processGroupExists:()=>true,sendSignal:()=>signals++});
    assert.equal(result.reclaimed.length,0);
  }
  assert.equal(signals,0);
});
test('wall-clock changes do not affect bounded cleanup; confirmed cleanup is idempotent',async t=>{
  const f=await fixture(t),signals=[];const original=Date.now;
  Date.now=()=>-1e12;t.after(()=>{Date.now=original});
  const readIdentity=async pid=>pid===worker.pid?null:signals.includes('SIGKILL')?null:acp;
  const options={home:f.home,graceMs:5,forceMs:5,readIdentity,
    processGroupExists:()=>!signals.includes('SIGKILL'),sendSignal:(_pgid,signal)=>signals.push(signal)};
  const started=performance.now(),report=await reclaimOrphanedAcp(options);
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  assert.equal(report.reclaimed[0].result,'terminated');
  assert.ok(performance.now()-started<1000);
  assert.equal((await reclaimOrphanedAcp(options)).reclaimed.length,0);
});
test('overlapping shared-runtime sweeps reuse one bounded operation',async t=>{
  const f=await fixture(t);let signals=0;
  const options={home:f.home,graceMs:0,forceMs:0,readIdentity:async pid=>pid===worker.pid?worker:acp,
    processGroupExists:()=>true,sendSignal:()=>signals++};
  const [first,second]=await Promise.all([sweepOrphanedAcp(options),sweepOrphanedAcp(options)]);
  assert.equal(first,second);
  assert.equal(signals,0);
  assert.equal((await sweepOrphanedAcp(options)).reason,'sweep_throttled');
});
