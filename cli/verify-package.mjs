import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
const ts=createRequire(import.meta.url)('typescript');

const root=fileURLToPath(new URL('../dist/plugin/',import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
assert.equal(manifest.name,'codex-squad');
assert.equal(manifest.version,metadata.version);
assert.equal(manifest.skills,'./skills/');
assert.deepEqual((await readdir(root)).sort(),['.codex-plugin','README.md','package.json','cli','skills'].sort());
assert.equal(metadata.bin['codex-squad'],'cli/index.mjs');
assert.ok((await readFile(path.join(root,'cli/index.mjs'))).length>0);
for(const name of ['runtime','worker','node-runtime','worker-control','local-store','storage-paths','host-session','host-title','codex-usage','cli-metrics','qoder-cli-usage','executor-usage','squad-benefits','task-read','handover','update-check','runtime-info','evidence','viewer','summary','qoder-execution','write-scope','conversation','analytics','analysis-service','analysis-worker','analysis-runner','analysis-runs','analysis-report']){
  assert.ok((await readFile(path.join(root,`cli/lib/${name}.mjs`))).length>0);
}
for(const name of ['codex-squad','ued-designer','stitch-review','session-summary','initialize','functional-acceptance']){
  assert.match(await readFile(path.join(root,`skills/${name}/SKILL.md`),'utf8'),new RegExp(`name: ${name}`));
}
const acceptanceSkill=await readFile(path.join(root,'skills/functional-acceptance/SKILL.md'),'utf8');
assert.match(acceptanceSkill,/description:.*功能测试.*测试报告/);
assert.match(await readFile(path.join(root,'skills/functional-acceptance/agents/openai.yaml'),'utf8'),/display_name: "功能验收"/);
assert.ok((await readFile(path.join(root,'skills/ued-designer/references/stitch-setup.md'))).length>0);
const build=JSON.parse(await readFile(path.join(root,'cli/public/build.json'),'utf8'));
for(const name of Object.keys(build.assets)){
  const actual=createHash('sha256').update(await readFile(path.join(root,'cli/public',name))).digest('hex');
  assert.equal(actual,build.assets[name],`Packaged asset mismatch: ${name}`);
}
assert.ok(build.assets['design/session.css']);
for(const name of ['summary.html','summary.css','summary.js','design/product-logo.png','design/product-brand.css'])assert.ok(build.assets[name]);
assert.ok(Object.keys(build.assets).some(name=>name.endsWith('.woff2')));
assert.equal((await readdir(path.join(root,'cli/public'))).some(name=>/fixture|qa-states/.test(name)),false,'QA entries must not ship');
const review=path.join(root,'skills/stitch-review/assets/review');
// app.js 哈希随用户要求的缩放灵敏度交互修订更新（滚轮系数 0.004、步长 1.5）。
for(const [name,hash] of Object.entries({
  'app.js':'1af01afda25f655e0912b7730b710aa1ca5d3ef044a4b111d4360584228ba2af',
  'index.html':'5c68d0e4c835d6636f8b2221e3a0cbd81d7c147bdda4101502b63aa6baa1c3bc',
  'style.css':'b1b928270b5cafc7c5eb125b5cf076653c27023f9df0d33710bfccf3f0794744',
  'data.json':'d79c1d18a2e6853b03fcaa078ec490d0bef20fb4660db55d350b138b78ea78d3',
}))assert.equal(createHash('sha256').update(await readFile(path.join(review,name))).digest('hex'),hash,`Accepted r5 review asset: ${name}`);
const help=JSON.parse(execFileSync(process.execPath,[path.join(root,'cli/index.mjs'),'--help'],{cwd:root,encoding:'utf8'}));
assert.ok(help.commands.bind&&help.commands.dispatch&&help.commands.open&&help.commands.acceptance);
const acceptanceHelp=execFileSync(process.execPath,[path.join(root,'cli/index.mjs'),'acceptance','--help'],{cwd:root,encoding:'utf8'});
assert.match(acceptanceHelp,/codex-squad acceptance build/);
assert.match(acceptanceHelp,/codex-squad acceptance serve/);
assert.equal(/assistant|--env\b/.test(acceptanceHelp),false,'Acceptance serve must stay local and static');
for(const name of ['assets/studio/template.html','assets/studio/app.js','assets/studio/app.css','assets/studio/code-view.js','references/data-contract.md','scripts/lib/serve.mjs']){
  assert.ok((await readFile(path.join(root,'cli/lib/functional-acceptance',name))).length>0);
}
const acceptanceRoot=path.join(root,'cli/lib/functional-acceptance');
assert.equal((await readdir(acceptanceRoot)).includes('assistant'),false,'Private assistant assets must not ship');
assert.equal((await readdir(path.join(root,'cli/lib'))).includes('update-install.mjs'),false,'Native auto-install must not ship');
const acceptanceDir=await mkdtemp(path.join(tmpdir(),'squad-packaged-acceptance-'));
try{
  const input=path.join(acceptanceDir,'data'),output=path.join(acceptanceDir,'report');
  const invoke=(args)=>JSON.parse(execFileSync(process.execPath,[path.join(root,'cli/index.mjs'),'acceptance',...args,'--json'],{cwd:acceptanceDir,encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:''}}));
  assert.equal(invoke(['init',input]).ok,true);
  assert.equal(invoke(['validate',path.join(input,'acceptance.json')]).ok,true);
  const built=invoke(['build',path.join(input,'acceptance.json'),'--out',output]);
  assert.equal(built.generator.name,'codex-squad-functional-acceptance');
  assert.match(await readFile(path.join(output,'index.html'),'utf8'),/acceptance-data/);
}finally{await rm(acceptanceDir,{recursive:true,force:true});}
const intro=JSON.parse(await readFile(path.join(root,'skills/codex-squad/references/introduction.json'),'utf8'));const introUrl=new URL(intro.url);assert.equal(introUrl.href,'https://chenchen428.github.io/codex-squad/');assert.equal(introUrl.hostname,'chenchen428.github.io');assert.equal(introUrl.pathname,'/codex-squad/');
async function verifyImports(folder){
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const file=path.join(folder,entry.name);
    if(entry.isDirectory()){await verifyImports(file);continue}
    assert.ok(!file.endsWith('.py'),'Python must not be required by the installed plugin');
    if(!file.endsWith('.mjs'))continue;
    const code=await readFile(file,'utf8');
    const source=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const imports=[];
    function visit(node){
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))imports.push(node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))imports.push(node.arguments[0].text);
      ts.forEachChild(node,visit);
    }
    visit(source);
    for(const name of imports){
      if(isBuiltin(name))continue;
      assert.ok(name.startsWith('./')||name.startsWith('../'),`External runtime import: ${name}`);
      const target=path.resolve(path.dirname(file),name);
      assert.ok(!path.relative(root,target).startsWith('..'),`Runtime import escapes plugin: ${name}`);
      assert.ok((await readFile(target)).length>0,`Runtime dependency missing: ${name}`);
    }
  }
}
await verifyImports(path.join(root,'cli/lib'));
await verifyImports(path.join(root,'skills/stitch-review/scripts'));
assert.equal(Object.keys(metadata.dependencies||{}).length,0,'Installed plugin must not require npm install');
console.log(`Verified portable plugin ${manifest.name}@${manifest.version}`);
