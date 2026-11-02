// Run in the rendered analysis page at 390, 541 and 1280 CSS px.
// This reads actual layout; it does not match CSS declarations or modify the page.
export function checkAnalysisLayout() {
  const root = document.querySelector('[data-analysis-report]');
  if (!root) throw new Error('分析页尚未完成渲染');
  const failures = [];
  const rect = element => element.getBoundingClientRect();
  const grid = root.querySelector('.benefit-hero-grid');
  const metrics = grid ? [...grid.children].filter(element => !element.hidden) : [];
  if (metrics.length > 1) {
    const first = rect(metrics[0]);
    for (const metric of metrics.slice(1)) {
      if (Math.abs(rect(metric).top - first.top) > 1) failures.push('收益指标发生上下换行');
    }
    if (grid.scrollWidth > grid.clientWidth + 1 && !['auto', 'scroll'].includes(getComputedStyle(grid).overflowX)) {
      failures.push('收益指标超出宽度却无法在区域内滚动');
    }
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('整页出现横向溢出');
  const headers = [...root.querySelectorAll('[data-action="sort"]')];
  if (!headers.length) failures.push('缺少可验证的排序表头');
  for (const button of headers) {
    const cell = rect(button.closest('th'));
    const label = button.querySelector('.header-label');
    const icon = button.querySelector('svg');
    const name = `${button.dataset.table}/${button.dataset.key}`;
    if (!label || !icon) { failures.push(`${name} 缺少标签或图标`); continue; }
    const text = rect(label), glyph = rect(icon), control = rect(button);
    if (text.left < cell.left - 1 || glyph.right > cell.right + 1 || text.right > glyph.left + 1) {
      failures.push(`${name} 标签与图标越界或重叠`);
    }
    if (control.left < cell.left - 1 || control.right > cell.right + 1) failures.push(`${name} 按钮越过单元格`);
    if (glyph.width < 10 || glyph.width > 16 || glyph.height < 10 || glyph.height > 16) failures.push(`${name} 图标尺寸不清楚或过大`);
    if (button.matches(':focus-visible')) {
      const style = getComputedStyle(button);
      if (parseFloat(style.outlineWidth) <= 0 || parseFloat(style.outlineOffset) > 0) failures.push(`${name} 焦点环缺失或存在裁切风险`);
    }
  }
  if (root.querySelector('[data-slot="usage-meta"]')) failures.push('被删除的过程说明重新出现');
  const result = {
    viewport: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    metricCount: metrics.length,
    benefits: grid ? {width: grid.clientWidth, scrollWidth: grid.scrollWidth} : null,
    headerCount: headers.length,
    failures,
  };
  if (failures.length) throw new Error(JSON.stringify(result));
  return result;
}
