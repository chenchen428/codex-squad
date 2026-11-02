#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadAndValidate, PathError, InputError } from './lib/validate.mjs';
import { buildPackage } from './lib/build.mjs';
import { auditQuality } from './lib/quality.mjs';
import { GENERATOR_NAME, GENERATOR_VERSION, EXIT, ASSET_MODES } from './lib/constants.mjs';

const USAGE = `Codex 小队 · 功能验收 CLI ${GENERATOR_VERSION}

用法：
  codex-squad acceptance init <数据目录> [--json]
  codex-squad acceptance validate <acceptance.json> [--json]
  codex-squad acceptance audit <acceptance.json> [--strict] [--json]
  codex-squad acceptance build <acceptance.json> --out <验收包目录> [--asset-mode inline|external] [--json]
  codex-squad acceptance serve <验收包目录> [--port 63352]
  acceptance --help
  acceptance --version

命令：
  init      创建输入骨架（acceptance.json 与 recordings/、evidence/ 目录）
  validate  校验输入结构、引用、时间点、状态、verification/reproduction 与本地资产
  audit     逐步骤检查原文/返回、用例依据、实际结果、图片及表格重点，输出补证任务
  build     真实报告默认通过质量门禁后生成离线验收包

选项：
  --out, -o <目录>   build 的输出目录，必须不存在或为空
  --asset-mode <模式> inline（默认，图片内联为 data: 的单 HTML）或 external（图片写入 images/<sha>.<ext>，页面走相对路径）
  --port <端口>       serve 绑定的本机端口，默认 63352，只监听 127.0.0.1
  --json             以 JSON 输出结果（便于脚本消费）
  --strict           audit 将警告也作为失败
  --require-quality  build 对示例也执行质量门禁（真实报告默认执行）
  --help, -h         显示本帮助
  --version, -v      显示版本

退出码：
  0  成功
  1  输入不合规或构建失败
  2  命令用法错误（缺少参数、未知选项、输入文件不可读）

说明：
  生成成功只表示输入可被渲染，不代表测试执行、用户验收或发布通过。
  CLI 不接受自定义 HTML/模板或项目目录作为视图输入；视图只随小队模块内置（assets/studio），缺失时构建失败且不回退旧 shell。
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = EXIT.usage;
  }
}

function parseArgs(argv) {
  const options = { positional: [], json: false, help: false, version: false, out: null, assetMode: 'inline' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new UsageError(arg + ' 需要参数');
      options[arg.slice(2)] = value;
    }
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--require-quality') options.requireQuality = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--out' || arg === '-o') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new UsageError(`${arg} 需要一个目录参数`);
      options.out = value;
      index += 1;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) throw new UsageError('--out 需要一个目录参数');
      options.out = value;
    } else if (arg === '--asset-mode') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new UsageError('--asset-mode 需要 inline 或 external');
      options.assetMode = value;
      index += 1;
    } else if (arg.startsWith('--asset-mode=')) {
      const value = arg.slice('--asset-mode='.length);
      if (!value) throw new UsageError('--asset-mode 需要 inline 或 external');
      options.assetMode = value;
    } else if (arg === '--') {
      options.positional.push(...argv.slice(index + 1));
      break;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`未知选项：${arg}`);
    } else {
      options.positional.push(arg);
    }
  }
  if (!ASSET_MODES.includes(options.assetMode)) {
    throw new UsageError(`--asset-mode 只能是 ${ASSET_MODES.join(' / ')}，收到：${options.assetMode}`);
  }
  return options;
}

function requireSinglePositional(options, label) {
  if (options.positional.length === 0) throw new UsageError(`缺少${label}参数`);
  if (options.positional.length > 1) throw new UsageError(`只接受一个${label}参数，收到 ${options.positional.length} 个`);
  return options.positional[0];
}

function skeleton() {
  return {
    schemaVersion: 1,
    report: {
      id: 'acceptance-report',
      title: '待填写验收报告',
      environment: '待填写环境',
      example: true,
    },
    groups: [{ id: 'sample', title: '待填写分组' }],
    recordings: [],
    evidence: [],
    cases: [
      {
        id: 'C1',
        groupId: 'sample',
        title: '待填写用例',
        requirement: '待填写需求编号',
        objective: '填写这条用例要验证的业务目标',
        status: 'not_run',
        preconditions: ['填写执行前置条件'],
        steps: [
          {
            id: 'step-1',
            type: 'page',
            page: '待填写页面',
            pageView: { title: '待填写页面', buttons: ['待填写操作'], focus: '待填写操作' },
            title: '待填写步骤',
            action: '填写本次执行的动作',
            expected: '填写预期结果',
            actual: '尚未执行',
            status: 'not_run',
            evidenceIds: [],
          },
        ],
        checks: [],
      },
    ],
  };
}

function countStats(data) {
  const cases = Array.isArray(data.cases) ? data.cases : [];
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  return {
    groups: Array.isArray(data.groups) ? data.groups.length : 0,
    cases: cases.length,
    steps: cases.reduce((sum, item) => sum + (Array.isArray(item.steps) ? item.steps.length : 0), 0),
    checks: cases.reduce((sum, item) => sum + (Array.isArray(item.checks) ? item.checks.length : 0), 0),
    recordings: Array.isArray(data.recordings) ? data.recordings.length : 0,
    evidence: evidence.length,
    images: evidence.filter((item) => item && item.type === 'image').length,
  };
}

function formatIssues(title, issues) {
  if (issues.length === 0) return [];
  const lines = [`${title}（${issues.length}）：`];
  for (const issue of issues) {
    lines.push(`  [${issue.code}] ${issue.path} — ${issue.message}`);
  }
  return lines;
}

function commandInit(target, options) {
  const dir = path.resolve(target);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
    throw new UsageError(`目标已存在且不是目录：${target}`);
  }
  const inputFile = path.join(dir, 'acceptance.json');
  if (fs.existsSync(inputFile)) {
    const message = `acceptance.json 已存在，拒绝覆盖：${inputFile}`;
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, command: 'init', input: inputFile, errors: [{ code: 'E_INIT_EXISTS', path: '$', message }] }, null, 2)}\n`);
    } else {
      process.stderr.write(`错误：${message}\n`);
    }
    return EXIT.failed;
  }

  const created = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['recordings', 'evidence']) {
    const sub = path.join(dir, name);
    fs.mkdirSync(sub, { recursive: true });
    created.push(name);
  }
  const text = `${JSON.stringify(skeleton(), null, 2)}\n`;
  fs.writeFileSync(inputFile, text, { flag: 'wx' });
  created.unshift('acceptance.json');

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, command: 'init', dataDir: dir, input: inputFile, created }, null, 2)}\n`);
  } else {
    process.stdout.write([
      `已创建验收输入骨架：${dir}`,
      ...created.map((name) => `  + ${name}`),
      '',
      '下一步：按 references/data-contract.md 填写 acceptance.json，然后运行：',
      `  node scripts/acceptance.mjs validate ${path.join(dir, 'acceptance.json')} --json`,
      `  node scripts/acceptance.mjs build ${path.join(dir, 'acceptance.json')} --out <验收包目录>`,
      '',
      '骨架使用 example: true 与 not_run 状态，仅作填写起点，不是真实执行结果。',
      '',
    ].join('\n'));
  }
  return EXIT.ok;
}

function inputArgumentFailure(error, command, options) {
  const payload = {
    ok: false,
    command,
    errors: [{ code: error.code || 'E_INPUT', path: '$', message: error.message }],
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`错误：${error.message}\n`);
}

function commandValidate(input, options) {
  let result;
  try {
    result = loadAndValidate(input);
  } catch (error) {
    if (error instanceof PathError || error instanceof InputError) {
      inputArgumentFailure(error, 'validate', options);
      return error instanceof PathError ? EXIT.usage : EXIT.failed;
    }
    throw error;
  }

  const stats = countStats(result.data);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      command: 'validate',
      input: result.inputAbsolute,
      dataDir: result.dataDirReal,
      inputSha256: result.inputSha256,
      inputBytes: result.inputBytes,
      stats,
      errors: result.errors,
      warnings: result.warnings,
    }, null, 2)}\n`);
    return result.ok ? EXIT.ok : EXIT.failed;
  }

  const lines = [];
  lines.push(`验收输入：${result.inputAbsolute}`);
  lines.push(`统计：${stats.groups} 分组 / ${stats.cases} 用例 / ${stats.steps} 步骤 / ${stats.checks} 核对 / ${stats.recordings} 录制 / ${stats.evidence} 证据（${stats.images} 图片）`);
  if (result.ok) {
    lines.push(`结果：通过${result.warnings.length ? `（${result.warnings.length} 个提醒）` : ''}`);
  } else {
    lines.push(`结果：未通过（${result.errors.length} 个错误${result.warnings.length ? `，${result.warnings.length} 个提醒` : ''}）`);
  }
  lines.push(...formatIssues('错误', result.errors));
  lines.push(...formatIssues('提醒', result.warnings));
  if (result.ok) {
    lines.push('提示：校验通过只表示输入可被渲染，不代表测试执行或验收通过。');
  }
  const text = `${lines.join('\n')}\n`;
  if (result.ok) process.stdout.write(text);
  else process.stderr.write(text);
  return result.ok ? EXIT.ok : EXIT.failed;
}

function commandBuild(input, options) {
  if (!options.out) throw new UsageError('build 需要 --out <验收包目录>');
  let result;
  try {
    result = buildPackage(input, options.out, { assetMode: options.assetMode, requireQuality:options.requireQuality });
  } catch (error) {
    if (error instanceof PathError || error instanceof InputError) {
      inputArgumentFailure(error, 'build', options);
      return error instanceof PathError && /^E_INPUT_/.test(error.code) ? EXIT.usage : EXIT.failed;
    }
    throw error;
  }

  if (!result.ok) {
    const payload = {
      ok: false,
      command: 'build',
      stage: result.stage,
      repairTasks: result.repairTasks || [],
      input: result.inputAbsolute || path.resolve(input),
      outDir: path.resolve(options.out),
      errors: result.errors,
      warnings: result.warnings || [],
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const lines = [
        `构建失败（阶段：${result.stage}）：${payload.input}`,
        ...formatIssues('错误', result.errors),
        ...formatIssues('提醒', payload.warnings),
        '未生成验收包。',
      ];
      process.stderr.write(`${lines.join('\n')}\n`);
    }
    return EXIT.failed;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'build',
      assetMode: result.assetMode,
      viewer: result.viewer,
      input: result.manifest.input.file,
      inputSha256: result.manifest.input.sha256,
      outDir: result.outDir,
      files: result.files,
      stats: result.stats,
      warnings: result.warnings,
      generator: result.manifest.generator,
    }, null, 2)}\n`);
    return EXIT.ok;
  }

  const lines = [
    `验收包已生成：${result.outDir}`,
    `资源模式：${result.assetMode}${result.assetMode === 'inline' ? '（单 HTML，图片内联）' : '（图片写入 images/，页面相对路径）'}；视图：${result.viewer.id}`,
    ...result.files.map((file) => `  ${file.path}  ${file.bytes} bytes  sha256:${file.sha256.slice(0, 12)}…`),
    `统计：${result.stats.cases} 用例 / ${result.stats.steps} 步骤 / ${result.stats.checks} 核对 / ${result.stats.recordings} 录制 / ${result.stats.evidence} 证据（${result.stats.images} 图片）`,
    ...formatIssues('提醒', result.warnings),
    `打开方式：直接打开 ${path.join(result.outDir, 'index.html')}（离线运行，不请求外部资源）`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }

  if (options.help || argv.length === 0) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  if (options.version) {
    process.stdout.write(`${GENERATOR_NAME} ${GENERATOR_VERSION}\n`);
    return EXIT.ok;
  }

  const command = options.positional.shift();
  try {
    if (options.strict && command !== 'audit') throw new UsageError('--strict 只用于 audit');
    if (options.requireQuality && command !== 'build') throw new UsageError('--require-quality 只用于 build');
    if (command === 'serve') {
      const { startAcceptanceServer } = await import('./lib/serve.mjs');
      const directory = requireSinglePositional(options, '验收包目录');
      const port = Number(options.port || 63352);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UsageError('port范围为1024–65535');
      let result;
      try {
        result = await startAcceptanceServer({directory, port});
      } catch (error) {
        if (error && error.name === 'PackageError') {
          process.stderr.write(`错误：${error.message}\n`);
          return EXIT.failed;
        }
        throw error;
      }
      process.stdout.write(JSON.stringify({ok:true,url:result.url,host:result.host,inputSha256:result.inputSha256})+'\n');
      process.stdout.write(`本机静态预览：${result.url}\n只读浏览已生成报告，按 Ctrl+C 结束。\n`);
      await new Promise(resolve => {
        const stop = () => { void result.close().finally(resolve); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return EXIT.ok;
    }
    if (command === 'init') {
      const target = requireSinglePositional(options, '数据目录');
      return commandInit(target, options);
    }
    if (command === 'validate') {
      const input = requireSinglePositional(options, '输入文件');
      if (options.out) throw new UsageError('validate 不接受 --out');
      return commandValidate(input, options);
    }
    if (command === 'audit') {
      const input = requireSinglePositional(options, '输入文件');
      let validation;
      try { validation = loadAndValidate(input); }
      catch(error) {
        if(error instanceof PathError || error instanceof InputError) { inputArgumentFailure(error,'audit',options); return error instanceof PathError ? EXIT.usage : EXIT.failed; }
        throw error;
      }
      const result = auditQuality(validation);
      const ok = result.ok && (!options.strict || !result.warnings.length);
      const output = {...result,ok,command:'audit',strict:!!options.strict};
      if(options.json)process.stdout.write(JSON.stringify(output,null,2)+'\n');
      else {
        process.stdout.write('报告质量检查：'+(ok?'通过':'未通过')+'；错误 '+result.errors.length+'，警告 '+result.warnings.length+'\n');
        for(const issue of [...result.errors,...result.warnings])process.stdout.write(issue.code+' '+issue.path+'：'+issue.message+'\n');
        process.stdout.write((result.boundary||'输入结构错误需先修复')+'\n');
      }
      return ok ? EXIT.ok : EXIT.failed;
    }
    if (command === 'build') {
      const input = requireSinglePositional(options, '输入文件');
      return commandBuild(input, options);
    }
    throw new UsageError(`未知命令：${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`未预期的错误：${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = EXIT.failed;
}
