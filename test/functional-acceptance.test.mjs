import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const cli=path.join(root,'cli/index.mjs');
const pluginVersion=JSON.parse(readFileSync(path.join(root,'.codex-plugin/plugin.json'),'utf8')).version;
const run=(args)=>spawnSync(process.execPath,[cli,'acceptance',...args],{encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:''},cwd:tmpdir()});

test('小队发布命令无需绑定即可初始化、校验和生成自包含功能验收HTML',t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'squad-acceptance-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const data=path.join(dir,'data'),input=path.join(data,'acceptance.json'),out=path.join(dir,'report');
  const init=run(['init',data,'--json']);assert.equal(init.status,0,init.stderr);
  const value=JSON.parse(readFileSync(input,'utf8'));
  value.cases[0].caseDesign={why:'验证新增设置不会影响已有选择，防止配置串用。',sources:[{kind:'confirmation',label:'需求原话',quote:'新设置只对当前场景生效。'}]};
  writeFileSync(input,JSON.stringify(value));
  assert.equal(run(['validate',input,'--json']).status,0);
  const build=run(['build',input,'--out',out,'--json']);assert.equal(build.status,0,build.stderr||build.stdout);
  const result=JSON.parse(build.stdout);assert.equal(result.generator.name,'codex-squad-functional-acceptance');
  const html=readFileSync(path.join(out,'index.html'),'utf8');
  assert.match(html,/用例设计依据/);assert.match(html,/新设置只对当前场景生效/);assert.match(html,/Content-Security-Policy/);
  assert.equal(/<iframe\b|<script[^>]+src=["']https?:/i.test(html),false);
  assert.equal(existsSync(path.join(out,'manifest.json')),true);
  const before=readFileSync(path.join(out,'index.html'));
  assert.equal(run(['build',input,'--out',out,'--json']).status,1,'拒绝覆盖既有验收包');
  assert.deepEqual(readFileSync(path.join(out,'index.html')),before);
});

test('小队功能验收保留用法错误退出码和结构校验错误',()=>{
  assert.equal(run(['build']).status,2);
  assert.equal(run(['--version']).stdout.trim(),`codex-squad-functional-acceptance ${pluginVersion}`);
});

test('插件扫描技能目录可以发现功能验收入口，入口的合同链接在同一插件内有效',()=>{
  const manifest=JSON.parse(readFileSync(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
  const skillRoot=path.resolve(root,manifest.skills,'functional-acceptance');
  const skill=readFileSync(path.join(skillRoot,'SKILL.md'),'utf8');
  assert.match(skill,/^---\nname: functional-acceptance\n/);
  assert.match(skill,/description:.*功能测试.*测试报告/);
  for(const match of skill.matchAll(/\]\(([^)]+\.md)\)/g)){
    const linked=path.resolve(skillRoot,match[1]);
    assert.ok(linked.startsWith(root));assert.ok(existsSync(linked),match[1]);
  }
  assert.match(readFileSync(path.join(skillRoot,'agents/openai.yaml'),'utf8'),/display_name: "功能验收"/);
});
