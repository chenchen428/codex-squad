import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI=fileURLToPath(new URL('../cli/index.mjs',import.meta.url));
const THREAD='44444444-4444-4444-8444-444444444444';

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'squad-cli-'));
  await mkdir(join(directory,'bindings'),{recursive:true});
  await writeFile(join(directory,'bindings',`${THREAD}.json`),JSON.stringify({
    schemaVersion:1,threadId:THREAD,workspace:'/Users/private/work',projectId:'p',parentWorkId:'w',
    title:'CLI 验收小队',tasks:[],attempts:{},workers:{},reviews:{},retirements:{},
    createdAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z',
  })+'\n');
  const env={...process.env,PLUGIN_DATA:directory,CODEX_THREAD_ID:THREAD};
  function cli(args,input=''){
    const result=spawnSync(process.execPath,[CLI,...args],{env,input,encoding:'utf8',timeout:20000});
    return {
      status:result.status,
      stdout:result.stdout||'',
      stderr:result.stderr||'',
      json:parse(result.stdout),
      error:parse(result.stderr),
    };
  }
  return {directory,cli,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
function parse(text){
  try{return text.trim()?JSON.parse(text):null}catch{return null}
}

test('analysis status and analytics read saved state without creating runs',async()=>{
  const {directory,cli,cleanup}=await fixture();
  try{
    const status=cli(['analysis','status']);
    assert.equal(status.status,0,status.stderr);
    assert.equal(status.json.schemaVersion,1);
    assert.deepEqual(status.json.history,[]);
    assert.equal(status.json.schedule.enabled,false);
    assert.equal(status.json.current,null);

    const analytics=cli(['analytics']);
    assert.equal(analytics.status,0,analytics.stderr);
    assert.equal(analytics.json.scope,'global');
    assert.equal(analytics.json.metrics.taskCount,0);
    assert.equal(analytics.json.analysis.available,false);
    assert.equal(analytics.json.analysis.reason,'NO_SUCCESSFUL_REPORT');

    await assert.rejects(stat(join(directory,'analysis')),error=>error.code==='ENOENT');
  }finally{await cleanup()}
});

test('analysis run and report reject input before starting Codex',async()=>{
  const {directory,cli,cleanup}=await fixture();
  try{
    const report=cli(['analysis','report']);
    assert.equal(report.status,1);
    assert.equal(report.error.error.code,'SQUAD_ANALYSIS_REPORT_MISSING');

    const unknown=cli(['analysis','run'],'{"requestId":"request-0001","prompt":"x"}');
    assert.equal(unknown.status,1);
    assert.equal(unknown.error.error.code,'SQUAD_INPUT_UNKNOWN_FIELD');

    const invalidDays=cli(['analysis','run'],'{"requestId":"request-0001","days":14}');
    assert.equal(invalidDays.status,1);
    assert.equal(invalidDays.error.error.code,'SQUAD_ANALYSIS_WINDOW_INVALID');

    const badReportInput=cli(['analysis','report'],'{"scope":"global"}');
    assert.equal(badReportInput.status,1);
    assert.equal(badReportInput.error.error.code,'SQUAD_INPUT_UNKNOWN_FIELD');

    await assert.rejects(stat(join(directory,'analysis')),error=>error.code==='ENOENT');
  }finally{await cleanup()}
});
