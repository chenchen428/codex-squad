/* 代码阅读：SQL/JSON 格式化 + 浅色语法高亮
 *
 * 只做“把已留存的原文排得更好读”，不执行、不改写原文语义：
 * - 原文永远是唯一事实：复制键仍指向 app.js 登记的原字符串，格式化结果只用于展示；
 * - SQL 走 vendor 里的 sql-formatter（仅 mysql 方言），JSON 走词法级重排：JSON.parse 只判断
 *   是否合法，排版不经过 parse 结果，因此大整数、1.000000、1e3、-0、重复键都保持原字节；
 * - 格式化失败、文本疑似被截断、或语言没有可用格式化器时保留原文并标注原因；
 * - 高亮走 vendor 里的 highlight.js（sql/json/http/java），库缺失或异常时退回纯文本转义；
 * - 所有输入按纯文本处理，不 eval、不 new Function、不拼接可执行代码。
 *
 * 支持 CommonJS 出口，便于 Node 侧对渲染结果做行为测试；浏览器侧只挂 window.AcceptanceCodeView。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AcceptanceCodeView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var LANG_LABEL = { sql: 'SQL', json: 'JSON', http: 'HTTP', java: 'HSF 签名', text: '纯文本' };

  /* 只映射“调用方明确知道”的语言；其余（工具说明、消息体、接口请求体、数据参数）
   * 交给内容识别，避免把参数或说明当成 SQL 排版。 */
  var HINT_LANG = {
    sql: 'sql', mysql: 'sql', db: 'sql', dms: 'sql',
    json: 'json',
    http: 'http',
    hsf: 'java', java: 'java',
  };

  var FALLBACK_LABEL = {
    'no-formatter': '原文',
    'json-invalid': '原文（不是合法 JSON）',
    'sql-parse': '原文（格式化未生效）',
    'sql-truncated': '原文（文本疑似不完整）',
    'json-lex': '原文（无法安全排版）',
    identical: '原文（已是标准排版）',
  };

  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }

  function escapeHtml(text) {
    return str(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hintOf(hint) {
    var key = str(hint).toLowerCase().trim();
    return HINT_LANG[key] || '';
  }

  function looksJson(text) {
    var t = str(text).trim();
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return false;
    try {
      var parsed = JSON.parse(t);
      return parsed !== null && typeof parsed === 'object';
    } catch (e) {
      return false;
    }
  }

  /* 去掉行首注释与空白后看首个关键字；这一步只用于“是否当 SQL 看”，不改写 SQL。 */
  function leadingWord(text) {
    var t = str(text);
    var i = 0;
    for (;;) {
      while (i < t.length && /\s/.test(t.charAt(i))) i += 1;
      if (t.charAt(i) === '-' && t.charAt(i + 1) === '-') {
        var nl = t.indexOf('\n', i);
        if (nl < 0) return '';
        i = nl + 1;
        continue;
      }
      if (t.charAt(i) === '#') {
        var nl2 = t.indexOf('\n', i);
        if (nl2 < 0) return '';
        i = nl2 + 1;
        continue;
      }
      if (t.charAt(i) === '/' && t.charAt(i + 1) === '*') {
        var end = t.indexOf('*/', i + 2);
        if (end < 0) return '';
        i = end + 2;
        continue;
      }
      if (t.charAt(i) === '(') { i += 1; continue; }
      break;
    }
    var match = /^[A-Za-z]+/.exec(t.slice(i));
    return match ? match[0].toUpperCase() : '';
  }

  var SQL_KEYWORDS = {
    SELECT: 1, WITH: 1, INSERT: 1, REPLACE: 1, UPDATE: 1, DELETE: 1, CREATE: 1, ALTER: 1,
    DROP: 1, TRUNCATE: 1, SHOW: 1, DESC: 1, DESCRIBE: 1, EXPLAIN: 1, USE: 1, SET: 1,
    CALL: 1, GRANT: 1, REVOKE: 1, BEGIN: 1, START: 1, ANALYZE: 1, OPTIMIZE: 1,
  };

  function looksSql(text) {
    var word = leadingWord(text);
    return !!word && SQL_KEYWORDS[word] === 1;
  }

  function looksHttp(text) {
    var t = str(text).trim();
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/.test(t) || /^HTTP\/\d(?:\.\d)?/.test(t);
  }

  function detectLanguage(text, hint) {
    var forced = hintOf(hint);
    if (forced) return forced;
    var t = str(text);
    if (!t.trim()) return 'text';
    if (looksJson(t)) return 'json';
    if (looksSql(t)) return 'sql';
    if (looksHttp(t)) return 'http';
    return 'text';
  }

  /**
   * 引号/块注释是否闭合。只判断“能不能安全地交给格式化器”，
   * 因为截断的 SQL 会被格式化器当成两个 token 拆开（例如未闭合注释变成 "/ *"），
   * 那等于生成了一条伪造的 SQL。这里遇到不完整文本一律保留原文。
   */
  function isCompleteSql(text) {
    var t = str(text);
    var i = 0;
    var quote = '';
    while (i < t.length) {
      var ch = t.charAt(i);
      if (quote) {
        if (ch === '\\' && quote !== '`') { i += 2; continue; }
        if (ch === quote) {
          if (quote !== '`' && t.charAt(i + 1) === quote) { i += 2; continue; }
          quote = '';
        }
        i += 1;
        continue;
      }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; i += 1; continue; }
      if (ch === '#' || (ch === '-' && t.charAt(i + 1) === '-')) {
        var nl = t.indexOf('\n', i);
        if (nl < 0) return true;
        i = nl + 1;
        continue;
      }
      if (ch === '/' && t.charAt(i + 1) === '*') {
        var end = t.indexOf('*/', i + 2);
        if (end < 0) return false;
        i = end + 2;
        continue;
      }
      i += 1;
    }
    return quote === '';
  }

  function isJsonWs(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'; }

  function isDigit(ch) { return ch >= '0' && ch <= '9'; }

  /* 词法扫描：每个 token 都是原文切片，字符串/数字一个字都不改，重复键各自成 token。
   * 返回 null 表示文本不符合 JSON 词法（此时也不会排版）。 */
  function lexJson(text) {
    var t = str(text);
    var n = t.length;
    var tokens = [];
    var i = 0;
    while (i < n) {
      var ch = t.charAt(i);
      if (isJsonWs(ch)) { i += 1; continue; }
      if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
        tokens.push({ type: 'punct', raw: ch });
        i += 1;
        continue;
      }
      if (ch === '"') {
        var start = i;
        i += 1;
        var closed = false;
        while (i < n) {
          var c = t.charAt(i);
          if (c === '\\') { i += 2; continue; }
          if (c === '"') { i += 1; closed = true; break; }
          i += 1;
        }
        if (!closed) return null;
        tokens.push({ type: 'string', raw: t.slice(start, i) });
        continue;
      }
      if (ch === 't' || ch === 'f' || ch === 'n') {
        var literal = t.substr(i, 5) === 'false' ? 'false'
          : t.substr(i, 4) === 'true' ? 'true'
            : t.substr(i, 4) === 'null' ? 'null' : '';
        if (!literal) return null;
        tokens.push({ type: 'literal', raw: literal });
        i += literal.length;
        continue;
      }
      if (ch === '-' || isDigit(ch)) {
        var numStart = i;
        if (ch === '-') i += 1;
        if (!isDigit(t.charAt(i))) return null;
        while (isDigit(t.charAt(i))) i += 1;
        if (t.charAt(i) === '.') {
          i += 1;
          if (!isDigit(t.charAt(i))) return null;
          while (isDigit(t.charAt(i))) i += 1;
        }
        if (t.charAt(i) === 'e' || t.charAt(i) === 'E') {
          i += 1;
          if (t.charAt(i) === '+' || t.charAt(i) === '-') i += 1;
          if (!isDigit(t.charAt(i))) return null;
          while (isDigit(t.charAt(i))) i += 1;
        }
        tokens.push({ type: 'number', raw: t.slice(numStart, i) });
        continue;
      }
      return null;
    }
    return tokens;
  }

  function jsonPad(level) {
    var out = '';
    for (var i = 0; i < level; i += 1) out += '  ';
    return out;
  }

  /* 只重排 token 之间的空白（换行与两空格缩进），token 本身按原样输出。 */
  function prettyJson(tokens) {
    var out = '';
    var depth = 0;
    for (var i = 0; i < tokens.length; i += 1) {
      var tok = tokens[i];
      var raw = tok.raw;
      if (tok.type !== 'punct') { out += raw; continue; }
      if (raw === '{' || raw === '[') {
        var close = raw === '{' ? '}' : ']';
        var next = tokens[i + 1];
        if (next && next.type === 'punct' && next.raw === close) {
          out += raw + close;
          i += 1;
          continue;
        }
        depth += 1;
        out += raw + '\n' + jsonPad(depth);
        continue;
      }
      if (raw === '}' || raw === ']') {
        depth -= 1;
        out += '\n' + jsonPad(depth) + raw;
        continue;
      }
      if (raw === ',') { out += ',\n' + jsonPad(depth); continue; }
      if (raw === ':') { out += ': '; continue; }
      out += raw;
    }
    return out;
  }

  /**
   * JSON.parse 只用来判定“是不是合法 JSON”，排版完全不使用 parse 结果：
   * JSON.parse/stringify 会把 9007199254740993 舍入成 …992、把 1.000000 规范成 1、
   * 并让重复键只剩最后一个，那是把证据数值改掉，不能用于展示。
   */
  function formatJson(text) {
    var raw = str(text).trim();
    if (!raw) return { ok: false, reason: 'json-invalid' };
    try {
      JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: 'json-invalid' };
    }
    var tokens = lexJson(raw);
    if (!tokens || !tokens.length) return { ok: false, reason: 'json-lex' };
    return { ok: true, text: prettyJson(tokens) };
  }

  function formatSql(text) {
    var formatter = root.sqlFormatter;
    if (!formatter || typeof formatter.format !== 'function') return { ok: false, reason: 'no-formatter' };
    if (!isCompleteSql(text)) return { ok: false, reason: 'sql-truncated' };
    try {
      return {
        ok: true,
        text: formatter.format(str(text), { keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 }),
      };
    } catch (e) {
      return { ok: false, reason: 'sql-parse' };
    }
  }

  function format(text, language) {
    var lang = language || 'text';
    var result;
    if (lang === 'json') result = formatJson(text);
    else if (lang === 'sql') result = formatSql(text);
    else result = { ok: false, reason: 'no-formatter' };
    return {
      ok: result.ok === true,
      language: lang,
      reason: result.ok ? '' : result.reason,
      text: result.ok ? result.text : str(text),
    };
  }

  var TAG_GUARD = /<\s*(?:script|iframe|object|embed|img|svg|style|link|meta)\b/i;

  /* 已知格式的最小结构化标注：只在库对该文本零命中时兜底，且只标出文本里真实存在的片段，
   * 不补字、不改空白，因此还原后仍与原文逐字节相同。 */
  function splitKeep(text) { return str(text).split(/([\s,]+)/); }

  function tokenizeHsfSignature(text) {
    var match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\s*)\(([\s\S]*)\)$/.exec(str(text));
    if (!match) return '';
    var params = splitKeep(match[3]).map(function (part) {
      if (!part) return '';
      if (/^[\s,]+$/.test(part)) return escapeHtml(part);
      return '<span class="code-token type">' + escapeHtml(part) + '</span>';
    }).join('');
    return '<span class="code-token method">' + escapeHtml(match[1]) + '</span>' +
      escapeHtml(match[2]) + '<span class="code-token punct">(</span>' + params +
      '<span class="code-token punct">)</span>';
  }

  function tokenizeHttpLine(text) {
    var match = /^([A-Z]+)(\s+)(\S+)([\s\S]*)$/.exec(str(text));
    if (!match) return '';
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(match[1])) return '';
    return '<span class="code-token keyword">' + escapeHtml(match[1]) + '</span>' +
      escapeHtml(match[2]) + '<span class="code-token string">' + escapeHtml(match[3]) + '</span>' +
      escapeHtml(match[4]);
  }

  /* highlight.js 自己会转义；这里再加一道兜底：一旦输出里出现标签形态，就退回纯文本转义。 */
  function highlight(text, language) {
    var raw = str(text);
    var hljs = root.hljs;
    var lang = language || 'text';
    if (lang === 'text' || !hljs || typeof hljs.highlight !== 'function') return escapeHtml(raw);
    if (typeof hljs.getLanguage === 'function' && !hljs.getLanguage(lang)) return escapeHtml(raw);
    var html;
    try {
      html = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
    } catch (e) {
      html = '';
    }
    if (typeof html === 'string' && html.indexOf('<span') !== -1 && !TAG_GUARD.test(html)) return html;
    var structural = lang === 'java' ? tokenizeHsfSignature(raw) : (lang === 'http' ? tokenizeHttpLine(raw) : '');
    return structural || escapeHtml(raw);
  }

  function codeBlockHtml(text, language, mode, hidden) {
    return '<pre class="pre code-block" data-code-mode="' + mode + '"' + (hidden ? ' hidden' : '') + '>' +
      '<code class="code-lang-' + escapeHtml(language) + '">' + text + '</code></pre>';
  }

  /**
   * 统一代码视图：中央材料页签、右侧检视器、复现参数与展开证据都走这里，
   * 保证同一段原文在三处渲染一致，也保证“格式化/原文”只影响展示。
   */
  function render(options) {
    var opts = options || {};
    var raw = str(opts.text);
    if (!raw) return '';
    var language = detectLanguage(raw, opts.hint);
    var formatted = format(raw, language);
    var showToggle = formatted.ok && formatted.text !== raw;
    var reason = formatted.ok ? (showToggle ? '' : 'identical') : formatted.reason;
    var label = LANG_LABEL[language] || LANG_LABEL.text;
    /* 不是合法 JSON 就不按 JSON 着色，否则会给出“键/值都对”的错觉。 */
    var highlightLang = reason === 'json-invalid' ? 'text' : language;

    var chip = showToggle
      ? label + ' · 已格式化'
      : label + ' · ' + (FALLBACK_LABEL[reason] || FALLBACK_LABEL['no-formatter']);

    var copyBtn = opts.copyKey
      ? '<button type="button" class="btn btn-quiet" data-copy-key="' + escapeHtml(opts.copyKey) + '">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<rect x="9" y="9" width="11" height="11" rx="1.5"></rect>' +
        '<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg>' +
        escapeHtml(opts.copyLabel || '复制原文') + '</button>'
      : '';

    var toggleBtn = showToggle
      ? '<button type="button" class="btn btn-quiet" data-code-toggle aria-pressed="false">' +
        '<span data-code-toggle-label>查看原文</span></button>'
      : '';

    var body = showToggle
      ? codeBlockHtml(highlight(formatted.text, language), language, 'formatted', false) +
        codeBlockHtml(highlight(raw, language), language, 'original', true)
      : codeBlockHtml(highlight(raw, highlightLang), language, 'original', false);

    return '<div class="code-view" data-code-view="1" data-code-lang="' + escapeHtml(language) + '"' +
      (showToggle ? '' : ' data-code-fallback="' + escapeHtml(reason) + '"') + '>' +
      '<div class="code-tools">' +
      '<span class="code-chip">' + escapeHtml(chip) + '</span>' +
      '<span class="code-actions">' + toggleBtn + copyBtn + '</span>' +
      '</div>' + body + '</div>';
  }

  /* 按钮文案与显隐只由当前状态决定，便于测试；不含 DOM 依赖。 */
  function toggleLabel(pressed) { return pressed ? '查看格式化' : '查看原文'; }

  return {
    render: render,
    detectLanguage: detectLanguage,
    format: format,
    highlight: highlight,
    isCompleteSql: isCompleteSql,
    escapeHtml: escapeHtml,
    toggleLabel: toggleLabel,
    LANG_LABEL: LANG_LABEL,
    HINT_LANG: HINT_LANG,
  };
});
