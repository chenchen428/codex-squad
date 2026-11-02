import {execFile} from 'node:child_process';
import {readFile,readlink} from 'node:fs/promises';

// libproc birth time is precise to a microsecond; ps lstart cannot safely identify PID reuse.
const DARWIN_IDENTITY="import ctypes, errno, json, sys\nclass BsdInfo(ctypes.Structure):\n    _fields_=[(n,ctypes.c_uint32) for n in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','rfu']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(n,ctypes.c_uint32) for n in ['nfiles','pgid','jobc','tdev','tpgid']]+[('nice',ctypes.c_int32),('sec',ctypes.c_uint64),('usec',ctypes.c_uint64)]\nlib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)\npid=int(sys.argv[1])\ndef info():\n    value=BsdInfo()\n    size=lib.proc_pidinfo(pid,3,0,ctypes.byref(value),ctypes.sizeof(value))\n    if size==0 and ctypes.get_errno()==errno.ESRCH: return None\n    if size!=ctypes.sizeof(value): raise RuntimeError('process_identity_unavailable')\n    return value\nfirst=info()\nif first is None:\n    print('null');sys.exit(0)\npath=ctypes.create_string_buffer(4096)\nif lib.proc_pidpath(pid,path,len(path))<=0: raise RuntimeError('process_executable_unavailable')\nboot=ctypes.create_string_buffer(128);length=ctypes.c_size_t(len(boot))\nsystem=ctypes.CDLL(None,use_errno=True)\nif system.sysctlbyname(b'kern.bootsessionuuid',boot,ctypes.byref(length),None,0)!=0: raise RuntimeError('boot_identity_unavailable')\nlast=info()\nif last is None:\n    print('null');sys.exit(0)\nif (first.pid,first.sec,first.usec)!=(last.pid,last.sec,last.usec): raise RuntimeError('process_identity_changed_during_read')\nprint(json.dumps(dict(pid=last.pid,ppid=last.ppid,pgid=last.pgid,command=path.value.decode(),startToken='darwin:'+boot.value.decode()+':'+str(last.sec)+':'+str(last.usec),supported=True)))";
async function darwinIdentity(pid){
  return new Promise((resolve,reject)=>{
    execFile('/usr/bin/python3',['-c',DARWIN_IDENTITY,String(pid)],{timeout:3000,maxBuffer:16*1024},(error,stdout)=>{
      if(error)return reject(error);
      try{resolve(JSON.parse(stdout))}catch(error){reject(error)}
    });
  });
}
async function linuxIdentity(pid){
  const path='/proc/'+pid;
  const stat=await readFile(path+'/stat','utf8');
  const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
  const [command,boot,after]=await Promise.all([readlink(path+'/exe'),readFile('/proc/sys/kernel/random/boot_id','utf8'),readFile(path+'/stat','utf8')]);
  const next=after.slice(after.lastIndexOf(')')+2).trim().split(/\s+/);
  if(fields[19]!==next[19])throw new Error('process_identity_changed_during_read');
  return {pid,ppid:Number(next[1]),pgid:Number(next[2]),command,startToken:'linux:'+boot.trim()+':'+next[19],supported:true};
}
export function verifiableIdentity(value){
  return Boolean(value&&value.supported===true&&Number.isSafeInteger(value.pid)&&value.pid>0
    &&Number.isSafeInteger(value.pgid)&&value.pgid>0&&typeof value.command==='string'&&value.command.startsWith('/')
    &&typeof value.startToken==='string'&&/^(?:darwin:[^:]+:\d+:\d+|linux:[^:]+:\d+)$/.test(value.startToken));
}
/** null means confirmed absence; unreadable and unsupported are separate states. */
export async function readProcessIdentity(pid,{run}={}){
  const target=Number(pid);
  if(!Number.isSafeInteger(target)||target<1)return {pid:target,supported:false,reason:'invalid_pid'};
  try{
    const value=run?await run(target):process.platform==='darwin'?await darwinIdentity(target)
      :process.platform==='linux'?await linuxIdentity(target):{pid:target,supported:false,reason:'process_identity_unsupported_platform'};
    if(value===null)return null;
    if(!verifiableIdentity(value)||value.pid!==target)return {pid:target,supported:false,reason:value?.reason||'process_identity_incomplete'};
    return value;
  }catch(error){
    if(error.code==='ENOENT'&&process.platform==='linux'){
      try{await readFile('/proc/'+target+'/stat')}catch(absence){if(absence.code==='ENOENT')return null}
    }
    return {pid:target,supported:false,reason:'process_identity_unavailable:'+(error.code||error.name)};
  }
}
export function sameProcessIdentity(recorded,current){
  // exec and process-group changes do not create a new process. ACP group
  // ownership is checked separately before signalling; a live owner stays live.
  return verifiableIdentity(recorded)&&verifiableIdentity(current)
    &&recorded.pid===current.pid&&recorded.startToken===current.startToken;
}
export function processExists(pid){
  if(!Number.isSafeInteger(Number(pid))||Number(pid)<1)return false;
  try{process.kill(Number(pid),0);return true}catch(error){return error.code==='EPERM'}
}
