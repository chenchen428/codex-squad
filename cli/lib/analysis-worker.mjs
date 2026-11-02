import {parentPort,workerData} from 'node:worker_threads';
import {snapshot,readBinding} from './runtime.mjs';
if(workerData?.kind==='collect'){
  try{const {collectFrozen}=await import('./analysis-service.mjs');parentPort.postMessage({result:await collectFrozen({...workerData,now:new Date(workerData.now)})})}
  catch(error){parentPort.postMessage({error:{message:error.message,code:error.code}})}
}else parentPort.on('message',async({id,binding})=>{
  try{parentPort.postMessage({id,result:await snapshot(await readBinding(binding.threadId))})}
  catch(error){parentPort.postMessage({id,error:{message:error.message,code:error.code}})}
});
