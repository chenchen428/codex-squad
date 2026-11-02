# 统一阅读视图：一步一屏，语句与真实结果同屏

> 适用版本：`integration-test-acceptance` 1.0.0-alpha.6 起。
> 目标是去掉中央的「语句 / 结果 / 材料」页签：同一个步骤只呈现一个完整视图，SQL 与真实结果表同屏，请求与响应同屏，右侧连续说明。

## 1. 固定视口与三栏版位

| 区域 | 宽度 / 高度 | 滚动 |
|---|---|---|
| 顶栏 | 48px | 不滚动 |
| 左栏（用例筛选） | 230px | 自身纵向滚动 |
| 中央（用例条 + 步骤条 + 核验台/截图） | 自适应 | 只有语句区、结果区、折叠材料各自滚动 |
| 右栏（验证说明与结论） | 340px，可收起 | 自身纵向滚动 |

`html, body` 固定 `100vh` 且 `overflow: hidden`，页面与 `main` 不产生文档级滚动条。中央核验台 `.stage-panel` 是 `position: absolute; inset: 0` 的定高容器，内部 `.console` 用 flex 列布局；下半区不会把容器撑高。

## 2. 中央核验台：语句 / 请求 + 结果 / 响应

- 页面步骤（`step.type = page` 且能解析到截图）仍铺满中央画布：滚轮缩放、拖动平移、双击复位、适应 / 原图 / 全屏都保持原行为，不渲染核验台。
- 其余步骤（`data` / `api` / `message`，以及没有截图的页面步骤）进入核验台：

```
console-split       flex 列；(--console-ratio:40%)
  console-top       语句 / 请求（flex: 0 0 var(--console-ratio)）
  console-gutter    分隔条（role="separator"，可拖动 / 可键盘）
  console-bottom    结果 / 响应（flex: 1 1 auto）
console-details     原始记录与材料（默认折叠）
```

- 分隔条：指针拖动按 `(clientY - top) / height` 折算并钳制在 20%–80%；键盘 `↑/←` 减 4%，`↓/→` 加 4%，`Home`/`End` 到边界。拖动与键盘都只改 CSS 变量与 `aria-valuenow`，**不重渲染内容**，保留两侧滚动位置；切换步骤时按同一比例恢复。
- 语句区：`verification.statement.text` 原样进入代码视图（格式化只是展示层，复制仍取原字符串）；没有留存原文时只写「未留存查询或请求原文」，不生成替代 SQL。
- 请求模板：接口步骤把 `reproduction.params` 以「参数模板」展示，并明确标注「占位符模板，不是原始执行参数」；`statement` 的方法/签名作为「调用信息」。
- 结果区：同屏渲染**实际响应**与**查询结果**；两者都有时标题为「实际响应与查询结果」，都不存在时写「该步骤没有留存查询结果」或「该步骤未关联原始材料」，不编造结果。
- 结果表：`thead th` 吸附在结果区顶部，列多时表格在 `.result-scroll` 内横向滚动，单元格不挤成竖排，横向滚动查看完整内容；单元格 `title` 提供完整值，表格不撑破中央或右栏。

## 3. 结果集只按内容识别

一个证据要被当作结果集，必须是明确的结果形态，而不是随便一段 JSON：

| 形态 | 识别为 | 说明 |
|---|---|---|
| `columns`（或 CLI 结果常用的 `columnNames`）+ `rows` 数组 | 表格 | 列名逐个来自原文，`rows` 必须是数组 |
| `row` 对象 | 单行表格 | 列 = 该对象的键，按原顺序 |
| `rows` 的二维数组 | 表格 | 按 `columns` 对齐，缺列显示「未提供」 |
| `columns` 只有一列 + 基础类型行 | 表格 | 每行一个值 |

以下**不会**被当成结果集：`rows` 不是数组（如 `{"rows": 3}`）、只有 `rows` 没有列名、比较表 / 明细清单 / 分页列表、`metadata` 之类包裹层。识别只看内容形状，不判断 C8、PRE 等业务 ID，也不读私有目录。

- 结果集只从**本步骤** `evidenceIds` 指向的证据里取；多个 before/after 各自一张表，标题取显式 `label`（如「导入校验前」「导入校验后」），没有 `label` 时用证据标题。
- 可选字段 `verification.resultSets: [{ evidenceId, label?, jsonPointer?, columnLabels? }]` 用于明确关联：`jsonPointer` 指向包裹层（例如读库 CLI 的 `/results/0`），`label` 提供语义标题。生成器校验 `evidenceId` 存在、`label` 非空、`jsonPointer` 以 `/` 开头；旧数据不填该字段时仍按上面的内容规则识别。
- 单元格原值直接切片自证据原文：数字保留 `1.000000`、`1e3`、`9007199254740993` 等原字节，`null` 显示为 `null`，字符串 `<NULL>` 按文本显示，两者可区分；缺失字段显示「未提供」，空串显示「（空串）」。

## 4. 实际响应只投影业务字段

接口 / HSF 步骤的实际响应只认证据里的 `invoke_result`、`response`、`result`（对象或数组），也支持它们嵌在根 `data` 下（指针写 `/data/invoke_result`）。`metadata`、`traceId`、请求回显、成功标志都不会进入「实际响应」字段表；原始证据仍完整保留在折叠区，可展开查看或复制原文。

## 5. 右侧连续检视流（不再有页签）

右栏是一条连续阅读路径，顺序固定：

1. 业务疑问
2. 为什么这样查（`method`）
3. 核心关注点（`focus`，含原因与实际）
4. 关键条件与设置理由（`statement.parameters`，可复制）
5. 逐项预期与实际对照（`comparison`，每项一张卡片，状态原样消费）
6. 结论
7. 结论边界（`limitations`，结构化验证时展示）
8. 步骤记录（没有 `verification` 时的回退摘要）
9. 原始记录与技术上下文（默认折叠：证据原文 + 复现入口）

首行状态保留失败、受阻、部分验证和未执行；只有全部对照通过才显示通过。没有逐项对照时沿用步骤原状态，不添加过程提示。语句原文不再复制到右栏，只在中央核验台出现一次。

## 6. 复制语义

| 复制键 | 内容 |
|---|---|
| `stage-statement` | 中央语句 / 请求原文（载荷原字符串） |
| `stage-request-template` | 参数模板原文 |
| `result-<evidenceId>` | 自动识别结果集的证据原文 |
| `result-<evidenceId>-<n>` | 显式 `resultSets` 第 n 项（n 从 0 开始） |
| `response-<evidenceId>` | 完整调用记录（包含业务响应与工具包装） |
| `ins-statement-params` / `ins-repro-params` / `ins-repro-instructions` | 右栏条件与复现参数 |
| `repro-params` / `repro-instructions` | 底部复现条 |
| `ev-content-<evidenceId>` | 证据原文 |

展示层（格式化、省略、换行）从不回写复制内容。

## 7. 构建集成与目录说明

`scripts/lib/render.mjs` 的 `resolveViewer()` 只内联四个 studio 文件——`template.html`、`app.css`、`app.js`、`code-view.js`——以及两个 vendor bundle（sql-formatter、highlight.js）与 rrweb；它**不会**扫描 `assets/studio/layout/`，且本次任务未授权修改 `render.mjs`。

因此统一视图的运行时实现全部落在既有文件里：

- `assets/studio/app.js`：结果集 / 响应识别、核验台渲染、分隔条纯函数、连续检视流、事件委托；
- `assets/studio/app.css`：`.console*` / `.result-*` / `.inspector-head` / `.ins-details` 等版位与吸附表头；
- `assets/studio/template.html`：检视器头部（`#inspector-status`）与帮助文案，移除旧页签容器；
- `scripts/lib/contract.mjs`：`verification.resultSets` 的可选字段校验。

若后续确实需要独立目录，必须先扩展 `render.mjs` 的资源解析与自包含校验，再迁移文件；否则放在 `layout/` 的文件不会进入产物。

## 8. 测试与验证

```bash
node --test assets/studio/tests/viewer.test.mjs
node --test assets/studio/tests/code-view.test.mjs
npm test
```

- `viewer.test.mjs` 里的真实标准载荷用例会按生成器相同的规则，把 `data/` 下证据文件原文注入 `content`（JSON 走 `JSON.stringify(parse(...), null, 2)`），以验证真实结果表；其余用例仍用原始载荷，避免把本地绝对路径带进断言。
- 真实数据核对结果：PRE 高金额 before 为 18 列 1 行、SQL 格式化 86 行；C8 聚合为 8 列 1 行、SQL 1461 字符、6 项对照同屏；C8 历史排除经 `/results/0` 取到 6 列表；PREIMPORT before/after 各 8 列 1 行且 `0` 不被空值替换；B7 重付请求模板与 `/data/invoke_result` 响应同屏。
- 本文件不代替浏览器验收：固定视口 1737×1117 / 1440×1000 的视觉检查、安装与发布由主 Codex 完成。

`resultSets.columnLabels` 可提供字段名到业务名称的映射；表头上方显示业务名，下方保留原字段名。映射只改变标签，列、顺序和值不变。宽表独立横滚，不截列或把编号挤成竖排。

## 固定筛选区（alpha.7）

左栏保持230px，搜索与三个筛选组固定显示，不横滚、不折叠。每组标签独占一行，按钮组按内容自动换行，零计数选项仍完整显示。筛选区不收缩，只有下方用例列表纵向滚动。依据Stitch导出：12px外边距、10px组间距、4px按钮间距、11px字体与16px行高。
