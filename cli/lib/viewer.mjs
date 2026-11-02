import {nodeFlags} from './node-runtime.mjs';
import {dataRoot} from './storage-paths.mjs';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open,unlink,realpath,link,readdir} from 'node:fs/promises';
import {join,resolve,relative,extname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root=fileURLToPath(new URL('../../',import.meta.url));
const ownPath=fileURLToPath(import.meta.url);
const pluginVersion=JSON.parse(await readFile(join(root,'.codex-plugin/plugin.json'),'utf8')).version;
const introduction=JSON.parse(await readFile(join(root,'skills/codex-squad/references/introduction.json'),'utf8'));
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const defaultPort=57755;
const tokenPattern=/^[a-f0-9]{48}$/;
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}};
const home=()=>dataRoot();
const serviceDir=()=>join(home(),'service');
const receiptPath=()=>join(serviceDir(),'receipt.json');
async function jsonFile(file){try{return JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}}
async function writeJson(file,value){const temporary=`${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});await rename(temporary,file)}
async function fingerprint(){
  const hash=createHash('sha256');
  for(const file of ['.codex-plugin/plugin.json','skills/codex-squad/references/introduction.json','cli/index.mjs','cli/public/build.json'])hash.update(await readFile(join(root,file)));
  async function collect(directory){for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(directory,entry.name);if(entry.isDirectory())await collect(file);else hash.update(await readFile(file))}}
  await collect(join(root,'cli/lib'));
  return hash.digest('hex');
}
function contained(parent,child){const path=relative(parent,child);return path===''||(!path.startsWith('..'+ '/')&&path!=='..'&&!isAbsolute(path))}
async function reviewWithin(binding,directory){
  const workspace=await realpath(binding.workspace),target=await realpath(resolve(directory));
  if(!contained(workspace,target))throw new Error('评审目录必须在当前会话工作目录内。');
  await readFile(join(target,'index.html'));return target;
}
// One process serves all chats. Local CLI registration is private; HTTP remains read-only.
export async function openViewer(binding,options={}){
  const id=binding.threadId;
  if(!idPattern.test(id||'')||!binding.workspace)throw new Error('需要有效的当前会话绑定。');
  if(!['squad','summary','review'].includes(options.page||'squad'))throw new Error('未知页面。');
  const reviewDirectory=options.reviewDirectory?await reviewWithin(binding,options.reviewDirectory):null;
  await mkdir(join(serviceDir(),'scopes'),{recursive:true,mode:0o700});
  const scopePath=join(serviceDir(),`${id}.json`);
  let scope=await jsonFile(scopePath);
  if(!scope){
    const initial={threadId:id,workspace:binding.workspace,token:randomBytes(24).toString('hex'),reviewDirectory:null};
    const temporary=`${scopePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;await writeFile(temporary,JSON.stringify(initial)+'\n',{mode:0o600});
    try{await link(temporary,scopePath)}catch(error){if(error.code!=='EEXIST')throw error}finally{await unlink(temporary)}
    scope=await jsonFile(scopePath);
  }
  if(scope.workspace!==binding.workspace)throw new Error('页面绑定工作目录不一致。');
  if(reviewDirectory){scope={...scope,reviewDirectory};await writeJson(scopePath,scope)}
  if(options.page==='review'&&!scope.reviewDirectory)throw new Error('请先登记当前会话的评审目录。');
  await writeJson(join(serviceDir(),'scopes',`${scope.token}.json`),{threadId:id,workspace:binding.workspace,token:scope.token});
  const version=await fingerprint(),existing=await jsonFile(receiptPath());
  let current=existing,reused=false;
  if(existing&&alive(existing.pid)){
    if(existing.fingerprint!==version)throw new Error('小队页面版本已更新，请先关闭该插件自己的旧页面进程再重新打开。');
    const health=await fetch(`${existing.origin}/${scope.token}/api/health`,{signal:AbortSignal.timeout(2000)});
    if(!health.ok||(await health.json()).threadId!==id)throw new Error('已有统一页面服务未返回本会话健康回执，请核对进程。');
    reused=true;
  }else{
    const logfile=await open(join(serviceDir(),'server.log'),'a',0o600);
    const child=spawn(process.execPath,[...nodeFlags(),ownPath,'--serve'],{detached:true,stdio:['ignore',logfile.fd,logfile.fd],env:process.env});child.unref();await logfile.close();
    let spawnError;child.once('error',error=>{spawnError=error});
    const deadline=Date.now()+12000;
    for(;;){
      if(spawnError)throw spawnError;
      current=await jsonFile(receiptPath());
      if(current?.fingerprint===version&&alive(current.pid)){
        const health=await fetch(`${current.origin}/${scope.token}/api/health`,{signal:AbortSignal.timeout(2000)});
        if(health.ok&&(await health.json()).threadId===id){reused=current.pid!==child.pid;break}
      }
      // Concurrent launchers may lose the bind race; only a verified winner receipt is reused.
      if(Date.now()>deadline)throw new Error('统一页面服务启动失败；请检查 service/server.log，端口冲突时不会更换端口或终止未知进程。');
      await delay(60);
    }
  }
  const suffix=options.page==='summary'?'summary/':options.page==='review'?'review/':'';
  return {url:`${current.origin}/${scope.token}/${suffix}`,threadId:id,reused,pid:current.pid,origin:current.origin};
}

const analysisBodyLimit=8*1024;
const analysisRequestPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
function httpError(status,code,message){return Object.assign(new Error(message),{status,code})}
async function readJsonObject(req,{limit,tooLargeCode,invalidCode}){
  const declared=Number(req.headers['content-length']);
  if(Number.isFinite(declared)&&declared>limit)throw httpError(413,tooLargeCode,`请求体超过 ${Math.floor(limit/1024)}KiB。`);
  let size=0,text='',tooLarge=false;
  for await(const chunk of req){
    size+=chunk.length;
    if(size>limit){tooLarge=true;continue;}
    if(!tooLarge)text+=chunk.toString('utf8');
  }
  if(tooLarge)throw httpError(413,tooLargeCode,`请求体超过 ${Math.floor(limit/1024)}KiB。`);
  let value;
  try{value=JSON.parse(text);}
  catch{throw httpError(400,invalidCode,'请求体必须是 JSON。');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw httpError(400,invalidCode,'请求体必须是 JSON 对象。');
  return value;
}
async function readAnalysisBody(req){
  const value=await readJsonObject(req,{
    limit:analysisBodyLimit,tooLargeCode:'SQUAD_ANALYSIS_BODY_TOO_LARGE',invalidCode:'SQUAD_ANALYSIS_BODY_INVALID',
  });
  for(const key of Object.keys(value))if(!['requestId','days'].includes(key))throw httpError(400,'SQUAD_ANALYSIS_FIELD_UNKNOWN','分析请求只接受 requestId 与 days。');
  if(typeof value.requestId!=='string'||!analysisRequestPattern.test(value.requestId))throw httpError(400,'SQUAD_ANALYSIS_REQUEST_INVALID','requestId 格式无效。');
  const days=value.days===undefined?null:value.days;
  if(!(days===null||days===7||days===30))throw httpError(400,'SQUAD_ANALYSIS_WINDOW_INVALID','days 只支持 7、30 或 null。');
  return {requestId:value.requestId,days};
}

export async function createViewer({snapshot,board,task,analytics,analysisRuns=null,runtimeInfo=null,assets=join(root,'cli/public'),loadScope,readSummary,port=0}){
  const files=new Map([['','index.html'],['app.js','app.js'],['app.css','app.css'],['summary/','summary.html'],['summary/summary.js','summary.js'],['summary/summary.css','summary.css']]);
  try{const build=JSON.parse(await readFile(join(assets,'build.json'),'utf8'));for(const file of Object.keys(build.assets||{}))if(/^design\/[a-zA-Z0-9/_.-]+$/.test(file)&&!file.split('/').includes('..'))files.set(file,file)}catch(error){if(error.code!=='ENOENT')throw error}
  let origin;
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if(req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return}
    if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return}
    let writePost=false;
    try{
      const url=new URL(req.url,origin),parts=url.pathname.split('/'),token=parts[1]||'';
      const route=decodeURIComponent(parts.slice(2).join('/'));
      if(req.method!=='GET'&&req.method!=='HEAD'){
        const allowed=route==='api/analysis/runs'&&analysisRuns?.start;
        if(req.method!=='POST'||!allowed){res.writeHead(405,{Allow:'GET, HEAD, POST'});res.end();return}
        writePost=true;
        if(req.headers.origin!==origin){res.writeHead(403);res.end();return}
        if(!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']||''))){res.writeHead(415);res.end();return}
      }
      const scope=tokenPattern.test(token)?await loadScope(token):null;
      if(!scope?.binding){res.writeHead(404);res.end();return}
      const {binding}=scope;
      if(route.split('/').some(part=>part==='..'||part==='.')||route.includes('\\')||route.includes('\0')){res.writeHead(404);res.end();return}
      function json(value){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(req.method==='HEAD'?undefined:JSON.stringify(value))}
      if(route==='api/health'){json({ok:true,threadId:binding.threadId});return}
      if(route==='api/links'){json({version:pluginVersion,squad:'./',analysis:'./#analysis',intro:introduction.url,summary:'./summary/',review:scope.reviewDirectory?'./review/':null});return}
      if(route==='api/runtime-info'){
        if([...url.searchParams.keys()].length){res.statusCode=400;json({error:'无效的版本信息请求'});return}
        if(!runtimeInfo)throw httpError(503,'SQUAD_RUNTIME_INFO_UNAVAILABLE','版本与任务状态信息暂不可用。');
        json(await runtimeInfo());return;
      }
      if(route==='api/board'){if(!board)throw new Error('BOARD_UNAVAILABLE');json(await board(binding));return}
      if(route==='api/task'){if(!task)throw new Error('TASK_UNAVAILABLE');json(await task(binding,url.searchParams));return}
      if(route==='api/snapshot'){
        const data=await snapshot(binding);if(data.binding?.threadId!==binding.threadId)throw new Error('SQUAD_BINDING_MISMATCH');json(data);return;
      }
      if(route==='api/analytics'){
        const scope=url.searchParams.get('scope')||'global',range=url.searchParams.get('days')||'all';
        if([...url.searchParams.keys()].some(key=>!['scope','days'].includes(key))||!['session','global'].includes(scope)||!['all','7','30'].includes(range)){
          res.statusCode=400;json({connected:false,error:'分析范围无效'});return;
        }
        if(!analytics)throw new Error('分析记录不可用');
        json(await analytics(binding,{scope,days:range==='all'?null:Number(range)},{origin}));return;
      }
      if(route==='api/analysis/runs'){
        if(req.method==='POST'){
          const input=await readAnalysisBody(req);
          const result=await analysisRuns.start(binding,input,{origin});
          const running=!result.skipped&&result.run?.status==='running';
          res.statusCode=running?202:200;
          json({
            schemaVersion:1,skipped:Boolean(result.skipped),reason:result.reason||null,
            reused:Boolean(result.reused),run:result.run||null,
          });
          return;
        }
        if([...url.searchParams.keys()].length){res.statusCode=400;json({connected:false,error:'分析运行查询无效'});return}
        if(!analysisRuns?.list)throw httpError(503,'SQUAD_ANALYSIS_UNAVAILABLE','分析运行记录不可用。');
        json(await analysisRuns.list(binding,{origin}));return;
      }
      if(route.startsWith('api/analysis/runs/')){
        const runId=route.slice('api/analysis/runs/'.length);
        if(!idPattern.test(runId)){res.writeHead(404);res.end();return}
        if(!analysisRuns?.detail)throw httpError(503,'SQUAD_ANALYSIS_UNAVAILABLE','分析运行记录不可用。');
        const detail=await analysisRuns.detail(binding,runId,{origin});
        if(!detail){res.writeHead(404);res.end();return}
        json(detail);return;
      }
      if(route==='summary/api'){json(await readSummary(binding));return}
      let file=files.has(route)?join(assets,files.get(route)):null;
      if(route.startsWith('review/')&&scope.reviewDirectory){
        const directory=await reviewWithin(binding,scope.reviewDirectory);
        try{file=await realpath(join(directory,route.slice(7)||'index.html'))}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR'){res.writeHead(404);res.end();return}throw error}
        if(!contained(directory,file)){res.writeHead(404);res.end();return}
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      }
      if(!file){res.writeHead(404);res.end();return}
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp'};
      if(/^design\/.*[a-f0-9]{12,}\.(?:woff2|css|png|jpg|svg|webp)$/.test(route))res.setHeader('Cache-Control','private, max-age=31536000, immutable');
      res.setHeader('Content-Type',types[extname(file)]||'application/octet-stream');let bytes=await readFile(file);
      // Existing exported reviews use an origin-wide key. Scope that known script without changing the adopted UI.
      if(route==='review/app.js'&&createHash('sha256').update(bytes).digest('hex')==='a07954ac9d8805ba6d7b4c0b075374248c7d4b148d1e698ec8e5b64c89906e3c')bytes=Buffer.from(bytes.toString('utf8').replace('stitch-review:${D.id}:',"stitch-review:${new URL('.',location.href).pathname}:${D.id}:"));
      res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){
      if(error.code==='ENOENT'||error.code==='EISDIR'||error instanceof URIError){res.writeHead(404);res.end();return}
      const code=error.code||'SQUAD_UNAVAILABLE';
      const status=error.status||(code==='SQUAD_ANALYSIS_BUSY'?409:code==='SQUAD_ANALYSIS_SCOPE_UNSUPPORTED'?400:503);
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      const body=writePost
        ?{ok:false,error:{code,message:String(error.message||'请求未完成。').slice(0,400)}}
        :{connected:false,errorCode:code,error:'未收到可确认的当前会话数据，请在原会话检查本机服务。'};
      res.end(req.method==='HEAD'?undefined:JSON.stringify(body));
    }
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok)});
  origin=`http://127.0.0.1:${server.address().port}`;
  return {origin,server,close:()=>new Promise((ok,fail)=>{server.closeAllConnections();server.close(error=>error?fail(error):ok())})};
}

async function serve(){
  const {readBinding,viewerClient}=await import('./runtime.mjs'),{readSummary}=await import('./summary.mjs');
  const {
    savedAnalytics,analysisRunsView,analysisRunDetail,startAnalysis,
    snapshotInWorker,stopActiveAnalysis,startAnalysisScheduler,stopAnalysisScheduler,closeAnalysis,
  }=await import('./analysis-service.mjs');
  const {recoverInterruptedAnalysisRuns}=await import('./analysis-runs.mjs');
  const {createViewerData}=await import('./viewer-data.mjs');
  const {createRuntimeInfo}=await import('./runtime-info.mjs');
  const runtimeInfo=createRuntimeInfo({home:dataRoot()});
  const data=createViewerData({loadClient:viewerClient});
  const {createLocalStore}=await import('./local-store.mjs');
  const store=createLocalStore({home:dataRoot()});store.ready();store.close();
  const old=await jsonFile(receiptPath());
  const analysisRuns={
    start:(binding,input)=>startAnalysis({home:dataRoot(),trigger:'manual',requestId:input.requestId,days:input.days,requestedByThreadId:binding.threadId}),
    list:()=>analysisRunsView({home:dataRoot()}),
    detail:(binding,runId,context)=>analysisRunDetail({home:dataRoot(),runId,origin:context?.origin||null}),
  };
  const view=await createViewer({snapshot:snapshotInWorker,board:data.board,task:data.task,analytics:savedAnalytics,analysisRuns,runtimeInfo:()=>runtimeInfo.read(),readSummary,port:old?.port||defaultPort,loadScope:async token=>{
    const scope=await jsonFile(join(serviceDir(),'scopes',`${token}.json`));if(!scope||scope.token!==token||!idPattern.test(scope.threadId))return null;
    const binding=await readBinding(scope.threadId);if(!binding||binding.workspace!==scope.workspace)return null;
    const page=await jsonFile(join(serviceDir(),`${scope.threadId}.json`));if(page?.token!==token)return null;
    return {binding,reviewDirectory:page.reviewDirectory};
  }});
  const receipt={pid:process.pid,port:Number(new URL(view.origin).port),origin:view.origin,fingerprint:await fingerprint()};await writeJson(receiptPath(),receipt);
  await recoverInterruptedAnalysisRuns({home:dataRoot()}).catch(error=>console.error(`分析运行恢复失败：${error.message}`));
  // Service startup and a low-frequency timer reclaim only registrations whose worker identity is gone.
  const {sweepOrphanedAcp}=await import('./orphan-recovery.mjs');
  const orphanTimer=setInterval(()=>{void sweepOrphanedAcp({home:dataRoot()}).catch(error=>console.error(`遗留执行进程回收失败：${error.message}`))},5*60*1000);
  orphanTimer.unref();
  await sweepOrphanedAcp({home:dataRoot(),force:true}).catch(error=>console.error(`遗留执行进程回收失败：${error.message}`));
  startAnalysisScheduler({home:dataRoot(),onError:error=>console.error(`周期分析失败：${error.message}`)});
  let closing=false;const stop=async()=>{if(closing)return;closing=true;clearInterval(orphanTimer);runtimeInfo.close();await stopAnalysisScheduler();await view.close();await stopActiveAnalysis();await closeAnalysis();if((await jsonFile(receiptPath()))?.pid===process.pid)await writeJson(receiptPath(),{...receipt,pid:null});process.exitCode=0};
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
}
if(process.argv[2]==='--serve'&&resolve(process.argv[1]||'')===ownPath)serve().catch(error=>{console.error(error.message);process.exitCode=1});
