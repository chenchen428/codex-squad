# Codex Squad / Codex 小队

[English](#english) · [中文](#中文) · [Overview page](https://chenchen428.github.io/codex-squad/) · [GitHub](https://github.com/chenchen428/codex-squad)

Codex Squad is a local Codex plugin for a clear division of labor. Codex keeps direction, design, decisions, and acceptance. A single fixed Qoder / DeepSeek-Flash implementer investigates, changes code, runs focused checks, and returns results and evidence to the original Codex session. Follow-up work continues in the same task thread instead of starting over.

Version: **0.12.0**

## English

### What it is

Codex Squad is a local plugin that gives one Codex session a disciplined way to hand off work that can be independently reviewed, then take the result back with enough evidence to verify it.

The working contract is deliberately small:

- **Main Codex** defines the observable outcome, scope, write paths, and acceptance criteria. It owns design and key decisions, reviews the actual diff and raw results, and records acceptance only after independent verification.
- **Qoder / DeepSeek-Flash** is the only implementer. It investigates, implements, self-checks, and reports what actually happened, including failures and unresolved gaps.
- **The original session** remains the place for decisions, follow-ups, and rework. Continuing a task preserves the native conversation, prior attempts, and reported usage.

### Task loop

1. **Define scope.** State the goal, allowed write paths, and evidence needed to accept the result. Overlapping write scopes wait instead of overwriting each other.
2. **Execute and self-check.** The implementer works in a native Qoder session, runs focused checks, and reports commands, results, evidence, and remaining gaps.
3. **Verify in the main session.** Codex inspects the diff and original results, performs its own checks, and records acceptance with evidence. A summary alone is not treated as proof.
4. **Continue or close.** Additional requirements, fixes, or missing evidence continue the same task. An optional session summary captures what is needed to resume later.

### Capabilities

- **Read-only task progress.** A local board shows the current session's tasks, status, public replies, and concise execution history. Dispatch and approval stay in the Codex conversation.
- **Continuous conversation.** Follow-ups reuse the original task session, including earlier attempts and reported usage, rather than creating a disconnected replacement.
- **Reported usage, not estimates.** The local analysis views summarize tasks, attempts, continuations, skill access, tool calls, and reported token usage. Missing receipts remain unknown and are not shown as zero; no cost, credit, or savings ratio is derived.
- **Functional acceptance reports.** The bundled `functional-acceptance` skill designs sourced cases, runs the target project's own tests, audits evidence, and builds an offline HTML report. `validate` and `build` check and render the supplied data; they do not execute project tests or certify business acceptance.
- **Optional design review.** When enabled, design work uses Stitch through your own MCP setup and Google account. Original DOM, CSS, and assets are exported before implementation and compared in the same state and viewport.
- **Session summary.** At closeout, a compact summary of goals, decisions, evidence, and open items can be saved for later recovery. Only a link is surfaced by default.

### Requirements

- **Node.js 22.5 or newer.** On older 22.x and 23.x releases, the CLI adds the SQLite experimental flag when it relaunches Node.
- **A Codex host with plugin support and local session records.** Session-bound commands read identity from the host; the plugin does not guess another session.
- **A working Qoder CLI.** `qodercli` must be installed and signed in, and its model catalog must include DeepSeek-Flash. The plugin resolves an existing binary on `PATH` or the standard Qoder install directories; it does not install or authenticate Qoder for you.
- **A project directory and explicit write scope.** The plugin schedules work; it is not a filesystem sandbox. Access to repositories, accounts, test environments, and external systems follows your existing permissions.

### Get started

Download a packaged build from [GitHub Releases](https://github.com/chenchen428/codex-squad/releases), or build the same package from source:

```sh
git clone https://github.com/chenchen428/codex-squad.git
cd codex-squad
npm ci
npm run check
npm run build
npm run package
npm run verify:package
```

`npm run build` creates the static viewer assets. `npm run package` writes a loadable plugin package to `dist/plugin`, and `npm run verify:package` checks its manifest, assets, bundled skills, and CLI entry. Load that directory through the local plugin mechanism supported by your Codex host; the exact installation command depends on the host version.

After the plugin is loaded, use the `initialize` skill to review and merge project principles after an explicit diff, then bind the current session. The `codex-squad` skill describes dispatch, continuation, verification, and acceptance. The `functional-acceptance` skill is the entry point for test evidence and HTML reports.

### Skills and entry points

| Entry | Purpose |
| --- | --- |
| [`codex-squad`](skills/codex-squad/SKILL.md) | Dispatch, continuation, stopping, verification, acceptance, local views, and design/summary routing. |
| [`functional-acceptance`](skills/functional-acceptance/SKILL.md) | Sourced test design, execution of project tests, evidence audit, and offline HTML acceptance reports. |
| [`initialize`](skills/initialize/SKILL.md) | Show and confirm project-principle changes before binding the current Codex session. |
| [`ued-designer`](skills/ued-designer/SKILL.md) / [`stitch-review`](skills/stitch-review/SKILL.md) | Optional Stitch-based design, export, review, and visual comparison workflow. |
| [`session-summary`](skills/session-summary/SKILL.md) | Save or read a compact recovery summary at closeout. |
| [`cli/index.mjs`](cli/index.mjs) | Local CLI for binding, dispatch, task reads, acceptance reports, analysis, and summary. |

The acceptance data contract and CLI reference are in [`cli/lib/functional-acceptance/references/data-contract.md`](cli/lib/functional-acceptance/references/data-contract.md) and [`cli/lib/functional-acceptance/references/cli.md`](cli/lib/functional-acceptance/references/cli.md).

### Limits

- **Local only.** The task, analysis, review, and summary views are served by a local process bound to `127.0.0.1`. URLs contain per-session access tokens and should not be shared.
- **One implementer.** The plugin does not create Codex sub-sessions or nested agent teams. It requires a compatible Codex host and an installed, authenticated Qoder CLI.
- **Manual download from GitHub Releases.** Packaged builds are published on [GitHub Releases](https://github.com/chenchen428/codex-squad/releases); loading the package depends on your Codex host.
- **Cross-platform support is not claimed.** Verify the build and runtime on your target operating system.
- **Optional services are external.** Stitch design review requires your own Google and MCP setup. Availability, data handling, and terms are governed by that service, not this plugin.
- **Usage is not billing.** Reported tokens and tool activity are operational signals from local receipts. They are not account balances, prices, or a measured savings rate.
- **Acceptance reports are evidence containers.** A successful build proves the report input is well-formed and renderable, not that a business flow passed.

---

## 中文

### 这是什么

Codex 小队是一个运行在本机的 Codex 插件，把可以独立验收的工作交给固定实现成员，再把结果和证据收回原会话，让主 Codex 能在同一上下文中完成判断和验收。

协作边界保持简单：

- **主 Codex** 定义可观察结果、范围、写入路径和验收条件，负责设计、关键决策、源码与实际结果核对，并在独立验证后登记验收。
- **Qoder / DeepSeek-Flash** 是唯一的实现成员，负责完整调查、实现、自检，并如实报告执行结果、证据和未解决缺口。
- **原会话** 继续承载决定、补充要求和返工。续接不会丢掉原生对话、已有尝试和已上报用量。

### 任务闭环

1. **范围明确。** 先写清目标、允许写入的范围和验收所需证据。写入范围重叠时等待，避免互相覆盖。
2. **执行自检。** 实现成员在原生 Qoder 会话中调查、修改并运行聚焦检查，报告命令、结果、证据和剩余问题。
3. **主会话核验。** Codex 核对差异与原始结果，执行自己的验证，再带证据登记验收；不把成员摘要直接当作根因或结论。
4. **续接或收尾。** 补充要求、返工和补证沿原任务继续；需要跨轮恢复时保存精简的会话总结。

### 主要能力

- **只读任务进展。** 本机看板展示当前会话的任务、状态、公开回复和简短执行过程。派工与确认仍留在 Codex 对话中。
- **连续对话。** 补充和返工复用原任务会话，保留此前尝试和已报用量，不另起一个失去上下文的新任务。
- **真实回执，不做推算。** 本机分析汇总任务、尝试、续接、技能访问、工具调用和已上报 Token。缺失数据保持未知，不当作零；不换算账户额度、金额或节省比例。
- **功能验收 HTML。** 内置 `functional-acceptance` 技能按来源设计用例，复用目标项目已有测试，审计证据，再生成可离线查看的 HTML 报告。`validate` 和 `build` 只检查、渲染输入，不执行项目测试，也不替代业务验收。
- **可选设计评审。** 启用后通过你自己的 Stitch MCP 和 Google 账号完成设计；实现前导出原始 DOM、CSS 和素材，并在同状态、同视口下核对，不凭截图重画。
- **会话总结。** 收尾时保存目标、已确认决定、证据和剩余问题的精简记录，供后续恢复；默认只给出链接。

### 环境前提

- **Node.js 22.5 或更高版本。** 在较旧的 22.x 和 23.x 版本上，CLI 会带 SQLite 实验参数重新启动 Node。
- **支持插件且保留本机会话记录的 Codex 宿主。** 会话级命令从宿主读取身份，不猜测其他会话。
- **可用的 Qoder CLI。** `qodercli` 需要已安装并登录，模型目录中需有 DeepSeek-Flash。插件只解析 `PATH` 或 Qoder 标准安装目录中的现有程序，不会代为安装或登录。
- **项目工作目录与明确的写入范围。** 插件负责调度，不是文件系统沙箱；仓库、账号、测试环境和外部系统的权限仍按现有授权执行。

### 开始使用

从 [GitHub Releases](https://github.com/chenchen428/codex-squad/releases) 下载打包产物，或按下面的命令从源码构建同一份包：

```sh
git clone https://github.com/chenchen428/codex-squad.git
cd codex-squad
npm ci
npm run check
npm run build
npm run package
npm run verify:package
```

`npm run build` 生成查看器静态资源；`npm run package` 把可加载的插件包写入 `dist/plugin`；`npm run verify:package` 核对清单、资源、内置技能和 CLI 入口。随后按你所使用 Codex 宿主支持的本机插件方式加载该目录，具体安装命令以宿主版本为准。

插件加载后，可先用 `initialize` 技能查看项目原则的具体差异，确认后再融合并绑定当前会话。派工、续接、核验和验收的完整规则见 `codex-squad` 技能；测试证据和 HTML 报告从 `functional-acceptance` 技能进入。

### 技能与入口

| 入口 | 用途 |
| --- | --- |
| [`codex-squad`](skills/codex-squad/SKILL.md) | 派工、续接、停止、核验、验收、本机视图，以及设计和总结的路由。 |
| [`functional-acceptance`](skills/functional-acceptance/SKILL.md) | 有来源的测试设计、项目测试执行、证据审计和离线 HTML 验收报告。 |
| [`initialize`](skills/initialize/SKILL.md) | 在绑定当前 Codex 会话前展示并确认项目原则的具体改动。 |
| [`ued-designer`](skills/ued-designer/SKILL.md) / [`stitch-review`](skills/stitch-review/SKILL.md) | 可选的 Stitch 设计、导出、评审和视觉对照流程。 |
| [`session-summary`](skills/session-summary/SKILL.md) | 收尾时保存或读取精简的恢复总结。 |
| [`cli/index.mjs`](cli/index.mjs) | 本机 CLI：绑定、派工、任务读取、验收报告、分析和总结。 |

验收数据合同和 CLI 说明分别在 [`cli/lib/functional-acceptance/references/data-contract.md`](cli/lib/functional-acceptance/references/data-contract.md) 与 [`cli/lib/functional-acceptance/references/cli.md`](cli/lib/functional-acceptance/references/cli.md)。

### 真实限制

- **只在本机运行。** 任务、分析、评审和总结页面由绑定 `127.0.0.1` 的本机进程提供。URL 含每个会话的访问凭据，不应外发。
- **只有一名实现成员。** 插件不创建 Codex 子会话或嵌套代理小队，并要求兼容的 Codex 宿主以及已安装、已登录的 Qoder CLI。
- **GitHub Releases 手动下载。** 打包产物发布在 [GitHub Releases](https://github.com/chenchen428/codex-squad/releases)；加载方式取决于你的 Codex 宿主。
- **未声明跨平台支持。** 请在目标操作系统上自行验证构建和运行。
- **可选服务属于外部依赖。** Stitch 设计评审需要你自己的 Google 和 MCP 配置；可用性、数据处理和条款由该服务决定，不由本插件保证。
- **用量不是账单。** 已上报 Token 和工具活动来自本机回执，是运行信号，不是账户余额、价格或经测量的节省率。
- **验收报告是证据容器。** 构建成功只证明输入结构完整且可渲染，不证明业务流程已经通过。

---

[Overview page](https://chenchen428.github.io/codex-squad/) · [Source](https://github.com/chenchen428/codex-squad) · [Back to English](#english)
