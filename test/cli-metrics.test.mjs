import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateCliCalls,classifyCliCall} from '../cli/lib/cli-metrics.mjs';

function cls(toolName,callText,resultText='',status='succeeded'){
  return classifyCliCall({toolName,callText,resultText,status});
}

test('cli attribution resolves absolute path CLIs, env assignments and subcommands without argument values',()=>{
  const result=cls('Bash','cd /Users/private/repo && /usr/local/bin/lgb capability invoke --token sk-secret "my value"','Process exited with code 0');
  assert.equal(result.name,'lgb');
  assert.equal(result.command,'lgb capability invoke');
  assert.deepEqual(result.commands,[{name:'lgb',command:'lgb capability invoke'}]);
  assert.equal(result.composite,false);
  assert.equal(result.execution,'succeeded');
  const serialized=JSON.stringify(result);
  for(const secret of ['/Users/private','sk-secret','my value','--token']){
    assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
  }

  const env=cls('Bash','FOO=bar env TOKEN=secret lgb capability invoke');
  assert.equal(env.command,'lgb capability invoke');
  assert.equal(JSON.stringify(env).includes('secret'),false);

  const timeout=cls('Bash','timeout 30s lgb capability invoke');
  assert.equal(timeout.command,'lgb capability invoke');

  const nohup=cls('Bash','nohup sf workflow create --name demo');
  assert.equal(nohup.command,'sf workflow create');
});

test('cli attribution reads JSON cmd/command and shell -c wrappers',()=>{
  const jsonCmd=cls('exec_command',JSON.stringify({cmd:'sf workflow create --name demo'}));
  assert.equal(jsonCmd.name,'sf');
  assert.equal(jsonCmd.command,'sf workflow create');

  const jsonArray=cls('run_command',JSON.stringify({command:['bash','-lc','a1 code repo view --id 1']}));
  assert.equal(jsonArray.name,'a1');
  assert.equal(jsonArray.command,'a1 code repo');

  const shellText=cls('Bash','bash -lc "cd /repo && lgb capability invoke --id 7"');
  assert.equal(shellText.command,'lgb capability invoke');
  assert.equal(shellText.composite,false);

  const quotedName=cls('Bash','"/usr/local/bin/lgb" capability invoke');
  assert.equal(quotedName.command,'lgb capability invoke');

  assert.equal(cls('Bash','lgb "capability" "invoke"').command,'lgb');
  assert.equal(cls('Bash','lgb capability production').command,'lgb capability');
  assert.equal(cls('Bash','a1 code myrepo').command,'a1 code');
});

test('unparsable command tools stay unclassified instead of guessing',()=>{
  for(const callText of ['','cat /Users/private/file','{"cmd":{"nested":true}}','lgb capability invoke <<EOF\nsecret value\nEOF','bash script.sh']){
    const result=cls('Bash',callText);
    assert.ok(result,`${callText} 应仍按命令工具处理`);
    assert.deepEqual(result.commands,[],`${callText} 不应归入 CLI 排行`);
  }
  assert.equal(cls('Read','/Users/private/file'),null);
  assert.equal(cls('Grep','needle'),null);
  assert.equal(cls('execute','', '', 'failed').name,null);
});

test('generic execute is never a row while specific MCP tools keep their full name',()=>{
  const execute=cls('execute','lgb capability invoke');
  assert.deepEqual(execute.commands,[{name:'lgb',command:'lgb capability invoke'}]);

  const mcp=cls('mcp__reui__search','{"query":"secret query"}','{"ok":true}');
  assert.equal(mcp.name,'mcp__reui__search');
  assert.equal(mcp.command,'mcp__reui__search');
  assert.equal(mcp.business,'succeeded');
  assert.equal(JSON.stringify(mcp).includes('secret query'),false);
});

test('execution success needs an explicit exit code while a completed tool is not success',()=>{
  assert.equal(cls('Bash','lgb capability invoke','done','succeeded').execution,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','Process exited with code 0','succeeded').execution,'succeeded');
  assert.equal(cls('Bash','lgb capability invoke','{"exit_code":0}','succeeded').execution,'succeeded');
  assert.equal(cls('Bash','lgb capability invoke','{"exitCode":2}','succeeded').execution,'failed');
  assert.equal(cls('Bash','lgb capability invoke','Process exited with code 1','succeeded').execution,'failed');
  // Prose that mentions an older exit code is not this command's executor verdict.
  assert.equal(cls('Bash','lgb capability invoke','User guide: previous command exit code: 1','SUCCEEDED').execution,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','','failed').execution,'failed');
});

test('failure distribution keeps bounded categories instead of raw errors',()=>{
  const timeout=cls('Bash','lgb capability invoke','request timed out after 30s','failed');
  assert.equal(timeout.failure,'timeout');
  const permission=cls('Bash','lgb capability invoke','permission denied: access token rejected','failed');
  assert.equal(permission.failure,'permission');
  const argument=cls('Bash','lgb capability invoke','error: unrecognized option --bad with value /Users/private','failed');
  assert.equal(argument.failure,'argument');
  const service=cls('Bash','lgb capability invoke','connect ECONNREFUSED 127.0.0.1:8080','failed');
  assert.equal(service.failure,'service');
  const execution=cls('Bash','lgb capability invoke','bash: lgb: command not found','failed');
  assert.equal(execution.failure,'execution');
  const unconfirmed=cls('Bash','lgb capability invoke','boom','failed');
  assert.equal(unconfirmed.failure,'unconfirmed');
  for(const result of [timeout,permission,argument,service,execution,unconfirmed]){
    assert.equal(JSON.stringify(result).includes('/Users/private'),false);
  }
});

test('business success only trusts top-level structured receipts',()=>{
  assert.equal(cls('Bash','lgb capability invoke','{"ok":true}').business,'succeeded');
  assert.equal(cls('Bash','lgb capability invoke','{"success":false}').business,'failed');
  assert.equal(cls('Bash','lgb capability invoke','{"status":"SUCCESS"}').business,'succeeded');
  assert.equal(cls('Bash','lgb capability invoke','{"code":0}').business,'succeeded');
  assert.equal(cls('Bash','lgb capability invoke','{"code":1}').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','{"code":200}').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','{"code":200,"success":false}').business,'failed');
  assert.equal(cls('Bash','lgb capability invoke','{"code":200,"success":true}').business,'succeeded');
  assert.equal(cls('Bash','lgb capability invoke','{"code":"0"}').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','{"code":"SUCCESS"}').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','{"data":{"success":false}}').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','{"data":{"code":0}}').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','{"ok":true,"success":false}').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','plain output').business,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','{"ok":true}','failed').business,'unknown');
});

test('composite commands never graft the overall exit code onto each command',()=>{
  const piped=cls('Bash','lgb capability invoke --id 1 | jq .ok','exit code: 0');
  assert.equal(piped.composite,true);
  assert.deepEqual(piped.commands,[{name:'lgb',command:'lgb capability invoke'}]);
  assert.equal(piped.execution,'unknown');
  assert.equal(piped.business,'unknown');

  const chained=cls('Bash','lgb capability invoke && sf workflow create','exit code: 0');
  assert.equal(chained.composite,true);
  assert.deepEqual(chained.commands.map(command=>command.name),['lgb','sf']);
  assert.equal(chained.execution,'unknown');

  const background=cls('Bash','lgb capability invoke &','');
  assert.equal(background.composite,true);
  assert.equal(background.execution,'unknown');
});

test('free-form lowercase positionals never become a public subcommand',()=>{
  const credential=cls('execute','lgb secretcredentialvalue','{"exit_code":0}','SUCCEEDED');
  assert.equal(credential.name,'lgb');
  assert.equal(credential.command,'lgb');
  assert.equal(JSON.stringify(credential).includes('secretcredentialvalue'),false);

  for(const [text,command] of [
    ['lgb capability invoke','lgb capability invoke'],
    ['sf log query --id 1','sf log query'],
    ['a1 repo view --repo demo','a1 repo view'],
    ['a1 code repo view --id 1','a1 code repo'],
  ]){
    assert.equal(cls('Bash',text).command,command,text);
  }
});

test('non-zero numeric code alone stays unconfirmed instead of business failure',()=>{
  const receipt=cls('Bash','lgb capability invoke','{"code":200}');
  assert.equal(receipt.business,'unknown');
  assert.equal(receipt.failure,null);
  assert.equal(cls('Bash','lgb capability invoke','{"status":"FAILED"}').business,'failed');
});

test('prose mentioning an older exit code is not the execution verdict',()=>{
  const prose=cls('Bash','lgb capability invoke','User guide: previous command exit code: 1','SUCCEEDED');
  assert.equal(prose.execution,'unknown');
  assert.equal(prose.failure,null);
  assert.equal(cls('Bash','lgb capability invoke','Output: exit code: 0','succeeded').execution,'unknown');
  assert.equal(cls('Bash','lgb capability invoke','Process exited with code 0','succeeded').execution,'succeeded');
});

test('business failures get a bounded category and count once per call',()=>{
  const businessOnly=cls('Bash','lgb capability invoke','{"exit_code":0,"success":false}');
  assert.equal(businessOnly.execution,'succeeded');
  assert.equal(businessOnly.business,'failed');
  assert.equal(businessOnly.failure,'business');

  const mapped=cls('Bash','lgb capability invoke','{"exit_code":0,"success":false,"error":"permission denied"}');
  assert.equal(mapped.failure,'permission');

  const overlapping=cls('Bash','lgb capability invoke','{"exit_code":2,"success":false}');
  assert.equal(overlapping.execution,'failed');
  assert.equal(overlapping.business,'failed');
  assert.equal(overlapping.failure,'execution');

  const result=aggregateCliCalls([
    {toolName:'Bash',callText:'lgb capability invoke',resultText:'{"exit_code":0,"success":false}',status:'succeeded',threadId:'t1',taskId:'a'},
    {toolName:'Bash',callText:'lgb capability invoke',resultText:'{"exit_code":0,"success":false}',status:'succeeded',threadId:'t1',taskId:'a'},
  ]);
  const row=result.rows[0];
  assert.equal(row.calls,2);
  assert.deepEqual(row.execution,{succeeded:2,failed:0,unknown:0});
  assert.deepEqual(row.business,{succeeded:0,failed:2,unknown:0});
  assert.deepEqual(row.failures,[{category:'business',count:2}]);
  assert.equal(JSON.stringify(result).includes('exit_code'),false);
});

test('aggregateCliCalls exposes counts, failure distribution and session attribution',()=>{
  const records=[
    {toolName:'Bash',callText:'lgb capability invoke --id 1',resultText:'Process exited with code 0',status:'succeeded',threadId:'t1',threadTitle:'会话一',taskId:'a',taskTitle:'任务一'},
    {toolName:'Bash',callText:'lgb capability invoke --id 2',resultText:'request timed out',status:'failed',threadId:'t1',threadTitle:'会话一',taskId:'a',taskTitle:'任务一'},
    {toolName:'execute',callText:'',resultText:'',status:'failed',threadId:'t2',threadTitle:'会话二',taskId:'b',taskTitle:'任务二'},
    {toolName:'Read',callText:'/Users/private/file',status:'succeeded',taskId:'b'},
    {toolName:'mcp__reui__search',callText:'{"query":"secret"}',resultText:'{"ok":true}',status:'succeeded',threadId:'t2',taskId:'b'},
  ];
  const result=aggregateCliCalls(records);
  assert.equal(result.unclassifiedCalls,1);
  assert.match(result.note,/不参与成功率/);
  assert.match(result.note,/未确认的调用不进入成功率分母/);
  assert.match(result.note,/Qoder/);
  assert.match(result.note,/主 Codex 会话未采集/);
  assert.deepEqual(result.rows.map(row=>row.name),['lgb','mcp__reui__search']);

  const lgb=result.rows[0];
  assert.equal(lgb.command,'lgb capability invoke');
  assert.equal(lgb.calls,2);
  assert.deepEqual(lgb.execution,{succeeded:1,failed:1,unknown:0});
  assert.deepEqual(lgb.business,{succeeded:0,failed:0,unknown:2});
  assert.deepEqual(lgb.failures,[{category:'timeout',count:1}]);
  assert.deepEqual(lgb.sessions,[{threadId:'t1',title:'会话一',taskId:'a',taskTitle:'任务一'}]);

  const serialized=JSON.stringify(result);
  for(const secret of ['--id','/Users/private','secret','request timed out']){
    assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
  }
  assert.equal(serialized.includes('"callText"'),false);
  assert.equal(serialized.includes('"resultText"'),false);
});

test('bash loop and conditional keywords are never CLIs and never inherit an exit code',()=>{
  const loop=cls('Bash','for f in a b; do /usr/bin/shasum "$f"; done','Process exited with code 0');
  assert.deepEqual(loop.commands,[],'循环块内联写法不猜测单条命令');
  assert.equal(loop.composite,true);
  assert.equal(loop.execution,'unknown');
  assert.equal(loop.business,'unknown');

  const conditional=cls('Bash','if [ -f x ]; then lgb capability invoke; fi','Process exited with code 0');
  assert.deepEqual(conditional.commands,[]);
  assert.equal(conditional.execution,'unknown');

  const whileLoop=cls('Bash','while true; do git status; done','exit code: 0');
  assert.deepEqual(whileLoop.commands,[]);
  assert.equal(whileLoop.execution,'unknown');

  const multiline=cls('Bash','for f in a b\ndo\n  git status\ndone','Process exited with code 0');
  assert.equal(multiline.composite,true);
  assert.equal(multiline.execution,'unknown');
  assert.equal(multiline.commands.some(command=>['for','do','done'].includes(command.name)),false);
  assert.deepEqual(multiline.commands,[],'循环体是否执行以及循环次数均不确定，不能把脚本里的命令当成调用');

  const onlyKeywords=cls('Bash','for x in a; do echo "$x"; done','Process exited with code 0');
  assert.deepEqual(onlyKeywords.commands,[]);
  const aggregated=aggregateCliCalls([
    {toolName:'Bash',callText:'for x in a; do echo "$x"; done',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'if true; then :; fi',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'while false; do :; done',resultText:'Process exited with code 0'},
  ]);
  assert.deepEqual(aggregated.rows,[],'shell 关键字不能出现在 CLI 排行');
  assert.equal(aggregated.unclassifiedCalls,3);
});

test('time and exec wrappers keep the real command while command stays a shell builtin',()=>{
  const timed=cls('Bash','time -p lgb capability invoke','Process exited with code 0');
  assert.equal(timed.command,'lgb capability invoke');
  assert.equal(timed.execution,'succeeded');

  const execd=cls('Bash','exec lgb capability invoke','Process exited with code 0');
  assert.equal(execd.command,'lgb capability invoke');

  const controlOnly=cls('Bash','cd /repo && lgb capability invoke','Process exited with code 0');
  assert.equal(controlOnly.command,'lgb capability invoke','cd 不是一次命令执行，不应把调用变成复合命令');

  const multi=cls('Bash','cd /repo; lgb capability invoke; git status','Process exited with code 0');
  assert.equal(multi.composite,true);
  assert.equal(multi.execution,'unknown','多段执行的退出码不分摊');
});

test('a completed executor event is not execution or business success',()=>{
  const completed=cls('execute','lgb capability invoke','lgb replied ok','completed');
  assert.equal(completed.name,'lgb');
  assert.equal(completed.execution,'unknown');
  assert.equal(completed.business,'unknown');
  assert.equal(completed.failure,null);

  const receipt=cls('execute','lgb capability invoke','{"ok":true}','completed');
  assert.equal(receipt.execution,'unknown','completed 不能代替退出码');
  assert.equal(receipt.business,'succeeded','业务判定只看顶层结构化回执');
});

test('script bodies, spaced heredocs and filenames never become CLI names',()=>{
  for(const command of [
    "python3 - << 'PY'\nfrom pathlib import Path\nfilename.json\nPY",
    "python3 - <<'PY'\nconst value = null\nPY",
    "cat << EOF\nReport.java\nEOF",
    'report.json', 'Report.java', 'library.jar', 'events.log',
    'def function():\n  return result',
    'for file in *.json; do git status; done',
  ]){
    const result=cls('Bash',command,'Process exited with code 0');
    assert.deepEqual(result.commands,[],command);
    assert.equal(result.execution,'unknown',command);
  }
  const real=cls('Bash','# inspect the business tool\nlgb capability invoke','Process exited with code 0');
  assert.deepEqual(real.commands,[{name:'lgb',command:'lgb capability invoke'}]);
  assert.equal(real.execution,'succeeded');
  assert.deepEqual(cls('Bash','checkpoint-continuation').commands,[],'无回执的任意单词不能冒充 CLI');
  const custom=cls('Bash','custom-tool --check','Process exited with code 1');
  assert.equal(custom.name,'custom-tool','真实退出回执仍支持未预设的 CLI');
  assert.equal(custom.execution,'failed');
});

test('python and node roots resolve to the module, script or test target that runs',()=>{
  assert.equal(cls('Bash','python3 -m pytest tests/test_a.py -q').command,'python3 -m pytest');
  assert.equal(cls('Bash','python3 -m http.server 8000').command,'python3 -m http.server');
  assert.equal(cls('Bash','python3 -m pip install -r requirements.txt').command,'python3 -m pip install');
  assert.equal(cls('Bash','python3 -u scripts/check.py --env prod').command,'python3 check.py');
  assert.equal(cls('Bash','/usr/bin/python3.11 tools/deploy.py').command,'python3.11 deploy.py');
  assert.equal(cls('Bash','node build.mjs').command,'node build.mjs');
  assert.equal(cls('Bash','node server.js --port 3000').command,'node server.js');
  assert.equal(cls('Bash','node --watch --env-file=.env app.mjs').command,'node app.mjs');
  assert.equal(cls('Bash','node --test test/a.test.mjs').command,'node --test a.test.mjs');
  assert.equal(cls('Bash','node --test test/').command,'node --test test');
  assert.equal(cls('Bash','node --test a.test.mjs b.test.mjs').command,'node --test');
  assert.equal(cls('Bash','node --test').command,'node --test','裸测试运行仍是可确认的测试子命令');
  assert.equal(cls('Bash','node --test test/*.test.mjs').command,'node --test','glob 目标不进入命令名');
  assert.equal(cls('Bash','npm run build').command,'npm run build');
  assert.equal(cls('Bash','npm run test:unit -- --watch').command,'npm run test:unit');
  assert.equal(cls('Bash','pnpm run lint').command,'pnpm run lint');

  const aggregated=aggregateCliCalls([
    {toolName:'Bash',callText:'python3 scripts/check.py --env prod --token sk-secret',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'python3 scripts/convert.py',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'python3 -m pytest tests/test_a.py',resultText:'Process exited with code 1'},
    {toolName:'Bash',callText:'node build.mjs --out /Users/private/out',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'node build-review.mjs',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'node --test test/a.test.mjs',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'npm run build',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'npm run test:unit -- --watch',resultText:'Process exited with code 0'},
  ]);
  assert.deepEqual(aggregated.rows.map(row=>row.command).sort(),[
    'node --test a.test.mjs','node build-review.mjs','node build.mjs','npm run build','npm run test:unit',
    'python3 -m pytest','python3 check.py','python3 convert.py',
  ],'不同脚本各自成行，不合并成 python3/node 根名');
  assert.equal(aggregated.rows.some(row=>['python3','node','npm'].includes(row.command)),false);
  const pytestRow=aggregated.rows.find(row=>row.command==='python3 -m pytest');
  assert.deepEqual(pytestRow.execution,{succeeded:0,failed:1,unknown:0});
  assert.deepEqual(pytestRow.failures,[{category:'execution',count:1}]);
  const serialized=JSON.stringify(aggregated);
  for(const secret of ['sk-secret','/Users/private','tests/test_a.py','--watch','--out','scripts/']) {
    assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
  }
});

test('inline interpreter code stays unclassified instead of becoming a python3/node row',()=>{
  const pythonInline=cls('Bash','python3 -c "import os\nprint(os.getcwd())"','Process exited with code 0');
  const nodeInline=cls('Bash','node -e "console.log(process.env.HOME)"','Process exited with code 0');
  const stdin=cls('Bash','python3 -','Process exited with code 0');
  const bare=cls('Bash','python3','Process exited with code 0');
  for(const result of [pythonInline,nodeInline,stdin,bare]){
    assert.deepEqual(result.commands,[]);
    assert.equal(result.execution,'unknown','内联脚本不能借用整体退出码冒充成功');
    assert.equal(result.failure,null);
    assert.equal(result.composite,true);
  }
  for(const callText of ['node report.json']){
    assert.deepEqual(cls('Bash',callText,'Process exited with code 0').commands,[],callText);
  }
  const bareTest=cls('Bash','node --test');
  assert.equal(bareTest.command,'node --test');
  assert.equal(bareTest.execution,'unknown','没有退出回执的测试运行不能算成功');
  assert.equal(cls('Bash','node --test','Process exited with code 0','succeeded').execution,'succeeded');
  assert.equal(cls('Bash','node --test a.test.mjs --test-name-pattern x').command,'node --test a.test.mjs');

  const aggregated=aggregateCliCalls([
    {toolName:'Bash',callText:'python3 -c "import os"',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'node -e "console.log(1)"',resultText:'Process exited with code 0'},
    {toolName:'Bash',callText:'node -e "process.exit(0)"',resultText:'Process exited with code 0'},
  ]);
  assert.deepEqual(aggregated.rows,[]);
  assert.equal(aggregated.unclassifiedCalls,3);
  const serialized=JSON.stringify(aggregated);
  for(const secret of ['os.getcwd','console.log','process.env','process.exit','import os']){
    assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
  }
});

test('lgb capability names come only from the documented positional, never ids or input values',()=>{
  const invoke=cls('Bash','lgb --env prod --auth-provider ncs capability invoke billing_fund_query --data-file request.json --json','Process exited with code 0');
  assert.equal(invoke.command,'lgb capability invoke billing_fund_query');
  assert.equal(invoke.execution,'succeeded');
  assert.equal(invoke.composite,false);

  assert.equal(cls('Bash','lgb --env=prod capability describe billing_settlement_360_query_tab --json').command,'lgb capability describe billing_settlement_360_query_tab');
  assert.equal(cls('Bash','lgb invoke billing_fund_query').command,'lgb invoke billing_fund_query');
  assert.equal(cls('Bash','lgb --env prod auth status --json').command,'lgb auth status');
  assert.equal(cls('Bash','lgb capabilities --refresh --json').command,'lgb capabilities');
  assert.equal(cls('Bash','lgb capability invoke --help').command,'lgb capability invoke');
  assert.equal(cls('Bash','lgb capability search \'业务词\'').command,'lgb capability search');
  assert.equal(cls('Bash','lgb --help').command,'lgb');

  for(const callText of [
    'lgb capability invoke 1234567890',
    'lgb capability invoke b1234567',
    'lgb capability invoke --id 7',
    'lgb capability invoke "$CAP"',
    'lgb capability describe billing.query',
  ]){
    assert.equal(cls('Bash',callText).command,lgbRootOf(callText),`${callText} 不应把 id 或输入参数当能力名`);
  }
  const serialized=JSON.stringify(invoke);
  for(const secret of ['request.json','--data-file','ncs','prod','--auth-provider']){
    assert.equal(serialized.includes(secret),false,`不应输出 ${secret}`);
  }
});

function lgbRootOf(callText){
  return callText.startsWith('lgb capability describe')?'lgb capability describe':'lgb capability invoke';
}
