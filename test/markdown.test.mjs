import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from '../cli/ui/markdown.mjs';

function assertNoExecutableMarkup(html) {
  assert.doesNotMatch(html, /<script\b|<img\b|<iframe\b|<object\b|<embed\b/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\son(?:error|load|click|mouseover)\s*=/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\shref\s*=\s*["']?\s*(?:javascript|data|file|vbscript):/i);
}

test('renders headings, lists, emphasis, code, tables and safe links semantically', () => {
  const html = renderMarkdown([
    '## 标题',
    '',
    '- 一',
    '- 二',
    '',
    '1. 甲',
    '2. 乙',
    '',
    '**重点** 和 *斜体* 以及 `inline`',
    '',
    '```ts',
    'const x = 1 < 2;',
    '```',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| a | b |',
    '',
    '[文档](https://example.com/docs)',
    '',
    '[邮件](mailto:team@example.com)',
  ].join('\n'));

  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<ul>\n<li>一<\/li>\n<li>二<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>甲<\/li>\n<li>乙<\/li>\n<\/ol>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /<pre><code class="language-ts">const x = 1 &lt; 2;\n<\/code><\/pre>/);
  assert.match(html, /<div class="md-table-scroll"><table>[\s\S]*<th>列 A<\/th>[\s\S]*<td>a<\/td>[\s\S]*<\/table><\/div>/);
  assert.match(html, /<a href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer">文档<\/a>/);
  assert.match(html, /<a href="mailto:team@example.com" target="_blank" rel="noopener noreferrer">邮件<\/a>/);
  assertNoExecutableMarkup(html);
});

test('raw HTML is escaped instead of executed', () => {
  const html = renderMarkdown([
    '<img src="x" onerror="alert(1)">',
    '',
    '<script>alert(1)</script>',
    '',
    '<span onclick="alert(1)">点击</span>',
  ].join('\n'));

  assert.match(html, /&lt;img src=&quot;x&quot; onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<span onclick/);
  assertNoExecutableMarkup(html);
});

test('unsafe link protocols stay as text and never become anchors', () => {
  const html = renderMarkdown([
    '[js](javascript:alert(1))',
    '',
    '[大写](JaVaScRiPt:alert(1))',
    '',
    '[空白](java\tscript:alert(1))',
    '',
    '[编码](%6a%61vascript:alert(1))',
    '',
    '[实体](javascript&#58;alert(1))',
    '',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '',
    '[文件](file:///etc/passwd)',
    '',
    '[协议相对](//evil.example/path)',
    '',
    '[安全](https://example.com/ok)',
  ].join('\n'));

  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(hrefs, ['https://example.com/ok']);
  assert.doesNotMatch(html, /href="(?:javascript|data|file|vbscript):/i);
  assert.match(html, /\[js\]\(javascript:alert\(1\)\)/);
  assert.match(html, /<a href="https:\/\/example.com\/ok"/);
  assertNoExecutableMarkup(html);
});

test('remote images load only on explicit click, never as embedded images', () => {
  const html = renderMarkdown('![架构图](https://example.com/diagram.png)');
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /<a class="md-image-link" href="https:\/\/example.com\/diagram.png" target="_blank" rel="noopener noreferrer">架构图<\/a>/);
});

test('unsafe or data image sources degrade to text', () => {
  const data = renderMarkdown('![像素](data:image/png;base64,AAAA)');
  const script = renderMarkdown('![图标](javascript:alert(1))');
  assert.doesNotMatch(data, /<img\b|href="data:/i);
  assert.doesNotMatch(script, /<img\b|href="javascript:/i);
  assert.match(data, /像素/);
  assert.match(script, /图标/);
});

test('linkify produces safe anchors and preserves line breaks', () => {
  const html = renderMarkdown('访问 https://example.com/auto\n第二行');
  assert.match(html, /<a href="https:\/\/example.com\/auto" target="_blank" rel="noopener noreferrer">https:\/\/example.com\/auto<\/a><br>\n第二行/);
  assertNoExecutableMarkup(html);
});

test('streaming unclosed fences render a stable code block and can complete later', () => {
  const open = '流式输出\n\n```ts\nconst longLine = "'+'a'.repeat(600)+'"\n';
  const first = renderMarkdown(open);
  assert.match(first, /<pre><code class="language-ts">const longLine = &quot;a{600}&quot;\n<\/code><\/pre>/);
  assert.doesNotMatch(first, /```/);

  const updating = renderMarkdown(open + '\nconst next = 2\n');
  assert.match(updating, /const next = 2/);
  assert.match(updating, /<pre><code class="language-ts">/);

  const closed = renderMarkdown(open + '\nconst next = 2\n```\n');
  assert.match(closed, /const next = 2\n<\/code><\/pre>/);
  assert.doesNotMatch(closed, /```/);
});

test('long single lines and long code lines stay rendered without injected markup', () => {
  const longLine = 'x'.repeat(1200);
  const paragraph = renderMarkdown(longLine);
  assert.equal(paragraph, `<p>${longLine}</p>\n`);

  const longCode = 'y'.repeat(900);
  const code = renderMarkdown('```\n' + longCode + '\n```\n');
  assert.match(code, new RegExp(`<pre><code>${longCode}\n<\\/code><\\/pre>`));
  assert.match(renderMarkdown('```\n<script>alert(1)</script>\n```\n'), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assertNoExecutableMarkup(renderMarkdown('```\n<script>alert(1)</script>\n```\n'));
});
