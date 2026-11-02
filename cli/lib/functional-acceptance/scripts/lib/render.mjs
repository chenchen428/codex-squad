import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escapeHtml, toJsonScript } from './text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(HERE, '..', '..');
const ASSETS = path.join(SKILL_ROOT, 'assets');

export class BuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
  }
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function fontFace(family, file, weight, display) {
  const buffer = fs.readFileSync(path.join(ASSETS, 'vendor', 'fonts', file));
  const data = buffer.toString('base64');
  return [
    '@font-face{',
    `font-family:'${family}';`,
    'font-style:normal;',
    `font-weight:${weight};`,
    `font-display:${display};`,
    `src:url(data:font/woff2;base64,${data}) format('woff2');`,
    '}',
  ].join('');
}

export function buildFontCss() {
  return [
    fontFace('Inter', 'inter-latin.woff2', '400 700', 'swap'),
    fontFace('JetBrains Mono', 'jetbrains-mono-latin.woff2', '400 600', 'swap'),
    fontFace('Material Symbols Outlined', 'material-symbols-outlined-subset.woff2', '100 700', 'block'),
  ].join('\n');
}

function inlineScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

/**
 * 技能私有的视图资源。assets/studio 是唯一正式视图，由技能内置模板、样式与脚本组成；
 * 缺失时明确失败，不回退旧 shell，也不读取数据目录或项目里的自定义 HTML。
 *
 * 代码阅读依赖两个离线 vendor bundle，必须先于 app.js 内联，且同样受 nonce 约束。
 */
const CODE_VIEW_VENDOR = ['sql-formatter.mysql.min.js', 'highlight-sql-json-http-java.min.js'];

export function resolveViewer({ root = SKILL_ROOT } = {}) {
  const studioDir = path.join(root, 'assets', 'studio');
  const codeViewDir = path.join(root, 'assets', 'vendor', 'code-view');
  const required = {
    'template.html': path.join(studioDir, 'template.html'),
    'app.css': path.join(studioDir, 'app.css'),
    'app.js': path.join(studioDir, 'app.js'),
    'code-view.js': path.join(studioDir, 'code-view.js'),
  };
  CODE_VIEW_VENDOR.forEach((name) => {
    required[`vendor/code-view/${name}`] = path.join(codeViewDir, name);
  });
  const missing = Object.entries(required).filter(([, file]) => !exists(file)).map(([name]) => name);
  if (missing.length) {
    throw new BuildError('E_VIEWER_ASSETS_MISSING',
      `技能内置视图资源缺失：assets/studio 与 assets/vendor/code-view 需要 ${Object.keys(required).join('/')}，缺少 ${missing.join('、')}。正式构建只使用内置 studio，不回退旧 shell；CLI 也不接受外部 HTML 或项目路径作为模板。`);
  }
  const codeView = CODE_VIEW_VENDOR.map((name) => ({
    name,
    code: read(path.join(codeViewDir, name)),
  }));
  return {
    id: 'studio',
    legacy: false,
    templateText: read(required['template.html']),
    css: read(required['app.css']),
    appJs: read(required['app.js']),
    codeViewJs: read(required['code-view.js']),
    codeViewVendor: codeView,
    warnings: [],
  };
}

function buildStyleBlock(viewer, includeRrweb, nonce) {
  const sections = [`<style nonce="${nonce}">`, buildFontCss(), viewer.css];
  if (includeRrweb) {
    sections.push(read(path.join(ASSETS, 'vendor', 'rrweb', 'style.min.css')));
  }
  sections.push('</style>');
  return sections.join('\n');
}

function assertSelfContained(html, { includeRrweb }) {
  const problems = [];
  // 库脚本自身含有 URL 字符串（如 SVG 命名空间），这里只检查可渲染的标记与样式。
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  if (/<link\b/i.test(markup)) problems.push('输出包含 <link> 标签');
  if (/@import\s/i.test(markup)) problems.push('输出包含 @import');
  const remote = markup.match(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//gi);
  if (remote) problems.push(`输出包含远程资源引用（${remote.length} 处）`);
  const cssRemote = markup.match(/url\(\s*["']?(?:https?:)?\/\//gi);
  if (cssRemote) problems.push(`输出样式包含远程 url()（${cssRemote.length} 处）`);
  if (/<iframe\b/i.test(html)) problems.push('输出包含 <iframe> 嵌套层');
  if (includeRrweb && !/window\.rrweb|"rrweb"/.test(html)) problems.push('缺少 rrweb 运行时');
  if (problems.length) {
    throw new BuildError('E_SELF_CONTAINED', `自包含检查失败：${problems.join('；')}`);
  }
}

function assertNoPrivatePaths(text, label) {
  if (/V3_DATA/.test(text)) {
    throw new BuildError('E_PRIVATE_BINDING', `${label} 依赖 window.V3_DATA 等私有数据绑定；视图只能读取 #acceptance-data`);
  }
  if (/\/Users\/|outputs-local|validation\/integration-acceptance/.test(text)) {
    throw new BuildError('E_PRIVATE_PATH', `${label} 含项目私有路径；技能视图不得依赖具体项目目录`);
  }
}

function cspMetaOf(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  return tags.find((tag) => /http-equiv=["']Content-Security-Policy["']/i.test(tag)) || null;
}

/**
 * CSP 校验：非内联样式/脚本必须使用本次 nonce；外置图片需要放行同源相对路径。
 * 模板自己声明 CSP，生成器只补必需的 img-src，不改默认策略。
 */
function assertAndAdjustCsp(html, nonce, { assetMode }) {
  let meta = cspMetaOf(html);
  if (!meta) {
    throw new BuildError('E_CSP_MISSING', '模板必须内置 Content-Security-Policy meta');
  }
  const contentMatch = meta.match(/content=(["'])([\s\S]*?)\1/i);
  if (!contentMatch) {
    throw new BuildError('E_CSP_MISSING', 'CSP meta 缺少 content 策略');
  }
  let policy = contentMatch[2];
  if (!/default-src\s+'none'/i.test(policy)) {
    throw new BuildError('E_CSP_POLICY', "CSP 必须以 default-src 'none' 起步，禁止外部请求");
  }
  if (!new RegExp(`script-src[^;]*'nonce-${nonce}'`, 'i').test(policy)) {
    throw new BuildError('E_CSP_NONCE', 'CSP script-src 必须使用本次生成的 nonce');
  }
  const imgSrc = policy.match(/(?:^|;)\s*img-src([^;]*)/i);
  if (!imgSrc) {
    throw new BuildError('E_CSP_IMAGE', 'CSP 必须声明 img-src，图片证据按 data: 或同源相对路径加载');
  }
  const needsSelf = assetMode === 'external';
  const hasSelf = /'self'/i.test(imgSrc[1]);
  const hasData = /\bdata:/i.test(imgSrc[1]);
  if (needsSelf && !hasSelf) {
    const patched = policy.replace(/((?:^|;)\s*img-src)([^;]*)/i, (whole, head, body) => `${head}${body.trimEnd()} 'self'`);
    const newMeta = meta.replace(contentMatch[0], `content=${contentMatch[1]}${patched}${contentMatch[1]}`);
    html = html.replace(meta, newMeta);
  } else if (!needsSelf && !hasData) {
    throw new BuildError('E_CSP_IMAGE', '内联模式的 CSP img-src 必须放行 data: 图片');
  }
  return html;
}

function assertClassicViewerScript(code) {
  if (/(^|\n)\s*(?:import|export)\s+[\w{*]/.test(code)) {
    throw new BuildError('E_VIEWER_SCRIPT_FORMAT', 'skills 视图脚本必须是普通脚本；禁止 import/export（CSP 下内联执行）');
  }
}

export function renderIndexHtml({ templateText, payload, nonce, viewer }) {
  const resolvedViewer = viewer || resolveViewer();
  assertClassicViewerScript(resolvedViewer.appJs || '');
  assertClassicViewerScript(resolvedViewer.codeViewJs || '');
  (resolvedViewer.codeViewVendor || []).forEach((item) => assertClassicViewerScript(item.code || ''));
  assertNoPrivatePaths(templateText, '模板');
  assertNoPrivatePaths(resolvedViewer.appJs || '', '视图脚本');
  assertNoPrivatePaths(resolvedViewer.codeViewJs || '', '代码阅读脚本');

  const includeRrweb = Array.isArray(payload.recordings) && payload.recordings.length > 0;
  const dataJson = toJsonScript(JSON.stringify(payload));
  const dataTag = `<script type="application/json" id="acceptance-data" nonce="${nonce}">${dataJson}</script>`;
  const rrwebLib = includeRrweb
    ? `<script nonce="${nonce}">${inlineScript(read(path.join(ASSETS, 'vendor', 'rrweb', 'rrweb.umd.min.js')))}</script>`
    : '<!-- rrweb 未启用：本报告没有录制回放 -->';
  /* 顺序固定：格式化/高亮 vendor → code-view 适配层 → 视图脚本。三者共用同一个 nonce。 */
  const codeViewLib = (resolvedViewer.codeViewVendor || [])
    .map((item) => `<script nonce="${nonce}">${inlineScript(item.code)}</script>`)
    .join('\n');
  const codeViewJs = resolvedViewer.codeViewJs
    ? `<script nonce="${nonce}">${inlineScript(resolvedViewer.codeViewJs)}</script>`
    : '';
  const appJs = `<script nonce="${nonce}">${inlineScript(resolvedViewer.appJs)}</script>`;
  const css = buildStyleBlock(resolvedViewer, includeRrweb, nonce);

  const pageTitle = `${payload.report.title} · 验收工作台`;
  const headerTitle = `${payload.report.title}`;

  const replacements = {
    '{{PAGE_TITLE}}': escapeHtml(pageTitle),
    '{{REPORT_TITLE}}': escapeHtml(headerTitle),
    '{{NONCE}}': nonce,
  };

  let html = templateText;
  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(token).join(value);
  }
  html = html.split('<!--INLINE_CSS-->').join(css);
  html = html.split('<!--INLINE_DATA-->').join(dataTag);
  html = html.split('<!--INLINE_RRWEB-->').join(rrwebLib);
  html = html.split('<!--INLINE_APP_JS-->').join([codeViewLib, codeViewJs, appJs].filter(Boolean).join('\n'));

  if (/\{\{[A-Z_]+\}\}|<!--INLINE_[A-Z_]+-->/.test(html)) {
    throw new BuildError('E_TEMPLATE_PLACEHOLDER', '模板占位符未被完全替换');
  }
  if (/<iframe\b/i.test(html)) {
    throw new BuildError('E_NESTED_FRAME', '输出不能包含 iframe 嵌套层；外置模式同样只交付业务 HTML');
  }

  html = assertAndAdjustCsp(html, nonce, { assetMode: payload.assetMode });
  assertSelfContained(html, { includeRrweb });

  const dataScripts = html.match(/<script type="application\/json" id="acceptance-data" nonce="[0-9a-f]+">/g) || [];
  if (dataScripts.length !== 1) {
    throw new BuildError('E_DATA_SCRIPT', `#acceptance-data 必须且只能出现一次（实际 ${dataScripts.length} 次）`);
  }
  const extracted = html.match(/<script type="application\/json" id="acceptance-data" nonce="[0-9a-f]+">([\s\S]*?)<\/script>/);
  try {
    JSON.parse(extracted[1]);
  } catch (error) {
    throw new BuildError('E_DATA_SCRIPT', `数据脚本内联后不是合法 JSON：${error.message}`);
  }
  return html;
}

export function createNonce() {
  return crypto.randomBytes(16).toString('hex');
}
