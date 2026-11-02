import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aggregateAnalytics,cliAttemptInputs} from '../cli/lib/analytics.mjs';
import {
  collectQoderCliUsage,loadQoderCliUsage,mergeQoderCliUsage,
  qoderProjectKey,qoderSessionPath,
} from '../cli/lib/qoder-cli-usage.mjs';

const NOW=new Date('2026-01-10T12:00:00.000Z');
const SESSION='0b29aa3e-91b7-43fd-9f8b-33346322cdc3';
const THREAD='11111111-1111-4111-8111-111111111111';
const TASK='task-native';
const SECRETS=['sk-secret','--token','--name','Invalid option','/elsewhere','private stdout'];

function attempt(id,overrides={}){
  return {
    id,
    index:overrides.index??1,
    status:'completed',
    startedAt:'2026-01-09T00:00:00.000Z',
    endedAt:'2026-01-09T00:10:00.000Z',
    sessionId:null,
    resumedFrom:null,
    model:'configured-model',
    actualModel:null,
    usage:null,
    handoff:null,
    events:[],
    result:null,
    error:null,
    ...overrides,
  };
}

function snapshot(workspace,tasks){
  return {
    schemaVersion:1,
    connected:true,
    observedAt:'2026-01-09T12:00:00.000Z',
    binding:{threadId:THREAD,workspace,projectId:'project-1',parentWorkId:'parent-1',title:'会话 原生回执'},
    members:[{id:'member-1',executor:'qoder'}],
    tasks,
    usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,reportedAttempts:0,totalAttempts:0,mainSession:'unavailable',currency:null},
    cursor:'cursor-1',
  };
}

function publicView(workspace){
  const events=[
    {id:'pub-bash',kind:'tool_use',toolName:'Bash',text:'lgb capability invoke --public',status:'RUNNING'},
    {id:'pub-bash',kind:'tool_result',toolName:'Bash',text:'Process exited with code 0',status:'SUCCEEDED'},
    {id:'mcp-call',kind:'tool_use',toolName:'mcp__reui__search',text:'{"query":"native secret query"}',status:'RUNNING'},
    {id:'mcp-call',kind:'tool_result',toolName:'mcp__reui__search',text:'{"ok":true}',status:'SUCCEEDED'},
  ];
  return snapshot(workspace,[{
    id:TASK,
    title:`任务 ${TASK}`,
    memberId:'member-1',
    status:'completed',
    attempts:[
      attempt('attempt-1',{index:1}),
      attempt('attempt-2',{
        index:2,
        startedAt:'2026-01-09T01:00:00.000Z',
        endedAt:'2026-01-09T01:10:00.000Z',
        sessionId:SESSION,
        resumedFrom:'attempt-1',
        events,
      }),
    ],
    acceptance:null,
  }]);
}

function nativeRows(workspace){
  const cwd=workspace;
  const row=(timestamp,content,extra={})=>({sessionId:SESSION,cwd,timestamp,message:{content},...extra});
  const use=(id,name,command)=>({type:'tool_use',id,name,input:{command}});
  const result=(id,machine)=>({type:'tool_result',tool_use_id:id,content:[{type:'text',text:'raw body private stdout'}]});
  return [
    row('2026-01-09T00:05:00.000Z',[use('tool-1','Bash','lgb capability invoke --token sk-secret')]),
    row('2026-01-09T00:05:05.000Z',[result('tool-1')],{toolUseResult:{kind:'execute',exitCode:0,signal:null,stdout:JSON.stringify({ok:true,data:{token:'sk-secret'}}),stderr:''}}),
    row('2026-01-09T00:05:06.000Z',[use('tool-1','Bash','lgb capability invoke --token sk-secret')]),
    row('2026-01-09T00:05:07.000Z',[result('tool-1')],{toolUseResult:{exitCode:0,stdout:'{"ok":true}'}}),
    row('2026-01-09T01:05:00.000Z',[use('tool-2','Bash','sf workflow create --name demo')]),
    row('2026-01-09T01:05:05.000Z',[result('tool-2')],{toolUseResult:{kind:'execute',exitCode:1,signal:null,stdout:'Invalid option: --name\nprivate stdout',stderr:'secret stderr'}}),
    row('2026-01-09T01:05:06.000Z',[result('tool-2')],{toolUseResult:{exitCode:0,stdout:'{"ok":true}'}}),
    row('2026-01-09T01:06:00.000Z',[use('tool-3','Bash','lgb capability invoke && sf workflow create')]),
    row('2026-01-09T01:06:05.000Z',[result('tool-3')],{toolUseResult:{exitCode:0,stdout:'{"ok":true}'}}),
    row('2026-01-09T01:07:00.000Z',[use('tool-4','Bash','a1 code repo view --id 7')]),
    row('2026-01-09T01:07:05.000Z',[result('tool-4')],{toolUseResult:{exitCode:0,stdout:''}}),
    row('2026-01-09T01:08:00.000Z',[use('tool-5','Read','/Users/private/file')]),
    row('2026-01-09T01:08:01.000Z',[result('tool-5')],{toolUseResult:{exitCode:0}}),
    {sessionId:SESSION,cwd:'/elsewhere',timestamp:'2026-01-09T01:09:00.000Z',message:{content:[use('tool-6','Bash','lgb capability invoke')]}},
    {sessionId:SESSION,cwd:'/elsewhere',timestamp:'2026-01-09T01:09:05.000Z',message:{content:[result('tool-6')]},toolUseResult:{exitCode:0}},
  ];
}

async function nativeRoot(workspace,rows){
  const qoderHome=await mkdtemp(join(tmpdir(),'squad-qoder-home-'));
  const directory=join(qoderHome,'projects',qoderProjectKey(workspace));
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`${SESSION}.jsonl`),rows.map(row=>JSON.stringify(row)).join('\n'));
  return qoderHome;
}

test('qoder paths follow the native project key and session id',()=>{
  assert.equal(qoderProjectKey('/Users/example/work/example-billing'),'-Users-example-work-example-billing');
  assert.equal(
    qoderSessionPath({qoderHome:'/qoder',workspace:'/Users/example/work/example-billing',nativeSessionId:SESSION}),
    `/qoder/projects/-Users-example-work-example-billing/${SESSION}.jsonl`,
  );
  assert.equal(qoderSessionPath({qoderHome:'/qoder',workspace:'',nativeSessionId:SESSION}),null);
});

test('native receipts attribute across resumed attempts and never expose raw output',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-ws-'));
  const qoderHome=await nativeRoot(workspace,nativeRows(workspace));
  try{
    const views=[publicView(workspace)];
    const stats=aggregateAnalytics(views,{scope:'global',now:NOW});
    let reads=0;
    const usage=await loadQoderCliUsage({
      inputs:cliAttemptInputs(views,{now:NOW}),
      qoderHome,
      readFileImpl:async(...args)=>{reads+=1;const {readFile}=await import('node:fs/promises');return readFile(...args)},
    });
    assert.equal(reads,1,'每个原生文件每轮只读一次');
    assert.equal(usage.available,true);
    assert.equal(usage.coverage.sessions,1);
    assert.equal(usage.coverage.ready,1);
    assert.equal(usage.coverage.missing,0);
    assert.equal(usage.coverage.rejectedLines,2);
    assert.equal(usage.coverage.coveredAttempts,2);
    assert.equal(usage.coverage.records,4);
    assert.equal(usage.coverage.businessReceipts,2);
    const [session]=usage.sessions;
    assert.equal(session.status,'ready');
    const first=session.assignments.get(`${THREAD}\0${TASK}\0attempt-1`).map(record=>record.id);
    const second=session.assignments.get(`${THREAD}\0${TASK}\0attempt-2`).map(record=>record.id).sort();
    assert.deepEqual(first,['tool-1'],'未绑定会话的父 attempt 仍按真实时间承接回执');
    assert.deepEqual(second,['tool-2','tool-3','tool-4'],'重复 tool_use id 与只读工具不进入统计');
    for(const records of session.assignments.values()){
      for(const record of records)assert.equal(record.businessReceipt,record.id!=='tool-2'&&record.id!=='tool-4');
    }

    mergeQoderCliUsage(stats,{inputs:cliAttemptInputs(views,{now:NOW}),usage});
    const rows=Object.fromEntries(stats.capabilities.cli.rows.map(row=>[row.name,row]));
    assert.deepEqual(Object.keys(rows).sort(),['a1','lgb','mcp__reui__search','sf']);
    assert.equal(rows.lgb.calls,2,'原生覆盖后公开 Bash 记录不再重复计数');
    assert.deepEqual(rows.lgb.execution,{succeeded:1,failed:0,unknown:1});
    assert.deepEqual(rows.lgb.business,{succeeded:1,failed:0,unknown:1});
    assert.equal(rows.sf.calls,2);
    assert.deepEqual(rows.sf.execution,{succeeded:0,failed:1,unknown:1});
    assert.deepEqual(rows.sf.failures,[{category:'argument',count:1}]);
    assert.deepEqual(rows.a1.execution,{succeeded:1,failed:0,unknown:0});
    assert.deepEqual(rows.a1.business,{succeeded:0,failed:0,unknown:1});
    assert.equal(rows.mcp__reui__search.calls,1,'specific MCP 公开记录保留');
    assert.deepEqual(rows.mcp__reui__search.business,{succeeded:1,failed:0,unknown:0});
    assert.equal(rows.lgb.sessions[0].taskId,TASK);

    const task=stats.tasks[0];
    assert.equal(task.cli.calls,6);
    assert.equal(task.cli.unclassifiedCalls,0);
    assert.deepEqual(task.cli.rows.map(row=>row.name).sort(),['a1','lgb','mcp__reui__search','sf']);
    assert.equal(stats.capabilities.cli.coverage.qoderNative.nativeRecords,4);
    assert.equal(stats.capabilities.cli.coverage.qoderNative.publicFallbackRecords,1);
    assert.match(stats.capabilities.cli.note,/Qoder/);
    assert.equal(stats.capabilities.cli.note.includes('unclassifiedCalls'),false);
    assert.equal(stats.capabilities.cli.note.includes('复合命令'),true);

    const serialized=JSON.stringify(stats);
    for(const secret of SECRETS){
      assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
    }
    assert.equal(serialized.includes('native secret query'),false,'公开 MCP 参数不进入命令行');
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('native time window follows record.timestamp instead of the attempt start',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-window-'));
  const qoderHome=await nativeRoot(workspace,nativeRows(workspace));
  try{
    const views=[publicView(workspace)];
    const inputs=cliAttemptInputs(views,{now:NOW});
    inputs.fromMs=Date.parse('2026-01-09T01:00:00.000Z');
    const usage=await loadQoderCliUsage({inputs,qoderHome});
    assert.equal(usage.coverage.records,3);
    assert.equal(usage.sessions[0].assignments.has(`${THREAD}\0${TASK}\0attempt-1`),false);
    assert.deepEqual(usage.sessions[0].assignments.get(`${THREAD}\0${TASK}\0attempt-2`).map(record=>record.id).sort(),['tool-2','tool-3','tool-4']);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('all-time native records respect cutoff and the actual attempt interval',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-interval-'));
  const rows=nativeRows(workspace);
  for(const [id,timestamp] of [['before','2026-01-08T23:59:00Z'],['between','2026-01-09T00:30:00Z'],['after','2026-01-09T01:30:00Z'],['future','2026-01-11T00:00:00Z']]){
    rows.push({sessionId:SESSION,cwd:workspace,timestamp,message:{content:[{type:'tool_use',id,name:'Bash',input:{command:'lgb capability invoke'}}]}});
    rows.push({sessionId:SESSION,cwd:workspace,timestamp,message:{content:[{type:'tool_result',tool_use_id:id}]},toolUseResult:{exitCode:0,stdout:'{"ok":true}'}});
  }
  const qoderHome=await nativeRoot(workspace,rows);
  try{
    const usage=await loadQoderCliUsage({inputs:cliAttemptInputs([publicView(workspace)],{now:NOW}),qoderHome});
    const ids=[...usage.sessions[0].assignments.values()].flat().map(record=>record.id).sort();
    assert.deepEqual(ids,['tool-1','tool-2','tool-3','tool-4']);
    assert.equal(usage.coverage.records,4);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('native receipts name the module, script and capability that actually ran',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-ident-'));
  const row=(timestamp,content,extra={})=>({sessionId:SESSION,cwd:workspace,timestamp,message:{content},...extra});
  const use=(id,command)=>({type:'tool_use',id,name:'Bash',input:{command}});
  const result=id=>({type:'tool_result',tool_use_id:id,content:[{type:'text',text:'private stdout'}]});
  const rows=[
    row('2026-01-09T01:05:00.000Z',[use('py-script','python3 scripts/report.py --token sk-secret')]),
    row('2026-01-09T01:05:01.000Z',[result('py-script')],{toolUseResult:{exitCode:0,stdout:'{"ok":true}'}}),
    row('2026-01-09T01:05:02.000Z',[use('py-inline','python3 -c "import json;print(json.load(open(\'x\')))"')]),
    row('2026-01-09T01:05:03.000Z',[result('py-inline')],{toolUseResult:{exitCode:0,stdout:'{"ok":true}'}}),
    row('2026-01-09T01:05:04.000Z',[use('node-test','node --test test/a.test.mjs')]),
    row('2026-01-09T01:05:05.000Z',[result('node-test')],{toolUseResult:{exitCode:0}}),
    row('2026-01-09T01:05:06.000Z',[use('node-inline','node -e "console.log(1)"')]),
    row('2026-01-09T01:05:07.000Z',[result('node-inline')],{toolUseResult:{exitCode:0,stdout:'{"ok":true}'}}),
    row('2026-01-09T01:05:08.000Z',[use('lgb-cap','lgb --env prod capability invoke billing_fund_query --data-file request.json')]),
    row('2026-01-09T01:05:09.000Z',[result('lgb-cap')],{toolUseResult:{exitCode:1,stdout:''}}),
  ];
  const qoderHome=await nativeRoot(workspace,rows);
  try{
    const views=[publicView(workspace)];
    const stats=aggregateAnalytics(views,{scope:'global',now:NOW});
    const merged=await collectQoderCliUsage({stats,views,days:null,now:NOW,qoderHome});
    const rowsOut=merged.capabilities.cli.rows;
    assert.deepEqual(rowsOut.map(item=>item.command).sort(),[
      'lgb capability invoke billing_fund_query','mcp__reui__search','node --test a.test.mjs','python3 report.py',
    ],'解释器根名不再成行，具体脚本、测试文件与能力名各自成行');
    const byCommand=Object.fromEntries(rowsOut.map(item=>[item.command,item]));
    assert.deepEqual(byCommand['python3 report.py'].execution,{succeeded:1,failed:0,unknown:0});
    assert.deepEqual(byCommand['python3 report.py'].business,{succeeded:1,failed:0,unknown:0});
    assert.deepEqual(byCommand['node --test a.test.mjs'].execution,{succeeded:1,failed:0,unknown:0});
    assert.deepEqual(byCommand['lgb capability invoke billing_fund_query'].execution,{succeeded:0,failed:1,unknown:0});
    assert.deepEqual(byCommand['lgb capability invoke billing_fund_query'].failures,[{category:'execution',count:1}]);
    for(const command of ['python3','node','lgb'])assert.equal(rowsOut.some(item=>item.command===command),false);

    const task=merged.tasks[0];
    assert.equal(task.cli.calls,4);
    assert.equal(task.cli.unclassifiedCalls,2,'内联 python/node 只计入未归类');
    const coverage=merged.capabilities.cli.coverage.qoderNative;
    assert.equal(coverage.records,5);
    assert.equal(coverage.nativeRecords,5);
    assert.equal(coverage.businessReceipts,3);
    assert.equal(coverage.publicFallbackRecords,1);

    const serialized=JSON.stringify(merged);
    for(const secret of ['sk-secret','request.json','json.load','console.log','--data-file','private stdout','scripts/']){
      assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
    }
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('missing native files keep public cli statistics and report coverage',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-missing-ws-'));
  const emptyHome=await mkdtemp(join(tmpdir(),'squad-qoder-missing-home-'));
  try{
    const views=[publicView(workspace)];
    const stats=aggregateAnalytics(views,{scope:'global',now:NOW});
    const before={...structuredClone(stats.capabilities.cli),coverage:undefined};
    const taskBefore=structuredClone(stats.tasks[0].cli);
    const result=await collectQoderCliUsage({stats,views,days:null,now:NOW,qoderHome:emptyHome});
    assert.deepEqual(result.capabilities.cli.rows,before.rows);
    assert.equal(result.capabilities.cli.unclassifiedCalls,before.unclassifiedCalls);
    assert.deepEqual(result.tasks[0].cli,taskBefore);
    assert.equal(result.capabilities.cli.coverage.qoderNative.missing,1);
    assert.equal(result.capabilities.cli.coverage.qoderNative.available,false);
    assert.equal(result.capabilities.cli.rows.some(row=>row.name==='lgb'),true,'公开记录仍作为未确认统计保留');
    assert.notEqual(result.capabilities.cli.rows.find(row=>row.name==='lgb').execution.succeeded,0);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(emptyHome,{recursive:true,force:true});
  }
});

test('a failed native provider cannot break frozen statistics',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-fail-ws-'));
  try{
    const views=[publicView(workspace)];
    const stats=aggregateAnalytics(views,{scope:'global',now:NOW});
    const before=structuredClone(stats.capabilities.cli.rows);
    const result=await collectQoderCliUsage({
      stats,views,days:null,now:NOW,
      provider:async()=>{throw Object.assign(new Error('native unavailable'),{code:'E_QODER_TEST'})},
    });
    assert.deepEqual(result.capabilities.cli.rows,before);
    assert.equal(result.capabilities.cli.coverage.qoderNative.available,false);
    assert.equal(result.capabilities.cli.coverage.qoderNative.errorCode,'E_QODER_TEST');
  }finally{
    await rm(workspace,{recursive:true,force:true});
  }
});
