import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analysisRunsView,cheapSourceFingerprint,collectFrozen,startAnalysis} from '../cli/lib/analysis-service.mjs';
import {CLI_STATS_VERSION} from '../cli/lib/cli-metrics.mjs';
import {BENEFITS_STATS_VERSION} from '../cli/lib/squad-benefits.mjs';
import {codexMetadataStamp} from '../cli/lib/codex-usage.mjs';
import {loadQoderCliUsage,qoderProjectKey} from '../cli/lib/qoder-cli-usage.mjs';

test('starting analysis returns a collecting run while historical source loading is still pending',async()=>{
  const home=await mkdtemp(join(tmpdir(),'squad-background-start-'));
  let entered,release;
  const sourceEntered=new Promise(resolve=>{entered=resolve});
  const sourceReady=new Promise(resolve=>{release=resolve});
  const startedAt='2026-10-27T02:00:00.000Z';
  const source={views:[{
    schemaVersion:1,observedAt:startedAt,
    binding:{threadId:'11111111-1111-4111-8111-111111111111',title:'Background test'},
    tasks:[{id:'task-one',title:'Load statistics',status:'completed',attempts:[{
      id:'attempt-one',index:1,status:'completed',startedAt,endedAt:'2026-10-27T02:01:00.000Z',
      usage:{inputTokens:4,outputTokens:2,totalTokens:6},events:[],
    }]}],
  }],expected:1,unavailable:[]};
  let timer;
  const starting=startAnalysis({
    home,codexHome:join(home,'codex-home'),requestId:'background-start-regression',now:new Date('2026-10-27T03:00:00.000Z'),
    fingerprintProvider:async()=>({fingerprint:'background-source-one',sourceCount:1}),
    sourceLoader:async()=>{entered();return sourceReady},
    runner:async()=>({
      realCodexThreadId:'test-background-thread',exitCode:0,eventTypes:['thread.started','turn.completed'],
      analysis:{schemaVersion:1,summary:'Statistics loaded.',categories:{skills_tools:[],time:[],tokens:[]},sessionDescriptions:[],benefitMatches:[]},
    }),
  });
  try{
    await sourceEntered;
    const result=await Promise.race([
      starting,
      new Promise(resolve=>{timer=setTimeout(()=>resolve(null),200)}),
    ]);
    assert.ok(result?.run?.runId,'Starting a background update must not wait for the historical scan');
    assert.equal(result.run.status,'running');
    const status=await analysisRunsView({home});
    assert.equal(status.current.runId,result.run.runId);
    assert.equal(status.current.phase,'collecting');
  }finally{
    clearTimeout(timer);
    release(source);
    const result=await starting;
    await result.completion;
    await rm(home,{recursive:true,force:true});
  }
});

test('collectFrozen replaces cli statistics from injected native receipts and keeps fallback on failure',async()=>{
  const home=await mkdtemp(join(tmpdir(),'squad-frozen-home-'));
  const workspace=await mkdtemp(join(tmpdir(),'squad-frozen-ws-'));
  const qoderHome=await mkdtemp(join(tmpdir(),'squad-frozen-qoder-'));
  const threadId='22222222-2222-4222-8222-222222222222';
  const taskId='task-native-wiring';
  const sessionId='native-session-wiring';
  const now=new Date('2026-10-27T03:00:00.000Z');
  const view={
    schemaVersion:1,observedAt:'2026-10-27T02:30:00.000Z',
    binding:{threadId,workspace,title:'原生接线会话'},
    members:[{id:'member-1',executor:'qoder'}],
    tasks:[{
      id:taskId,title:'原生接线任务',memberId:'member-1',status:'completed',acceptance:null,
      attempts:[{
        id:'attempt-native',index:1,status:'completed',
        startedAt:'2026-10-27T02:00:00.000Z',endedAt:'2026-10-27T02:10:00.000Z',sessionId,
        events:[{id:'public-bash',kind:'tool_use',toolName:'Bash',text:'lgb capability invoke --public',status:'RUNNING'}],
      }],
    }],
  };
  const directory=join(qoderHome,'projects',qoderProjectKey(workspace));
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`${sessionId}.jsonl`),[
    {sessionId,cwd:workspace,timestamp:'2026-10-27T02:05:00.000Z',message:{content:[{type:'tool_use',id:'native-bash',name:'Bash',input:{command:'lgb capability invoke --token native-secret'}}]}},
    {sessionId,cwd:workspace,timestamp:'2026-10-27T02:05:05.000Z',message:{content:[{type:'tool_result',tool_use_id:'native-bash',content:[]}]},toolUseResult:{kind:'execute',exitCode:0,signal:null,stdout:'{"ok":true,"data":{"token":"native-secret"}}',stderr:''}},
  ].map(row=>JSON.stringify(row)).join('\n'));
  const common={
    home,days:null,now,qoderHome,
    sourceLoader:async()=>({views:[view],expected:1,unavailable:[]}),
    fingerprintProvider:async()=>({fingerprint:'frozen-native',sourceCount:1}),
    codexUsageProvider:async()=>({available:false}),
  };
  try{
    let seen=null;
    const frozen=await collectFrozen({
      ...common,
      qoderUsageProvider:async args=>{seen=args;return loadQoderCliUsage(args)},
    });
    assert.ok(seen,'注入的采集器必须收到原生归属输入');
    assert.equal(seen.qoderHome,qoderHome);
    assert.equal(seen.inputs.tasks[0].workspace,workspace);
    assert.equal(seen.inputs.tasks[0].attempts[0].sessionId,sessionId);
    assert.equal(frozen.stats.benefits.generatedAt,now.toISOString());
    assert.equal(frozen.stats.benefits.coverage.observedDeliveries,1);
    assert.equal(frozen.stats.benefits.summary.codexTokensSaved,null);
    const rows=frozen.stats.capabilities.cli.rows;
    assert.deepEqual(rows.map(row=>row.name),['lgb']);
    assert.equal(rows[0].calls,1,'原生回执覆盖后公开 execute 记录不再重复计数');
    assert.deepEqual(rows[0].execution,{succeeded:1,failed:0,unknown:0});
    assert.deepEqual(rows[0].business,{succeeded:1,failed:0,unknown:0});
    assert.equal(frozen.stats.tasks[0].cli.calls,1);
    assert.equal(frozen.stats.capabilities.cli.coverage.qoderNative.nativeRecords,1);
    assert.equal(frozen.stats.capabilities.cli.coverage.qoderNative.publicFallbackRecords,0);
    assert.equal(JSON.stringify(frozen.stats).includes('native-secret'),false);

    const fallback=await collectFrozen({
      ...common,
      qoderUsageProvider:async()=>{throw Object.assign(new Error('native unavailable'),{code:'E_NATIVE_WIRING'})},
    });
    assert.equal(fallback.stats.capabilities.cli.rows.length,1);
    assert.equal(fallback.stats.capabilities.cli.rows[0].name,'lgb');
    assert.equal(fallback.stats.capabilities.cli.rows[0].calls,1);
    assert.deepEqual(fallback.stats.capabilities.cli.rows[0].execution,{succeeded:0,failed:0,unknown:1});
    assert.equal(fallback.stats.capabilities.cli.coverage.qoderNative.available,false);
    assert.equal(fallback.stats.capabilities.cli.coverage.qoderNative.errorCode,'E_NATIVE_WIRING');
  }finally{
    await rm(home,{recursive:true,force:true});
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('cheapSourceFingerprint binds the cli parser version',async()=>{
  const home=await mkdtemp(join(tmpdir(),'squad-fingerprint-'));
  const bindingName='33333333-3333-4333-8333-333333333333';
  try{
    await mkdir(join(home,'bindings'),{recursive:true});
    const contents=JSON.stringify({schemaVersion:1,workspace:'/tmp/fingerprint-ws'});
    await writeFile(join(home,'bindings',`${bindingName}.json`),contents);
    const result=await cheapSourceFingerprint({home,codexHome:join(home,'codex-home')});
    assert.equal(result.sourceCount,1);
    const expected=createHash('sha256');
    expected.update(`${bindingName}.json`);expected.update('\0');expected.update(contents);expected.update('\0');
    expected.update('cli-stats\0');expected.update(CLI_STATS_VERSION);expected.update('\0');
    expected.update(BENEFITS_STATS_VERSION);expected.update('\0');
    const stamp=await codexMetadataStamp({codexHome:join(home,'codex-home'),excludeThreadIds:[]});
    const {main,wal,...activity}=stamp;
    expected.update(JSON.stringify(activity));
    assert.equal(result.fingerprint,expected.digest('hex'),'CLI 解析规则升级必须产生新指纹');
  }finally{
    await rm(home,{recursive:true,force:true});
  }
});
