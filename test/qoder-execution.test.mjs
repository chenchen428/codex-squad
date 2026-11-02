import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {mergeAttemptUsage,qoderClientOptions,qoderFailureDiagnostic} from '../cli/lib/qoder-execution.mjs';
test('Qoder process disables planning and delegation while preserving explicitly configured proxy routes and user settings',()=>{
 const source={CODEX_THREAD_ID:'private',HTTPS_PROXY:'http://127.0.0.1:7890',ALL_PROXY:'socks5://localhost:7890',http_proxy:'http://proxy.example:8080',PATH:'/bin'};
 const opts=qoderClientOptions('.',source),settings=JSON.parse(opts.args[1]);
 assert.equal(settings.general.plan.enabled,false);assert.deepEqual(settings.tools.exclude,['Agent','EnterPlanMode','ExitPlanMode']);assert.equal(opts.args[3],'Agent,EnterPlanMode,ExitPlanMode');assert.equal(opts.env.HTTPS_PROXY,source.HTTPS_PROXY);assert.equal(opts.env.ALL_PROXY,source.ALL_PROXY);assert.equal(opts.env.http_proxy,source.http_proxy);assert.equal('CODEX_THREAD_ID' in opts.env,false);assert.equal(source.HTTPS_PROXY,'http://127.0.0.1:7890');
});
test('current native API failure is distinguished from stale errors, wrong workspace and generic failures',async t=>{
 const home=await mkdtemp(join(tmpdir(),'squad-qoder-error-'));t.after(()=>rm(home,{recursive:true,force:true}));const workspace=resolve(home,'workspace'),id='01a162b5-bd96-7440-90a3-e422ae74d358';const dir=join(home,'.qoder/projects',workspace.replace(/[^a-zA-Z0-9]/g,'-'));await mkdir(dir,{recursive:true});const file=join(dir,id+'.jsonl');
 const row={type:'assistant',sessionId:id,cwd:workspace,timestamp:'2026-10-23T03:00:02Z',isApiErrorMessage:true,errorDetails:'NetworkAttemptError: Network attempt failed at response_headers'};const input={workspace,nativeSessionId:id,startedAt:'2026-10-23T03:00:00Z'};
 assert.equal(await qoderFailureDiagnostic(input,{home}),null);await writeFile(file,JSON.stringify(row)+'\n');assert.equal((await qoderFailureDiagnostic(input,{home})).code,'QODER_NETWORK_RESPONSE_HEADERS');
 assert.equal(await qoderFailureDiagnostic({...input,startedAt:'2026-10-23T03:00:03Z'},{home}),null);await writeFile(file,JSON.stringify({...row,cwd:'/other'})+'\n');assert.equal(await qoderFailureDiagnostic(input,{home}),null);await writeFile(file,JSON.stringify({...row,errorDetails:'unknown'})+'\n');assert.equal(await qoderFailureDiagnostic(input,{home}),null);
});


test('stopped zero receipts use bounded native consumption while absent evidence stays unknown',()=>{
 const zeros={inputTokens:0,outputTokens:0,cachedInputTokens:null,totalTokens:0};
 assert.equal(mergeAttemptUsage(zeros,null),null,'没有原始证据的零回执不能当成真实零消费');
 assert.equal(mergeAttemptUsage(null,null),null);
 const stopped=mergeAttemptUsage(zeros,{inputTokens:100,outputTokens:10,cacheReadInputTokens:40,totalTokens:110});
 assert.deepEqual(stopped,{inputTokens:100,outputTokens:10,cachedInputTokens:40,totalTokens:110},'cached 是 input 子集，不重复相加');
 const completed=mergeAttemptUsage({inputTokens:100,outputTokens:10,cachedInputTokens:null,totalTokens:110},{
   inputTokens:100,outputTokens:10,cacheReadInputTokens:40,totalTokens:110,
 });
 assert.deepEqual(completed,{inputTokens:100,outputTokens:10,cachedInputTokens:40,totalTokens:110});
 const mismatch=mergeAttemptUsage({inputTokens:100,outputTokens:10,cachedInputTokens:null,totalTokens:110},{
   inputTokens:50,outputTokens:5,cacheReadInputTokens:40,totalTokens:55,
 });
 assert.deepEqual(mismatch,{inputTokens:100,outputTokens:10,cachedInputTokens:null,totalTokens:110},'身份不一致的缓存不补写');
 const impossible=mergeAttemptUsage({inputTokens:10,outputTokens:1,cachedInputTokens:20,totalTokens:11},null);
 assert.equal(impossible.cachedInputTokens,null,'cache 不得超过 input');
});
