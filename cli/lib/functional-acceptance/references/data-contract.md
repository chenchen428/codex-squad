# 验收数据合同 v1

输入是一个 UTF-8 JSON 文件，通常命名为 `acceptance.json`。生成器只解释数据，不执行输入中的代码、SQL、HTTP 请求或 `.rec.js`。

## 顶层结构

```json
{
  "schemaVersion": 1,
  "report": {
    "id": "claim-acceptance-001",
    "title": "理赔新增提现户 · 用例验收",
    "environment": "项目预发",
    "revision": "提交或构建标识",
    "executedAt": "2026-10-30T08:00:00+08:00",
    "example": false
  },
  "groups": [{"id": "refund", "title": "退款流水", "requirement": "F-09"}],
  "recordings": [],
  "evidence": [{"id": "relation", "title": "单据关系读回", "type": "json", "category": "data", "file": "evidence/relation.json", "source": "本次只读查询"}],
  "cases": [{
    "id": "C2",
    "groupId": "refund",
    "title": "流水关联理赔单",
    "requirement": "F-09",
    "objective": "从流水打开对应理赔单并定位异常单",
    "status": "not_run",
    "caseRole": "new",
    "caseRoleReason": "本需求新增从退款流水进入关联理赔单的跳转，并有意改变异常单默认定位行为",
    "caseRoleSources": ["需求 F-09 变更说明", "本次变更代码评审记录"],
    "preconditions": ["测试账号拥有当前商家的只读权限"],
    "steps": [{
      "id": "open-detail",
      "type": "page",
      "title": "打开流水明细",
      "page": "退款流水",
      "action": "点击查看详情",
      "expected": "展示对应付款的明细",
      "actual": "尚未执行",
      "status": "not_run",
      "pageView": {"title": "退款流水", "buttons": ["查看详情"], "focus": "查看详情"},
      "evidenceIds": []
    }],
    "checks": [{"id": "relation-check", "title": "单据关系一致", "expected": "来源单据与付款关系一致", "actual": "尚未核对", "status": "not_run", "evidenceIds": []}]
  }]
}
```

上例不需要录制；证据文件需存在，字段示意不能原样作为真实执行结果。

## 必需字段与状态

- `schemaVersion` 固定为 `1`。
- `report.id/title/environment` 为非空字符串；`report.example` 为布尔值。`revision/executedAt` 可选，必须来自实际材料，不填写虚构执行时间。
- `report.links` 可选，最多12个 `{label,url}`，标签非空，地址为无凭据的真实HTTPS链接；显示为Header关联资料，支持需求、PRD、变更单等，不自动拼造地址或读取正文。
- `verification.response` 可显式引用原始返回：`{evidenceId:"raw-response",jsonPointer:"/results"}`，`jsonPointer` 可省略。证据必须同时属于该步骤且是JSON/文本；支持JSON对象、数组、标量及原始stdout，原始字节内容保留，不能用人工摘要冒充响应。嵌套查询结果表格用 `verification.resultSets` 指向各组 `columnNames/rows`。
- `groups` 至少一项，每组有唯一 `id` 和 `title`，可附 `requirement`。
- `cases` 至少一项；用例 `id` 唯一，`groupId` 必须存在。`title/objective/status/steps/checks` 必需，`preconditions` 为可选字符串数组。
- `caseRole` 可选，取值 `new/regression/mixed/audit/unknown`；省略即 `unknown`（未分类），页面显示未分类且不做推断。`new/regression/mixed/audit` 必须同时提供非空 `caseRoleReason` 与非空 `caseRoleSources` 字符串数组。
- 状态为 `passed`（已验证）、`failed`（失败）、`blocked`（阻断）、`not_run`（待执行）、`partial`（部分验证）。步骤和核对项分别声明状态。
- `steps` 至少一项，`id/type/title/action/expected/actual/status` 必需。`type` 为 `page/api/data/message`。`page` 对页面步骤填写页面名称。
- `checks` 可以为空；若用例声明 `passed`，至少有一个 `passed` 核对项，且不得包含失败、阻断、待执行或部分验证的步骤/核对项。通过的核对项应有真实证据来源；未引用时给出提醒，不因缺少录制否决已经存在的执行结果。
- `actual` 必须来自本次观察，不能用复制预期代替取证；相等性断言允许预期与实际值相同，但要有对应证据来源。阻断/待执行时写原因或尚未执行的事实，不填成功值。

## 用例目的分类（可选，测新 / 回归）

`caseRole` 与执行状态相互独立：分类只说明用例覆盖的是新增行为还是存量行为，不改变 `status/actual/checks`，也不能由状态、版本、ID 或旧数据推断。

| 取值 | 含义 |
| --- | --- |
| `new` | 测新：本需求新增或有意改变的行为 |
| `regression` | 回归：保护存量行为不被本次变更破坏 |
| `mixed` | 同一条记录同时覆盖新增与存量两类，只按一条记录计数，不拆分重复计 |
| `audit` | 执行审计：对执行过程/证据的审计记录，不得当作产品失败，也不计入业务数 |
| `unknown` | 未分类；`caseRole` 省略时视同此值，允许不填依据 |

- `new/regression/mixed/audit` 必须提供 `caseRoleReason`（为何归入该类）与 `caseRoleSources`（非空字符串数组，文本来源，如需求编号、变更说明、评审记录）。来源仅作说明，CLI 不读取、不执行、不按来源内容自动归类。
- 校验规则：非法枚举值报 `E_CASE_ROLE`；缺少或空白的 `caseRoleReason` 报 `E_CASE_ROLE_REASON_REQUIRED`；缺少或含空字符串的 `caseRoleSources` 报 `E_CASE_ROLE_SOURCES_REQUIRED`；字段类型错误分别报 `E_CASE_ROLE_REASON/E_CASE_ROLE_SOURCES`。
- 统计口径：每条记录只有一个 `caseRole`，`mixed` 不重复计入 `new` 与 `regression`；`audit` 单独成组，不与产品失败或业务数量合并。
- 查看器口径：状态筛选与失败数量只统计业务记录，`audit` 记录不计入，避免把审计执行失败当成产品缺陷；切到「目的 = 执行审计」时按这些记录自身的 `status` 显示「审计执行失败」等措辞，输入中的 `status` 仍为 `failed`，不被改写。分类依据在用例头以可点开的紧凑标签展示，展开后可读理由与来源。

## 语义标题（displayTitle，可选）

`groups[]`、`cases[]`、`steps[]` 可提供 `displayTitle`，作为左侧导航、步骤标题与详情标题面向业务的短名称。`id` 仍保留用于关联、搜索与详情展示，不得用 `id` 猜测业务名称；省略 `displayTitle` 时回退到 `title`，不改变原字段含义。

- `displayTitle` 必须是非空字符串，类型错误分别报 `E_GROUP_DISPLAY_TITLE/E_CASE_DISPLAY_TITLE/E_STEP_DISPLAY_TITLE`。
- 语义标题只影响展示，不改变 `status/actual/checks/caseRole`，也不替换 `id`。
- 旧数据没有 `displayTitle` 时照常展示 `title`，不需要补写。

## 页面表达（默认，无需录制）

页面步骤可提供 `pageView`，CLI 按输入构建场景并随流程播放。字段全部按文本渲染，不执行HTML。示例：

```json
{
  "durationMs": 4000,
  "pageView": {
    "title": "退款流水",
    "breadcrumb": "退款管理 / 流水查询",
    "subtitle": "从对应流水进入理赔单",
    "fields": [{"label": "来源单号", "value": "DEMO-001"}],
    "table": {"columns": ["单号", "金额", "操作"], "rows": [["DEMO-001", "CNY 1.00", "查看详情"]]},
    "buttons": ["重置", "查询"],
    "focus": "查看详情"
  }
}
```

`title/subtitle/breadcrumb/url/focus/caption` 均为可选字符串；`fields` 为 `{label,value}` 字符串对象数组；`table` 的 `columns` 为字符串数组，`rows` 为等列数二维字符串数组；`buttons` 为字符串数组。可加 `dialog: {title, fields, buttons}` 表达弹窗。`focus` 与按钮或表格单元格文本相同时突出显示操作目标。`caption` 是该页面的业务名称，填写时必须非空（`E_PAGE_VIEW_CAPTION`）。

已有截图可用 `pageView.imageEvidenceId` 引用顶层 `type: image` 证据，并在步骤 `evidenceIds` 中一并关联。无需截图时直接提供上述结构。省略 `pageView` 时按页面名称、操作和实际结果生成简洁状态卡。

截图的产生方式、补拍说明、本地只读提示等属于证据来源信息，只放在证据详情（`title/source` 或证据扩展字段）中，不进入主视图，也不删除原始来源事实。证据对象上的扩展字段（如截图 `kind`）会原样保留并可在详情中查看。

`durationMs` 是表达时长，默认4000，范围500–60000毫秒，不是实测耗时。一个无录制用例的页面、接口、数据、消息步骤在同一时间线上播放；`recordings` 可以省略或为空。页面构建素材与执行证据是两类事实，构建页面不改变输入状态。

## 核对过程（verification，可选）

`steps[].verification` 用业务问题、取证方式与比较结论组织核对叙述，视图先讲核对过程再展示原始数据。字段全部可选，填写时类型和引用必须合法：

```json
{
  "question": "这笔退款是否已生成对应理赔单",
  "method": "按来源单号只读查询理赔单表并比对关系",
  "focus": [{"label": "来源单号", "reason": "决定关联是否正确", "actual": "DEMO-001", "evidenceIds": ["relation"]}],
  "statement": {
    "kind": "sql",
    "text": "SELECT order_id, claim_id FROM claim_order WHERE source_no = :sourceNo",
    "origin": "reconstructed",
    "explanation": "原始 SQL 未留存，本文按表结构还原，仅用于说明查询范围",
    "parameters": [{"name": "sourceNo", "value": "DEMO-001", "reason": "本次核对的来源单号"}]
  },
  "comparison": [{"label": "理赔单号", "expected": "存在且等于 C-001", "actual": "C-001", "status": "passed", "evidenceIds": ["relation"]}],
  "conclusion": "来源单号与理赔单一一对应，且金额一致",
  "limitations": ["仅覆盖当前商家的一条来源单"]
}
```

- `question/method/conclusion` 为非空字符串；`limitations` 为非空字符串数组（`E_VERIFICATION_FIELD/E_VERIFICATION_LIMITATIONS`）。
- `focus[]` 每项为 `{label,reason,actual,evidenceIds}`，前三项为非空字符串；`evidenceIds` 引用顶层证据，不得悬空（`E_VERIFICATION_FOCUS/FOCUS_FIELD/FOCUS_EVIDENCE_UNKNOWN`）。
- `statement.kind` 为 `sql/http/hsf/message/tool`；`origin` 为 `executed/reconstructed/unavailable`（`E_VERIFICATION_STATEMENT_KIND/ORIGIN`）。
  - `executed`：`text` 必须是本次实际执行原文，不能为空。
  - `reconstructed`：`explanation` 必填并说明还原方式（含「还原/重构/重建/整理」等），不得把还原内容标成「执行原文/实际执行记录」；否则报 `E_VERIFICATION_STATEMENT_RECONSTRUCTED`。
  - `unavailable`：`text` 必须留空，`explanation` 必填并明确原文未留存（含「未留存/未保留/未记录/未获取/不可得」等）；否则报 `E_VERIFICATION_STATEMENT_UNAVAILABLE`。
  - `parameters[]` 为 `{name,value,reason}` 非空字符串对象数组（`E_VERIFICATION_STATEMENT_PARAMETERS`）。
- `comparison[]` 每项为 `{label,expected,actual,status,evidenceIds}`；`status` 必须由 Agent 按实际观察给出（`passed/failed/blocked/not_run/partial`），生成器与视图不得根据 `expected === actual` 推断或改写（`E_VERIFICATION_COMPARISON_STATUS`）。证据引用不得悬空（`E_VERIFICATION_COMPARISON_EVIDENCE_UNKNOWN`）。
- `statement.text`、参数等只按纯文本渲染与复制，不执行 HTML/SQL/HTTP。

## 复现入口（reproduction，可选）

每个步骤可提供 `reproduction`，入口与该步骤同处展示（执行时序步骤区内联一行提示 + 当前步骤的按钮与参数），不另设底部独立「自己复现」面板；切换用例或步骤时按钮、说明、参数与来源同步更新，筛到空集时一并清空。

```json
{
  "kind": "db",
  "label": "只读查询控制台",
  "url": "https://console.example.test/db",
  "urlStatus": "verified",
  "reason": "本次在该只读控制台执行核对，地址来自实际会话",
  "params": "SELECT order_id, claim_id FROM claim_order WHERE source_no = :sourceNo",
  "instructions": "打开控制台，按参数查询后比对来源单号与理赔单号",
  "constraints": ["只读查询，不执行写操作", "不重放历史请求"],
  "sourceIds": ["relation"]
}
```

- `kind` 为 `page/lantu/hsf/db/mq/trace/api/ci/data`；`label` 为非空字符串（`E_REPRODUCTION_KIND/LABEL`）。
- `urlStatus` 为 `verified/unavailable`（`E_REPRODUCTION_URL_STATUS`）：
  - `verified`：`url` 必须是合法 `https://` 地址，且不含占位符或模板片段（`{}`、`<>`、`${`、`...`、`your_` 等）与示例域名；`reason` 必填说明核验来源。错误码 `E_REPRODUCTION_URL/E_REPRODUCTION_URL_INVALID/URL_HTTPS/URL_PLACEHOLDER/E_REPRODUCTION_REASON`。
  - `unavailable`：`url` 必须为 `null`，`reason` 必填说明不可用原因；界面按钮真禁用，不用平台首页、元数据地址或含占位符的模板地址冒充（`E_REPRODUCTION_URL_UNAVAILABLE/E_REPRODUCTION_REASON`）。
- `params` 为可复制请求/模板文本，不是响应；只复制与展示，不执行（`E_REPRODUCTION_PARAMS`）。
- `instructions` 为非空字符串（`E_REPRODUCTION_INSTRUCTIONS`）；`constraints` 为非空字符串数组，写明写操作、重放、历史只读等限制（`E_REPRODUCTION_CONSTRAINTS`）。
- `sourceIds` 引用顶层 `evidence[].id`，不得悬空（`E_REPRODUCTION_SOURCE_UNKNOWN`）。
- 复制内容跟随步骤类型：页面步骤复制操作说明（操作/预期/实际/入口状态），工具、接口、数据库、消息步骤复制参数模板；复制提示必须与实际复制内容一致。
- 报告只打开入口或复制模板，不执行写操作、不重放请求。入口缺失或未核验时明确写未知，不据此推断步骤已执行。

版面约束：步骤序号横向单行滚动（步数再多也不换行成多排），复现条默认只占一行、明细收进同一折叠区；用例头压缩为一行，长版本与来源等次要信息不抢首屏。截图区占主体剩余高度，工具栏与截图下方校验信息仍可见、可滚动。

## 旧数据兼容

没有 `displayTitle/verification/reproduction/caption` 的旧数据照常通过校验与生成：视图按 `action/expected/actual` 展示步骤三步逻辑，并明确提示未提供核对过程或查询原文，不推断执行过查询，也不把已收集的元数据拍平成表格主结果。旧数据的 `status/actual/checks/caseRole` 原样保留；缺少 `verification` 的步骤在适配层仅标记为 `legacy` 用于提示，不改写状态。

## 页面录制（可选）

`recordings[]` 的 `id` 唯一，`file` 指向数据目录内的文件。支持：

- `format: "rrweb"`：JSON 为 rrweb 事件数组，或带 `events` 数组的对象。
- `format: "chromepilot"`：ChromePilot 导出的 JSON（包含 `events`，可带 `session/pages/net/console`）；或官方导出包中的 `sessions/*.rec.js`。`.rec.js` 只接受固定的 `window.__CP_EXPORT__` JSON 包装，采用严格 JSON 解析，不执行 JavaScript。

事件应包含有效的 full snapshot（`type: 2`），至少两个有效事件，时间戳按非递减顺序排列。`atMs` 是相对首个事件时间戳的毫秒偏移，必须处于录制时长内；可选 `endMs` 不小于 `atMs`，并位于同一录制范围。

录制是可选增强，页面 `passed` 不以录制为前提。使用录制时提供有效 `recordingId` 和相对首事件的 `atMs`。同一用例包含有效录制时，相关页面步骤进入录制回放；其他步骤展示状态与证据。完全无录制的用例使用默认流程播放器。

原网页样式、字体和图片需在采集时尽量内联；验收包离线运行，不通过网络重取录制中引用的外部资源。缺少样式或图片时明确展示资源缺口，不用新截图替换历史画面。

## 核对项与证据

核对项有唯一 `id`（用例内）、`title/expected/actual/status`；可选 `stepId` 关联本用例步骤。`evidenceIds` 引用顶层 `evidence[].id`，不得悬空。

证据有 `id/title/type`；`type` 为 `json/text/image`。`category` 可选 `api/data/log/source`，用于证据分栏：api 为接口返回，log 为执行日志，data 为查询/页面观察值，source 为来源与范围材料；`source` 说明来源。证据可以使用 `file`，或使用 `value` 内联 JSON/文本，两者不能同时填写。图片必须用 `file`，只支持 PNG/JPEG/WebP。文本/JSON 文件无需固定扩展名，单个证据上限16MiB、图片32MiB、录制256MiB；输入JSON上限64MiB。未被步骤或核对项引用的材料会提醒 `W_UNUSED_EVIDENCE`，如属当前用例范围材料可关联对应步骤。

传入 HTML、SQL 或日志均按文本显示，不能成为可执行脚本。原始结果与脱敏节选要在 `source/title` 中区分。页面回放与证据是验收依据的不同部分，不能把一段视频的存在当作所有断言都通过。

## 用例设计依据（caseDesign，可选）

每个用例可带 `caseDesign`，回答「为什么要测此用例、覆盖什么风险」，不是操作步骤或查询方式的复述：

```json
{
  "why": "缺少该用例时，提现户确认后的快照写入错误无法被发现。",
  "sources": [
    {
      "kind": "requirement",
      "label": "PRD F02 · 确认赔付选择提现户",
      "quote": "选择\"提现户\"时（本次新增）",
      "url": "https://docs.example.com/...?singleDoc#"
    },
    {
      "kind": "rule",
      "label": "退款账户设置.spec.json#config-claim",
      "ref": "requirements/settings.md#scene-scope",
      "quote": "理赔打款可单独维护账户"
    }
  ]
}
```

- `why` 必填，逐用例单独撰写；测新说明缺少该用例会漏掉的需求风险，回归说明哪条既有规则/影响路径/历史问题会被破坏，审计说明执行约束。
- `sources` 至少一项，`kind` 取 `requirement`（需求原话/文档）、`rule`（既有规则）、`impact`（影响路径）、`history`（历史问题）、`confirmation`（确认结论）、`evidence`（原核对/证据）、`design`（设计稿）。
- 每项 `label` 必填，且至少保留 `quote`（原话）、`ref`（本地/文档出处）或 `url`（已核验 https 链接）之一；链接含占位符或非 https 报错。
- 页面在右侧检视器固定展示「为什么测此用例」与参考来源；有链接显示可跳转入口，无链接显示原话与出处。所有用例的 `caseDesign` 不得复用同一段模板文字。

## 数据关注点与设计对照（可选）

`verification.focus[]` 在原字段外可增加：

```json
{
  "label": "付款状态",
  "reason": "确认资金拒绝后不能仍显示成功",
  "expected": "FAIL",
  "actual": "FAIL",
  "evidenceIds": ["b1-facts"],
  "cellRefs": [{ "resultSet": 0, "row": 0, "column": "payment_status" }]
}
```

- `expected` 与逐项 `comparison` 一样由 Agent 提供，生成器不推断通过状态。
- `cellRefs` 指向同一步 `verification.resultSets` 的下标（`resultSet`）、数据行（`row`，0 起）和字段名（`column`）；越界或字段不存在时结果表不高亮，校验报错。
- 结果表对命中的单元格显式高亮，hover 与键盘 focus 均显示关注原因、预期、实际、依据与证据引用；高亮只表示「这里需要核对」，不表示通过。
- 单元值仍取证据原文片段，`9007199254740993`、`1.000000`、重复键、`null` 与 `"<NULL>"` 保持原样。

## 设计对照（verification.ued，可选）

涉及前端改造的步骤可关联真实设计截图：

```json
{
  "ued": {
    "evidenceId": "ued-withdrawal",
    "title": "退款提现户设计稿",
    "caption": "账户选择与继承关系",
    "sourceUrl": "https://example.com/design/...",
    "note": "真实 UED 缓存；缺失区域以证据标题说明"
  }
}
```

`evidenceId` 必须指向 `type: "image"` 的证据；图片必须先复制进数据目录（保留原字节并在 `source` 记 sha256），不得引用业务仓或外部 URL 充当图片。`sourceUrl` 可跳转设计原稿，必须是已核验 https 地址。右侧显示可点击缩略图，点击进入统一灯箱。

## 截图标注（evidence.annotations，可选）

`type: "image"` 的证据可带 `annotations`，坐标使用**原图像素**，随灯箱缩放平移自动对齐：

```json
{
  "annotations": [
    {
      "number": 1,
      "label": "理赔打款改为单独设置",
      "note": "与全局默认不一致，需核对快照",
      "tone": "focus",
      "x": 624, "y": 447, "w": 601, "h": 77
    }
  ]
}
```

- `label` 必填；`number` 为正整数序号（缺省按数组顺序）；`tone` 取 `focus/context/risk`。
- `x/y` 为非负数值，`w/h` 为大于 0 的数值，单位是原图像素；标注只覆盖真实区域，不重绘或替换原图像节。
- 图片在中央截图、右侧验证说明、设计对照、原始记录与技术上下文中都可点击进入统一灯箱：滚轮/按钮缩放、拖动平移、`+/-/0/1` 键盘操作、`Esc` 关闭、隐藏标注、焦点回到触发控件；缩放后标注仍按原图坐标对齐。
- 原图文件与 `source` 中记录的 SHA-256 不变；标注是独立覆盖层。

## 复现预填（reproduction.prefill，可选）

在已核验复现入口基础上，可带入当前步骤的具体参数：

```json
{
  "prefill": {
    "url": "https://tools.company.test/console#/tool/sample/read-record?appName=sample-app&projectEnv=sample-pre",
    "parameters": [
      { "name": "recordId", "value": "10001" },
      { "name": "ownerId", "value": "100001" }
    ],
    "environment": "项目预发环境",
    "note": "打开仅预填，需在页面主动执行"
  }
}
```

- `url` 必须按平台真实路由合同生成并已核验：https、无 `{}`/`${}`/`example.com` 等占位片段；带 `params` 的地址必须能被入口页解析为 JSON 对象。
- `parameters` 至少一项，如实列出带入的参数名与值，不能包含未带入的占位参数。
- 页面对预填入口显示「已带入 N 个参数 · 环境」与「打开仅预填，需主动执行」；点击只打开页面，不自动执行查询或业务写操作。带写操作或不可重放的步骤不得提供预填入口。

## 文件与生成

所有输入资产必须位于 `acceptance.json` 所在目录或其子目录。拒绝绝对路径、目录穿越和通过符号链接逃逸该目录。需要复用项目其他位置的素材时，先复制脱敏后的文件进入数据目录。

## 资源模式与输出（inline / external）

`build --asset-mode inline`（默认）把样式、脚本、rrweb 运行时、输入数据和图片全部内联进单个 `index.html`，可离线直接打开。图片较多时可用 `--asset-mode external`：真实图片按 SHA-256 去重写入 `images/<sha256>.<ext>` 并保留原始字节，`index.html` 以相对路径引用；数据中对应 `evidence[].dataUri` 为相对路径，并带 `assetMode: "external"`。

- 外置模式的 `index.html` 仍是业务 HTML 本体，不再套第二层 iframe，也不做 gzip 包装；相对路径适合受保护的独立入口。
- 外置模式 `index.html` 的原始请求体积必须小于 4MiB，超限报 `E_PAGE_TOO_LARGE` 并阻断生成；不得靠删除其他文本压缩体积，证据原文可在详情中折叠。
- 两种模式都只有一个 `#acceptance-data` 标准 JSON 数据入口；视图只能读取该数据，不得依赖 `window.V3_DATA` 或项目私有路径（`E_PRIVATE_BINDING/E_PRIVATE_PATH`）。
- `manifest.json` 记录 `assetMode`、视图来源、资源列表（sha/mime/bytes/路径/是否内联/关联证据）、去重节省字节与页面体积。

视图模板由小队模块自身提供（仅 `assets/studio`；模板、样式或脚本缺失时报 `E_VIEWER_ASSETS_MISSING` 并阻断生成，不回退旧 shell），任务数据不能携带自定义 HTML、项目私有路径或第二个数据绑定。输出目录必须不存在或为空，CLI 不覆盖已有验收包；成功生成的 `index.html` 可直接离线打开，`manifest.json` 记录生成器版本、输入与资产指纹。构造失败不能留下貌似完整的成功页面。
