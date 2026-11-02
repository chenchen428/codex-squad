import test from 'node:test';
import assert from 'node:assert/strict';
import {auditQuality} from '../lib/quality.mjs';
import {imageDimensions} from '../lib/assets.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {loadAndValidate} from '../lib/validate.mjs';
const fixture=()=>({ok:true,inputSha256:'a'.repeat(64),data:{report:{revision:'rev1',links:[{label:'需求',url:'https://project.example.com/r/1'}]},groups:[],cases:[{id:'c',caseRole:'regression',caseDesign:{why:'账户变更不得影响历史付款',sources:[{quote:'历史付款记录保持只读'}]},status:'passed',steps:[{id:'s',type:'page',status:'passed',expected:'已确认账户只读，不提供修改入口',actual:'已确认账户只读，页面没有修改按钮',evidenceIds:['image']}],checks:[{id:'check',stepId:'s',status:'passed',expected:'账户只读',actual:'页面没有修改入口',evidenceIds:['image']}]}],evidence:[{id:'image',type:'image',source:'真实预发截图',annotations:[{label:'检查修改入口缺失',x:5,y:5,w:80,h:40}]}]},evidence:new Map([['image',{type:'image',width:100,height:100}]])});
test('quality audit accepts specific evidence and returns machine-readable coverage without changing results',()=>{
 const value=fixture(),before=JSON.stringify(value.data);const result=auditQuality(value);
 assert.equal(result.ok,true);assert.equal(result.errors.length,0);assert.equal(result.warnings.length,0);assert.equal(result.stats.images,1);
 assert.equal(JSON.stringify(value.data),before);assert.match(result.boundary,/不验证业务结论真实性/);
});
test('missing rationale, unmarked images, out-of-bounds boxes and contradictory pass cannot escape through structure validation',()=>{
 const x=fixture();delete x.data.cases[0].caseDesign;x.data.cases[0].steps[0].status='blocked';x.data.evidence[0].annotations[0].w=200;
 const result=auditQuality(x),codes=result.errors.map(e=>e.code);
 for(const code of ['Q_CASE_WHY','Q_CASE_SOURCE','Q_IMAGE_BOUNDS','Q_STATUS_CONFLICT'])assert.ok(codes.includes(code),code);
 x.data.evidence[0].annotations=[];assert.ok(auditQuality(x).errors.some(e=>e.code==='Q_IMAGE_FOCUS'));
});
test('passing generic outcomes fail while missing historical evidence is explicit and never invented',()=>{
 const x=fixture();x.data.cases[0].steps[0].actual='符合预期';x.data.cases[0].steps[0].evidenceIds=[];x.data.cases[0].checks=[];
 const result=auditQuality(x);assert.ok(result.errors.some(e=>e.code==='Q_ACTUAL'));assert.ok(result.errors.some(e=>e.code==='Q_PAGE_MATERIAL'));assert.ok(result.errors.some(e=>e.code==='Q_PASS_EVIDENCE'));
});
test('focus references must point at actual rows and columns',()=>{
 const x=fixture();x.data.cases[0].steps[0].verification={focus:[{label:'金额',cellRefs:[{resultSet:0,row:4,column:'amount'}]}]};
 assert.ok(auditQuality(x).errors.some(e=>e.code==='Q_FOCUS_TARGET'));
});
test('image dimensions are read from real PNG/JPEG/WebP bytes',()=>{
 const png=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(640,16);png.writeUInt32BE(480,20);
 assert.deepEqual(imageDimensions(png),{width:640,height:480});
 const jpg=Buffer.from([255,216,255,192,0,7,8,1,224,2,128]);assert.deepEqual(imageDimensions(jpg,'image/jpeg'),{width:640,height:480});
 const webp=Buffer.alloc(30);webp.write('RIFF',0);webp.write('WEBP',8);webp.write('VP8X',12);webp.writeUIntLE(639,24,3);webp.writeUIntLE(479,27,3);
 assert.deepEqual(imageDimensions(webp),{width:640,height:480});assert.deepEqual(imageDimensions(Buffer.alloc(3)),{});
});
test('CLI audit reports content defects, strict warnings fail, and required quality blocks output',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'squad-quality-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cli=fileURLToPath(new URL('../acceptance.mjs',import.meta.url));
 const run=args=>spawnSync(process.execPath,[cli,...args,'--json'],{encoding:'utf8'});
 assert.equal(run(['init',root]).status,0);
 const input=path.join(root,'acceptance.json'),out=path.join(root,'report');
 const first=run(['audit',input]);assert.equal(first.status,1);assert.ok(JSON.parse(first.stdout).errors.some(e=>e.code==='Q_CASE_WHY'));
 const build=run(['build',input,'--out',out,'--require-quality']);assert.equal(build.status,1);assert.equal(JSON.parse(build.stdout).stage,'quality');assert.equal(fs.existsSync(out),false);
 const data=JSON.parse(fs.readFileSync(input));data.cases[0].caseRole='new';data.cases[0].caseRoleReason='新增账户页面';data.cases[0].caseRoleSources=['用户原话'];data.cases[0].caseDesign={why:'新增选户路径需要验证可访问性',sources:[{kind:'requirement',label:'用户需求',quote:'打开账户页面'}]};data.cases[0].steps[0].actual='测试环境未启动，本步骤尚未执行';fs.writeFileSync(input,JSON.stringify(data));
 assert.equal(run(['audit',input]).status,0);assert.equal(run(['audit',input,'--strict']).status,1);
 assert.equal(run(['validate',input,'--require-quality']).status,2);
 const invalid=path.join(root,'invalid.json');fs.writeFileSync(invalid,'{');assert.equal(JSON.parse(run(['audit',invalid]).stdout).ok,false);
});
test('an executed step cannot pass quality with only an actual summary and an unavailable original',()=>{
 const x=fixture();x.data.cases[0].steps[0]={id:'db',type:'data',title:'查询前置',status:'passed',expected:'状态INIT，付款记录为3条',actual:'状态INIT、付款3',evidenceIds:['db-result'],verification:{statement:{kind:'sql',origin:'unavailable',explanation:'原文未留存'}}};
 x.data.evidence.push({id:'db-result',type:'json',source:'原始DMS输出',content:{results:[{columnNames:['state'],rows:[{state:'INIT'}]}]}});x.evidence.set('db-result',{type:'json',content:JSON.stringify(x.data.evidence.at(-1).content)});
 const q=auditQuality(x);assert.equal(q.ok,false);assert.ok(q.errors.some(e=>e.code==='Q_STEP_ORIGINAL'));assert.ok(q.errors.some(e=>e.code==='Q_STEP_RESULT'));assert.equal(q.repairTasks[0].stepId,'db');assert.deepEqual(q.repairTasks[0].missing,['executedOriginal','visibleRawResult']);
});
test('file-backed original JSON retains duplicate keys, large identifiers and lexical numbers',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'squad-original-json-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cli=fileURLToPath(new URL('../acceptance.mjs',import.meta.url));
 assert.equal(spawnSync(process.execPath,[cli,'init',root,'--json']).status,0);
 const file=path.join(root,'acceptance.json'),data=JSON.parse(fs.readFileSync(file));
 const original=' {"id":9007199254740993,"amount":1.00,"state":"INIT","state":"FAILED"}\n';
 fs.writeFileSync(path.join(root,'evidence','raw.json'),original);
 data.evidence=[{id:'raw',title:'原始返回',type:'json',file:'evidence/raw.json',source:'原始stdout'}];
 data.cases[0].steps[0].evidenceIds=['raw'];fs.writeFileSync(file,JSON.stringify(data));
 const loaded=loadAndValidate(file);assert.equal(loaded.ok,true,JSON.stringify(loaded.errors));assert.equal(loaded.evidence.get('raw').content,original);
});
