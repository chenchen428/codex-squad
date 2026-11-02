import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {validateStructure} from '../../../scripts/lib/contract.mjs';
const V=createRequire(import.meta.url)('../app.js');
test('header renders only labeled HTTPS references, escaping text and isolating external windows',()=>{
 const links=[{label:'需求 <85468484>',url:'https://project.example.com/a?x=1&y=2'},{label:'重复',url:'https://project.example.com/a?x=1&y=2'},{label:'不安全',url:'javascript:alert(1)'},{label:'凭据',url:'https://user:password@example.com/a'}];
 const html=V.reportLinksHtml({links});
 assert.match(html,/需求 &lt;85468484&gt;/);assert.match(html,/x=1&amp;y=2/);
 assert.match(html,/rel="noopener noreferrer"/);assert.equal((html.match(/<a /g)||[]).length,1);
 assert.equal(V.reportLinksHtml({}), '');
});
test('explicit raw response references expose original JSON and text without treating summaries as returned data',()=>{
 const step={evidenceIds:['raw'],verification:{response:{evidenceId:'raw'}}};
 const model=V.buildModel({report:{},cases:[],evidence:[{id:'raw',type:'json',title:'原始API返回',content:'{"resultCode":-9,"data":null,"id":9007199254740993}'}]});
 const reply=V.buildResponse(step,model,step.verification);assert.ok(reply);assert.equal(reply.text.slice(reply.node.entries.find(x=>x.key==='id').node.start,reply.node.entries.find(x=>x.key==='id').node.end),'9007199254740993');
 const textModel=V.buildModel({report:{},cases:[],evidence:[{id:'raw',type:'text',title:'原始stdout',content:'第2行：收款账户类型非法'}]});
 assert.equal(V.buildResponse(step,textModel,step.verification).plainText,true);
 assert.equal(V.buildResponse(step,model,{response:{evidenceId:'other'}}),null);
 assert.equal(V.buildResponse(step,model,{response:{evidenceId:'raw',jsonPointer:'/missing'}}),null);
});
test('report link data survives model normalization and malformed references fail contract checks',()=>{
 const report={id:'r',title:'报告',environment:'预发',example:false,links:[{label:'变更需求',url:'https://project.example.com/work/85468484'}]};
 assert.equal(V.buildModel({report,cases:[]}).report.links[0].label,'变更需求');
 for(const links of [[{label:'无地址'}],[{label:'凭据',url:'https://user:password@project.example.com/a'}],new Array(13).fill({label:'x',url:'https://a.example.com/x'})]){
  assert.ok(validateStructure({schemaVersion:1,report:{...report,links},groups:[],cases:[]}).errors.some(e=>e.code.startsWith('E_REPORT_LINK')));
 }
});
test('valid explicit raw responses survive structure validation and images cannot be responses',()=>{
 const input={schemaVersion:1,report:{id:'r',title:'报告',environment:'PRE',example:false},groups:[{id:'g',title:'分组'}],evidence:[{id:'raw',type:'json',title:'原始返回',value:{resultCode:-9}}],cases:[{id:'c',groupId:'g',title:'拒绝超额',objective:'验证返回',status:'passed',steps:[{id:'s',type:'api',title:'提交',action:'提交超额请求',expected:'拒绝',actual:'resultCode=-9',status:'passed',evidenceIds:['raw'],verification:{response:{evidenceId:'raw'}}}],checks:[]}]};
 input.cases[0].checks=[{id:'check',stepId:'s',title:'超额拒绝',status:'passed',expected:'拒绝',actual:'resultCode=-9',evidenceIds:['raw']}];
 assert.deepEqual(validateStructure(input).errors,[]);
 input.evidence[0].type='image';input.evidence[0].file='screen.png';delete input.evidence[0].value;
 assert.ok(validateStructure(input).errors.some(e=>e.code==='E_VERIFICATION_RESPONSE_EVIDENCE'));
});
