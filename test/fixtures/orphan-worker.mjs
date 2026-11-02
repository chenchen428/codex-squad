// Uses product registration, signal handling and ACP close; never launches Qoder.
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {QoderAcpClient} from '../../cli/lib/qoder/qoder-acp-client.mjs';
import {createWorkerSignalHandler} from '../../cli/lib/worker.mjs';
import {markAcpExited,recordAcpProcess,watchWorker} from '../../cli/lib/worker-control.mjs';
const arg=name=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:''};
const home=arg('--home'),nonce=arg('--nonce'),acp=arg('--acp');
if(!home||!nonce||!acp)throw Error('Missing fixture arguments');
const controller=new AbortController();
let lastSignal=null;
const client=new QoderAcpClient({command:acp,cwd:process.cwd(),env:{...process.env},onSpawn:details=>recordAcpProcess(nonce,details,{home})});
const closeControl=await watchWorker(nonce,controller,{home,taskId:'fixture-task',attemptId:nonce});
const handler=createWorkerSignalHandler({controller,onSignal:signal=>{lastSignal=signal},onForce:()=>client.close({force:true,forceMs:3000})});
process.on('SIGTERM',()=>handler('SIGTERM'));
process.on('SIGINT',()=>handler('SIGINT'));
const aborted=new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));
const timeout=setTimeout(()=>handler('SIGTERM'),60_000);
try{
  await client.ensureStarted();
  if(!controller.signal.aborted){
    await mkdir(join(home,'ready'),{recursive:true,mode:0o700});
    await writeFile(join(home,'ready',nonce+'.json'),JSON.stringify({workerPid:process.pid,acpPid:client.child.pid})+'\n',{mode:0o600});
    await aborted;
  }
}finally{
  const result=await client.close({graceMs:300,forceMs:3000});
  if(result.exited)await markAcpExited(nonce,{by:'worker',result},{home});
  await closeControl({reason:'test_signal',signal:lastSignal,exitCode:0});
  clearTimeout(timeout);
}
