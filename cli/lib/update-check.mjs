import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// The public local build has no release channel of its own: it reports the
// version it was installed with and points at the GitHub Releases page.
export const UPDATE_PACKAGE='codex-squad';
export const UPDATE_ENTRY_URL='https://github.com/chenchen428/codex-squad/releases';
export const UPDATE_ENTRY_MODE='manual';

const SCHEMA_VERSION=1;
const SEMVER=/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const pluginRoot=fileURLToPath(new URL('../../',import.meta.url));

function normalizeError(value){
  return value&&typeof value==='object'&&typeof value.code==='string'
    ?{code:value.code,message:String(value.message||'').slice(0,300)}
    :null;
}

async function readLocalVersion(options={}){
  const root=options.pluginRoot||pluginRoot;
  try{
    const manifest=JSON.parse(await readFile(join(root,'.codex-plugin/plugin.json'),'utf8'));
    const version=typeof manifest?.version==='string'?manifest.version.trim():'';
    if(!SEMVER.test(version))return {version:null,error:{code:'SQUAD_UPDATE_LOCAL_VERSION_INVALID',message:'本机插件版本无法识别。'}};
    return {version,error:null};
  }catch(error){
    return {
      version:null,
      error:{
        code:error?.code==='ENOENT'?'SQUAD_UPDATE_LOCAL_VERSION_MISSING':'SQUAD_UPDATE_LOCAL_VERSION_INVALID',
        message:'无法读取本机插件版本。',
      },
    };
  }
}

export async function updateCheckView(options={}){
  const local=await readLocalVersion(options);
  return {
    schemaVersion:SCHEMA_VERSION,
    package:UPDATE_PACKAGE,
    entry:{url:UPDATE_ENTRY_URL,mode:UPDATE_ENTRY_MODE},
    autoUpdate:false,
    localVersion:local.version,
    localVersionError:normalizeError(local.error),
  };
}
