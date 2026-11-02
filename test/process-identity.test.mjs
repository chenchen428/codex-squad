import test from 'node:test';
import assert from 'node:assert/strict';
import {readProcessIdentity,sameProcessIdentity,verifiableIdentity} from '../cli/lib/qoder/process-identity.mjs';

const original={pid:123,ppid:10,pgid:123,command:'/bin/sh',startToken:'darwin:boot:100:123456',supported:true};
test('exec and reparenting preserve process identity; same-second PID reuse does not',()=>{
  assert.equal(sameProcessIdentity(original,{...original,ppid:1,pgid:999,command:'/usr/bin/node'}),true);
  assert.equal(sameProcessIdentity(original,{...original,startToken:'darwin:boot:100:123457'}),false);
  assert.equal(sameProcessIdentity(original,{...original,startToken:'darwin:new-boot:100:123456'}),false);
  assert.equal(sameProcessIdentity(original,{...original,pid:124}),false);
  assert.equal(verifiableIdentity({...original,startToken:undefined,startedAt:'Thu Jan 1 00:00:00 1970'}),false);
  assert.equal(verifiableIdentity({...original,startToken:'darwin:boot:100'}),false);
});
test('identity read failures and malformed data never mean confirmed absence',async()=>{
  assert.equal(await readProcessIdentity(123,{run:async()=>null}),null);
  assert.equal((await readProcessIdentity(123,{run:async()=>{throw Error('denied')}})).supported,false);
  assert.equal((await readProcessIdentity(123,{run:async()=>({...original,pid:124})})).supported,false);
  assert.equal((await readProcessIdentity(123,{run:async()=>({...original,startToken:''})})).supported,false);
});
test('the owning OS exposes a verifiable and stable birth identity',{
  skip:!['darwin','linux'].includes(process.platform),
},async()=>{
  const first=await readProcessIdentity(process.pid),second=await readProcessIdentity(process.pid);
  assert.equal(verifiableIdentity(first),true,JSON.stringify(first));
  assert.equal(sameProcessIdentity(first,second),true);
});
