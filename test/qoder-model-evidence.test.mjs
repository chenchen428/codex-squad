import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cliAttemptInputs} from '../cli/lib/analytics.mjs';
import {qoderProjectKey,qoderSessionPath} from '../cli/lib/qoder-cli-usage.mjs';
import {loadQoderAttemptUsage,loadQoderModelEvidence} from '../cli/lib/qoder-model-evidence.mjs';

const NOW=new Date('2026-01-10T12:00:00.000Z');
const SESSION='0b29aa3e-91b7-43fd-9f8b-33346322cdc3';
const SESSION_2='1c30bb4f-a2c8-44ae-a09c-44457433dec4';
const THREAD='11111111-1111-4111-8111-111111111111';
const SECRETS=['sk-secret','private thinking','tool payload','hidden analysis'];

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

function snapshot(workspace,tasks,threadId=THREAD){
  return {
    schemaVersion:1,
    connected:true,
    observedAt:'2026-01-09T12:00:00.000Z',
    binding:{threadId,workspace,projectId:`project-${threadId}`,parentWorkId:`parent-${threadId}`,title:'模型证据',},
    members:[{id:'member-1',executor:'qoder'}],
    tasks,
    usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,reportedAttempts:0,totalAttempts:0,mainSession:'unavailable',currency:null},
    cursor:'cursor-1',
  };
}

function row(sessionId,workspace,id,model,timestamp,usage=null,extra={}){
  return {
    type:'assistant',
    sessionId,
    cwd:workspace,
    timestamp,
    message:{
      id,
      role:'assistant',
      model,
      content:[
        {type:'thinking',thinking:'private thinking'},
        {type:'text',text:'hidden analysis'},
        {type:'tool_use',id:'tool-secret',name:'Bash',input:{command:'curl --token sk-secret'}},
      ],
      ...(usage?{usage}:{}),
    },
    toolUseResult:{stdout:'tool payload sk-secret'},
    ...extra,
  };
}

async function qoderRoot(workspace,sessions){
  const qoderHome=await mkdtemp(join(tmpdir(),'squad-qoder-model-home-'));
  for(const [sessionId,rows] of Object.entries(sessions)){
    const directory=join(qoderHome,'projects',qoderProjectKey(workspace));
    await mkdir(directory,{recursive:true});
    await writeFile(
      join(directory,`${sessionId}.jsonl`),
      rows.map(item=>typeof item==='string'?item:JSON.stringify(item)).join('\n'),
    );
  }
  return qoderHome;
}

async function review({workspace,entries,qoderHome,inputOverrides={}}){
  const views=Array.isArray(entries)&&entries[0]?.binding
    ?entries
    :[snapshot(workspace,entries)];
  const inputs={...cliAttemptInputs(views,{now:NOW}),...inputOverrides};
  let reads=0;
  const evidence=await loadQoderModelEvidence({
    inputs,
    qoderHome,
    readFileImpl:async(...args)=>{
      reads+=1;
      const {readFile}=await import('node:fs/promises');
      return readFile(...args);
    },
  });
  return {evidence,inputs,reads};
}

test('native assistant segments dedupe to one response with the final usage',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-ws-'));
  const rows=[
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z'),
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z'),
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z',{
      input_tokens:100,cache_read_input_tokens:40,output_tokens:10,
    }),
    row(SESSION,workspace,'response-2','dfmodel','2026-01-09T00:02:00.000Z',{
      input_tokens:50,cache_read_input_tokens:0,output_tokens:5,
    }),
  ];
  const qoderHome=await qoderRoot(workspace,{[SESSION]:rows});
  try{
    const {evidence,reads}=await review({
      workspace,
      qoderHome,
      entries:[{
        id:'task-model',title:'模型证据',memberId:'member-1',status:'completed',
        attempts:[attempt('attempt-1',{sessionId:SESSION})],acceptance:null,
      }],
    });
    assert.equal(reads,1,'每个原生文件只读取一次');
    assert.equal(evidence.coverage.responses,2,'重复 response 分段按 message.id 去重');
    assert.equal(evidence.coverage.duplicateRows,2);
    assert.equal(evidence.coverage.ready,1);
    const [result]=evidence.attempts;
    assert.equal(result.model,'dfmodel');
    assert.equal(result.source,'actual');
    assert.equal(result.reason,null);
    assert.equal(result.records,2);
    assert.deepEqual(result.modelCounts,{dfmodel:2});
    assert.deepEqual(result.usage,{
      inputTokens:150,outputTokens:15,cacheReadInputTokens:40,totalTokens:165,inputIncludesCacheRead:true,
    },'cache_read 已包含在 input_tokens 中，不重复相加');
    assert.equal(result.sourceRef,`qoder-native:${SESSION}`);
    assert.equal(evidence.coverage.matched,1);
    assert.deepEqual(evidence.coverage.models,{dfmodel:1});
    assert.deepEqual(evidence.coverage.usage,{inputTokens:150,outputTokens:15,cacheReadInputTokens:40});

    const serialized=JSON.stringify(evidence);
    for(const secret of [...SECRETS,'configured-model',workspace,'.qoder','.jsonl'])assert.equal(serialized.includes(secret),false,`不应泄露 ${secret}`);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('the same response id with conflicting models fails coverage instead of last-write winning',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-conflict-'));
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z'),
    row(SESSION,workspace,'response-1','other-model','2026-01-09T00:01:00.000Z'),
  ]});
  try{
    const {evidence}=await review({
      workspace,
      qoderHome,
      entries:[{
        id:'task-conflict',title:'冲突',memberId:'member-1',status:'completed',
        attempts:[attempt('attempt-1',{sessionId:SESSION})],acceptance:null,
      }],
    });
    const [result]=evidence.attempts;
    assert.equal(result.model,null);
    assert.equal(result.reason,'model_conflict');
    assert.equal(result.records,1);
    assert.deepEqual(result.modelCounts,{});
    assert.equal(evidence.coverage.conflicts,1);
    assert.equal(evidence.coverage.byReason.model_conflict,1);
    assert.equal(JSON.stringify(evidence).includes('configured-model'),false);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('mixed response models keep modelCounts but never select a configured model',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-mixed-'));
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z'),
    row(SESSION,workspace,'response-2','other-model','2026-01-09T00:02:00.000Z'),
  ]});
  try{
    const {evidence}=await review({
      workspace,
      qoderHome,
      entries:[{
        id:'task-mixed',title:'混合',memberId:'member-1',status:'completed',
        attempts:[attempt('attempt-1',{sessionId:SESSION})],acceptance:null,
      }],
    });
    const [result]=evidence.attempts;
    assert.equal(result.model,null);
    assert.equal(result.source,null);
    assert.equal(result.reason,'mixed_models');
    assert.equal(result.records,2);
    assert.deepEqual(result.modelCounts,{dfmodel:1,'other-model':1});
    assert.equal(JSON.stringify(evidence).includes('configured-model'),false);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('missing, empty, unreadable and unbound attempts stay explicitly unknown',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-unknown-'));
  const qoderHome=await qoderRoot(workspace,{
    [SESSION]:[
      row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z'),
      row(SESSION,workspace,'response-2',null,'2026-01-09T00:02:00.000Z'),
    ],
    [SESSION_2]:['{"type":"user","sessionId":"'+SESSION_2+'"}'],
  });
  const tasks=[{
    id:'task-unknown',title:'未知',memberId:'member-1',status:'completed',
    attempts:[
      attempt('attempt-1',{index:1,sessionId:SESSION}),
      attempt('attempt-2',{index:2,sessionId:SESSION_2,startedAt:'2026-01-09T00:10:00.000Z',endedAt:'2026-01-09T00:20:00.000Z'}),
      attempt('attempt-3',{index:3,startedAt:'2026-01-09T00:20:00.000Z',endedAt:'2026-01-09T00:30:00.000Z'}),
      attempt('attempt-4',{index:4,sessionId:'3e52dd60-c4ea-46c0-92be-66679655fa06',startedAt:'2026-01-09T00:30:00.000Z',endedAt:'2026-01-09T00:40:00.000Z'}),
    ],
    acceptance:null,
  }];
  try{
    const views=[snapshot(workspace,tasks)];
    const inputs=cliAttemptInputs(views,{now:NOW});
    const {attempts,coverage}=await loadQoderModelEvidence({inputs,qoderHome});
    const byId=Object.fromEntries(attempts.map(item=>[item.attemptId,item]));
    assert.equal(byId['attempt-1'].reason,'missing_model');
    assert.equal(byId['attempt-1'].model,null);
    assert.equal(byId['attempt-2'].reason,'no_records');
    assert.equal(byId['attempt-3'].reason,'no_session');
    assert.equal(byId['attempt-4'].reason,'missing_file');
    assert.equal(coverage.attempts,4);
    assert.equal(coverage.matched,0);
    assert.equal(coverage.unknown,4);
    assert.equal(coverage.missing,1);
    assert.equal(coverage.ready,2);
    for(const item of attempts)assert.equal(JSON.stringify(item).includes('configured-model'),false);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('unreadable native files report unreadable rather than guessing',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-unreadable-'));
  try{
    const views=[snapshot(workspace,[{
      id:'task-unreadable',title:'不可读',memberId:'member-1',status:'completed',
      attempts:[attempt('attempt-1',{sessionId:SESSION})],acceptance:null,
    }])];
    const {attempts,coverage}=await loadQoderModelEvidence({
      inputs:cliAttemptInputs(views,{now:NOW}),
      qoderHome:workspace,
      readFileImpl:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'})},
    });
    assert.equal(attempts[0].reason,'unreadable');
    assert.equal(attempts[0].model,null);
    assert.equal(coverage.unreadable,1);
    assert.equal(coverage.available,false);
  }finally{
    await rm(workspace,{recursive:true,force:true});
  }
});

test('resumed ancestors keep their own interval and future rows respect the freeze cutoff',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-resume-'));
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row(SESSION,workspace,'before','dfmodel','2026-01-08T23:00:00.000Z'),
    row(SESSION,workspace,'parent','dfmodel','2026-01-09T00:02:00.000Z'),
    row(SESSION,workspace,'boundary','dfmodel','2026-01-09T00:05:00.000Z'),
    row(SESSION,workspace,'child','dfmodel','2026-01-09T00:05:01.000Z'),
    row(SESSION,workspace,'after','dfmodel','2026-01-09T00:11:00.000Z'),
    row(SESSION,workspace,'future','dfmodel','2026-01-10T13:00:00.000Z'),
  ]});
  try{
    const {evidence}=await review({
      workspace,
      qoderHome,
      entries:[{
        id:'task-resume',title:'续接',memberId:'member-1',status:'completed',
        attempts:[
          attempt('attempt-1',{index:1,startedAt:'2026-01-09T00:00:00.000Z',endedAt:'2026-01-09T00:05:00.000Z'}),
          attempt('attempt-2',{
            index:2,sessionId:SESSION,resumedFrom:'attempt-1',
            startedAt:'2026-01-09T00:05:01.000Z',endedAt:'2026-01-09T00:10:00.000Z',
          }),
        ],
        acceptance:null,
      }],
    });
    const byId=Object.fromEntries(evidence.attempts.map(item=>[item.attemptId,item]));
    assert.equal(byId['attempt-1'].model,'dfmodel');
    assert.equal(byId['attempt-1'].records,2);
    assert.equal(byId['attempt-1'].sessionId,SESSION,'续接祖先归入同一条原生会话');
    assert.equal(byId['attempt-2'].model,'dfmodel');
    assert.equal(byId['attempt-2'].records,1);
    assert.equal(evidence.coverage.responses,5);
    assert.equal(evidence.coverage.futureResponses,1);
    assert.equal(evidence.coverage.unassignedResponses,2,'开始前和结束后的 response 不归属任何 attempt');
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('one native file feeds multiple tasks and overlapping reuse is excluded, not double attributed',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-overlap-'));
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row(SESSION,workspace,'only-a','dfmodel','2026-01-09T00:02:00.000Z'),
    row(SESSION,workspace,'overlap','dfmodel','2026-01-09T00:07:00.000Z'),
    row(SESSION,workspace,'only-b','dfmodel','2026-01-09T00:12:00.000Z'),
  ]});
  try{
    const threadA='aaaaaaaa-1111-4111-8111-111111111111';
    const threadB='bbbbbbbb-2222-4222-8222-222222222222';
    const views=[
      snapshot(workspace,[{
        id:'task-a',title:'A',memberId:'member-1',status:'completed',
        attempts:[attempt('attempt-a',{sessionId:SESSION,startedAt:'2026-01-09T00:00:00.000Z',endedAt:'2026-01-09T00:10:00.000Z'})],
        acceptance:null,
      }],threadA),
      snapshot(workspace,[{
        id:'task-b',title:'B',memberId:'member-1',status:'completed',
        attempts:[attempt('attempt-b',{sessionId:SESSION,startedAt:'2026-01-09T00:05:00.000Z',endedAt:'2026-01-09T00:15:00.000Z'})],
        acceptance:null,
      }],threadB),
    ];
    let reads=0;
    const {attempts,coverage}=await loadQoderModelEvidence({
      inputs:cliAttemptInputs(views,{now:NOW}),
      qoderHome,
      readFileImpl:async(...args)=>{
        reads+=1;
        const {readFile}=await import('node:fs/promises');
        return readFile(...args);
      },
    });
    assert.equal(reads,1,'跨任务共享同一 native 会话也只读一次');
    assert.equal(coverage.attempts,2);
    assert.equal(coverage.ambiguousResponses,1);
    for(const item of attempts){
      assert.equal(item.model,null);
      assert.equal(item.reason,'overlap');
      assert.equal(item.records,1);
    }
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('session id and cwd mismatches are rejected, and model strings are bounded',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-identity-'));
  const longModel='m'.repeat(81);
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row('7f41cc5f-b3d9-45bf-b1ad-55568544efd5',workspace,'wrong-session','dfmodel','2026-01-09T00:01:00.000Z'),
    row(SESSION,'/elsewhere','wrong-cwd','dfmodel','2026-01-09T00:02:00.000Z'),
    'not-json',
    row(SESSION,workspace,'sanitized','  dfmodel\n','2026-01-09T00:03:00.000Z'),
    row(SESSION,workspace,'too-long',longModel,'2026-01-09T00:04:00.000Z'),
  ]});
  try{
    const {evidence}=await review({
      workspace,
      qoderHome,
      entries:[{
        id:'task-identity',title:'身份',memberId:'member-1',status:'completed',
        attempts:[attempt('attempt-1',{sessionId:SESSION})],acceptance:null,
      }],
    });
    const [result]=evidence.attempts;
    assert.equal(result.reason,'missing_model');
    assert.equal(result.model,null);
    assert.deepEqual(result.modelCounts,{dfmodel:1});
    assert.equal(result.records,2);
    assert.equal(evidence.coverage.rejectedRows,2);
    assert.equal(evidence.coverage.rejectedLines,1);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('a pure identity mismatch marks the native session as mismatch',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-mismatch-'));
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row('7f41cc5f-b3d9-45bf-b1ad-55568544efd5',workspace,'wrong-session','dfmodel','2026-01-09T00:01:00.000Z'),
    row(SESSION,'/elsewhere','wrong-cwd','dfmodel','2026-01-09T00:02:00.000Z'),
  ]});
  try{
    const {evidence}=await review({
      workspace,
      qoderHome,
      entries:[{
        id:'task-mismatch',title:'不匹配',memberId:'member-1',status:'completed',
        attempts:[attempt('attempt-1',{sessionId:SESSION})],acceptance:null,
      }],
    });
    assert.equal(evidence.attempts[0].reason,'mismatch');
    assert.equal(evidence.attempts[0].model,null);
    assert.equal(evidence.coverage.mismatch,1);
    assert.equal(evidence.coverage.available,false);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('the window excludes attempts outside the requested days',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-model-window-'));
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z'),
  ]});
  try{
    const views=[snapshot(workspace,[{
      id:'task-window',title:'窗口',memberId:'member-1',status:'completed',
      attempts:[attempt('attempt-1',{sessionId:SESSION})],acceptance:null,
    }])];
    const {attempts,coverage}=await loadQoderModelEvidence({
      inputs:cliAttemptInputs(views,{now:NOW,days:7}),
      qoderHome,
    });
    assert.equal(attempts.length,1);
    assert.equal(attempts[0].model,'dfmodel');
    const older=await loadQoderModelEvidence({
      inputs:cliAttemptInputs(views,{now:new Date('2026-01-20T12:00:00.000Z'),days:7}),
      qoderHome,
    });
    assert.deepEqual(older.attempts,[],'窗口外 attempt 不进入模型证据');
    assert.equal(older.coverage.attempts,0);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});


test('single-attempt native usage stays inside its interval and dedupes repeated segments',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-attempt-usage-'));
  const qoderHome=await qoderRoot(workspace,{[SESSION]:[
    row(SESSION,workspace,'earlier','dfmodel','2026-01-09T00:00:00.000Z',{
      input_tokens:900,cache_read_input_tokens:800,output_tokens:90,
    }),
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z'),
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z',{
      input_tokens:100,cache_read_input_tokens:40,output_tokens:10,
    }),
    row(SESSION,workspace,'response-2','dfmodel','2026-01-09T00:02:00.000Z',{
      input_tokens:50,cache_read_input_tokens:30,output_tokens:5,
    }),
    row(SESSION,workspace,'later','dfmodel','2026-01-09T00:10:01.000Z',{
      input_tokens:777,cache_read_input_tokens:700,output_tokens:70,
    }),
  ]});
  try{
    const evidence=await loadQoderAttemptUsage({
      workspace,nativeSessionId:SESSION,
      startedAt:'2026-01-09T00:00:01.000Z',endedAt:'2026-01-09T00:10:00.000Z',qoderHome,
    });
    assert.equal(evidence.status,'ready');
    assert.equal(evidence.responses,2,'只统计本次执行时段内的响应');
    assert.equal(evidence.duplicateRows,1,'同一 response 的重复分段只取最终 usage');
    assert.deepEqual(evidence.usage,{
      inputTokens:150,outputTokens:15,cacheReadInputTokens:70,totalTokens:165,inputIncludesCacheRead:true,
    },'cache_read 是 input 子集，不重复相加');
    const unknown=await loadQoderAttemptUsage({
      workspace,nativeSessionId:SESSION,
      startedAt:'2026-01-09T00:20:00.000Z',endedAt:'2026-01-09T00:30:00.000Z',qoderHome,
    });
    assert.equal(unknown.responses,0);
    assert.equal(unknown.usage,null,'没有时段内证据时保持未知，不能伪造 0');
    const missing=await loadQoderAttemptUsage({
      workspace,nativeSessionId:'3e52dd60-c4ea-46c0-92be-66679655fa06',
      startedAt:'2026-01-09T00:00:01.000Z',endedAt:'2026-01-09T00:10:00.000Z',qoderHome,
    });
    assert.equal(missing.status,'missing');
    assert.equal(missing.usage,null);
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});


test('native attempt usage keeps unreported fields unknown instead of zero',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-attempt-partial-'));
  const sessionMissingCache='2d41cc50-b3d9-45bf-b1ad-55568544efd5';
  const sessionPartialCache='3e52dd60-c4ea-46c0-92be-66679655fa07';
  const sessionMissingOutput='4f63ee71-d5fb-47d1-a2bf-77780766ab18';
  const qoderHome=await qoderRoot(workspace,{
    [SESSION]:[
      row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z',{
        input_tokens:100,output_tokens:10,
      }),
    ],
    [sessionMissingCache]:[
      row(sessionMissingCache,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z',{
        input_tokens:100,cache_read_input_tokens:40,output_tokens:10,
      }),
      row(sessionMissingCache,workspace,'response-2','dfmodel','2026-01-09T00:02:00.000Z',{
        input_tokens:50,output_tokens:5,
      }),
    ],
    [sessionMissingOutput]:[
      row(sessionMissingOutput,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z',{
        input_tokens:20,cache_read_input_tokens:5,
      }),
    ],
  });
  const load=nativeSessionId=>loadQoderAttemptUsage({
    workspace,nativeSessionId,
    startedAt:'2026-01-09T00:00:01.000Z',endedAt:'2026-01-09T00:10:00.000Z',qoderHome,
  });
  try{
    const noCache=await load(SESSION);
    assert.deepEqual(noCache.usage,{
      inputTokens:100,outputTokens:10,cacheReadInputTokens:null,totalTokens:110,inputIncludesCacheRead:true,
    },'响应没有 cache 时保持 null，不能伪造 0');
    const partialCache=await load(sessionMissingCache);
    assert.deepEqual(partialCache.usage,{
      inputTokens:150,outputTokens:15,cacheReadInputTokens:null,totalTokens:165,inputIncludesCacheRead:true,
    },'部分响应缺 cache 时已知部分不是完整 cache');
    const missingOutput=await load(sessionMissingOutput);
    assert.deepEqual(missingOutput.usage,{
      inputTokens:20,outputTokens:null,cacheReadInputTokens:5,totalTokens:null,inputIncludesCacheRead:true,
    },'缺少 output 时 total 保持未知，不做部分相加');
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});

test('a truncated native tail never sums partial evidence as the attempt total',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'squad-qoder-attempt-truncated-'));
  const rows=[
    row(SESSION,workspace,'response-1','dfmodel','2026-01-09T00:01:00.000Z',{
      input_tokens:100,cache_read_input_tokens:40,output_tokens:10,
    }),
    row(SESSION,workspace,'response-2','dfmodel','2026-01-09T00:02:00.000Z',{
      input_tokens:50,cache_read_input_tokens:30,output_tokens:5,
    }),
  ];
  const qoderHome=await qoderRoot(workspace,{[SESSION]:rows});
  const input={
    workspace,nativeSessionId:SESSION,
    startedAt:'2026-01-09T00:00:01.000Z',endedAt:'2026-01-09T00:10:00.000Z',qoderHome,
  };
  try{
    const lastLineBytes=Buffer.byteLength(JSON.stringify(rows[1]))+1;
    const partial=await loadQoderAttemptUsage({...input,maxBytes:lastLineBytes});
    assert.equal(partial.status,'truncated');
    assert.equal(partial.usage,null,'尾部截断无法证明覆盖执行起点时保持未知');
    const complete=await loadQoderAttemptUsage({...input,maxBytes:1024*1024});
    assert.equal(complete.status,'ready');
    assert.deepEqual(complete.usage,{
      inputTokens:150,outputTokens:15,cacheReadInputTokens:70,totalTokens:165,inputIncludesCacheRead:true,
    });
  }finally{
    await rm(workspace,{recursive:true,force:true});
    await rm(qoderHome,{recursive:true,force:true});
  }
});
