import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  buildFailureReceipt,deliveryInstruction,parseDeliveryChecklist,reverifyDeliveryChecklist,verifyDeliveryChecklist,
} from '../cli/lib/handover.mjs';

function sha256(value){return createHash('sha256').update(value).digest('hex');}
function checklist(overrides={}){
  return JSON.stringify({
    schemaVersion:1,conclusion:'筛选问题已修复',artifacts:['src/report.ts','result.txt'],
    checks:[
      {name:'focused tests',status:'passed',evidence:'20 passed'},
      {name:'manual browser check',status:'not_run',evidence:''},
    ],
    remaining:['未覆盖历史数据'],
    ...overrides,
  });
}
function markdown(payload,{fence='json'}={}){
  return `已完成本轮修复。\n\n\`\`\`${fence}\n${payload}\n\`\`\`\n`;
}

async function workspaceFixture(t){
  const root=await mkdtemp(join(tmpdir(),'squad-handover-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'src'),{recursive:true});
  await writeFile(join(root,'src','report.ts'),'export const report = 1;\n');
  await writeFile(join(root,'result.txt'),'verified output\n');
  await writeFile(join(root,'untracked.log'),'outside scope\n');
  return root;
}

test('only an explicit structured final reply becomes a member checklist',()=>{
  const parsed=parseDeliveryChecklist(markdown(checklist()));
  assert.equal(parsed.available,true);
  assert.equal(parsed.source,'member_reported');
  assert.equal(parsed.conclusion,'筛选问题已修复');
  assert.deepEqual(parsed.artifacts,['src/report.ts','result.txt']);
  assert.deepEqual(parsed.checks.map(check=>check.status),['passed','not_run']);
  assert.deepEqual(parsed.remaining,['未覆盖历史数据']);
  assert.deepEqual(parsed.issues,[]);

  const inline=parseDeliveryChecklist(`结论。\nSQUAD_DELIVERY: ${checklist({artifacts:['only.txt']})}\n`);
  assert.deepEqual(inline.artifacts,['only.txt']);

  assert.equal(parseDeliveryChecklist('已修复，测试通过。').reason,'missing');
  assert.equal(parseDeliveryChecklist(markdown('{"schemaVersion":1}')).reason,'invalid');
  assert.match(parseDeliveryChecklist(markdown('not json')).issues.join(' '),/无法解析/);

  const alias=parseDeliveryChecklist(markdown(checklist({
    checks:[{name:'unit',status:'PASS'},{name:'smoke',status:'skipped'},{name:'unknown',status:'weird'}],
  })));
  assert.deepEqual(alias.checks.map(check=>check.status),['passed','not_run']);
  assert.match(alias.issues.join(' '),/status 只能是/);

  const instruction=deliveryInstruction();
  assert.match(instruction,/schemaVersion/);
  assert.match(instruction,/not_run\/unknown/);
});

test('program verification checks scope, existence and fingerprints instead of trusting the member',async t=>{
  const root=await workspaceFixture(t);
  const record=await verifyDeliveryChecklist({
    markdown:markdown(checklist({artifacts:['src/report.ts','result.txt','missing.txt','untracked.log','../escape.txt'],checks:[
      {name:'focused tests',status:'passed'},{name:'browser',status:'not_run'},
    ]})),
    workspace:root,writePaths:['src','result.txt'],status:'completed',
    startedAt:'2026-10-27T00:00:00.000Z',endedAt:'2026-10-27T00:01:00.000Z',
    now:()=> '2026-10-27T00:02:00.000Z',
  });
  assert.equal(record.available,true);
  assert.equal(record.source,'member_reported');
  assert.equal(record.program.source,'program_checked');
  assert.equal(record.program.status,'completed');
  assert.equal(record.program.durationMs,60000);
  assert.deepEqual(record.program.missing,['missing.txt']);
  assert.deepEqual(record.program.outOfScope,['untracked.log']);
  assert.deepEqual(record.program.unreadable,[{path:'../escape.txt',error:'invalid_path'}]);
  const report=record.program.artifacts.find(item=>item.path==='src/report.ts');
  assert.equal(report.exists,true);
  assert.equal(report.inScope,true);
  assert.equal(report.sha256,sha256('export const report = 1;\n'));
  const escaped=record.program.artifacts.find(item=>item.path==='../escape.txt');
  assert.equal(escaped.error,'invalid_path');
  assert.equal(record.program.fingerprint,sha256(JSON.stringify([
    ['../escape.txt',null],['missing.txt',null],['result.txt',sha256('verified output\n')],['src/report.ts',sha256('export const report = 1;\n')],['untracked.log',sha256('outside scope\n')],
  ].sort(([left],[right])=>left.localeCompare(right)))));
  assert.equal(record.failure,null);
  assert.match(record.gaps.join(' '),/不存在：missing.txt/);
  assert.match(record.gaps.join(' '),/超出写入范围：untracked\.log/);
  assert.match(record.gaps.join(' '),/检查未通过：browser（not_run）/);

  const same=await verifyDeliveryChecklist({markdown:markdown(checklist()),workspace:root,writePaths:['.'],status:'completed'});
  const reverified=await reverifyDeliveryChecklist(root,same);
  assert.equal(reverified.checked,true);
  assert.equal(reverified.changedSinceVerification,false);

  await writeFile(join(root,'result.txt'),'edited later\n');
  const drifted=await reverifyDeliveryChecklist(root,same);
  assert.equal(drifted.checked,true);
  assert.equal(drifted.changedSinceVerification,true);
  assert.notEqual(drifted.currentFingerprint,same.program.fingerprint);

  const mutated=await verifyDeliveryChecklist({markdown:markdown(checklist()),workspace:root,writePaths:['.'],status:'completed'});
  assert.notEqual(mutated.program.fingerprint,same.program.fingerprint);
});

test('missing or unverifiable checklists keep the real terminal state and explain the gap',async t=>{
  const root=await workspaceFixture(t);
  const missing=await verifyDeliveryChecklist({markdown:'全部完成，无需进一步操作。',workspace:root,writePaths:['.'],status:'completed'});
  assert.equal(missing.available,false);
  assert.equal(missing.reason,'missing');
  assert.equal(missing.program.status,'completed');
  assert.equal(missing.failure,null);
  assert.match(missing.gaps.join(' '),/未在最终回复中提供结构化交付清单/);

  const empty=await verifyDeliveryChecklist({markdown:markdown(checklist({artifacts:[]})),workspace:root,writePaths:['.'],status:'completed'});
  assert.deepEqual(empty.program.artifacts,[]);
  assert.match(empty.gaps.join(' '),/未列出可核验产物/);

  const failed=await verifyDeliveryChecklist({
    markdown:markdown(checklist({artifacts:['src/report.ts','missing.txt']})),workspace:root,writePaths:['src'],
    status:'failed',error:'session/prompt failed: upstream reset',nativeSessionId:'native-failed',
  });
  assert.equal(failed.program.status,'failed');
  const receipt=failed.failure;
  assert.equal(receipt.phase,'model_request');
  assert.equal(receipt.phaseConfirmed,true);
  assert.equal(receipt.nativeSessionId,'native-failed');
  assert.deepEqual(receipt.confirmedArtifacts.map(item=>item.path),['src/report.ts']);
  assert.deepEqual(receipt.checks.executed.map(check=>check.name),['focused tests']);
  assert.deepEqual(receipt.checks.unknown.map(check=>check.name),['manual browser check']);
  assert.deepEqual(receipt.checks.interrupted,[]);
  assert.equal(receipt.retryable,false);
  assert.equal(receipt.autoRetry,false);
  assert.match(receipt.recoveryConditions.join(' '),/网络、代理与模型目录/);
});

test('failure receipts only name a phase the recorded evidence confirms',async t=>{
  const root=await workspaceFixture(t);
  const unconfirmed=await verifyDeliveryChecklist({
    markdown:markdown(checklist({artifacts:['src/report.ts']})),workspace:root,writePaths:['src'],
    status:'failed',error:'执行器未返回完成回执。',
  });
  assert.equal(unconfirmed.failure.phase,'unconfirmed');
  assert.equal(unconfirmed.failure.phaseConfirmed,false);
  assert.match(unconfirmed.failure.recoveryConditions.join(' '),/读取原生会话与执行记录/);

  const recordSave=await verifyDeliveryChecklist({
    markdown:'',workspace:root,writePaths:['src'],status:'failed',error:'后台存储不可用',
    persistenceError:Object.assign(new Error('store offline'),{code:'LOCAL_STORE_UNAVAILABLE'}),
  });
  assert.equal(recordSave.failure.phase,'record_save');
  assert.equal(recordSave.failure.phaseConfirmed,true);
  assert.match(recordSave.failure.recoveryConditions.join(' '),/核对本地记录/);

  const resume=await verifyDeliveryChecklist({
    markdown:markdown(checklist()),workspace:root,writePaths:['src'],
    status:'failed',error:'Qoder ACP does not support loading sessions',
  });
  assert.equal(resume.failure.phase,'native_resume');
  assert.equal(resume.failure.phaseConfirmed,true);

  const diagnostic=await verifyDeliveryChecklist({
    markdown:markdown(checklist()),workspace:root,writePaths:['src'],status:'failed',
    error:'unclassified',diagnostic:{stage:'model-request',code:'MODEL_UNAVAILABLE'},
  });
  assert.equal(diagnostic.failure.phase,'model_request');
  assert.equal(diagnostic.failure.phaseConfirmed,true);

  const stopped=await verifyDeliveryChecklist({
    markdown:markdown(checklist({checks:[{name:'lint',status:'not_run'}]})),workspace:root,writePaths:['src'],
    status:'stopped',
  });
  assert.equal(stopped.failure,null);
});

test('a claimed pass without evidence stays a reported claim and becomes an explicit gap',async t=>{
  const root=await workspaceFixture(t);
  const record=await verifyDeliveryChecklist({
    markdown:markdown(checklist({checks:[
      {name:'focused tests',status:'passed'},
      {name:'build',status:'failed'},
      {name:'manual browser check',status:'not_run'},
    ]})),
    workspace:root,writePaths:['.'],status:'completed',
  });
  assert.deepEqual(record.checks.map(check=>check.source),['member_reported','member_reported','member_reported']);
  assert.deepEqual(record.checksWithoutEvidence,[
    {name:'focused tests',status:'passed'},
    {name:'build',status:'failed'},
  ]);
  assert.match(record.gaps.join(' '),/检查缺少可核验证据：focused tests（passed，仅成员声称）/);
  assert.match(record.gaps.join(' '),/检查缺少可核验证据：build（failed，仅成员声称）/);
  assert.doesNotMatch(record.gaps.join(' '),/manual browser check（not_run，仅成员声称）/);
  assert.equal(record.program.source,'program_checked');

  const receipt=buildFailureReceipt({checklist:record,status:'failed',error:'session/prompt failed'});
  assert.deepEqual(receipt.checks.executed.map(check=>check.name),['focused tests','build']);
  assert.deepEqual(receipt.checks.withoutEvidence,[
    {name:'focused tests',status:'passed'},
    {name:'build',status:'failed'},
  ]);

  const evidenced=await verifyDeliveryChecklist({
    markdown:markdown(checklist({checks:[{name:'focused tests',status:'passed',evidence:'78 passed'}]})),
    workspace:root,writePaths:['.'],status:'completed',
  });
  assert.equal(evidenced.checksWithoutEvidence,undefined);
  assert.doesNotMatch(evidenced.gaps.join(' '),/缺少可核验证据/);
});

test('only the explicit delivery shape counts, and a dedicated marker wins over prose blocks',()=>{
  const business=JSON.stringify({schemaVersion:1,conclusion:'catalog refreshed',rows:[{id:1}]});
  const parsed=parseDeliveryChecklist([
    '业务数据示例：','```json',business,'```',
    '最终交付：','```json',checklist({conclusion:'最终结论',artifacts:['final.txt']}),'```',
  ].join('\n'));
  assert.equal(parsed.available,true);
  assert.equal(parsed.conclusion,'最终结论');
  assert.deepEqual(parsed.artifacts,['final.txt']);

  const onlyBusiness=parseDeliveryChecklist(`示例：\n\`\`\`json\n${business}\n\`\`\``);
  assert.equal(onlyBusiness.available,false);
  assert.equal(onlyBusiness.reason,'invalid');
  assert.match(onlyBusiness.issues.join(' '),/artifacts、checks 或 remaining/);

  const lastBusiness=parseDeliveryChecklist([
    '```json',checklist({conclusion:'先前的清单',artifacts:['earlier.txt']}),'```',
    '```json',business,'```',
  ].join('\n'));
  assert.equal(lastBusiness.available,true);
  assert.equal(lastBusiness.conclusion,'先前的清单');

  const marker=parseDeliveryChecklist([
    '```json',checklist({conclusion:'围栏清单',artifacts:['fenced.txt']}),'```',
    `SQUAD_DELIVERY: ${checklist({conclusion:'标记清单',artifacts:['marked.txt']})}`,
  ].join('\n'));
  assert.equal(marker.conclusion,'标记清单');
  assert.deepEqual(marker.artifacts,['marked.txt']);
});

test('direct failure receipts never invent checked artifacts or retries',()=>{
  const receipt=buildFailureReceipt({
    checklist:{available:true,checks:[{name:'tests',status:'passed'},{name:'e2e',status:'failed'}],program:{artifacts:[
      {path:'src/a.ts',exists:true,inScope:true,sha256:'a'.repeat(64)},
      {path:'src/b.ts',exists:false,inScope:true,sha256:null},
      {path:'outside.ts',exists:true,inScope:false,sha256:'b'.repeat(64)},
    ]}},
    status:'failed',error:'session/new failed: model catalog unavailable',nativeSessionId:'native-1',
  });
  assert.equal(receipt.phase,'directory_discovery');
  assert.deepEqual(receipt.confirmedArtifacts,[{path:'src/a.ts',sha256:'a'.repeat(64)}]);
  assert.deepEqual(receipt.checks.executed.map(check=>check.status),['passed','failed']);
  assert.equal(receipt.retryable,false);
  assert.equal(receipt.autoRetry,false);
  assert.equal(buildFailureReceipt({checklist:null,status:'completed'}),null);
});
