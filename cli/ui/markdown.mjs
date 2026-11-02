import MarkdownIt from 'markdown-it';

const SAFE_LINK = /^(?:https?:|mailto:)/i;

const md = new MarkdownIt({html:false,linkify:true,breaks:true});
const builtinValidateLink = md.validateLink.bind(md);
md.validateLink = url => builtinValidateLink(url) && SAFE_LINK.test(String(url).trim());

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const source = (token.attrGet('src') || '').trim();
  const label = token.content.trim() || source;
  if (!SAFE_LINK.test(source)) return md.utils.escapeHtml(label);
  return `<a class="md-image-link" href="${md.utils.escapeHtml(source)}" target="_blank" rel="noopener noreferrer">${md.utils.escapeHtml(label)}</a>`;
};

md.renderer.rules.table_open = () => '<div class="md-table-scroll"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

/** @param {string} text @returns {string} */
export function renderMarkdown(text) {
  return md.render(typeof text === 'string' ? text : '');
}
