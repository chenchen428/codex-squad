import path from 'node:path';

/** 文本节点一律走 textContent，这里只处理需要拼进 HTML/脚本的字符串。 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把 JSON 序列化结果安全地放进 <script type="application/json">。
 * 只替换 JSON 字符串内部可能出现的危险字符；`<` 在 JSON 结构字符中不会出现，
 * 因此整体替换不会破坏 JSON 语义。
 */
export function toJsonScript(jsonText) {
  return jsonText
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function relativeDisplay(dir, file) {
  const rel = path.relative(dir, file);
  return rel === '' ? '.' : rel;
}

export function truncate(text, max) {
  const value = String(text);
  return value.length > max ? value.slice(0, max) + '…' : value;
}
