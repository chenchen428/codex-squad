import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSummary,writeSummary} from '../cli/lib/summary.mjs';
const binding={threadId:'01a162b5-bd96-7440-90a3-e422ae74d358',workspace:'/workspace/a'};
async function setup(t){const home=await mkdtemp(join(tmpdir(),'squad-summary-'));t.after(()=>rm(home,{recursive:true,force:true}));return {home};}
test('summary stays in the same session, retains stages, and duplicate writes do not add a stage',async t=>{
 const options=await setup(t);assert.equal(await readSummary(binding,options),null);
 assert.equal((await writeSummary(binding,{title:'阶段一',content:'# 目标\n第一条事实。\n'},options)).revision,1);
 assert.equal((await writeSummary(binding,{title:'阶段一',content:'# 目标\n第一条事实。\n'},options)).duplicate,true);
 await writeSummary(binding,{title:'阶段二',content:'已验证；剩余发布。'},options);
 const found=await readSummary(binding,options);assert.equal(found.revision,2);assert.equal(found.content,'已验证；剩余发布。');assert.equal(found.history[0].content,'# 目标\n第一条事实。\n');
 const metadata=await stat(join(options.home,'summaries',binding.threadId+'.json'));assert.equal(metadata.mode&0o777,0o600);
});
test('summary cannot read a second workspace or accept caller-controlled identity and paths',async t=>{
 const options=await setup(t);await writeSummary(binding,{title:'事实',content:'只属于本会话。'},options);
 await assert.rejects(readSummary({...binding,workspace:'/workspace/other'},options),{code:'SQUAD_SUMMARY_BINDING_MISMATCH'});
 await assert.rejects(writeSummary(binding,{title:'其他',content:'x',threadId:'other'},options),{code:'SQUAD_SUMMARY_INPUT_INVALID'});
 await assert.rejects(readSummary({...binding,threadId:'../outside'},options),{code:'SQUAD_SUMMARY_BINDING_INVALID'});
});
test('missing is distinct from corrupt summary, and literal Markdown is preserved',async t=>{
 const options=await setup(t),content='<script>never execute</script>\n未知不能补零。';await writeSummary(binding,{title:'字面内容',content},options);assert.equal((await readSummary(binding,options)).content,content);
 const file=join(options.home,'summaries',binding.threadId+'.json');const data=JSON.parse(await readFile(file));data.threadId='another';await writeFile(file,JSON.stringify(data));await assert.rejects(readSummary(binding,options),{code:'SQUAD_SUMMARY_BINDING_MISMATCH'});
});
