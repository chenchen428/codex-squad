# 代码阅读：SQL/JSON 格式化与浅色语法高亮

> 适用版本：`integration-test-acceptance` 1.0.0-alpha.5 起。
> 目标是让验收报告里的查询原文与证据内容真正可读，而不是把一长串单行 SQL 直接塞进 `<pre>`。

## 1. 行为边界

| 事项 | 约定 |
|---|---|
| 展示 | 默认展示格式化结果；SQL/JSON 有可信格式化结果时提供“查看原文”切换 |
| 原文 | 原文只用于展示与复制，**从不被格式化结果覆盖** |
| 复制 | 复制键仍指向载荷里的原字符串，与原文逐字节相等 |
| 失败 | 格式化失败、文本疑似截断、语言无格式化器时保留原文，并在角标写明原因 |
| 安全 | 输入一律当纯文本；不执行、不 `eval`、不 `new Function`、不拼可执行代码 |
| 主题 | 只在既有浅色底上增加 token 颜色，不引入暗色主题 |

格式化不写回数据：`verification.statement.text`、证据 `content`、`status` 都保持载荷原值，报告生成物里的标准 JSON 不因本次改动发生变化。

## 2. 语言识别与映射

调用方明确标注的 `kind` 优先，其余按内容识别：

| 来源 | 提示 | 结果 |
|---|---|---|
| `statement.kind = sql` / 复现 `kind = db` | `sql` | 格式化 + SQL 高亮（mysql 方言） |
| `statement.kind = hsf` | `java` | Java 词法；零命中时按 HSF 方法签名结构化标注 |
| `statement.kind = http` | `http` | HTTP 词法；零命中时按请求行结构化标注 |
| 证据 `type = json` | `json` | 词法级换行缩进 + JSON 高亮（数值与重复键保持原字节） |
| `tool` / `message` / 复现参数 / 其他 | 无 | 内容识别：JSON → SQL → HTTP → 纯文本 |

内容识别规则（只决定“当什么语言看”，不改写内容）：

- JSON：文本以 `{` 或 `[` 开头且能被 `JSON.parse` 解析为对象/数组（`JSON.parse` 只用于判定合法性）；
- SQL：跳过行首空白、`--`/`#` 行注释与 `/* */` 块注释后，首个词是 `SELECT/WITH/INSERT/REPLACE/UPDATE/DELETE/CREATE/ALTER/DROP/TRUNCATE/SHOW/DESC/DESCRIBE/EXPLAIN/USE/SET/CALL/GRANT/REVOKE/BEGIN/START/ANALYZE/OPTIMIZE`；
- HTTP：`METHOD /path` 或 `HTTP/1.x` 开头；
- 其余为纯文本，只做转义，不做任何着色。

识别不依赖业务 ID、表名或项目路径，换一份报告同样生效。

## 3. 回退与原因角标

| `data-code-fallback` | 角标文案 | 触发条件 |
|---|---|---|
| `no-formatter` | 原文 | 该语言没有格式化器（HTTP/HSF/纯文本） |
| `sql-truncated` | 原文（文本疑似不完整） | 引号或块注释未闭合，交给格式化器会被拆成假 token |
| `sql-parse` | 原文（格式化未生效） | 格式化器抛错 |
| `json-invalid` | 原文（不是合法 JSON） | 标注为 JSON 但解析失败，此时也不按 JSON 着色 |
| `json-lex` | 原文（无法安全排版） | JSON 合法但词法重排不可用（防御性出口，正常不会触发） |
| `identical` | 原文（已是标准排版） | 格式化结果与原文一致（例如已美化的 JSON） |

`sql-truncated` 这道判断是必要的：`SELECT 1 /* 未闭合` 直接交给 `sql-formatter` 会被改写成 `SELECT 1 / * 未闭合`，等于凭空产出一条不存在的 SQL。宁可显示“疑似不完整”，也不能展示伪造内容。

### JSON 排版只动空白

JSON 不使用 `JSON.stringify(JSON.parse(text))` 重建：`JSON.parse` 会把 `9007199254740993` 舍入成 `9007199254740992`、把 `1.000000` 规范成 `1`、让重复键只剩最后一个——那是把证据里的金额/编号改掉，即使“复制原文”仍正确，展示也已误导。

现在的做法分两步：

1. `JSON.parse` 只做合法性判断，失败即 `json-invalid`；
2. 用词法扫描把文本切成字符串/数字/字面量/标点 token，每个 token 都是原文切片，然后**只在 token 之间**插入换行与两空格缩进。

因此大整数、尾零、`1e3`、`-0`、重复键、`\u` 转义、emoji 以及字符串内的任何字节都不变；判据是“去掉字符串外空白后与原文完全一致”。

## 4. 渲染与交互

同一套渲染器 `assets/studio/code-view.js`（浏览器全局 `window.AcceptanceCodeView`）供三处复用：

1. 中央材料页签 / 右侧检视器的语句区（`statementBlockHtml`）；
2. 检视器里的复现参数模板（`reproductionHtml`）；
3. 展开的证据内容（`renderEvidenceItems`，仍包在 `<details>` 里）。

DOM 契约：

```html
<div class="code-view" data-code-view="1" data-code-lang="sql">
  <div class="code-tools">
    <span class="code-chip">SQL · 已格式化</span>
    <span class="code-actions">
      <button data-code-toggle aria-pressed="false"><span data-code-toggle-label>查看原文</span></button>
      <button data-copy-key="…">复制原文</button>
    </span>
  </div>
  <pre class="pre code-block" data-code-mode="formatted"><code class="code-lang-sql">…</code></pre>
  <pre class="pre code-block" data-code-mode="original" hidden><code class="code-lang-sql">…</code></pre>
</div>
```

切换只翻转两个已渲染块的 `hidden`，不重新格式化、不重新登记复制键，因此复制内容与原文永远一致。

## 5. 离线与 CSP

构建时（`scripts/lib/render.mjs`）按固定顺序内联，五段脚本共用同一个 nonce：

```
sql-formatter → highlight.js → code-view.js → app.js（+ 录制回放的 rrweb）
```

- 无 CDN、无远程字体、无 `<link>`、无 `@import`；
- `#acceptance-data` 仍唯一；
- 无 `eval` / `new Function`；
- 页面体积：当前真实报告外置资源模式约 1.19 MiB，仍小于 4 MiB 上限（内联模式受截图体积影响会更大，走 `--asset-mode external`）。

## 6. Vendor 来源

| 包 | 版本 | 许可 | 用途 | SHA-256 |
|---|---|---|---|---|
| `sql-formatter` | 15.9.0 | MIT | SQL 格式化（仅 mysql 方言，tree-shake） | `253602ebbc10663d414dd61e00c52bb0339513f32542362d99e3153e84fc399d` |
| `highlight.js` | 11.12.0 | BSD-3-Clause | 语法高亮（sql/json/http/java） | `df1ffdd8cbd7b11247986419d8999ff3e3ee3660db916bcca6b1c2aa676cb9e1` |

许可全文见 `assets/vendor/code-view/LICENSE-sql-formatter.txt`、`LICENSE-highlightjs.txt`，构建时会写入 `THIRD-PARTY-NOTICES.txt`；版本、许可与 SHA 同时记录在 `assets/vendor/code-view/SOURCE.json` 与产物 `manifest.json` 的 `assets.codeView`。

### 重新构建 bundle

```bash
mkdir -p /tmp/cv-build && cd /tmp/cv-build
npm init -y
npm i --no-audit --no-fund sql-formatter@15.9.0 highlight.js@11.12.0 esbuild@0.25.10
# entry-sql.mjs：import { formatDialect, mysql } from 'sql-formatter'; 暴露 globalThis.sqlFormatter
# entry-hljs.mjs：highlight.js/lib/core 注册 sql/json/http/java；暴露 globalThis.hljs
npx esbuild entry-sql.mjs  --bundle --format=iife --minify --target=es2017 --legal-comments=none --outfile=dist/sql-formatter.mysql.min.js
npx esbuild entry-hljs.mjs --bundle --format=iife --minify --target=es2017 --legal-comments=none --outfile=dist/highlight-sql-json-http-java.min.js
```

产物落到 `assets/vendor/code-view/` 后，同步更新 `SOURCE.json` 的版本/SHA、`scripts/lib/build.mjs` 的许可段落与 manifest 版本号。技能运行时不需要 `npm install`。

## 7. 测试

```bash
npm test   # scripts/tests/*.test.mjs + assets/studio/tests/*.test.mjs
```

代码阅读的行为测试在 `assets/studio/tests/code-view.test.mjs`，覆盖：复杂 SQL（嵌套 `CASE`、子查询、引号、注释、Unicode）、非法/截断 SQL 回退、JSON 换行缩进与键值高亮、JSON 只改空白（`9007199254740993`、`1.000000`、`1e3`、`-0`、重复键、`\u` 转义、emoji、嵌套数组）、含 HTML 的注入尝试、原文/格式化切换、复制逐字节相等、三处复用同一渲染器，以及当前真实报告的 12 条 SQL。构建侧另有 `scripts/tests/studio-contract.test.mjs` 校验 nonce 内联顺序、唯一数据入口、许可与页面体积。
