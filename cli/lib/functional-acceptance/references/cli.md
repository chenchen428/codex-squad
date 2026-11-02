# CLI 使用说明

Node.js 22.5+；无需 npm install 或全局命令。`<CLI>` 指小队插件 cli/index.mjs 的绝对路径，输入与输出参数可用绝对路径，所以可从任意工作目录运行。

```sh
node <CLI> acceptance init ./acceptance-data --json
node <CLI> acceptance validate ./acceptance-data/acceptance.json --json
node <CLI> acceptance audit ./acceptance-data/acceptance.json --json
node <CLI> acceptance build ./acceptance-data/acceptance.json --out ./acceptance-package --json
node <CLI> acceptance build ./acceptance-data/acceptance.json --out ./acceptance-package --asset-mode external --json
```

- `init <目录>`：创建 `acceptance.json`、`recordings/`、`evidence/`。骨架为示例且未执行，已有 acceptance.json 时拒绝覆盖。
- `validate <JSON>`：检查结构、状态自洽、引用、资产路径、录制完整快照及时间范围，并校验用例目的分类：`caseRole` 省略时按 `unknown` 通过；`new/regression/mixed/audit` 缺少 `caseRoleReason` 或非空 `caseRoleSources` 会报错。新增字段同样校验：`displayTitle` 非空；`verification` 的枚举、`origin` 语义、证据引用与 `comparison.status`（必须由数据提供，不推断）；`reproduction` 的枚举、已核验地址必须是无占位符的 https 地址、未核验地址必须为 `null`、来源引用不得悬空。不执行测试或业务请求。
- `audit <JSON> [--strict]`：校验结构和资源后检查内容完整性：用例缘由及来源、具体预期/实际、执行原文、可展示原始结果、图片标注及边界、关注单元格引用、状态自洽。输出 `repairTasks[]`，含用例/步骤、缺项、现有来源与补证动作，供 Agent 定向修复。`--strict` 使警告也返回失败。规则不证明事实正确，Agent 仍须阅读原件。
- `build <JSON> --out <目录>`：真实报告默认执行质量门禁；存在质量错误时返回 `stage=quality` 和修复任务，不生成报告。示例报告可演示缺口，`--require-quality` 可对示例也启用门禁；不得把真实报告改成示例绕过检查。输出目录必须不存在或为空。失败退出码不能作为成功交付。
- `--asset-mode inline|external`：默认 `inline`，图片、样式、脚本与数据全部内联为单个 `index.html`，超过 4MiB 时给出 `W_PAGE_LARGE` 提醒但不阻断；`external` 把图片按 SHA-256 去重写入 `images/<sha>.<ext>`，HTML 以相对路径引用，且 `index.html` 必须小于 4MiB（超限 `E_PAGE_TOO_LARGE` 阻断）。非法取值按用法错误退出 2。
- `--json`：命令结果以 JSON 输出；校验问题位于 `errors[]` / `warnings[]`，包含 `code/path/message`。warning 不阻断生成，应检查并保留其边界；error 会阻断。参数用法错误通过 stderr 输出帮助。
- `--help` / `--version`：查看本地实际命令与版本。

退出码：`0` 成功；`1` 输入内容不合法或构建失败；`2` 参数用法错误或输入路径不可读。`validate` 的成功不代表用例通过，页面状态取自输入。

## 输出与打开

验收包包含：

- `index.html`：`inline` 模式下录制事件、JSON/文本/图片证据、rrweb、字体与样式全部内联；`external` 模式下图片写入 `images/`，HTML 通过相对路径引用。两种模式都可直接打开，无需 CDN、npm 或常驻服务，`external` 的 `index.html` 原始请求体积小于 4MiB。
- `images/<sha256>.<ext>`：仅 `external` 模式生成，按 SHA-256 去重并保留原始图片字节；数据中的 `evidence[].dataUri` 为显式 `./images/` 相对路径，可供受保护的独立HTML宿主识别并装配图片。
- `manifest.json`：输入、录制与生成文件的 SHA-256、统计、版本和生成时间，另含 `assetMode`、视图来源（studio）、资源列表与去重节省字节。清单不声称包含自己的哈希。
- `THIRD-PARTY-NOTICES.txt`：随包资源的第三方许可。

页面模板由小队模块自身提供，任务只提供标准 JSON 数据，不能传自定义 HTML、项目私有路径或第二个数据绑定。正式构建只使用内置 `assets/studio`；`template.html/app.css/app.js` 任一缺失时报 `E_VIEWER_ASSETS_MISSING`（stage=assets）并阻断生成，不回退旧 `assets/shell`，也不生成半成品。输出使用带 nonce 的 CSP，页面只有一个 `#acceptance-data` 数据入口；视图脚本必须是普通脚本（禁止 `import/export`），不得依赖 `window.V3_DATA`，不得包含 iframe 嵌套层、gzip 包装或外部 CDN。`E_SELF_CONTAINED/E_PRIVATE_BINDING/E_PRIVATE_PATH/E_VIEWER_SCRIPT_FORMAT/E_NESTED_FRAME/E_DATA_SCRIPT/E_PAGE_TOO_LARGE` 均会阻断生成。

提交给用户时交付本地 HTML 与完整目录（可另打 ZIP），不能只交临时 localhost 链接。浏览器需要允许本地 JavaScript。默认使用固定视口三栏：业务用例、中央证据预览、右侧连续检视器。SQL与结果表、接口请求与响应同屏呈现，不再通过资料页签分开阅读。无需录制；整页无纵向滚动，长内容在面板内部查看。左侧列表可按状态、用例目的（测新/回归/混合/审计/未分类）和页面范围（含页面 / 仅接口数据）筛选，并与搜索按 AND 组合；每个选项显示的数量是其他条件不变时的匹配数，混合记录只计一条，未分类不做推断。状态与失败数量只统计业务记录，执行审计记录不计入，避免审计执行失败被读成产品失败；切到「目的 = 执行审计」时，状态行改为查看这些记录自身的执行状态并显示「审计执行失败」等措辞，输入中的 `status` 仍保留 `failed`。用例详情保留分类理由与来源，默认导航只展示业务名称。可选录制回放还原 DOM 与操作轨迹；原页面远程图片、字体等资源若未被采集内联，会被离线策略阻断，需要保留该证据边界。

## 示例

本地预览使用 `node <CLI> acceptance serve <验收包目录> --port 63352`。serve 只把已生成的验收包作为只读静态页面提供：服务只监听 127.0.0.1，启动前校验 manifest.json 与 index.html 的内容指纹，运行中拒绝其它 Host、目录穿越和指向包外的符号链接。它不提供问答、云端接口或任何外部请求，也不读取本机登录凭据。浏览器打开输出的 URL 看到的仍是离线 HTML 本身，按 Ctrl+C 结束服务。

```sh
node <CLI> acceptance validate <skill-dir>/examples/acceptance.json --json
node <CLI> acceptance build <skill-dir>/examples/acceptance.json --out ./acceptance-example
```

默认示例不依赖录制，由 Agent 提供页面结构、操作及证据；另附 recorded-acceptance.json 用于可选 rrweb 兼容验证（本地虚构页面实际录制的34个事件）。示例包含已验证、故意失败、阻断、待执行状态。它证明展示与回放能力，不代表理赔业务验收完成。新需求的数据合同见 [data-contract.md](data-contract.md)，录制时间原点见 [recording.md](recording.md)。
