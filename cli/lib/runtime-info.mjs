import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {dataRoot} from './storage-paths.mjs';
import {isWorkerAlive} from './worker-control.mjs';
import {updateCheckView} from './update-check.mjs';

const WORKER_TTL_MS=10000;

export async function activeWorkerCount({home}={}){
  const directory=join(dataRoot({home}),'workers');
  let entries;try{entries=await readdir(directory)}catch(error){if(error.code==='ENOENT')return 0;throw error}
  const receipts=entries.filter(file=>/^[a-f0-9-]{36}\.json$/i.test(file));
  const results=await Promise.all(receipts.map(async file=>{
    let record;try{record=JSON.parse(await readFile(join(directory,file),'utf8'))}catch{return null}
    if(record.exited||Date.now()-record.updatedAt>30000)return false;
    return isWorkerAlive(record.pid,record.nonce,{home}).catch(()=>null);
  }));
  return results.includes(null)?null:results.filter(Boolean).length;
}

// Only local reads sit on the report path: the installed plugin version and a
// cached worker count. No release feed, install action or account quota is queried.
export function createRuntimeInfo({home,updates=updateCheckView,countWorkers=activeWorkerCount}={}){
  let workersAt=-Infinity,workersRunning=false,activeTasks=null,closed=false;
  function refreshWorkers(){
    if(closed||workersRunning||Date.now()-workersAt<WORKER_TTL_MS)return;
    workersRunning=true;workersAt=Date.now();
    Promise.resolve(countWorkers({home})).then(value=>{activeTasks=value},()=>{activeTasks=null}).finally(()=>{workersRunning=false});
  }
  return {
    async read(){
      const release=await updates({});
      refreshWorkers();
      return {schemaVersion:1,updates:release,activeTasks};
    },
    close(){closed=true},
  };
}
