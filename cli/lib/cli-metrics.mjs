const COMMAND_TOOLS=new Set([
  'bash','shell','terminal','sh','zsh','fish','dash','ksh','powershell','pwsh','cmd',
  'command','commandexecution','command_execution','exec','execute','exec_command',
  'run','run_command','run_terminal_cmd','local_shell','shell_command',
]);
const SHELLS=new Set(['bash','sh','zsh','fish','dash','ksh','pwsh','powershell','cmd']);
const CONTROL=new Set(['cd','pushd','popd','export','unset','set','source','.',':','alias','unalias','umask','command']);
// Bash keywords are never CLIs. A loop/conditional body is multi-statement, so it stays
// unresolved and its exit code is never grafted onto every command inside.
const SHELL_RESERVED=new Set([
  'for','do','done','while','until','if','then','elif','else','fi','case','esac','select',
  'function','in','!','{','}','[[',']]','coproc',
  'break','continue','return','exit','shift','setopt',
  'def','from','import','except','assert','with','const','let','var','null','EOF','PY',
]);
// Shell plumbing stays out of the business CLI ranking; its segments still count when
// deciding whether an exit code can be attributed to a single command.
const PLUMBING=new Set([
  'echo','printf','cat','head','tail','less','more','ls','pwd','find','grep','rg','sed','awk',
  'cut','sort','uniq','wc','tr','tee','xargs','jq','chmod','chown','mkdir','rm','cp','mv',
  'touch','ln','sleep','true','false','test','[','which','date','kill','ps','tar','unzip','gzip',
]);
// Both subcommand words are checked against this action/resource vocabulary. A lowercase
// positional value is never safe on its own, so unknown words fall back to the CLI root.
const ACTION_WORDS=new Set([
  'add','analyze','analyse','apply','approve','ask','auth','branch','build','call','capability','capabilities','cancel','cat','chat',
  'checkout','clean','clone','close','code','commit','config','create','delete','deploy','describe','diff',
  'disable','doctor','download','enable','env','exec','explain','export','fetch','format','get',
  'group','help','import','info','init','inspect','install','invoke','issue','job','lint','list',
  'log','login','logout','ls','manage','merge','metrics','mr','open','org','package','pipeline',
  'plan','preview','project','publish','pull','push','query','release','remove','report','repo',
  'repository','rerun','restart','retry','run','search','set','show','skill','start','stats','stat',
  'status','stop','submit','sync','tail','task','test','trace','unset','update','upgrade','upload',
  'usage','user','validate','verify','version','view','wait','watch','whoami','work','workflow',
]);
const SAFE_NAME=/^[A-Za-z][A-Za-z0-9._-]*$/;
const SAFE_WORD=/^[a-z][a-z-]*$/;
const SCRIPT_EXTENSION=/\.(?:sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|ts|tsx|ps1|bat|cmd)$/i;
const DATA_EXTENSION=/\.(?:json|jsonl|yaml|yml|md|html?|css|sql|log|txt|csv|tsv|java|class|jar|xml|png|jpe?g|svg|pdf|git)$/i;
// An interpreter root (`python3`, `node`) says nothing about the work. Resolve the
// module or script the same way a person reads the command, using safe names only.
const PYTHON_BIN=/^python(?:\d+(?:\.\d+)*)?$/;
const NODE_BIN=/^node(?:\.exe)?$/;
const PY_SCRIPT=/\.py$/i;
const NODE_SCRIPT=/\.(?:js|mjs|cjs|ts|tsx)$/i;
const MODULE_NAME=/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,4}$/;
// Options that change how the interpreter starts but not what it runs.
const PY_NO_VALUE=new Set(['-u','-B','-E','-s','-S','-I','-O','-OO','-b','-d','-q','-v']);
const PY_VALUE=new Set(['-W','-X']);
const NODE_VALUE_FLAGS=new Set([
  '-r','--require','--loader','--experimental-loader','--import','--env-file','--conditions',
  '--max-old-space-size','--inspect-port','--test-reporter','--test-reporter-destination',
  '--test-name-pattern','--test-skip-pattern','--test-concurrency','--test-timeout','--test-shard',
]);
const NODE_INLINE=new Set(['-e','--eval','-p','--print','-i','--interactive']);
// Leading flags before the subcommand (`lgb --env prod auth status`) hide the real verb.
const GLOBAL_VALUE_FLAGS=new Set([
  '--env','--auth-provider','--profile','--project','--format','--output','-o','--cwd','-C',
  '--log-level','--config','--context','--namespace','--region','--repo','--org','--timeout',
]);
const GLOBAL_BOOLEAN_FLAGS=new Set(['--json','--quiet','-q','--verbose','--debug','--no-color','--color','--yes','-y','--help','-h','--version']);
const RUNNERS=new Set(['npm','pnpm','yarn','bun']);
const RUNNER_SCRIPT=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,47}$/;
// lgb documents `capability invoke|describe <能力名>`; only that positional can name a capability.
const LGB_BIN=/^lgb(?:-darwin-arm64)?$/;
const CAPABILITY_NAME=/^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z]{3,32})$/;
// Without an execution receipt, an arbitrary bare word may be copied output or
// a script variable. Keep recognized CLI identities; custom executables need a
// real receipt before they enter the ranking.
const KNOWN_CLI=/^(?:a1|lgb(?:-darwin-arm64)?|sf|compass|lgr1|lg-decision|maxc(?:-cli)?|data-agent|dws|aone|codex|qodercli|node|npm|npx|pnpm|yarn|bun|deno|python(?:\d+(?:\.\d+)*)?|pip\d*|uv|git|gh|go|gofmt|java|javac|javap|jar|jshell|mvn|gradle|docker|colima|kubectl|curl|wget|shasum|sha256sum|openssl|sqlite3|make|tsc|esbuild|playwright|ffmpeg|ffprobe|magick|identify|sips|pdfinfo|pdfimages|pdftotext|pdftoppm|pdftocairo|rsvg-convert|hyperframes|at-cli|afinfo|bsdtar|cmp|comm|df|diff|diffstat|du|egrep|fc-list|fc-scan|file|fold|id|java_home|lsof|md5|mdfind|mdls|mktemp|montage|nl|od|paste|patch|perl|pg_isready|pgrep|pkill|readlink|rmdir|rsync|ruby|stat|strings|sysctl|textutil|tidy|uptime|whoami|xcrun|xmllint|xxd)$/;
const SUCCESS_STATUSES=new Set(['succeeded','success','ok','completed','done']);
const FAILED_STATUSES=new Set(['failed','failure','error','errored','timeout','timed_out','cancelled','canceled','interrupted','denied']);
const SUCCESS_BUSINESS=new Set(['ok','success','succeeded','completed','done']);
const FAILED_BUSINESS=new Set(['failed','failure','error','errored']);
const FAILURE_RULES=[
  ['timeout',/\b(?:timed?\s*out|timeout|etimedout|deadline exceeded)\b/i],
  ['permission',/\b(?:permission denied|access denied|not authorized|unauthorized|forbidden|eacces|eperm|authentication (?:failed|required)|login required)\b/i],
  ['argument',/\b(?:invalid (?:argument|option|value|parameter)|unknown (?:option|flag)|unrecognized (?:option|flag)|missing (?:required )?(?:argument|parameter|value)|usage:)\b/i],
  ['service',/\b(?:econnrefused|econnreset|enotfound|eai_again|connection (?:refused|reset)|service unavailable|bad gateway|gateway timeout|network error|http (?:502|503|504))\b/i],
  ['execution',/\b(?:command not found|enoent|no such file or directory|exec format error)\b/i],
];
const MAX_RESULT_CHARS=4000;
// Bump when attribution or outcome rules change so frozen snapshots are not reused.
export const CLI_STATS_VERSION='cli-stats-v7';
const NOTE='按可识别的命令与子命令统计；无法确认归属的调用只计数，不参与成功率。'
  +'执行成功仅依据执行器退出码或明确失败，业务成功仅依据顶层结构化回执，未确认的调用不进入成功率分母。'
  +'复合命令不把整体退出码分摊给每条命令。解释器调用按明确的模块或脚本名区分，无法确认用途的内联脚本不进入排行。'
  +'Qoder 执行部分来自本机原生执行回执；主 Codex 会话未采集，不代表全部工具调用。';

function lower(value){return typeof value==='string'?value.trim().toLowerCase():''}
function basename(value){
  const parts=String(value||'').split(/[\\/]+/).filter(Boolean);
  return parts.length?parts[parts.length-1]:'';
}
function isCommandTool(name){return COMMAND_TOOLS.has(lower(name))}
function isSpecificMcpTool(name){
  const value=String(name||'').trim();
  return /^mcp(?:__|[._:-])[\w.:-]{1,80}$/i.test(value);
}
export function isSpecificMcpToolName(name){return isSpecificMcpTool(name)}
function statusSignal(value){
  const status=lower(value);
  if(SUCCESS_STATUSES.has(status))return 'succeeded';
  if(FAILED_STATUSES.has(status))return 'failed';
  return 'unknown';
}
function isAssignment(token){return Boolean(token)&&!token.quoted&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)}

/** Single pass shell tokenizer: quotes/escapes only, no expansion and no execution. */
function scanSegments(text){
  const segments=[];
  let tokens=[];
  let value='';
  let quoted=false;
  let started=false;
  let quote='';
  const flushToken=()=>{
    if(!started)return;
    tokens.push({value,quoted});
    value='';quoted=false;started=false;
  };
  const flushSegment=background=>{
    flushToken();
    if(tokens.length)segments.push({tokens,background});
    tokens=[];
  };
  for(let index=0;index<text.length;index+=1){
    const ch=text[index];
    if(quote==="'"){
      if(ch==="'")quote='';
      else value+=ch;
      started=true;
      continue;
    }
    if(quote==='"'){
      if(ch==='\\'&&index+1<text.length){value+=text[index+=1];started=true;continue}
      if(ch==='"'){quote='';continue}
      value+=ch;started=true;continue;
    }
    if(ch==='\\'&&index+1<text.length){value+=text[index+=1];started=true;continue}
    if(ch==="'"||ch==='"'){quote=ch;quoted=true;started=true;continue}
    if(ch==='#'&&!started){while(index+1<text.length&&text[index+1]!=='\n')index+=1;continue}
    if(ch===' '||ch==='\t'||ch==='\r'){flushToken();continue}
    if(ch==='\n'){flushSegment(false);continue}
    if(ch==='&'&&text[index+1]==='&'){flushSegment(false);index+=1;continue}
    if(ch==='|'&&text[index+1]==='|'){flushSegment(false);index+=1;continue}
    if(ch==='|'){flushSegment(false);continue}
    if(ch==='&'){flushSegment(true);continue}
    if(ch===';'){flushSegment(false);continue}
    value+=ch;started=true;
  }
  if(quote)return null;
  flushSegment(false);
  return segments;
}

function structuredJson(text){
  const trimmed=String(text||'').trim();
  if(!trimmed.startsWith('{')||!trimmed.endsWith('}'))return null;
  try{
    const value=JSON.parse(trimmed);
    return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
  }catch{return null}
}

function commandSource(callText){
  const text=String(callText||'').replace(/\0/g,'').trim();
  if(!text)return '';
  const json=structuredJson(text);
  if(!json)return text;
  for(const key of ['cmd','command','script']){
    const value=json[key];
    if(typeof value==='string'&&value.trim())return value.trim();
    if(Array.isArray(value)&&value.length&&value.every(item=>typeof item==='string')){
      if(SHELLS.has(lower(basename(value[0])))){
        const flag=value.findIndex((item,index)=>index>0&&/^-[A-Za-z]*c[A-Za-z]*$/.test(item));
        if(flag>=0&&typeof value[flag+1]==='string')return value[flag+1];
      }
      return value.join(' ');
    }
  }
  return '';
}

function resolvedIdentity(name,command){
  return {commands:[{name,command,plumbing:false}],executions:1,unresolved:false};
}
function unresolvedIdentity(){return {commands:[],executions:1,unresolved:true}}

/** `python3 -m module action`, `python3 script.py`; inline code and bare stdin stay unknown. */
function pythonIdentity(name,tokens){
  let index=1;
  while(index<tokens.length){
    const token=tokens[index];
    if(!token.quoted&&(token.value==='--version'||token.value==='-V'))return resolvedIdentity(name,`${name} --version`);
    if(!token.quoted&&PY_NO_VALUE.has(token.value)){index+=1;continue}
    if(!token.quoted&&PY_VALUE.has(token.value)){index+=2;continue}
    if(!token.quoted&&token.value==='-m'){
      const module=tokens[index+1];
      if(!module||module.quoted||module.value.length>64||!MODULE_NAME.test(module.value))return unresolvedIdentity();
      const action=tokens[index+2];
      const word=action&&!action.quoted&&ACTION_WORDS.has(action.value)?` ${action.value}`:'';
      return resolvedIdentity(name,`${name} -m ${module.value}${word}`);
    }
    if(!token.quoted&&token.value.startsWith('-'))return unresolvedIdentity();
    const script=basename(token.value);
    if(!script||script.length>64||!SAFE_NAME.test(script)||!PY_SCRIPT.test(script))return unresolvedIdentity();
    return resolvedIdentity(name,`${name} ${script}`);
  }
  return unresolvedIdentity();
}

/** `node --test [file]`, `node script.mjs`; `-e/--eval` code is never a CLI identity. */
function nodeIdentity(name,tokens){
  let test=false;
  let script=null;
  let extra=false;
  for(let index=1;index<tokens.length;index+=1){
    const token=tokens[index];
    if(token.quoted){
      if(script===null)script=token.value;
      else extra=true;
      continue;
    }
    const value=token.value;
    if(value==='--version'||value==='-v')return resolvedIdentity(name,`${name} --version`);
    if(value==='--test'){test=true;continue}
    if(NODE_INLINE.has(value))return unresolvedIdentity();
    if(value.startsWith('-')&&value!=='-'){
      const flag=value.split('=')[0];
      if(NODE_VALUE_FLAGS.has(flag)&&!value.includes('='))index+=1;
      continue;
    }
    if(script!==null){extra=true;continue}
    script=value;
  }
  if(test)return testIdentity(name,script,extra);
  if(script===null)return unresolvedIdentity();
  const file=basename(script);
  if(!file||file.length>64||!SAFE_NAME.test(file))return unresolvedIdentity();
  if(DATA_EXTENSION.test(file)&&!NODE_SCRIPT.test(file))return unresolvedIdentity();
  return resolvedIdentity(name,`${name} ${file}`);
}

function testIdentity(name,script,extra){
  // The test flag itself is a stable identity (like `python3 -m pytest`); only a single
  // safe JavaScript target narrows it to one file. Several, glob or non-script targets
  // name no single file, so the runner stays the identity instead of guessing one.
  if(script===null||extra)return resolvedIdentity(name,`${name} --test`);
  const target=basename(script);
  if(!target||target.length>64||!SAFE_NAME.test(target))return resolvedIdentity(name,`${name} --test`);
  if(NODE_SCRIPT.test(target))return resolvedIdentity(name,`${name} --test ${target}`);
  if(SCRIPT_EXTENSION.test(target)||DATA_EXTENSION.test(target))return resolvedIdentity(name,`${name} --test`);
  return resolvedIdentity(name,`${name} --test ${target}`);
}

/** Skip leading global flags so the documented subcommand is not hidden behind them. */
function subcommandWords(name,tokens){
  const words=[];
  let index=1;
  while(index<tokens.length&&words.length<2){
    const token=tokens[index];
    if(!token.quoted&&token.value.startsWith('-')){
      const inline=token.value.includes('=');
      const flag=token.value.split('=')[0];
      if(!inline&&GLOBAL_VALUE_FLAGS.has(flag)){index+=2;continue}
      if(inline||GLOBAL_BOOLEAN_FLAGS.has(flag)||GLOBAL_VALUE_FLAGS.has(flag)){index+=1;continue}
      break;
    }
    if(token.quoted||!SAFE_WORD.test(token.value)||token.value.length>32)break;
    if(!ACTION_WORDS.has(token.value))break;
    words.push(token.value);
    index+=1;
    if(RUNNERS.has(lower(name))&&words.length===1&&words[0]==='run'){
      const script=tokens[index];
      if(script&&!script.quoted&&RUNNER_SCRIPT.test(script.value)){words.push(script.value);index+=1;}
    }
  }
  return {words,next:index};
}

function commandIdentity(name,tokens){
  const {words,next}=subcommandWords(name,tokens);
  let identity=[name,...words].join(' ');
  if(!LGB_BIN.test(lower(name)))return identity;
  const documented=words.length===2&&words[0]==='capability'&&(words[1]==='invoke'||words[1]==='describe')
    ||words.length===1&&words[0]==='invoke';
  const capability=tokens[next];
  if(!documented||!capability||capability.quoted||!CAPABILITY_NAME.test(capability.value))return identity;
  return `${identity} ${capability.value}`;
}

function parseTokens(input,depth){
  let tokens=input.slice();
  while(tokens.length&&isAssignment(tokens[0]))tokens=tokens.slice(1);
  if(!tokens.length)return {commands:[],executions:0,unresolved:false};
  const base=basename(tokens[0].value);
  if(base==='env'){
    tokens=tokens.slice(1);
    while(tokens.length){
      const token=tokens[0];
      if(isAssignment(token)){tokens=tokens.slice(1);continue}
      if(!token.quoted&&/^-[i0v]+$/.test(token.value)){tokens=tokens.slice(1);continue}
      if(!token.quoted&&/^--(?:ignore-environment|null|debug|verbose)$/.test(token.value)){tokens=tokens.slice(1);continue}
      if(!token.quoted&&/^-(?:u|C)$/.test(token.value)){tokens=tokens.slice(2);continue}
      if(!token.quoted&&/^--unset=/.test(token.value)){tokens=tokens.slice(1);continue}
      if(!token.quoted&&token.value==='--unset'){tokens=tokens.slice(2);continue}
      break;
    }
    if(!tokens.length)return {commands:[],executions:1,unresolved:true};
    return parseTokens(tokens,depth);
  }
  if(base==='timeout'){
    tokens=tokens.slice(1);
    while(tokens.length){
      const token=tokens[0];
      if(!token.quoted&&/^-(?:s|k|-signal|-kill-after)$/.test(token.value)){tokens=tokens.slice(2);continue}
      if(!token.quoted&&token.value.startsWith('-')){tokens=tokens.slice(1);continue}
      break;
    }
    if(tokens.length&&/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[0].value))tokens=tokens.slice(1);
    if(!tokens.length)return {commands:[],executions:1,unresolved:true};
    return parseTokens(tokens,depth);
  }
  if(base==='nohup'){
    tokens=tokens.slice(1);
    if(!tokens.length)return {commands:[],executions:1,unresolved:true};
    return parseTokens(tokens,depth);
  }
  if(base==='time'){
    tokens=tokens.slice(1);
    if(tokens.length&&!tokens[0].quoted&&tokens[0].value==='-p')tokens=tokens.slice(1);
    if(!tokens.length)return {commands:[],executions:1,unresolved:true};
    return parseTokens(tokens,depth);
  }
  if(base==='exec'){
    tokens=tokens.slice(1);
    while(tokens.length&&!tokens[0].quoted&&/^-[A-Za-z]+$/.test(tokens[0].value))tokens=tokens.slice(1);
    if(!tokens.length)return {commands:[],executions:1,unresolved:true};
    return parseTokens(tokens,depth);
  }
  if(SHELL_RESERVED.has(base))return {commands:[],executions:1,unresolved:true};
  if(CONTROL.has(base))return {commands:[],executions:0,unresolved:false};
  if(SHELLS.has(lower(base))){
    let scriptIndex=-1;
    for(let index=1;index<tokens.length;index+=1){
      if(tokens[index].quoted)continue;
      if(/^-[A-Za-z]*c[A-Za-z]*$/.test(tokens[index].value)||tokens[index].value==='--command'){
        scriptIndex=index+1;
        break;
      }
    }
    if(scriptIndex>0&&scriptIndex<tokens.length&&depth<2){
      const nested=parseText(tokens[scriptIndex].value,depth+1);
      return nested||{commands:[],executions:1,unresolved:true};
    }
    return {commands:[],executions:1,unresolved:true};
  }
  const name=base;
  if(!name||name.length>48||!SAFE_NAME.test(name)||SCRIPT_EXTENSION.test(name)||DATA_EXTENSION.test(name)||CONTROL.has(name)){
    return {commands:[],executions:1,unresolved:true};
  }
  if(PYTHON_BIN.test(lower(name)))return pythonIdentity(name,tokens);
  if(NODE_BIN.test(lower(name)))return nodeIdentity(name,tokens);
  return {
    commands:[{name,command:commandIdentity(name,tokens),plumbing:PLUMBING.has(lower(name))}],
    executions:1,
    unresolved:false,
  };
}

function parseText(text,depth=0){
  if(typeof text!=='string'||!text.trim())return null;
  const segments=scanSegments(text.replace(/\0/g,''));
  if(!segments)return null;
  const commands=[];
  let executions=0;
  let unresolved=false;
  let background=false;
  for(const segment of segments){
    // A heredoc body would otherwise look like a fresh command; refuse to guess.
    if(segment.tokens.some(token=>token.value.startsWith('<<')))return null;
    if(segment.background)background=true;
    const parsed=parseTokens(segment.tokens,depth);
    commands.push(...parsed.commands);
    executions+=parsed.executions;
    if(parsed.unresolved)unresolved=true;
  }
  return {commands,executions,unresolved,background};
}

function exitCodeOf(resultText){
  const text=String(resultText||'').slice(0,MAX_RESULT_CHARS);
  if(!text)return null;
  const json=structuredJson(text);
  if(json){
    for(const key of ['exitCode','exit_code','exitStatus','exit_status']){
      const value=json[key];
      if(typeof value==='number'&&Number.isInteger(value))return value;
    }
  }
  // Only the executor's fixed wrapper is trusted; prose that mentions an older exit code is not.
  const wrapper=/^Process exited with code (-?\d+)\b/i.exec(text.trimStart());
  return wrapper?Number(wrapper[1]):null;
}

export function failureCategory(resultText,fallback){
  const text=String(resultText||'').slice(0,MAX_RESULT_CHARS);
  for(const [category,pattern] of FAILURE_RULES){
    if(pattern.test(text))return category;
  }
  return fallback;
}

function hasFailureEvidence(resultText){
  const text=String(resultText||'').slice(0,MAX_RESULT_CHARS);
  return FAILURE_RULES.some(([,pattern])=>pattern.test(text));
}

/** Only a top-level envelope can carry a business verdict; nested success/code fields are never promoted. */
function businessSignal(resultText){
  const json=structuredJson(resultText);
  if(!json)return 'unknown';
  let success=0;
  let failed=0;
  for(const [key,value] of Object.entries(json)){
    if(key==='ok'||key==='success'){
      if(value===true)success+=1;
      else if(value===false)failed+=1;
      continue;
    }
    if(key==='status'||key==='state'){
      if(typeof value!=='string')continue;
      const status=lower(value);
      if(SUCCESS_BUSINESS.has(status))success+=1;
      else if(FAILED_BUSINESS.has(status))failed+=1;
      continue;
    }
    if(key==='code'&&typeof value==='number'&&Number.isInteger(value)){
      // Non-zero is not a portable failure signal: without a declared protocol it stays unknown.
      if(value===0)success+=1;
      continue;
    }
    if(key==='error'){
      const present=value===true||(typeof value==='string'&&value.trim())||(value!==null&&typeof value==='object'&&Object.keys(value).length>0);
      if(present)failed+=1;
    }
  }
  if(success&&failed)return 'unknown';
  if(failed)return 'failed';
  if(success)return 'succeeded';
  return 'unknown';
}

function outcomeFor(resultText,status,reliable){
  const signal=statusSignal(status);
  if(!reliable)return {execution:'unknown',failure:null};
  const exitCode=exitCodeOf(resultText);
  if(exitCode!==null){
    if(exitCode===0)return {execution:'succeeded',failure:null};
    return {execution:'failed',failure:failureCategory(resultText,'execution')};
  }
  if(signal==='failed')return {execution:'failed',failure:failureCategory(resultText,'unconfirmed')};
  if(signal==='unknown'&&hasFailureEvidence(resultText))return {execution:'failed',failure:failureCategory(resultText,'unconfirmed')};
  return {execution:'unknown',failure:null};
}

/**
 * Pure attribution for one tool record. Returns null when the tool is neither a command
 * execution tool nor a specific MCP tool. A command tool that cannot be attributed safely
 * returns commands=[] so callers can count it as unclassified instead of guessing.
 * `failure` is a bounded category for an execution failure, or for a business-only failure
 * (falling back to `business`), so each call contributes at most one failure category.
 *
 * @param {{toolName?:string,callText?:string,resultText?:string,status?:string}} input
 * @returns {null|{name:string|null,command:string|null,commands:{name:string,command:string}[],composite:boolean,execution:'succeeded'|'failed'|'unknown',business:'succeeded'|'failed'|'unknown',failure:string|null}}
 */
export function classifyCliCall({toolName,callText,resultText,status}={}){
  const tool=String(toolName||'').trim();
  if(isCommandTool(tool)){
    const parsed=parseText(commandSource(callText));
    const composite=parsed?Boolean(parsed.background||parsed.executions>1||parsed.unresolved):false;
    const reliable=Boolean(parsed)&&!composite;
    const {execution,failure}=outcomeFor(resultText,status,reliable);
    const commands=parsed&&!parsed.unresolved?parsed.commands
      .filter(command=>!command.plumbing&&(KNOWN_CLI.test(command.name)||execution!=='unknown'))
      .map(({name,command})=>({name,command})):[];
    const business=reliable?businessSignal(resultText):'unknown';
    const settledBusiness=execution==='failed'&&business==='succeeded'?'unknown':business;
    return {
      name:commands.length===1?commands[0].name:null,
      command:commands.length===1?commands[0].command:null,
      commands,
      composite,
      execution,
      business:settledBusiness,
      failure:failure||(settledBusiness==='failed'?failureCategory(resultText,'business'):null),
    };
  }
  if(isSpecificMcpTool(tool)){
    const name=tool.replace(/[^A-Za-z0-9._:-]/g,'').slice(0,80);
    if(!name)return null;
    const {execution,failure}=outcomeFor(resultText,status,true);
    const business=businessSignal(resultText);
    const settledBusiness=execution==='failed'&&business==='succeeded'?'unknown':business;
    return {
      name,
      command:name,
      commands:[{name,command:name}],
      composite:false,
      execution,
      business:settledBusiness,
      failure:failure||(settledBusiness==='failed'?failureCategory(resultText,'business'):null),
    };
  }
  return null;
}

/**
 * Aggregate classified tool records into the public cli contract.
 * Each record may carry threadId/threadTitle/taskId/taskTitle for session attribution.
 *
 * @param {Array<{toolName?:string,callText?:string,resultText?:string,status?:string,outcome?:string,threadId?:string,threadTitle?:string|null,taskId?:string,taskTitle?:string|null}>} records
 * @returns {{rows:Array<{name:string,command:string,calls:number,execution:{succeeded:number,failed:number,unknown:number},business:{succeeded:number,failed:number,unknown:number},failures:{category:string,count:number}[],sessions:{threadId:string,title:string|null,taskId:string,taskTitle:string|null}[]}>,unclassifiedCalls:number,note:string}}
 */
export function aggregateCliCalls(records){
  const rows=new Map();
  let unclassifiedCalls=0;
  for(const record of Array.isArray(records)?records:[]){
    const result=classifyCliCall({
      toolName:record?.toolName,
      callText:record?.callText,
      resultText:record?.resultText,
      status:record?.status??record?.outcome,
    });
    if(!result)continue;
    if(!result.commands.length){unclassifiedCalls+=1;continue}
    for(const command of result.commands){
      const key=`${command.name}\u0000${command.command}`;
      let row=rows.get(key);
      if(!row){
        row={name:command.name,command:command.command,calls:0,execution:{succeeded:0,failed:0,unknown:0},business:{succeeded:0,failed:0,unknown:0},failures:new Map(),sessions:new Map()};
        rows.set(key,row);
      }
      row.calls+=1;
      row.execution[result.execution]+=1;
      row.business[result.business]+=1;
      if(result.failure)row.failures.set(result.failure,(row.failures.get(result.failure)||0)+1);
      if(typeof record.threadId==='string'&&record.threadId&&typeof record.taskId==='string'&&record.taskId){
        const sessionKey=`${record.threadId}\u0000${record.taskId}`;
        if(!row.sessions.has(sessionKey)){
          row.sessions.set(sessionKey,{
            threadId:record.threadId,
            title:typeof record.threadTitle==='string'?record.threadTitle:null,
            taskId:record.taskId,
            taskTitle:typeof record.taskTitle==='string'?record.taskTitle:null,
          });
        }
      }
    }
  }
  const output=[...rows.values()].map(row=>({
    name:row.name,
    command:row.command,
    calls:row.calls,
    execution:row.execution,
    business:row.business,
    failures:[...row.failures.entries()].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0])).map(([category,count])=>({category,count})),
    sessions:[...row.sessions.values()].sort((left,right)=>left.threadId.localeCompare(right.threadId)||left.taskId.localeCompare(right.taskId)),
  })).sort((left,right)=>right.calls-left.calls||left.name.localeCompare(right.name)||left.command.localeCompare(right.command));
  return {rows:output,unclassifiedCalls,note:NOTE};
}
