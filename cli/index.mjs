#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ensureNodeRuntime} from './lib/node-runtime.mjs';
import {
  acceptTask,bindCurrent,compactView,continueTask,dispatch,loadModules,readBinding,retireTask,snapshot,stopTask,verifyTask,
} from './lib/runtime.mjs';
import {inboxView,taskDetails,waitForTasks} from './lib/task-read.mjs';
import {dataRoot} from './lib/storage-paths.mjs';

ensureNodeRuntime();

const commands={
  acceptance:'功能验收：init/validate/build 生成离线 HTML，serve 本机静态预览；无需安装独立技能',
  bind:'绑定当前 Codex 会话',open:'打开当前会话的只读小队页面',snapshot:'读取当前会话的小队简洁快照',details:'按需读取原任务的公开执行详情',
  inbox:'读取待Codex核验与Codex核验中的返回队列',
  dispatch:'交办一个新问题',continue:'沿原执行会话续接',stop:'停止当前成员执行',wait:'有界等待小队变化',
  verify:'登记主 Codex 开始核验当前返回',retire:'记录任务取消或已被替代（cancelled|superseded）',
  accept:'记录负责人验收',summary:'保存、读取或查看当前会话的Agent总结（write/read/open）',review:'通过统一服务打开当前会话的UED评审目录（open）',
  intro:'查看 GitHub Pages 产品介绍与使用说明（open）',
  analytics:'读取最近成功保存的整体分析报告（stdin 可选 {scope,days}）',
  analysis:'分析报告：run（stdin {requestId,days}）/status/report（stdin 可选 {runId,days}）',
};

function fail(code,message){
  const error=Object.assign(new Error(message),{code});
  throw error;
}
async function readInput({required=false}={}){
  const chunks=[];
  let size=0;
  for await(const chunk of process.stdin){
    size+=chunk.length;
    if(size>200_000)fail('SQUAD_INPUT_INVALID','输入超过 200000 字节。');
    chunks.push(chunk);
  }
  const raw=Buffer.concat(chunks).toString('utf8').trim();
  if(!raw){
    if(required)fail('SQUAD_INPUT_INVALID','该命令需要 stdin JSON。');
    return {};
  }
  let value;
  try{value=JSON.parse(raw);}
  catch(error){fail('SQUAD_INPUT_INVALID',`stdin 不是有效 JSON：${error.message}`);}
  if(!value||typeof value!=='object'||Array.isArray(value))fail('SQUAD_INPUT_INVALID','stdin JSON 必须是对象。');
  return value;
}
async function currentBinding(){
  const threadId=String(process.env.CODEX_THREAD_ID||'').trim();
  if(!threadId)fail('SQUAD_HOST_THREAD_MISSING','当前进程没有 CODEX_THREAD_ID，无法定位小队绑定。');
  const binding=await readBinding(threadId);
  if(!binding)fail('SQUAD_BINDING_NOT_FOUND','当前会话尚未绑定小队，请先执行 bind。');
  return binding;
}
async function serviceOrigin(){
  try{
    const receipt=JSON.parse(await readFile(join(dataRoot(),'service','receipt.json'),'utf8'));
    if(typeof receipt?.origin==='string'&&/^http:\/\/127\.0\.0\.1:\d+$/.test(receipt.origin))return receipt.origin;
  }catch{}
  return null;
}
async function withProgressLink(result){
  if(!result.accepted||!result.taskId)return result;
  try{
    const {openViewer}=await import('./lib/viewer.mjs');const view=await openViewer(await currentBinding());
    return {...result,progressUrl:`${view.url}#session/${encodeURIComponent(result.taskId)}`};
  }catch(error){
    return {...result,progressUrl:null,pageError:{code:error.code||'SQUAD_VIEW_UNAVAILABLE',message:error.message}};
  }
}
async function run(command){
  if(command==='bind'){
    const binding=await bindCurrent({});
    return {connected:true,binding:{threadId:binding.threadId,workspace:binding.workspace,projectId:binding.projectId,parentWorkId:binding.parentWorkId,title:binding.title}};
  }
  if(command==='snapshot')return compactView(await snapshot(await currentBinding()));
  if(command==='inbox'){
    const binding=await currentBinding();
    return inboxView(binding,{loadClient:async()=>(await loadModules({defaultWorkspace:binding.workspace})).client});
  }
  if(command==='analytics'){
    const input=await readInput();
    if(Object.keys(input).some(key=>!['scope','days'].includes(key)))fail('SQUAD_INPUT_UNKNOWN_FIELD','analytics 只接受 scope 与 days。');
    const {savedAnalytics}=await import('./lib/analysis-service.mjs');
    return savedAnalytics(await currentBinding(),input,{home:dataRoot(),origin:await serviceOrigin()});
  }
  if(command==='analysis'){
    const action=process.argv[3];
    if(!action)return {actions:{
      run:'stdin {requestId,days=7|30|null}，同步执行一轮本机整体分析并返回紧凑运行记录',
      status:'读取运行状态、最近成功报告与周期计划',
      report:'stdin 可选 {runId?,days?}，读取已保存的成功报告',
    }};
    if(!['run','status','report'].includes(action))fail('SQUAD_COMMAND_UNKNOWN','analysis 仅支持 run/status/report。');
    const binding=await currentBinding();
    const {analysisRunsView,analysisReport,startAnalysis}=await import('./lib/analysis-service.mjs');
    const {compactRun}=await import('./lib/analysis-runs.mjs');
    if(action==='run'){
      const input=await readInput({required:true});
      if(Object.keys(input).some(key=>!['requestId','days'].includes(key)))fail('SQUAD_INPUT_UNKNOWN_FIELD','analysis run 只接受 requestId 与 days。');
      if(input.days!==undefined&&input.days!==null&&input.days!==7&&input.days!==30)fail('SQUAD_ANALYSIS_WINDOW_INVALID','days 只支持 7、30 或 null。');
      const result=await startAnalysis({
        home:dataRoot(),trigger:'manual',requestId:input.requestId,days:input.days??null,
        requestedByThreadId:binding.threadId,
      });
      const completed=result.completion?await result.completion:null;
      return {
        schemaVersion:1,skipped:Boolean(completed?.skipped??result.skipped),reason:completed?.reason||result.reason||null,reused:Boolean(result.reused),
        run:compactRun(completed?completed.run:result.run),reportAvailable:Boolean(completed?.report||result.report||result.run?.reportAvailable),error:completed?.error||null,
      };
    }
    if(action==='status')return analysisRunsView({home:dataRoot()});
    const input=await readInput();
    if(Object.keys(input).some(key=>!['runId','days'].includes(key)))fail('SQUAD_INPUT_UNKNOWN_FIELD','analysis report 只接受 runId 与 days。');
    const detail=await analysisReport({home:dataRoot(),runId:input.runId||null,days:input.days??null,origin:await serviceOrigin()});
    if(!detail)fail('SQUAD_ANALYSIS_REPORT_MISSING','没有可读取的成功分析报告。');
    return detail;
  }
  if(command==='details'){
    const input=await readInput({required:true});
    if(Object.keys(input).some(key=>!['taskId','attemptId','process','after','limit'].includes(key)))fail('SQUAD_INPUT_UNKNOWN_FIELD','details 只接受 taskId、可选 attemptId、process、after 与 limit。');
    if(typeof input.taskId!=='string'||!input.taskId.trim())fail('SQUAD_INPUT_INVALID','taskId 不能为空。');
    if(input.attemptId!==undefined&&(typeof input.attemptId!=='string'||!input.attemptId.trim()))fail('SQUAD_INPUT_INVALID','attemptId 必须是非空字符串。');
    if(input.process!==undefined&&typeof input.process!=='boolean')fail('SQUAD_INPUT_INVALID','process 必须是布尔值。');
    if(input.after!==undefined&&(!Number.isSafeInteger(Number(input.after))||Number(input.after)<0))fail('SQUAD_INPUT_INVALID','after 必须是非负整数。');
    if(input.limit!==undefined&&(!Number.isSafeInteger(Number(input.limit))||Number(input.limit)<1||Number(input.limit)>200))fail('SQUAD_INPUT_INVALID','limit 必须是 1 到 200 的整数。');
    const binding=await currentBinding();
    return taskDetails(binding,{
      taskId:input.taskId.trim(),attemptId:input.attemptId?.trim()||null,
      process:input.process===true,after:Number(input.after)||0,limit:Number(input.limit)||50,
    },{loadClient:async()=>(await loadModules({defaultWorkspace:binding.workspace})).client});
  }
  if(command==='open'){
    const binding=await currentBinding();
    const viewer=await import('./lib/viewer.mjs');
    return viewer.openViewer(binding);
  }
  if(command==='summary'){
    const action=process.argv[3];
    if(!action)return {actions:{write:'stdin {title,content}，保存会话总结并返回链接，不回显正文',read:'读取当前总结供Agent恢复上下文',open:'仅返回总结链接，不自动打开浏览器'}};
    const binding=await currentBinding();
    const {readSummary,writeSummary}=await import('./lib/summary.mjs');
    if(action==='read'){const value=await readSummary(binding);return value?{...value,history:value.history.map(({content,...meta})=>meta)}:null;}
    if(action!=='write'&&action!=='open')fail('SQUAD_COMMAND_UNKNOWN','summary 仅支持 write/read/open。');
    const saved=action==='write'?await writeSummary(binding,await readInput({required:true})):{};
    const {openViewer}=await import('./lib/viewer.mjs');return {...saved,...await openViewer(binding,{page:'summary'})};
  }
  if(command==='intro'){
    if(process.argv[3]!=='open')return {actions:{open:'返回 GitHub Pages 产品介绍链接，无需绑定或启动本机服务'}};
    const {readFile}=await import('node:fs/promises');const intro=JSON.parse(await readFile(new URL('../skills/codex-squad/references/introduction.json',import.meta.url),'utf8'));
    if(!intro.url)fail('SQUAD_INTRO_NOT_PUBLISHED','介绍页尚未取得可确认的公开地址。');return intro;
  }
  if(command==='review'){
    if(process.argv[3]!=='open')return {actions:{open:'stdin {directory}，挂载本会话的UED评审目录并返回统一服务链接'}};
    const input=await readInput({required:true});
    if(Object.keys(input).some(key=>key!=='directory')||typeof input.directory!=='string'||!input.directory.trim())fail('SQUAD_INPUT_INVALID','review open 只接受非空 directory。');
    const {openViewer}=await import('./lib/viewer.mjs');return openViewer(await currentBinding(),{page:'review',reviewDirectory:input.directory});
  }
  if(command==='dispatch')return withProgressLink(await dispatch(await readInput({required:true})));
  if(command==='continue')return withProgressLink(await continueTask(await readInput({required:true})));
  if(command==='stop')return stopTask(await readInput({required:true}));
  if(command==='verify')return verifyTask(await readInput({required:true}));
  if(command==='retire')return retireTask(await readInput({required:true}));
  if(command==='accept')return acceptTask(await readInput({required:true}));
  if(command==='wait'){
    const binding=await currentBinding();
    const input=await readInput();
    if(Object.keys(input).some(key=>!['taskIds','after','seconds'].includes(key)))fail('SQUAD_INPUT_UNKNOWN_FIELD','wait 只接受 taskIds、after 与 seconds。');
    if(input.after!==undefined&&typeof input.after!=='string')fail('SQUAD_INPUT_INVALID','after 必须是 wait 返回的游标字符串。');
    if(input.seconds!==undefined&&(!Number.isFinite(Number(input.seconds))||Number(input.seconds)<0||Number(input.seconds)>30))fail('SQUAD_INPUT_INVALID','seconds 必须是 0 到 30 的数值。');
    return waitForTasks(binding,{taskIds:input.taskIds,after:input.after||'',seconds:input.seconds===undefined?30:Number(input.seconds)},{
      loadClient:async()=>(await loadModules({defaultWorkspace:binding.workspace})).client,
    });
  }
  if(command==='--help'||command==='help'||!command){
    return {commands:Object.fromEntries(Object.entries(commands)),note:'除 bind/open/snapshot/wait 外，命令从 stdin 读取 JSON；会话身份只来自 CODEX_THREAD_ID。'};
  }
  throw Object.assign(new Error(`未知命令：${command}`),{code:'SQUAD_COMMAND_UNKNOWN'});
}

const command=process.argv[2]||'help';
if(command==='acceptance'){
  const {spawnSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const entry=fileURLToPath(new URL('./lib/functional-acceptance/scripts/acceptance.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[entry,...process.argv.slice(3)],{stdio:'inherit'});
  if(result.error){process.stderr.write(`功能验收启动失败：${result.error.message}\n`);process.exitCode=1;}
  else process.exitCode=result.status??1;
}else{
try{
  const result=await run(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}catch(error){
  const payload={ok:false,error:{code:error?.code||'SQUAD_FAILED',message:String(error?.message||error)}};
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode=1;
}
}
