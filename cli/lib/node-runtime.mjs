import {spawnSync} from 'node:child_process';

export function nodeFlags(version=process.versions.node){
  const [major,minor]=version.split('.').map(Number);
  if(major<22||major===22&&minor<5)throw new Error('Codex 小队需要 Node.js 22.5 或更高版本。');
  return major===22&&minor<13||major===23&&minor<4?['--experimental-sqlite']:[];
}
export function ensureNodeRuntime(){
  const flags=nodeFlags().filter(flag=>!process.execArgv.includes(flag));
  if(flags.length){const child=spawnSync(process.execPath,[...flags,...process.argv.slice(1)],{stdio:'inherit',env:process.env});if(child.error)throw child.error;process.exit(child.status??1)}
}
