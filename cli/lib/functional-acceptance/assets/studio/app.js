/* 验收工作台 · 数据驱动视图脚本
 *
 * 只读取 #acceptance-data 的标准载荷；不联网、不执行 SQL/RPC、不推断通过状态。
 * 布局按固定视口三栏操作台移植：左栏用例列表、中央步骤证据、右侧检视器；
 * 页面本身不滚动，只有左栏列表与右侧检视器各自滚动。
 * 业务标题只取 displayTitle/title；内部 id 仅用于选择、搜索和展开详情。
 */
(function () {
  'use strict';

  var STATUSES = ['passed', 'failed', 'blocked', 'partial', 'not_run'];
  var STATUS_LABEL = { passed: '通过', failed: '失败', blocked: '阻断', partial: '部分验证', not_run: '未执行' };
  var STATUS_ICON = { passed: 'check_circle', failed: 'error', blocked: 'block', partial: 'pending', not_run: 'schedule' };
  var STATUS_DOT = { passed: 'dot-passed', failed: 'dot-failed', blocked: 'dot-blocked', partial: 'dot-partial', not_run: 'dot-not_run' };
  var ROLE_ORDER = ['new', 'regression', 'mixed', 'audit', 'unknown'];
  var ROLE_LABEL = { new: '测新', regression: '回归', mixed: '兼有', audit: '执行审计', unknown: '待分类' };
  var ROLE_CLASS = { new: 'role-new', regression: 'role-regression', mixed: 'role-mixed', audit: 'role-audit', unknown: '' };
  var PAGE_SCOPES = ['all', 'page', 'data'];
  var TYPE_LABEL = { page: '页面', api: '接口', data: '数据', message: '消息', tool: '工具' };
  var TYPE_CLASS = { page: 'type-page', api: 'type-api', data: 'type-data', message: 'type-message' };
  var ORIGIN_LABEL = { executed: '执行原文', reconstructed: '还原整理（非执行原文）', unavailable: '原文未留存' };
  var STMT_KIND = { sql: 'SQL', http: 'HTTP', hsf: 'HSF', message: '消息', tool: '工具' };
  var REPRO_KIND = { page: '页面', lantu: '蓝图', hsf: 'HSFOps', db: 'DMS', mq: 'MetaQ', trace: '调用链', api: '接口', ci: '发布', data: '数据' };
  var ANNOTATION_TONES = ['focus', 'context', 'risk'];
  var CIRCLE_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

  /* 中央核验台：语句/请求与结果/响应上下同屏，默认 40/60，可拖动也可键盘调整。
   * 右栏不再分页签，按疑问 → 方法 → 关注点 → 条件 → 对照 → 结论 → 边界连续排布。 */
  var SPLIT = { min: 0.2, max: 0.8, step: 0.04, initial: 0.4 };
  /* 接口/HSF 证据里承载业务响应的字段名；只按内容识别，不按用例或方法名特判。 */
  var RESPONSE_KEYS = ['invoke_result', 'response', 'result', 'resultLines'];

  /* 图标使用内联 SVG，避免依赖图标字体：字体未加载时不会把 ligature 名称渲染成英文文本。 */
  var ICON_PATHS = {
    fact_check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    visibility: '<path d="M2 12s3.7-6 10-6 10 6 10 6-3.7 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.8"/>',
    inventory_2: '<path d="M4 8l8-4 8 4-8 4z"/><path d="M4 8v8l8 4 8-4V8"/><path d="M12 12v8"/>',
    help_outline: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9a3 3 0 1 1 5.2 2.1c-.8.8-2.4 1.4-2.4 3.1"/><circle cx="12" cy="17.4" r="0.7" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    account_tree: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v3M6 16v-3h12v3"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.5"/><path d="M4 18l5-5 3 3 3-3 5 5"/>',
    fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    fullscreen_exit: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    description: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
    content_copy: '<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    data_object: '<path d="M8 4c-2 0-2 3-2 4s0 3-2 3c2 0 2 2 2 3s0 4 2 4"/><path d="M16 4c2 0 2 3 2 4s0 3 2 3c-2 0-2 2-2 3s0 4-2 4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    table_chart: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/>',
    task_alt: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.6"/>',
    grid_on: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 14.5h18M9 4v16M15 4v16"/>',
    compare_arrows: '<path d="M4 8h13l-3.2-3.2M20 16H7l3.2 3.2"/>',
    psychology: '<path d="M9.2 4A3.2 3.2 0 0 0 6 7.2 3 3 0 0 0 5 13v1.5a3 3 0 0 0 4.2 2.7z"/><path d="M14.8 4A3.2 3.2 0 0 1 18 7.2 3 3 0 0 1 19 13v1.5a3 3 0 0 1-4.2 2.7z"/>',
    aspect_ratio: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h2.6M7 9v2.6M17 15h-2.6M17 15v-2.6"/>',
    dock_to_left: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    verified: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    open_in_new: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    link_off: '<path d="M9 18H7a4 4 0 0 1 0-8h2M15 6h2a4 4 0 0 1 0 8h-2"/><path d="M8 16l8-8"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.7" r="0.8" fill="currentColor" stroke="none"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    expand_more: '<path d="M6 9l6 6 6-6"/>',
    arrow_forward: '<path d="M4 12h14M13 6l6 6-6 6"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    check_circle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.6" r="0.8" fill="currentColor" stroke="none"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="M6 18L18 6"/>',
    pending: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
    schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    drag_handle: '<path d="M6 9h12M6 15h12"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
    table_rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 14.5h18"/>',
    zoom_in: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M11 8.5v5M8.5 11h5"/>',
    zoom_out: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M8.5 11h5"/>',
    menu_book: '<path d="M12 6c-2-1.6-4.4-2-8-2v14c3.6 0 6 .4 8 2 2-1.6 4.4-2 8-2V4c-3.6 0-6 .4-8 2z"/><path d="M12 6v14"/>',
    track_changes: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'
  };

  /* ---------- 复现文本登记表 ----------
   * 报告里可能出现同名按钮，所以复制内容按渲染时生成的键保存，
   * 不依赖 DOM 文本，也不会把说明文字或接口响应误当作输入。 */
  var copyStore = Object.create(null);
  function resetCopyStore() { copyStore = Object.create(null); }
  function registerCopy(key, text) {
    if (!key) return '';
    copyStore[key] = str(text);
    return key;
  }
  function copyTextByKey(key) { return str(copyStore[key]); }

  /* ---------- 基础工具 ---------- */
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }
  function esc(v) {
    return str(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }
  function icon(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      (ICON_PATHS[name] || ICON_PATHS.dot) + '</svg>';
  }
  function setIcon(el, name) {
    if (!el) return;
    el.innerHTML = ICON_PATHS[name] || ICON_PATHS.dot;
  }
  function hydrateIcons(root) {
    var nodes = (root || document).querySelectorAll('svg[data-icon]');
    Array.prototype.forEach.call(nodes, function (el) { setIcon(el, el.getAttribute('data-icon')); });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function uniq(list) {
    var seen = Object.create(null);
    return (list || []).filter(function (item) {
      if (!item || seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function safeHttpsUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      var parsed = new URL(value.trim());
      return parsed.protocol === 'https:' ? parsed.href : '';
    } catch (e) {
      return '';
    }
  }

  /* 图片只接受内联 data:image 或报告内的相对路径；其余一律不渲染，避免外部请求。 */
  function safeImgSrc(value) {
    var s = str(value).trim();
    if (!s) return '';
    if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s;
    if (/^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(s) && s.indexOf('..') === -1) return s;
    return '';
  }

  /* 标注坐标使用原图像素，灯箱把标注层放进与原图同尺寸的世界坐标里，
   * 因此缩放/平移时框线跟随图片，不依赖 DOM 测量。 */
  function normalizeAnnotations(list) {
    return (Array.isArray(list) ? list : []).filter(isObj).map(function (item, index) {
      return {
        number: Number.isInteger(item.number) && item.number > 0 ? item.number : index + 1,
        label: str(item.label),
        tone: ANNOTATION_TONES.indexOf(item.tone) !== -1 ? item.tone : 'focus',
        x: Math.max(0, num(item.x, 0)),
        y: Math.max(0, num(item.y, 0)),
        w: Math.max(0, num(item.w, 0)),
        h: Math.max(0, num(item.h, 0)),
        note: str(item.note),
      };
    }).filter(function (item) { return !!item.label && item.w > 0 && item.h > 0; });
  }

  function normalizeEvidence(ev) {
    var out = {};
    Object.keys(ev).forEach(function (key) { out[key] = ev[key]; });
    out.annotations = normalizeAnnotations(ev.annotations);
    return out;
  }

  /* ---------- 状态与分类 ---------- */
  /* 模型标准化后可能只保留 raw 与 role；分类必须同时兼容原始 caseRole 与映射后的 role。 */
  function caseRoleOf(c) {
    var raw = c && c.raw;
    var role = (raw && (raw.caseRole || raw.role)) || (c && (c.caseRole || c.role));
    return ROLE_LABEL[role] ? role : 'unknown';
  }
  function isAudit(c) { return caseRoleOf(c) === 'audit'; }
  function hasPage(c) {
    return !!(c && Array.isArray(c.steps) && c.steps.some(function (s) { return s.type === 'page' || s.pageView; }));
  }
  function statusKeyOf(status) { return STATUSES.indexOf(status) !== -1 ? status : ''; }
  function statusLabel(status, audit) {
    var base = STATUS_LABEL[status] || (status ? String(status) : '未标注');
    if (!audit) return base;
    if (status === 'not_run') return '审计待执行';
    return '审计执行' + base;
  }
  function roleLabel(role) { return ROLE_LABEL[role] || '待分类'; }
  function isPageStep(step) { return !!(step && (step.type === 'page' || step.pageView)); }

  /* ---------- 筛选与计数（与 shells/case-filter 语义一致） ---------- */
  function defaultFilters() { return { status: 'all', role: 'all', page: 'all', group: 'all', query: '' }; }
  function normalizeFilters(input) {
    var f = isObj(input) ? input : {};
    return {
      status: STATUSES.indexOf(f.status) !== -1 ? f.status : 'all',
      role: ['all'].concat(ROLE_ORDER).indexOf(f.role) !== -1 ? f.role : 'all',
      page: PAGE_SCOPES.indexOf(f.page) !== -1 ? f.page : 'all',
      group: nonEmptyFilterValue(f.group),
      query: str(f.query).trim().toLowerCase(),
    };
  }
  function nonEmptyFilterValue(value) {
    var text = str(value).trim();
    return text && text !== 'all' ? text : 'all';
  }

  /* statusScope：business 时状态只反映业务记录；audit 时只看审计记录自身的执行状态。 */
  function matchesCase(c, filters, statusScope) {
    var f = normalizeFilters(filters);
    if (!c) return false;
    if (f.status !== 'all') {
      if (statusScope !== 'audit' && isAudit(c) && f.role !== 'audit') return false;
      if (c.status !== f.status) return false;
    }
    if (f.role !== 'all' && caseRoleOf(c) !== f.role) return false;
    if (f.page === 'page' && !hasPage(c)) return false;
    if (f.page === 'data' && hasPage(c)) return false;
    if (f.group !== 'all' && c.groupId !== f.group) return false;
    if (!f.query) return true;
    return str(c.searchText).indexOf(f.query) !== -1;
  }

  function filterCases(model, filters) {
    var f = normalizeFilters(filters);
    return (model && model.cases ? model.cases : []).filter(function (c) { return matchesCase(c, f, 'business'); });
  }

  function countWith(list, filters, dimension, value, statusScope) {
    var probe = normalizeFilters(filters);
    probe[dimension] = value;
    return list.filter(function (c) {
      if (!matchesCase(c, probe, statusScope)) return false;
      if (statusScope === 'business' && isAudit(c)) return false;
      if (statusScope === 'audit' && !isAudit(c)) return false;
      return true;
    }).length;
  }

  /* 每个选项的计数 = 其余筛选不变、仅本维度取该选项时的匹配数。 */
  function computeCounts(model, filters) {
    var f = normalizeFilters(filters);
    var list = model && model.cases ? model.cases : [];
    function facet(dimension, values, statusScope) {
      var out = { all: countWith(list, f, dimension, 'all', statusScope) };
      values.forEach(function (value) { out[value] = countWith(list, f, dimension, value, statusScope); });
      return out;
    }
    var audit = list.filter(isAudit).length;
    var groupIds = ((model && model.groups) || []).map(function (g) { return g.id; });
    return {
      status: facet('status', STATUSES, 'business'),
      auditStatus: facet('status', STATUSES, 'audit'),
      role: facet('role', ROLE_ORDER, 'all'),
      page: facet('page', ['page', 'data'], 'all'),
      group: facet('group', groupIds, 'all'),
      totals: { all: list.length, business: list.length - audit, audit: audit },
    };
  }

  function buildSearchText(c, group) {
    var parts = [c && c.id, c && c.title, c && c.displayTitle, c && c.objective, c && c.requirement,
      c && c.caseRoleReason, Array.isArray(c && c.caseRoleSources) ? c.caseRoleSources.join(' ') : '',
      group ? (group.displayTitle || group.title) : ''];
    ((c && c.steps) || []).forEach(function (s) {
      parts.push(s.id, s.title, s.displayTitle, s.action, s.expected, s.actual);
    });
    ((c && c.checks) || []).forEach(function (ch) { parts.push(ch && ch.title, ch && ch.expected, ch && ch.actual); });
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  /* ---------- 视图模型 ---------- */
  function buildModel(payload) {
    if (!isObj(payload)) throw new Error('acceptance-data 必须是 JSON 对象');
    var groups = (Array.isArray(payload.groups) ? payload.groups : []).map(function (g, i) {
      return {
        id: str(g && g.id) || ('group-' + i),
        title: str(g && g.title),
        displayTitle: str(g && g.displayTitle),
        requirement: str(g && g.requirement),
      };
    });
    var groupById = Object.create(null);
    groups.forEach(function (g) { groupById[g.id] = g; });

    var evidenceById = Object.create(null);
    var evidenceList = Array.isArray(payload.evidence) ? payload.evidence : [];
    evidenceList.forEach(function (ev) {
      if (isObj(ev) && ev.id) evidenceById[str(ev.id)] = normalizeEvidence(ev);
    });

    var cases = (Array.isArray(payload.cases) ? payload.cases : []).map(function (raw, index) {
      var steps = (Array.isArray(raw.steps) ? raw.steps : []).map(function (s, si) {
        return {
          id: str(s && s.id) || ('step-' + (si + 1)),
          type: str(s && s.type),
          title: str(s && s.title),
          displayTitle: str(s && s.displayTitle),
          navTitle: str(s && (s.displayTitle || s.title)) || ('步骤 ' + (si + 1)),
          action: str(s && s.action),
          expected: str(s && s.expected),
          actual: str(s && s.actual),
          status: str(s && s.status),
          evidenceIds: Array.isArray(s && s.evidenceIds) ? s.evidenceIds.filter(function (id) { return typeof id === 'string' && id; }) : [],
          page: str(s && s.page),
          pageView: isObj(s && s.pageView) ? s.pageView : null,
          verification: isObj(s && s.verification) ? s.verification : null,
          reproduction: normalizeReproduction(s && s.reproduction),
        };
      });
      var caseObj = {
        id: str(raw && raw.id) || ('case-' + (index + 1)),
        groupId: str(raw && raw.groupId),
        title: str(raw && raw.title),
        displayTitle: str(raw && raw.displayTitle),
        navTitle: str(raw && (raw.displayTitle || raw.title)) || ('用例 ' + (index + 1)),
        requirement: str(raw && raw.requirement),
        objective: str(raw && raw.objective),
        status: str(raw && raw.status),
        preconditions: Array.isArray(raw && raw.preconditions) ? raw.preconditions.map(str) : [],
        checks: Array.isArray(raw && raw.checks) ? raw.checks.filter(isObj) : [],
        steps: steps,
        raw: raw,
        role: caseRoleOf(raw),
        caseRoleReason: str(raw && raw.caseRoleReason),
        caseRoleSources: Array.isArray(raw && raw.caseRoleSources) ? raw.caseRoleSources.map(str) : [],
        caseDesign: normalizeCaseDesign(raw && raw.caseDesign),
      };
      caseObj.caseRole = caseObj.role;
      caseObj.isAudit = caseObj.role === 'audit';
      caseObj.hasPage = hasPage(caseObj);
      caseObj.navTitle = caseObj.displayTitle || caseObj.title || caseObj.navTitle;
      caseObj.searchText = buildSearchText(raw, groupById[caseObj.groupId]);
      return caseObj;
    });

    var report = isObj(payload.report) ? payload.report : {};
    return {
      report: {
        id: str(report.id),
        title: str(report.title),
        environment: str(report.environment),
        revision: str(report.revision),
        executedAt: str(report.executedAt),
        example: report.example === true,
        links: normalizeReportLinks(report.links),
      },
      groups: groups,
      groupById: groupById,
      cases: cases,
      evidenceById: evidenceById,
      evidenceList: evidenceList,
    };
  }

  function groupNavTitle(model, groupId) {
    var g = model.groupById[groupId];
    return g ? (g.displayTitle || g.title || g.id) : '未分组';
  }

  function defaultStepIndex(c, evidenceById) {
    if (!c || !c.steps.length) return 0;
    var byId = evidenceById || {};
    for (var i = 0; i < c.steps.length; i += 1) {
      if (isPageStep(c.steps[i]) && resolveStepImage(c.steps[i], byId).src) return i;
    }
    return 0;
  }

  /* ---------- 验证逻辑（question → focus → comparison → conclusion → statement） ---------- */
  var DESIGN_KIND_LABEL = {
    requirement: '需求原话', rule: '既有规则', impact: '影响路径', history: '历史问题',
    confirmation: '确认结论', evidence: '原核对/证据', design: '设计稿',
  };
  function normalizeCaseDesign(design) {
    var why = isObj(design) ? str(design.why).trim() : '';
    if (!why) return null;
    var sources = (Array.isArray(design.sources) ? design.sources : []).filter(isObj).map(function (s) {
      return {
        kind: str(s.kind),
        label: str(s.label),
        quote: str(s.quote),
        ref: str(s.ref),
        url: safeHttpsUrl(s.url),
        note: str(s.note),
      };
    });
    return { why: why, sources: sources };
  }
  function normalizeComparison(item) {
    if (!isObj(item)) return null;
    return {
      label: str(item.label) || '未命名核对项',
      expected: str(item.expected),
      actual: str(item.actual),
      expectedSource: str(item.expectedSource),
      actualSource: str(item.actualSource),
      status: str(item.status),
      evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.filter(function (id) { return typeof id === 'string' && id; }) : [],
    };
  }
  function normalizeFocus(item) {
    if (!isObj(item)) return null;
    var cellRefs = (Array.isArray(item.cellRefs) ? item.cellRefs : []).filter(function (ref) {
      return isObj(ref) && Number.isInteger(ref.resultSet) && Number.isInteger(ref.row) && str(ref.column);
    }).map(function (ref) {
      return { resultSet: ref.resultSet, row: ref.row, column: str(ref.column), note: str(ref.note) };
    });
    return {
      label: str(item.label) || '核验节点',
      reason: str(item.reason),
      expected: str(item.expected),
      actual: str(item.actual),
      evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.filter(function (id) { return typeof id === 'string' && id; }) : [],
      cellRefs: cellRefs,
    };
  }
  function normalizeResultSet(item, index) {
    if (!isObj(item)) return null;
    var evidenceId = str(item.evidenceId);
    if (!evidenceId) return null;
    return { index: num(index, 0), evidenceId: evidenceId, label: str(item.label), jsonPointer: str(item.jsonPointer), columnLabels: isObj(item.columnLabels) ? item.columnLabels : {} };
  }
  /* 设计对照只指向报告内已有的真实 UED 图片证据；没有素材时不生成示意预览。 */
  function normalizeUed(ued) {
    if (!isObj(ued) || !str(ued.evidenceId)) return null;
    return {
      evidenceId: str(ued.evidenceId),
      title: str(ued.title),
      caption: str(ued.caption),
      note: str(ued.note),
      sourceUrl: safeHttpsUrl(ued.sourceUrl),
    };
  }
  function normalizePrefill(prefill) {
    if (!isObj(prefill)) return null;
    var url = safeHttpsUrl(prefill.url);
    var parameters = (Array.isArray(prefill.parameters) ? prefill.parameters : []).filter(isObj)
      .map(function (p) { return { name: str(p.name), value: str(p.value) }; })
      .filter(function (p) { return !!p.name; });
    if (!url || !parameters.length) return null;
    return { url: url, parameters: parameters, environment: str(prefill.environment), note: str(prefill.note) };
  }
  function normalizeReproduction(r) {
    if (!isObj(r)) return null;
    var out = {};
    Object.keys(r).forEach(function (key) { out[key] = r[key]; });
    out.prefill = normalizePrefill(r.prefill);
    return out;
  }
  /* 预填参数按名称还原成对象文本，只用于复制/对照；报告不据此发起调用。 */
  function prefillParamText(prefill) {
    if (!prefill || !prefill.parameters) return '';
    var obj = {};
    prefill.parameters.forEach(function (p) { obj[p.name] = p.value; });
    return JSON.stringify(obj, null, 2);
  }
  /* 蓝图工具从 hash 路由的 params 查询值读取 JSON 快照；地址由核验入口与参数合成，打开只预填不执行。 */
  function prefillHref(prefill) {
    if (!prefill || !prefill.url || !prefill.parameters.length) return '';
    var obj = {};
    prefill.parameters.forEach(function (p) { obj[p.name] = p.value; });
    var sep = prefill.url.indexOf('?') === -1 ? '?' : '&';
    return prefill.url + sep + 'params=' + encodeURIComponent(JSON.stringify(obj));
  }
  function normalizeStatement(statement) {
    if (!isObj(statement)) return null;
    return {
      kind: str(statement.kind),
      text: str(statement.text),
      origin: str(statement.origin),
      explanation: str(statement.explanation),
      parameters: Array.isArray(statement.parameters) ? statement.parameters.filter(isObj).map(function (p) {
        return { name: str(p.name), value: str(p.value), reason: str(p.reason) };
      }) : [],
    };
  }
  function relatedChecks(step, c) {
    var checks = c && Array.isArray(c.checks) ? c.checks : [];
    var byStep = checks.filter(function (ch) { return ch && ch.stepId === step.id; });
    if (byStep.length) return byStep;
    var ids = step.evidenceIds || [];
    return checks.filter(function (ch) {
      return ch && Array.isArray(ch.evidenceIds) && ch.evidenceIds.some(function (id) { return ids.indexOf(id) !== -1; });
    });
  }
  function buildVerification(step, c) {
    var v = step && step.verification;
    if (isObj(v)) {
      return {
        provided: true,
        question: str(v.question) || step.navTitle,
        method: str(v.method) || step.action,
        focus: (Array.isArray(v.focus) ? v.focus : []).map(normalizeFocus).filter(Boolean),
        comparison: (Array.isArray(v.comparison) ? v.comparison : []).map(normalizeComparison).filter(Boolean),
        resultSets: (Array.isArray(v.resultSets) ? v.resultSets : []).map(normalizeResultSet).filter(Boolean),
        ued: normalizeUed(v.ued),
        conclusion: str(v.conclusion),
        limitations: (Array.isArray(v.limitations) ? v.limitations : []).map(str).filter(Boolean),
        statement: normalizeStatement(v.statement),
        response: isObj(v.response) ? v.response : null,
        fallback: false,
        stepRecord: null,
      };
    }
    var checks = relatedChecks(step, c);
    return {
      provided: false,
      question: step.expected ? ('本步骤要确认：' + step.expected) : step.navTitle,
      method: step.action,
      focus: [],
      comparison: checks.map(function (ch) {
        return normalizeComparison({
          label: ch.title,
          expected: ch.expected,
          actual: ch.actual,
          status: ch.status,
          evidenceIds: ch.evidenceIds,
        });
      }).filter(Boolean),
      resultSets: [],
      ued: null,
      conclusion: step.actual,
      limitations: ['该步骤未提供结构化验证说明；以下由步骤记录与关联核对项整理，不推断通过。'],
      statement: null,
      fallback: true,
      stepRecord: { action: step.action, expected: step.expected, actual: step.actual, status: step.status },
    };
  }

  /* ---------- 图片解析 ---------- */
  function resolveStepImage(step, evidenceById) {
    if (!step) return { src: '', evidence: null, title: '', module: '' };
    var ids = [];
    if (step.pageView && step.pageView.imageEvidenceId) ids.push(str(step.pageView.imageEvidenceId));
    (step.evidenceIds || []).forEach(function (id) { ids.push(id); });
    for (var i = 0; i < ids.length; i += 1) {
      var ev = evidenceById[ids[i]];
      if (!ev || ev.type !== 'image') continue;
      var src = safeImgSrc(ev.dataUri || ev.file);
      if (!src) continue;
      return {
        src: src,
        evidence: ev,
        title: str(step.pageView && (step.pageView.caption || step.pageView.title)),
        module: step.page || '',
      };
    }
    return { src: '', evidence: null, title: '', module: step.page || '' };
  }

  /* ---------- 证据渲染（详情可展开，只按文本） ---------- */
  function evidenceIdsOf(step, verification) {
    var ids = [];
    (step.evidenceIds || []).forEach(function (id) { ids.push(id); });
    if (verification && verification.provided) {
      (verification.focus || []).forEach(function (f) { (f.evidenceIds || []).forEach(function (id) { ids.push(id); }); });
      (verification.comparison || []).forEach(function (cmp) { (cmp.evidenceIds || []).forEach(function (id) { ids.push(id); }); });
    }
    if (step.reproduction) {
      (Array.isArray(step.reproduction.sourceIds) ? step.reproduction.sourceIds : []).forEach(function (id) { ids.push(id); });
    }
    return uniq(ids);
  }

  function evidenceContentText(ev) {
    if (!isObj(ev) || ev.content === undefined || ev.content === null) return '';
    if (typeof ev.content === 'string') return ev.content;
    try { return JSON.stringify(ev.content, null, 2); } catch (e) { return str(ev.content); }
  }

  /* ---------- 证据原文的保真读取 ----------
   * 结果表与接口响应都从证据原文读取：只解析结构，不重新序列化，
   * 每个节点保留原文偏移，单元格直接取原文字符串片段。
   * 因此 9007199254740993、1.000000 与重复键都不会被 JSON.parse → stringify 改掉。 */
  function readJsonTree(text) {
    var src = str(text);
    var i = 0;
    function ws() { while (i < src.length && /\s/.test(src.charAt(i))) i += 1; }
    function bad() { throw new Error('bad json'); }
    function readEscaped() {
      var code = src.charAt(i + 1);
      if (code === 'u') {
        var hex = src.substr(i + 2, 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad();
        i += 6;
        return String.fromCharCode(parseInt(hex, 16));
      }
      var map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (!Object.prototype.hasOwnProperty.call(map, code)) bad();
      i += 2;
      return map[code];
    }
    function readString() {
      var start = i;
      i += 1;
      var out = '';
      while (i < src.length) {
        var ch = src.charAt(i);
        if (ch === '"') { i += 1; return { type: 'string', value: out, start: start, end: i }; }
        if (ch === '\\') { out += readEscaped(); continue; }
        out += ch;
        i += 1;
      }
      bad();
    }
    function readNumber() {
      var start = i;
      var m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m || !m[0]) bad();
      i += m[0].length;
      return { type: 'number', raw: m[0], start: start, end: i };
    }
    function readObject() {
      var start = i;
      i += 1;
      var entries = [];
      ws();
      if (src.charAt(i) === '}') { i += 1; return { type: 'object', entries: entries, start: start, end: i }; }
      for (;;) {
        ws();
        if (src.charAt(i) !== '"') bad();
        var key = readString();
        ws();
        if (src.charAt(i) !== ':') bad();
        i += 1;
        entries.push({ key: key.value, node: readValue() });
        ws();
        var next = src.charAt(i);
        if (next === ',') { i += 1; continue; }
        if (next === '}') { i += 1; return { type: 'object', entries: entries, start: start, end: i }; }
        bad();
      }
    }
    function readArray() {
      var start = i;
      i += 1;
      var items = [];
      ws();
      if (src.charAt(i) === ']') { i += 1; return { type: 'array', items: items, start: start, end: i }; }
      for (;;) {
        items.push(readValue());
        ws();
        var next = src.charAt(i);
        if (next === ',') { i += 1; continue; }
        if (next === ']') { i += 1; return { type: 'array', items: items, start: start, end: i }; }
        bad();
      }
    }
    function readValue() {
      ws();
      var ch = src.charAt(i);
      if (ch === '{') return readObject();
      if (ch === '[') return readArray();
      if (ch === '"') return readString();
      var start = i;
      if (src.substr(i, 4) === 'true') { i += 4; return { type: 'boolean', value: true, start: start, end: i }; }
      if (src.substr(i, 5) === 'false') { i += 5; return { type: 'boolean', value: false, start: start, end: i }; }
      if (src.substr(i, 4) === 'null') { i += 4; return { type: 'null', value: null, start: start, end: i }; }
      return readNumber();
    }
    try {
      var root = readValue();
      ws();
      if (i !== src.length) return null;
      return root;
    } catch (e) {
      return null;
    }
  }

  function jsonEntry(node, key) {
    if (!node || node.type !== 'object') return null;
    for (var i = 0; i < node.entries.length; i += 1) {
      if (node.entries[i].key === key) return node.entries[i].node;
    }
    return null;
  }

  /* jsonPointer 只支持对象键与数组下标，用于显式指定结果集在证据里的位置。 */
  function jsonPointerNode(node, pointer) {
    var path = str(pointer);
    if (!path) return node;
    if (path.charAt(0) !== '/') return null;
    var parts = path.slice(1).split('/').map(function (part) {
      return part.replace(/~1/g, '/').replace(/~0/g, '~');
    });
    var current = node;
    for (var i = 0; i < parts.length; i += 1) {
      if (!current) return null;
      if (current.type === 'object') current = jsonEntry(current, parts[i]);
      else if (current.type === 'array' && /^\d+$/.test(parts[i])) current = current.items[Number(parts[i])] || null;
      else return null;
    }
    return current || null;
  }

  /* 单元格保留原值：null 与字符串 "<NULL>" 是两种不同的东西，缺字段单独标记。 */
  function jsonCell(node, src) {
    if (!node) return { kind: 'missing' };
    if (node.type === 'null') return { kind: 'null' };
    if (node.type === 'string') return { kind: 'text', text: node.value };
    if (node.type === 'number') return { kind: 'text', text: node.raw };
    if (node.type === 'boolean') return { kind: 'text', text: node.value ? 'true' : 'false' };
    return { kind: 'json', text: src.slice(node.start, node.end) };
  }

  function jsonRowCells(node, columns, src) {
    if (node && node.type === 'object') {
      return columns.map(function (name) { return jsonCell(jsonEntry(node, name), src); });
    }
    if (node && node.type === 'array') {
      if (!columns.length) return node.items.map(function (item) { return jsonCell(item, src); });
      return columns.map(function (_, index) { return jsonCell(node.items[index], src); });
    }
    if (columns.length === 1) return [jsonCell(node, src)];
    return columns.map(function () { return { kind: 'missing' }; });
  }

  /* 只认显式列名 + 行数组，或单行 row：比对表、明细清单、分页列表都不会被当成查询结果。
   * 列名兼容 columns 与 CLI 结果常用的 columnNames，仍然只按内容识别。 */
  function jsonTable(node, src) {
    if (!node || node.type !== 'object') return null;
    var columnsNode = jsonEntry(node, 'columns') || jsonEntry(node, 'columnNames');
    var rowsNode = jsonEntry(node, 'rows');
    var rowNode = jsonEntry(node, 'row');
    var columns = [];
    if (columnsNode && columnsNode.type === 'array') {
      columns = columnsNode.items.map(function (item) {
        return item.type === 'string' ? item.value : '';
      }).filter(function (name) { return !!name; });
    }
    if (columns.length && rowsNode && rowsNode.type === 'array') {
      return {
        columns: columns,
        rows: rowsNode.items.map(function (item) { return jsonRowCells(item, columns, src); }),
        rowNodes: rowsNode.items.slice(),
      };
    }
    if (rowNode && rowNode.type === 'object' && rowNode.entries.length) {
      var keys = rowNode.entries.map(function (entry) { return entry.key; });
      return { columns: keys, rows: [jsonRowCells(rowNode, keys, src)], rowNodes: [rowNode] };
    }
    return null;
  }

  function evidenceTree(ev) {
    var text = evidenceContentText(ev);
    if (!text) return null;
    var tree = readJsonTree(text);
    if (!tree) return null;
    return { text: text, tree: tree };
  }

  function makeResultSet(ev, table, label, text, copyKey, index) {
    return {
      index: num(index, 0),
      evidenceId: str(ev.id),
      title: str(ev.title) || str(ev.id),
      label: str(label),
      copyKey: str(copyKey) || ('result-' + str(ev.id)),
      copyText: str(text),
      /* 行详情按原文偏移切片，必须拿到与 copyText 相同的原文。 */
      text: str(text),
      columns: table.columns,
      rows: table.rows,
      rowNodes: table.rowNodes || [],
      columnLabels: table.columnLabels || {},
    };
  }

  /* 结果集只从本步骤 evidenceIds 的证据原文里取；显式 resultSets 用于指定 jsonPointer 与语义标签。
   * 表格按证据顺序展示，便于与原始材料对照；显式条目另记 focusIndex = resultSets 下标，
   * 使 verification.focus.cellRefs.resultSet 能定位到正确的表，而不受展示顺序影响。 */
  function buildResultSets(step, model, verification) {
    var out = [];
    var specs = (verification && verification.resultSets) || [];
    var byEvidence = Object.create(null);
    specs.forEach(function (spec, specIndex) {
      byEvidence[spec.evidenceId] = (byEvidence[spec.evidenceId] || []).concat([{ spec: spec, specIndex: specIndex }]);
    });
    var extras = 0;
    (step.evidenceIds || []).forEach(function (id) {
      var ev = model.evidenceById[id];
      if (!ev || ev.type === 'image') return;
      var parsed = evidenceTree(ev);
      if (!parsed) return;
      var explicit = byEvidence[id];
      if (explicit && explicit.length) {
        explicit.forEach(function (entry) {
          var table = jsonTable(jsonPointerNode(parsed.tree, entry.spec.jsonPointer), parsed.text);
          if (!table) return;
          table.columnLabels = entry.spec.columnLabels;
          var set = makeResultSet(ev, table, entry.spec.label, parsed.text,
            'result-' + str(ev.id) + '-' + entry.specIndex, out.length);
          set.focusIndex = entry.specIndex;
          out.push(set);
        });
        return;
      }
      var auto = jsonTable(parsed.tree, parsed.text);
      if (!auto) return;
      var autoSet = makeResultSet(ev, auto, '', parsed.text, 'result-' + str(ev.id), out.length);
      autoSet.focusIndex = specs.length + extras;
      extras += 1;
      out.push(autoSet);
    });
    return out;
  }

  /* 接口/HSF 的实际响应：只认 invoke_result / response / result 这些业务响应字段，
   * 不把 metadata、请求回显或成功标志当业务响应。 */
  function responseNode(tree) {
    var i;
    for (i = 0; i < RESPONSE_KEYS.length; i += 1) {
      var node = jsonEntry(tree, RESPONSE_KEYS[i]);
      if (node && (node.type === 'object' || node.type === 'array')) {
        return { node: node, pointer: '/' + RESPONSE_KEYS[i] };
      }
    }
    var data = jsonEntry(tree, 'data');
    if (data && data.type === 'object') {
      for (i = 0; i < RESPONSE_KEYS.length; i += 1) {
        var inner = jsonEntry(data, RESPONSE_KEYS[i]);
        if (inner && (inner.type === 'object' || inner.type === 'array')) {
          return { node: inner, pointer: '/data/' + RESPONSE_KEYS[i] };
        }
      }
    }
    return null;
  }

  function buildResponse(step, model, verification) {
    var ids = step.evidenceIds || [];
    var explicit = verification && verification.response;
    if (explicit && ids.indexOf(explicit.evidenceId) < 0) return null;
    if (explicit && ids.indexOf(explicit.evidenceId) >= 0) {
      var source = model.evidenceById[explicit.evidenceId];
      if (source && source.type !== 'image') {
        var original = evidenceContentText(source), parsed = evidenceTree(source);
        var node = parsed && jsonPointerNode(parsed.tree, explicit.jsonPointer || '');
        if (node) return {evidenceId:source.id,title:source.title,pointer:explicit.jsonPointer || '/',node:node,text:original};
        if (original && source.type === 'text' && !explicit.jsonPointer) return {evidenceId:source.id,title:source.title,pointer:'原始文本',plainText:true,text:original};
      }
      return null;
    }
    for (var i = 0; i < ids.length; i += 1) {
      var ev = model.evidenceById[ids[i]];
      if (!ev || ev.type === 'image') continue;
      var parsed = evidenceTree(ev);
      if (!parsed) continue;
      var hit = responseNode(parsed.tree);
      if (!hit) continue;
      return {
        evidenceId: str(ids[i]),
        title: str(ev.title) || str(ids[i]),
        pointer: hit.pointer,
        node: hit.node,
        text: parsed.text,
      };
    }
    return null;
  }

  function responseFields(node, src) {
    if (!node || node.type !== 'object') return [];
    return node.entries.map(function (entry) {
      return { name: entry.key, cell: jsonCell(entry.node, src) };
    });
  }

  /* ---------- 代码阅读 ----------
   * 中央核验台、右侧检视器、复现参数与展开证据共用同一个渲染器：
   * 它只负责“把同一段原文排得更好读”，原文与复制内容都不经过格式化。
   * vendor 未加载时返回空串，调用方退回原有 <pre>，既有交互不变。 */
  function codeViewApi() {
    if (typeof window !== 'undefined' && window.AcceptanceCodeView) return window.AcceptanceCodeView;
    if (typeof globalThis !== 'undefined' && globalThis.AcceptanceCodeView) return globalThis.AcceptanceCodeView;
    return null;
  }

  function codeViewHtml(text, hint, opts) {
    var api = codeViewApi();
    var raw = str(text);
    if (!api || !raw) return '';
    var options = { text: raw, hint: hint };
    if (opts && opts.copyKey) {
      options.copyKey = opts.copyKey;
      options.copyLabel = opts.copyLabel;
    }
    return api.render(options);
  }

  /* 切换只翻转两个已渲染块的显隐；不重新格式化，也不影响复制键里的原文。 */
  function toggleCodeView(button) {
    var box = button.closest('[data-code-view]');
    if (!box) return;
    var blocks = box.querySelectorAll('[data-code-mode]');
    if (blocks.length < 2) return;
    var showOriginal = button.getAttribute('aria-pressed') !== 'true';
    Array.prototype.forEach.call(blocks, function (block) {
      var isOriginal = block.getAttribute('data-code-mode') === 'original';
      block.hidden = showOriginal ? !isOriginal : isOriginal;
    });
    button.setAttribute('aria-pressed', showOriginal ? 'true' : 'false');
    var label = button.querySelector('[data-code-toggle-label]');
    if (label) {
      var api = codeViewApi();
      label.textContent = api && api.toggleLabel
        ? api.toggleLabel(showOriginal)
        : (showOriginal ? '查看格式化' : '查看原文');
    }
  }

  function renderEvidenceItems(ids, evidenceById) {
    return (ids || []).map(function (id) {
      var ev = evidenceById[id];
      if (!ev) {
        return '<div class="ev-item"><div class="ev-item-head"><span class="ev-title">证据未随报告提供</span></div>' +
          '<div class="ev-meta mono">' + esc(id) + '</div></div>';
      }
      var title = str(ev.title) || '未命名证据';
      var type = str(ev.type) || 'evidence';
      var meta = [];
      if (ev.source) meta.push('来源：' + str(ev.source));
      if (ev.file) meta.push('文件：' + str(ev.file));
      if (ev.sha256) meta.push('sha256：' + str(ev.sha256));
      var content = evidenceContentText(ev);
      var img = '';
      if (ev.type === 'image') {
        var src = safeImgSrc(ev.dataUri || ev.file);
        if (src) img = '<button type="button" class="ev-img-btn" data-lightbox-evidence="' + esc(id) + '" title="点击放大查看原图与标注">' +
          '<img class="ev-img" alt="' + esc(title) + '" src="' + esc(src) + '"/>' +
          '<span class="ev-img-hint">' + icon('zoom_in') + '查看大图' +
          (Array.isArray(ev.annotations) && ev.annotations.length ? ' · ' + ev.annotations.length + ' 处标注' : '') +
          '</span></button>';
      }
      var body = '';
      if (content) {
        var copyKey = 'ev-content-' + id;
        registerCopy(copyKey, content);
        body = codeViewHtml(content, type, { copyKey: copyKey, copyLabel: '复制原文' }) ||
          '<pre class="pre">' + esc(content) + '</pre>';
      }
      return '<div class="ev-item">' +
        '<div class="ev-item-head"><span class="ev-type">' + esc(type) + '</span><span class="ev-title">' + esc(title) + '</span></div>' +
        (meta.length ? '<div class="ev-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
        img +
        (content ? '<details class="ev-content"><summary>查看原始内容</summary>' + body + '</details>' : '') +
        '</div>';
    }).join('');
  }

  function renderEvidenceAccordion(ids, evidenceById, label) {
    if (!ids || !ids.length) return '';
    return '<details class="ev-group"><summary>' + icon('description') + esc(label || ('原始证据（' + ids.length + '）')) +
      '</summary>' + renderEvidenceItems(ids, evidenceById) + '</details>';
  }

  /* ---------- 左栏：列表与筛选 ---------- */
  function caseItemHtml(c, selectedId, index) {
    var active = c.id === selectedId;
    var key = statusKeyOf(c.status);
    var dot = c.isAudit ? 'dot-audit' : (STATUS_DOT[key] || 'dot-not_run');
    var label = statusLabel(c.status, c.isAudit);
    return '<button type="button" class="case-item' + (active ? ' active' : '') + '" data-case-index="' + index + '"' +
      (active ? ' aria-current="true"' : '') + '>' +
      '<div class="case-item-top"><span class="case-item-title">' + esc(c.navTitle) + '</span>' +
      '<span class="status-dot ' + dot + '" title="' + esc(label) + '"></span></div>' +
      '<div class="case-item-meta"><span><span class="role-chip ' + (ROLE_CLASS[caseRoleOf(c)] || '') + '">' + esc(roleLabel(caseRoleOf(c))) + '</span></span>' +
      '<span>' + c.steps.length + ' 步 · ' + esc(label) + '</span></div></button>';
  }

  function renderCaseGroups(model, filters, selectedId) {
    var visible = filterCases(model, filters);
    if (!visible.length) {
      return '<div class="list-empty">当前筛选没有匹配的用例<br/><span>状态、目的、类型与搜索为 AND 组合</span></div>';
    }
    var byGroup = Object.create(null);
    visible.forEach(function (c) {
      var key = c.groupId && model.groupById[c.groupId] ? c.groupId : '__ungrouped__';
      (byGroup[key] = byGroup[key] || []).push(c);
    });
    var html = '';
    model.groups.forEach(function (g) {
      var list = byGroup[g.id];
      if (!list || !list.length) return;
      html += '<div class="group-label"><span title="' + esc(g.displayTitle || g.title) + '">' + esc(g.displayTitle || g.title) + '</span><span>' + list.length + '</span></div>';
      list.forEach(function (c) { html += caseItemHtml(c, selectedId, model.cases.indexOf(c)); });
      delete byGroup[g.id];
    });
    var rest = [];
    Object.keys(byGroup).forEach(function (key) { rest = rest.concat(byGroup[key]); });
    if (rest.length) {
      html += '<div class="group-label"><span>未分组</span><span>' + rest.length + '</span></div>';
      rest.forEach(function (c) { html += caseItemHtml(c, selectedId, model.cases.indexOf(c)); });
    }
    return html;
  }

  function filterButton(dimension, value, label, count, active) {
    return '<button type="button" class="filter-btn' + (active ? ' active' : '') + '" data-filter="' + dimension +
      '" data-value="' + value + '">' + esc(label) + ' ' + count + '</button>';
  }

  function renderFilters(model, filters) {
    var f = normalizeFilters(filters);
    var counts = computeCounts(model, f);
    var statusCounts = f.role === 'audit' ? counts.auditStatus : counts.status;
    var statusHtml = '<span class="filter-label">状态</span>' +
      filterButton('status', 'all', '全部', statusCounts.all, f.status === 'all') +
      STATUSES.map(function (s) {
        return filterButton('status', s, STATUS_LABEL[s], statusCounts[s], f.status === s);
      }).join('');
    var roleHtml = '<span class="filter-label">目的</span>' +
      filterButton('role', 'all', '全部', counts.role.all, f.role === 'all') +
      ROLE_ORDER.map(function (r) {
        if (r === 'unknown' && !counts.role[r]) return '';
        return filterButton('role', r, ROLE_LABEL[r], counts.role[r], f.role === r);
      }).join('');
    var pageHtml = '<span class="filter-label">类型</span>' +
      filterButton('page', 'all', '全部', counts.page.all, f.page === 'all') +
      filterButton('page', 'page', '页面', counts.page.page, f.page === 'page') +
      filterButton('page', 'data', '接口/数据', counts.page.data, f.page === 'data');
    var activeGroup = f.group !== 'all' ? model.groupById[f.group] : null;
    var activeLabel = activeGroup ? (activeGroup.displayTitle || activeGroup.title || activeGroup.id) : '全部业务分组';
    var activeCount = counts.group[f.group] || 0;
    var groupOptions = groupOptionHtml('all', '全部业务分组', counts.group.all, f.group === 'all') +
      model.groups.map(function (g) {
        return groupOptionHtml(g.id, g.displayTitle || g.title || g.id, counts.group[g.id] || 0, f.group === g.id);
      }).join('');
    var groupHtml = '<span class="filter-label">业务分组</span>' +
      '<div class="group-select" data-group-select>' +
      '<button type="button" class="group-toggle" data-group-toggle aria-haspopup="listbox" aria-expanded="false" title="业务分组：' + esc(activeLabel) + '">' +
      '<span class="group-toggle-label">' + esc(activeLabel) + '</span>' +
      '<span class="group-count">' + activeCount + '</span>' + icon('expand_more') + '</button>' +
      '<div class="group-menu" role="listbox" aria-label="业务分组" hidden>' + groupOptions + '</div></div>';
    return { group: groupHtml, status: statusHtml, role: roleHtml, page: pageHtml, counts: counts };
  }

  function groupOptionHtml(value, label, count, active) {
    return '<button type="button" class="group-option' + (active ? ' active' : '') + '" role="option"' +
      ' aria-selected="' + (active ? 'true' : 'false') + '" data-group-value="' + esc(value) + '"' +
      ' title="' + esc(label) + '">' +
      '<span class="group-option-label">' + esc(label) + '</span><span class="group-option-count">' + count + '</span></button>';
  }

  /* ---------- 用例条：一行主信息，详情收进浮层 ---------- */
  function renderCaseBar(model, c, report) {
    var key = statusKeyOf(c.status);
    var pillClass = c.isAudit ? 'audit' : key;
    var chips = [];
    if (report && report.revision) chips.push('<span class="chip">版本 <span class="mono">' + esc(report.revision) + '</span></span>');
    if (c.isAudit) chips.push('<span class="chip warn">执行审计记录 · 非产品用例</span>');
    return '<div class="case-bar-main">' +
      '<h1 class="case-title" title="' + esc(c.navTitle) + '">' + esc(c.navTitle) + '</h1>' +
      '<span class="status-pill ' + pillClass + '">' + icon(STATUS_ICON[key] || 'info') + esc(statusLabel(c.status, c.isAudit)) + '</span>' +
      '<span class="role-chip ' + (ROLE_CLASS[caseRoleOf(c)] || '') + '">' + esc(roleLabel(caseRoleOf(c))) + '</span>' +
      (c.objective ? '<span class="case-objective" title="' + esc(c.objective) + '">' + esc(c.objective) + '</span>' : '') +
      '</div>' +
      '<div class="case-bar-right">' + chips.join('') +
      '<button type="button" class="btn" data-case-detail aria-expanded="false">' + icon('description') + '用例详情</button></div>';
  }

  function checkRowsHtml(c) {
    if (!c.checks.length) return '<div class="panel-note">该用例未提供独立核对项。</div>';
    return c.checks.map(function (ch) {
      var key = statusKeyOf(ch.status);
      return '<div class="check-row"><span class="cmp-status ' + key + '">' + icon(STATUS_ICON[key] || 'info') + esc(statusLabel(ch.status, false)) + '</span>' +
        '<b class="check-title">' + esc(str(ch.title) || '未命名核对项') + '</b>' +
        '<div class="panel-note">预期：' + esc(ch.expected) + ' · 实际：' + esc(ch.actual) + '</div></div>';
    }).join('');
  }

  function renderCaseDetail(c) {
    var bits = [];
    bits.push('<div><b>用例ID（内部）</b><div class="mono">' + esc(c.id) + '</div></div>');
    if (c.requirement) bits.push('<div><b>需求</b><div>' + esc(c.requirement) + '</div></div>');
    if (c.caseRoleReason) bits.push('<div class="wide"><b>分类理由</b><div>' + esc(c.caseRoleReason) + '</div></div>');
    if (c.caseRoleSources.length) {
      bits.push('<div class="wide"><b>分类来源</b><div class="source-chips">' + c.caseRoleSources.map(function (s) {
        return '<span class="source-chip">' + esc(s) + '</span>';
      }).join('') + '</div></div>');
    }
    if (c.preconditions.length) {
      bits.push('<div class="wide"><b>前置条件</b><ul class="detail-list">' + c.preconditions.map(function (p) {
        return '<li>' + esc(p) + '</li>';
      }).join('') + '</ul></div>');
    }
    bits.push('<div class="wide"><b>核对项（' + c.checks.length + '）</b>' + checkRowsHtml(c) + '</div>');
    return '<div class="case-detail-head"><h2>用例详情</h2>' +
      '<button type="button" class="icon-btn" data-case-detail-close title="关闭">' + icon('close') + '</button></div>' +
      '<div class="case-detail-body">' + bits.join('') + '</div>';
  }

  /* ---------- 步骤条（单行横向滚动，卡片之间用箭头连接） ---------- */
  function renderSteps(c, selectedIndex) {
    var out = [];
    c.steps.forEach(function (s, i) {
      var key = statusKeyOf(s.status);
      var v = isObj(s.verification) ? s.verification : null;
      var comparisons = v && Array.isArray(v.comparison) ? v.comparison.filter(isObj) : [];
      var sub = statusLabel(s.status, false);
      if (comparisons.length) {
        var passed = comparisons.filter(function (x) { return x.status === 'passed'; }).length;
        sub += ' · ' + passed + '/' + comparisons.length + ' 项核对';
      }
      var type = TYPE_LABEL[s.type] || s.type || '步骤';
      out.push('<button type="button" class="step-card' + (i === selectedIndex ? ' active' : '') + '" data-step-index="' + i + '"' +
        (i === selectedIndex ? ' aria-current="step"' : '') + ' title="' + esc(s.navTitle) + '">' +
        '<span class="step-card-row"><span class="step-no">' + pad2(i + 1) + '</span>' +
        '<span class="step-type ' + (TYPE_CLASS[s.type] || '') + '">' + esc(type) + '</span>' +
        '<span class="step-title">' + esc(s.navTitle) + '</span>' +
        '<span class="status-dot ' + (STATUS_DOT[key] || 'dot-not_run') + '"></span></span>' +
        '<span class="step-sub">' + esc(sub) + '</span></button>');
      if (i < c.steps.length - 1) out.push('<span class="step-arrow" aria-hidden="true">' + icon('arrow_forward') + '</span>');
    });
    return out.join('');
  }

  /* ---------- 中央核验台：页面步骤看截图，其他步骤看语句 + 真实结果 ---------- */
  function moduleLabel(step, c, model) {
    return (step && step.page) || groupNavTitle(model, c.groupId);
  }

  function buildStageModel(step, c, model) {
    var vm = buildVerification(step, c);
    var statement = vm.statement;
    var kind = statement ? statement.kind : '';
    var resultSets = buildResultSets(step, model, vm);
    var response = buildResponse(step, model, vm);
    var mode = 'record';
    /* 语句形态决定上屏语义；只有完全没有语句形态、仅剩结果表时才按查询结果展示。 */
    if (kind === 'sql') mode = 'sql';
    else if (kind || response) mode = 'api';
    else if (resultSets.length) mode = 'sql';
    return {
      mode: mode,
      vm: vm,
      statement: statement,
      kind: kind,
      resultSets: resultSets,
      response: response,
      requestTemplate: mode === 'api' ? str(step.reproduction && step.reproduction.params) : '',
    };
  }

  function renderStageBar(step, c, model) {
    var toggle = '<button type="button" class="icon-btn" data-toggle-inspector title="收起 / 展开检视器">' + icon('dock_to_left') + '</button>';
    /* 只有页面步骤的中央区展示截图；其他步骤一律走核验台，图片留在原始材料里。 */
    var image = isPageStep(step) ? resolveStepImage(step, model.evidenceById) : { src: '' };
    if (image.src) {
      var evidenceId = image.evidence ? str(image.evidence.id) : '';
      return '<span class="stage-title">' + icon('image') + '<span>系统截图</span></span>' +
        '<span class="stage-sub">' + esc(moduleLabel(step, c, model)) + '</span>' +
        '<div class="stage-tools">' +
        (image.evidence && image.evidence.annotations.length ? '<button class="btn" type="button" data-stage-annotations aria-pressed="true">重点标注 ' + image.evidence.annotations.length + ' · 隐藏标注</button>' : '') +
        '<button class="icon-btn" type="button" data-zoom="out" title="缩小">−</button>' +
        '<span class="zoom-label" id="zoom-label">适应</span>' +
        '<button class="icon-btn" type="button" data-zoom="in" title="放大">+</button>' +
        '<button class="btn" type="button" data-fit>适应</button>' +
        '<button class="btn" type="button" data-original>原图</button>' +
        (evidenceId ? '<button class="btn" type="button" data-lightbox-evidence="' + esc(evidenceId) + '" title="打开带标注的大图">' +
          icon('zoom_in') + '大图与标注</button>' : '') +
        '<button class="icon-btn" type="button" data-fullscreen id="fullscreen-btn" title="全屏查看截图">' + icon('fullscreen') + '</button>' +
        '<span class="stage-sep"></span>' + toggle +
        '</div>';
    }
    var stage = buildStageModel(step, c, model);
    var metaParts = [];
    if (stage.mode === 'api') metaParts.push('请求 / 响应');
    if (stage.resultSets.length) metaParts.push('真实结果 ' + stage.resultSets.length + ' 组');
    if (!metaParts.length) metaParts.push('步骤材料');
    var meta = (TYPE_LABEL[step.type] || '步骤') + ' · ' + metaParts.join(' · ');
    return '<span class="stage-title">' + icon('terminal') + '<span>步骤验证</span></span>' +
      '<span class="stage-sub">' + esc(moduleLabel(step, c, model) + ' · ' + meta) + '</span>' +
      '<div class="stage-tools">' + toggle + '</div>';
  }

  function consoleLabel(stage) {
    if (stage.mode === 'sql') return '查询语句 · SQL';
    if (stage.mode === 'api') return '请求与响应 · ' + (STMT_KIND[stage.kind] || '接口');
    return '步骤材料';
  }

  function paneHead(iconName, title, metaHtml, toolsHtml) {
    return '<div class="pane-head"><span class="pane-title">' + icon(iconName) + esc(title) + '</span>' +
      (metaHtml || '') +
      '<span class="pane-tools">' + (toolsHtml || '') + '</span></div>';
  }

  function statementPaneHtml(stage) {
    var statement = stage.statement;
    var title = stage.mode === 'api' ? '调用信息' : (stage.mode === 'sql' ? '查询语句' : '步骤原文');
    var meta = '';
    var tools = '';
    var body = '';
    if (statement) {
      var origin = statement.origin;
      var copyText = statementCopyText(statement);
      meta = '<span class="origin ' + (ORIGIN_LABEL[origin] ? origin : '') + '">' +
        esc(ORIGIN_LABEL[origin] || str(origin) || '来源未标注') + '</span>' +
        '<span class="stmt-kind">' + esc(STMT_KIND[statement.kind] || '查询 / 请求') + '</span>';
      if (copyText) {
        registerCopy('stage-statement', copyText);
        tools = '<button type="button" class="btn btn-quiet" data-copy-key="stage-statement">' +
          icon('content_copy') + '复制原文</button>';
        body = codeViewHtml(copyText, statement.kind) ||
          '<pre class="pre stmt-text">' + esc(copyText) + '</pre>';
        if (statement.explanation) {
          body += '<div class="pane-note">' + esc(statement.explanation) + '</div>';
        }
      } else {
        body = '<div class="pane-note">' +
          esc(statement.explanation || '该步骤未留存查询或请求原文；未提供原文时不生成替代 SQL。') + '</div>';
      }
    } else {
      body = '<div class="pane-note">该步骤未提供查询或请求原文。</div>';
    }
    if (stage.requestTemplate) {
      registerCopy('stage-request-template', stage.requestTemplate);
      body += '<div class="template-block"><div class="template-head">' + icon('data_object') +
        '<span>参数模板</span><span class="template-note">占位符模板，不是原始执行参数</span>' +
        '<button type="button" class="btn btn-quiet" data-copy-key="stage-request-template">' +
        icon('content_copy') + '复制模板</button></div>' +
        (codeViewHtml(stage.requestTemplate, '') || '<pre class="pre">' + esc(stage.requestTemplate) + '</pre>') +
        '</div>';
    }
    return '<section class="console-pane console-top" data-console-pane="statement">' +
      paneHead('terminal', title, meta, tools) +
      '<div class="pane-body custom-scrollbar">' + body + '</div></section>';
  }

  /* ---------- 关注单元格 / 行详情 ---------- */
  /* 关注单元格只按 cellRefs 定位：结果集序号 + 行号 + 字段名。
   * 定位在渲染时落到单元格上，右侧说明保留整体叙述，不改写任何原值。 */
  var focusCellRegistry = Object.create(null);
  function circled(index) {
    var i = num(index, 0);
    return CIRCLE_NUMBERS[i - 1] || ('(' + i + ')');
  }
  function resetFocusCells() { focusCellRegistry = Object.create(null); }
  function focusCellData(key) { return focusCellRegistry[key] || null; }
  function buildFocusMap(focusList) {
    var map = Object.create(null);
    (focusList || []).forEach(function (focus, fi) {
      (focus.cellRefs || []).forEach(function (ref) {
        var key = ref.resultSet + ':' + ref.row + ':' + ref.column;
        (map[key] = map[key] || []).push({ index: fi + 1, focus: focus, ref: ref });
      });
    });
    return map;
  }
  function registerFocusCell(key, entry) { focusCellRegistry[key] = entry; }

  function focusPopHtml(entry) {
    if (!entry || !entry.hits.length) return '';
    var primary = entry.hits[0];
    var f = primary.focus;
    var marks = entry.hits.map(function (hit) { return circled(hit.index); }).join('');
    return '<div class="focus-pop-head"><span class="focus-pop-title">' + esc(f.label) + '</span>' +
      '<span class="focus-pop-chip">核对点 ' + esc(marks) + '</span></div>' +
      '<div class="focus-pop-why"><span>为什么关注</span><b>' + esc(f.reason || '报告未写明关注原因') + '</b></div>' +
      '<div class="focus-pop-compare">' +
      '<div><span>预期</span><b class="mono">' + esc(f.expected || '—') + '</b></div>' +
      '<div><span>实际</span><b class="mono">' + esc(f.actual || '—') + '</b></div></div>' +
      (primary.ref && primary.ref.note ? '<div class="focus-pop-note">' + esc(primary.ref.note) + '</div>' : '') +
      '<div class="focus-pop-src">' + icon('track_changes') + '<span>定位：' + esc(entry.setTitle) +
      (entry.label ? ' · ' + esc(entry.label) : '') + ' · 字段 ' + esc(entry.column) +
      '（第 ' + (entry.row + 1) + ' 行）</span></div>' +
      (f.evidenceIds.length ? '<div class="focus-pop-src">' + icon('inventory_2') + '<span>证据 ' +
        f.evidenceIds.length + ' 条，可在右栏与原始材料中展开</span></div>' : '');
  }

  function rawSlice(node, src) {
    if (!node || !src) return '';
    return src.slice(node.start, node.end);
  }

  /* 字段按原始节点枚举，重复键保留全部出现位置并标出次序；
   * 数组行按结果集列名对齐；复制值一律取原文片段，不做 JSON 重排。 */
  function rowFields(set, rowIndex) {
    var src = str(set.text);
    var node = (set.rowNodes || [])[rowIndex] || null;
    var counts = Object.create(null);
    var entries = [];
    if (node && node.type === 'object') {
      entries = node.entries.map(function (entry) {
        counts[entry.key] = (counts[entry.key] || 0) + 1;
        return { name: entry.key, raw: rawSlice(entry.node, src) };
      });
    } else if (node && node.type === 'array') {
      entries = node.items.map(function (item, i) {
        var name = set.columns[i] || ('#' + (i + 1));
        counts[name] = (counts[name] || 0) + 1;
        return { name: name, raw: rawSlice(item, src) };
      });
    } else if (node) {
      var name0 = set.columns[0] || '值';
      counts[name0] = 1;
      entries = [{ name: name0, raw: rawSlice(node, src) }];
    }
    var seen = Object.create(null);
    return entries.map(function (entry) {
      var total = counts[entry.name] || 1;
      var ordinal = (seen[entry.name] = (seen[entry.name] || 0) + 1);
      return { name: entry.name, raw: entry.raw, duplicate: total > 1, ordinal: ordinal, total: total };
    });
  }
  function rowRawText(set, rowIndex) {
    var node = (set.rowNodes || [])[rowIndex];
    if (!node) return '';
    return rawSlice(node, str(set.text));
  }

  function rowDetailHtml(set, rowIndex) {
    var fields = rowFields(set, rowIndex);
    var whole = rowRawText(set, rowIndex);
    var wholeKey = 'row-json-' + set.index + '-' + rowIndex;
    if (whole) registerCopy(wholeKey, whole);
    var fieldRows = fields.map(function (field, i) {
      var key = 'row-field-' + set.index + '-' + rowIndex + '-' + i;
      registerCopy(key, field.raw);
      return '<tr' + (field.duplicate ? ' class="is-dup"' : '') + '>' +
        '<td class="row-field-name">' + esc(field.name) +
        (field.duplicate ? '<span class="dup-chip">重复键 ' + field.ordinal + '/' + field.total + '</span>' : '') + '</td>' +
        '<td class="row-field-raw"><code>' + esc(field.raw) + '</code></td>' +
        '<td class="row-op"><button type="button" class="btn btn-quiet btn-tiny" data-copy-key="' + key + '">' +
        icon('content_copy') + '复制</button></td></tr>';
    }).join('');
    var title = str(set.title) || str(set.evidenceId);
    return '<div class="row-detail-head">' +
      '<div class="row-detail-title">' + icon('table_rows') + '<span title="' + esc(title) + '">行详情 · ' + esc(title) + '</span>' +
      '<span class="source-chip">第 ' + (rowIndex + 1) + ' 行</span>' +
      (set.label ? '<span class="pane-chip">' + esc(set.label) + '</span>' : '') + '</div>' +
      '<button type="button" class="icon-btn" data-row-detail-close title="关闭行详情">' + icon('close') + '</button></div>' +
      '<div class="row-detail-body custom-scrollbar">' +
      (fields.length
        ? '<table class="row-detail-table"><thead><tr><th scope="col">字段</th><th scope="col">原始值</th><th scope="col" class="row-op">操作</th></tr></thead><tbody>' + fieldRows + '</tbody></table>'
        : '<div class="pane-note">该行没有可展开的原始字段。</div>') +
      '<div class="row-detail-hint">原始值按证据原文片段展示：null 与字符串 "&lt;NULL&gt;"、大整数与尾随零、重复键都保持原样。</div>' +
      '</div>' +
      '<div class="row-detail-foot">' +
      (whole
        ? '<button type="button" class="btn" data-copy-key="' + wholeKey + '">' + icon('content_copy') + '复制整行 JSON</button>'
        : '<span class="btn is-disabled">整行原文不可用</span>') +
      '<button type="button" class="btn btn-primary" data-row-detail-close>关闭</button></div>';
  }

  function cellHtml(cell) {
    if (!cell || cell.kind === 'missing') return '<span class="cell-missing">未提供</span>';
    if (cell.kind === 'null') return '<span class="cell-null">null</span>';
    if (cell.kind === 'json') return '<code class="cell-json">' + esc(cell.text) + '</code>';
    if (cell.text === '') return '<span class="cell-empty">（空串）</span>';
    return '<span class="cell-text" title="' + esc(cell.text) + '">' + esc(cell.text) + '</span>';
  }

  function resultTableHtml(set, focusMap) {
    registerCopy(set.copyKey, set.copyText);
    var rows = set.rows.length;
    var focusId = typeof set.focusIndex === 'number' ? set.focusIndex : set.index;
    var body = rows
      ? set.rows.map(function (row, rowIndex) {
        return '<tr>' + row.map(function (cell, colIndex) {
          var column = str(set.columns[colIndex]);
          var hits = focusMap && focusMap[focusId + ':' + rowIndex + ':' + column];
          if (!hits || !hits.length) return '<td>' + cellHtml(cell) + '</td>';
          var key = 'focus-' + focusId + '-' + rowIndex + '-' + colIndex;
          registerFocusCell(key, { hits: hits, setIndex: focusId, row: rowIndex, column: column, setTitle: str(set.title), label: str(set.label) });
          return '<td class="focus-cell-td"><span class="focus-cell" tabindex="0" role="note"' +
            ' data-focus-cell="' + esc(key) + '" aria-label="' + esc(hits[0].focus.label + '，按回车或悬停查看核对说明') + '">' +
            cellHtml(cell) + '<span class="focus-mark" aria-hidden="true">' +
            hits.map(function (hit) { return circled(hit.index); }).join('') + '</span></span></td>';
        }).join('') +
          '<td class="row-op"><button type="button" class="btn btn-quiet btn-tiny" data-result-index="' + set.index +
          '" data-row-index="' + rowIndex + '" title="查看该行完整原始字段">' + icon('table_rows') + '查看行</button></td></tr>';
      }).join('')
      : '<tr><td class="result-empty" colspan="' + (Math.max(1, set.columns.length) + 1) + '">查询返回 0 行</td></tr>';
    return '<div class="result-block" data-result-evidence="' + esc(set.evidenceId) + '">' +
      '<div class="result-head">' +
      '<span class="result-title">' + esc(set.title) + '</span>' +
      (set.label ? '<span class="pane-chip">' + esc(set.label) + '</span>' : '') +
      '<span class="result-count">共 ' + rows + ' 行 · ' + set.columns.length + ' 个字段</span>' +
      '<span class="result-tools"><button type="button" class="btn btn-quiet" data-copy-key="' + set.copyKey + '">' +
      icon('content_copy') + '复制结果原文</button></span></div>' +
      '<div class="result-scroll custom-scrollbar"><table class="result-table"><thead><tr>' +
      set.columns.map(function (name) { var label = (set.columnLabels || {})[name]; return '<th scope="col">' + (label ? '<span class="column-label">' + esc(label) + '</span><span class="column-field">' + esc(name) + '</span>' : esc(name)) + '</th>'; }).join('') +
      '<th scope="col" class="row-op">操作</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }

  function responseHtml(response) {
    if (response.plainText) {
      var plainKey = 'response-' + response.evidenceId;
      registerCopy(plainKey, response.text);
      return '<div class="result-block" data-result-evidence="' + esc(response.evidenceId) + '"><div class="result-head"><span class="result-title">' + esc(response.title) + '</span><button type="button" class="btn btn-quiet" data-copy-key="' + plainKey + '">复制原始返回</button></div>' +
        (codeViewHtml(response.text,'text') || '<pre class="pre">' + esc(response.text) + '</pre>') + '</div>';
    }
    var fields = responseFields(response.node, response.text);
    var copyKey = 'response-' + response.evidenceId;
    registerCopy(copyKey, response.text);
    var table = '';
    if (fields.length) {
      table = '<div class="result-scroll custom-scrollbar"><table class="result-table result-kv">' +
        '<thead><tr><th scope="col">字段</th><th scope="col">实际值</th></tr></thead><tbody>' +
        fields.map(function (field) {
          return '<tr><th scope="row" class="kv-name">' + esc(field.name) + '</th><td>' + cellHtml(field.cell) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if (!fields.length && response.node.type === 'array') {
      table = '<ol class="response-lines">' + response.node.items.map(function (item) {
        return '<li>' + cellHtml(jsonCell(item, response.text)) + '</li>';
      }).join('') + '</ol>';
      if (!response.node.items.length) table = '<div class="pane-note">原始返回为空数组 []（0项）</div>';
    }
    if (!fields.length && response.node.type !== 'array') table = '<div class="pane-note">' + cellHtml(jsonCell(response.node,response.text)) + '</div>';
    return '<div class="result-block" data-result-evidence="' + esc(response.evidenceId) + '">' +
      '<div class="result-head"><span class="result-title">' + esc(response.title) + '</span>' +
      '<span class="result-count">' + (fields.length ? fields.length + ' 个字段' : '原始响应') + '</span>' +
      '<span class="result-tools"><span class="source-chip mono">' + esc(response.pointer) + '</span>' +
      '<button type="button" class="btn btn-quiet" data-copy-key="' + copyKey + '">' +
      icon('content_copy') + '复制调用记录</button></span></div>' +
      table +
      '<details class="raw-block"><summary>查看完整调用记录</summary>' +
      (codeViewHtml(response.text, 'json') || '<pre class="pre">' + esc(response.text) + '</pre>') +
      '</details></div>';
  }

  /* 结果区同屏展示“实际响应 + 查询结果”：接口步骤既有响应又有只读核对表时都不丢。 */
  function resultPaneHtml(stage, step, model) {
    var parts = [];
    var chips = [];
    resetFocusCells();
    var focusMap = buildFocusMap(stage.vm.focus);
    if (stage.response) {
      parts.push(responseHtml(stage.response));
      chips.push('<span class="pane-chip">返回自本步骤证据</span>');
    }
    if (stage.resultSets.length) {
      parts.push(stage.resultSets.map(function (set) { return resultTableHtml(set, focusMap); }).join(''));
      var rows = stage.resultSets.reduce(function (sum, set) { return sum + set.rows.length; }, 0);
      chips.push('<span class="pane-chip ok">共 ' + rows + ' 行</span>');
    }
    var title = stage.response && stage.resultSets.length ? '实际响应与查询结果'
      : (stage.response ? '实际响应' : '查询结果');
    var iconName = stage.response ? 'verified' : 'table_chart';
    var body;
    if (parts.length) {
      body = parts.join('');
    } else if (!evidenceIdsOf(step, stage.vm).length) {
      body = '<div class="pane-note">该步骤未关联原始材料；对照结论见右栏。</div>';
    } else {
      body = '<div class="pane-note">该步骤没有留存查询结果；对照结论见右栏，原始材料在下方折叠区。</div>';
    }
    return '<section class="console-pane console-bottom" data-console-pane="result">' +
      paneHead(iconName, title, chips.join(''), '') +
      '<div class="pane-body custom-scrollbar">' + body + '</div></section>';
  }

  function gutterHtml(pct) {
    return '<div class="console-gutter" role="separator" tabindex="0" aria-orientation="horizontal"' +
      ' aria-label="调整查询与结果的高度比例" aria-valuemin="' + Math.round(SPLIT.min * 100) + '"' +
      ' aria-valuemax="' + Math.round(SPLIT.max * 100) + '" aria-valuenow="' + pct + '" data-split-gutter>' +
      '<span class="gutter-bar" aria-hidden="true"></span></div>';
  }

  function rawDetailsHtml(step, model, stage) {
    var ids = evidenceIdsOf(step, stage.vm);
    if (!ids.length) return '';
    return '<details class="console-details"><summary>' + icon('data_object') +
      '原始记录与材料（' + ids.length + '）</summary><div class="details-body custom-scrollbar">' +
      renderEvidenceItems(ids, model.evidenceById) + '</div></details>';
  }

  function renderConsole(step, c, model, ratio) {
    var stage = buildStageModel(step, c, model);
    var value = clamp(num(ratio, SPLIT.initial), SPLIT.min, SPLIT.max);
    var pct = Math.round(value * 100);
    return '<div class="console">' +
      '<div class="console-split" id="console-split" style="--console-ratio:' + pct + '%">' +
      statementPaneHtml(stage) +
      gutterHtml(pct) +
      resultPaneHtml(stage, step, model) +
      '</div>' +
      rawDetailsHtml(step, model, stage) +
      '</div>';
  }

  /* 分栏比例：拖动与键盘共用同一套纯函数，便于复算与测试。 */
  function roundRatio(value) {
    return Math.round(value * 10000) / 10000;
  }

  function ratioFromPointer(top, height, clientY, min, max) {
    var h = Math.max(1, num(height, 1));
    return roundRatio(clamp((num(clientY, 0) - num(top, 0)) / h, min, max));
  }

  function stepRatio(ratio, delta, min, max) {
    return roundRatio(clamp(num(ratio, SPLIT.initial) + num(delta, 0), min, max));
  }

  /* 查询/请求原文：只在报告确实留存原文时展示，不生成替代 SQL。 */
  function statementCopyText(statement) {
    return statement && statement.text ? str(statement.text) : '';
  }

  function paramsHtml(parameters, key) {
    if (!parameters || !parameters.length) return '';
    var raw = parameters.map(function (p) { return p.name + '：' + p.value; }).join('\n');
    registerCopy(key, raw);
    return '<div class="param-block"><div class="panel-title">' + icon('data_object') + '关键条件与设置理由' +
      '<button type="button" class="btn btn-quiet" data-copy-key="' + key + '">' + icon('content_copy') + '复制条件</button></div>' +
      parameters.map(function (p) {
        return '<div class="param"><span class="param-name">' + esc(p.name) + '</span>' +
          '<span class="param-value">' + esc(p.value) + '</span>' +
          (p.reason ? '<span class="param-reason">' + esc(p.reason) + '</span>' : '') + '</div>';
      }).join('') + '</div>';
  }

  function reproductionHtml(step, c, model, key) {
    var r = isObj(step.reproduction) ? step.reproduction : null;
    if (!r) {
      return '<div class="panel-note">该步骤未提供复现入口与参数。</div>';
    }
    var label = str(r.label) || REPRO_KIND[r.kind] || '复现';
    var prefill = r.prefill || null;
    var url = prefill ? prefillHref(prefill) : (r.urlStatus === 'verified' ? safeHttpsUrl(r.url) : '');
    var constraints = Array.isArray(r.constraints) ? r.constraints.map(str).filter(Boolean) : [];
    var sourceIds = Array.isArray(r.sourceIds) ? r.sourceIds.filter(function (id) { return typeof id === 'string' && id; }) : [];
    var copyBtn = '';
    if (str(r.params)) {
      registerCopy(key + '-params', r.params);
      copyBtn = '<button type="button" class="btn btn-quiet" data-copy-key="' + key + '-params">' + icon('content_copy') + '复制输入参数</button>';
    } else if (prefill) {
      var prefillText = prefillParamText(prefill);
      registerCopy(key + '-prefill', prefillText);
      copyBtn = '<button type="button" class="btn btn-quiet" data-copy-key="' + key + '-prefill">' + icon('content_copy') + '复制预填参数</button>';
    } else if (str(r.instructions)) {
      registerCopy(key + '-instructions', r.instructions);
      copyBtn = '<button type="button" class="btn btn-quiet" data-copy-key="' + key + '-instructions">' + icon('content_copy') + '复制操作说明</button>';
    }
    var prefillBlock = '';
    if (prefill) {
      prefillBlock = '<div class="ins-kv"><span>预填</span><b>' + esc(prefillSummary(prefill)) + '</b></div>' +
        '<div class="ins-prefill">' + prefill.parameters.map(function (p) {
          return '<div class="param"><span class="param-name">' + esc(p.name) + '</span>' +
            '<span class="param-value">' + esc(p.value) + '</span></div>';
        }).join('') + '</div>' +
        '<div class="panel-note">打开仅预填表单，不会自动执行；DML/写操作仍需在平台内主动确认。</div>' +
        '<a class="btn btn-primary ins-prefill-link" href="' + esc(prefillHref(prefill)) + '" target="_blank" rel="noopener noreferrer">' +
        icon('open_in_new') + '打开并带入参数</a>';
    }
    return '<div class="ins-section"><div class="panel-title">' + icon('account_tree') + '复现入口' +
      (copyBtn || '') + '</div>' +
      '<div class="ins-kv"><span>方式</span><b>' + esc(REPRO_KIND[r.kind] || str(r.kind) || '未标注') + '</b></div>' +
      '<div class="ins-kv"><span>入口</span><b>' + esc(label) + ' · ' + (url ? '已核验 https 入口' : '入口未核验') + '</b></div>' +
      prefillBlock +
      (str(r.reason) ? '<div class="panel-note">' + esc(r.reason) + '</div>' : '') +
      (str(r.instructions) ? '<div class="panel-note">' + esc(r.instructions) + '</div>' : '') +
      (str(r.params) ? (codeViewHtml(r.params, '') || '<pre class="pre">' + esc(r.params) + '</pre>') : '') +
      (constraints.length ? '<ul class="constraint-list">' + constraints.map(function (item) {
        return '<li>' + esc(item) + '</li>';
      }).join('') + '</ul>' : '') +
      (sourceIds.length ? renderEvidenceAccordion(sourceIds, model.evidenceById, '来源证据（' + sourceIds.length + '）') : '') +
      '</div>';
  }

  function prefillSummary(prefill) {
    if (!prefill) return '';
    return '已带入 ' + prefill.parameters.length + ' 个参数 · ' + (prefill.environment || '环境未标注');
  }

  function prefillPopHtml(prefill) {
    if (!prefill) return '';
    var text = prefillParamText(prefill);
    registerCopy('prefill-params', text);
    return '<div class="prefill-pop-head"><span class="prefill-pop-title">' + icon('data_object') + '预填参数（' +
      prefill.parameters.length + '）</span>' +
      '<button type="button" class="icon-btn" data-prefill-close title="关闭预填参数">' + icon('close') + '</button></div>' +
      '<div class="prefill-pop-env">' + esc(prefillSummary(prefill)) + '</div>' +
      '<div class="prefill-pop-list custom-scrollbar">' + prefill.parameters.map(function (p) {
        return '<div class="prefill-param"><span class="param-name">' + esc(p.name) + '</span>' +
          '<span class="param-value">' + esc(p.value) + '</span></div>';
      }).join('') + '</div>' +
      (prefill.note ? '<div class="prefill-pop-note">' + esc(prefill.note) + '</div>' : '') +
      '<div class="prefill-pop-warn">' + icon('info') + '<span>打开仅预填，需主动执行；报告不发起任何业务调用。</span></div>' +
      '<div class="prefill-pop-foot"><button type="button" class="btn" data-copy-key="prefill-params">' +
      icon('content_copy') + '复制参数</button>' +
      '<a class="btn btn-primary" href="' + esc(prefillHref(prefill)) + '" target="_blank" rel="noopener noreferrer">' +
      icon('open_in_new') + '打开并带入参数</a></div>';
  }

  /* ---------- 右侧连续检视流（无页签） ---------- */

  function comparisonCardsHtml(vm) {
    if (!vm.comparison.length) {
      return '';
    }
    var hasSource = vm.comparison.some(function (x) { return x.expectedSource || x.actualSource; });
    var passed = vm.comparison.filter(function (x) { return x.status === 'passed'; }).length;
    return '<div class="ins-card" data-ins-section="comparison">' +
      '<div class="panel-title">' + icon('fact_check') + '逐项预期与实际对照（' + vm.comparison.length + '）</div>' +
      '<div class="ins-summary">' + icon('task_alt') + '<span>' + passed + ' / ' + vm.comparison.length + ' 项通过</span></div>' +
      (hasSource ? '<div class="ins-note">预期与实际分别记录来源，来源不同的数值不做合并。</div>' : '') +
      vm.comparison.map(function (cmp) {
        var key = statusKeyOf(cmp.status);
        return '<div class="cmp-card"><div class="cmp-card-head"><span class="cmp-label">' + esc(cmp.label) + '</span>' +
          (key ? '<span class="cmp-status ' + key + '">' + icon(STATUS_ICON[key]) + esc(STATUS_LABEL[key]) + '</span>' : '') +
          '</div><div class="cmp-sides">' +
          '<div class="cmp-side"><span class="cmp-side-label">预期 / 对照</span>' +
          '<span class="cmp-side-value">' + esc(cmp.expected || '—') + '</span>' +
          (cmp.expectedSource ? '<span class="cmp-src">来源：' + esc(cmp.expectedSource) + '</span>' : '') + '</div>' +
          '<div class="cmp-side"><span class="cmp-side-label">实际结果</span>' +
          '<span class="cmp-side-value">' + esc(cmp.actual || '—') + '</span>' +
          (cmp.actualSource ? '<span class="cmp-src">来源：' + esc(cmp.actualSource) + '</span>' : '') + '</div>' +
          '</div></div>';
      }).join('') + '</div>';
  }

  /* 右栏首行状态：只描述本步骤已有对照的通过情况，不推断未核验项。 */
  function inspectorStatus(vm, step) {
    if (vm.comparison.length) {
      var passed = vm.comparison.filter(function (x) { return x.status === 'passed'; }).length;
      var failed = vm.comparison.filter(function (x) { return statusKeyOf(x.status) === 'failed'; }).length;
      var blocked = vm.comparison.filter(function (x) { return statusKeyOf(x.status) === 'blocked'; }).length;
      if (failed) return { key: 'failed', text: passed + ' / ' + vm.comparison.length + ' 项通过，' + failed + ' 项不一致' };
      if (blocked) return { key: 'blocked', text: passed + ' / ' + vm.comparison.length + ' 项通过，' + blocked + ' 项受阻' };
      var pending = vm.comparison.filter(function (x) { return statusKeyOf(x.status) === 'not_run'; }).length;
      var partial = vm.comparison.filter(function (x) { return statusKeyOf(x.status) === 'partial'; }).length;
      if (pending || partial) return { key: partial || passed ? 'partial' : 'not_run', text: passed + ' / ' + vm.comparison.length + ' 项通过 · ' + (partial ? '部分验证' : '含未执行项') };
      return { key: passed === vm.comparison.length ? 'passed' : '', text: passed + ' / ' + vm.comparison.length + ' 项通过' };
    }
    var key = statusKeyOf(step && step.status);
    return { key: key, text: statusLabel(step && step.status, false) };
  }

  /* 用例缘由与来源：测新追需求原话/文档/确认结论，回归追既有规则/影响路径/历史问题。
   * 只展示报告已有来源；没有链接时保留原话与出处，不补造引用。 */
  function designKindLabel(kind) { return DESIGN_KIND_LABEL[kind] || '来源'; }
  function designSourceHtml(source) {
    var label = source.url
      ? '<a class="design-source-label" href="' + esc(source.url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(source.label) + icon('open_in_new') + '</a>'
      : '<span class="design-source-label">' + esc(source.label) + '</span>';
    return '<li class="design-source">' +
      '<div class="design-source-head"><span class="design-kind">' + esc(designKindLabel(source.kind)) + '</span>' + label + '</div>' +
      (source.quote ? '<blockquote class="design-quote">' + esc(source.quote) + '</blockquote>' : '') +
      (source.ref ? '<div class="design-ref mono">' + esc(source.ref) + '</div>' : '') +
      (source.note ? '<div class="design-note">' + esc(source.note) + '</div>' : '') +
      '</li>';
  }
  function caseDesignHtml(c) {
    var d = c && c.caseDesign;
    if (!d) return '';
    var role = caseRoleOf(c);
    var chip = role === 'new' ? '测新追溯来源'
      : role === 'regression' ? '回归追溯来源'
        : role === 'mixed' ? '测新与回归来源'
          : role === 'audit' ? '执行审计依据' : '设计依据来源';
    var hint = role === 'regression' ? '回归用例追溯到既有规则、影响路径或历史问题，不以本步骤动作代替缘由。'
      : role === 'mixed' ? '同一用例同时覆盖测新与回归：需求原话与既有规则分别列出，不合并成一段。'
        : role === 'audit' ? '执行审计记录的依据单独标注，不计入业务用例结论。'
          : role === 'new' ? '测新用例追溯到需求原话、文档或确认结论，不用“怎么查/怎么做”代替缘由。'
            : '按报告已有来源原样列出；未标注目的时不推断。';
    return '<div class="ins-card case-design" data-ins-section="case-design">' +
      '<div class="panel-title">' + icon('menu_book') + '用例设计依据<span class="design-chip">' + esc(chip) + '</span></div>' +
      '<div class="design-why"><span>为什么测此用例</span><b>' + esc(d.why) + '</b></div>' +
      (d.sources.length ? '<ul class="design-sources">' + d.sources.map(designSourceHtml).join('') + '</ul>' : '') +
      '<div class="design-hint">' + icon('info') + '<span>' + esc(hint) + '</span></div></div>';
  }

  /* UED 对照使用报告内已有的真实设计图证据；缺素材时由数据显式登记，不画示意图。 */
  function uedHtml(vm, model) {
    var u = vm.ued;
    if (!u) return '';
    var ev = model.evidenceById[u.evidenceId];
    if (!ev || ev.type !== 'image') return '';
    var src = safeImgSrc(ev.dataUri || ev.file);
    if (!src) return '';
    var title = u.title || u.caption || '设计对照图';
    var annotations = Array.isArray(ev.annotations) ? ev.annotations.length : 0;
    return '<div class="ins-card ued-card"><div class="panel-title">' + icon('layers') + '与页面实现对照' +
      '<span class="ued-chip">UED 设计稿</span></div>' +
      '<button type="button" class="ued-thumb" data-lightbox-evidence="' + esc(u.evidenceId) + '" title="点击放大并查看标注">' +
      '<img alt="' + esc(title) + '" src="' + esc(src) + '"/>' +
      '<span class="ued-thumb-hint">' + icon('zoom_in') + '点击放大' + (annotations ? ' · ' + annotations + ' 处标注' : '') + '</span>' +
      '</button>' +
      '<div class="ued-meta">' + (u.caption ? '<span>' + esc(u.caption) + '</span>' : '') +
      (u.sourceUrl ? '<a href="' + esc(u.sourceUrl) + '" target="_blank" rel="noopener noreferrer">查看设计原稿' + icon('open_in_new') + '</a>' : '') +
      '</div>' + (u.note ? '<div class="panel-note">' + esc(u.note) + '</div>' : '') + '</div>';
  }

  function focusRefText(ref) {
    return '结果表 ' + (ref.resultSet + 1) + ' · 第 ' + (ref.row + 1) + ' 行 · 字段 ' + ref.column +
      (ref.note ? ' · ' + ref.note : '');
  }
  function focusListHtml(focus) {
    return '<ul class="ins-list focus-list">' + focus.map(function (f, i) {
      return '<li class="focus-item"><b><span class="focus-index">' + circled(i + 1) + '</span>' + esc(f.label) + '</b>' +
        (f.reason ? '<span class="ins-why">为何关注：' + esc(f.reason) + '</span>' : '') +
        '<div class="focus-pair"><span>预期：' + esc(f.expected || '—') + '</span><span>实际：' + esc(f.actual || '—') + '</span></div>' +
        (f.cellRefs.length ? '<div class="focus-locs">' + f.cellRefs.map(function (ref) {
          return '<button type="button" class="focus-loc" data-goto-result="' + ref.resultSet + '" data-goto-row="' + ref.row +
            '" data-goto-column="' + esc(ref.column) + '" title="定位到结果表中的高亮单元格">' +
            icon('track_changes') + esc(focusRefText(ref)) + '</button>';
        }).join('') + '</div>' : '') +
        (f.evidenceIds.length ? '<span class="focus-ev">证据 ' + f.evidenceIds.length + ' 条</span>' : '') +
        '</li>';
    }).join('') + '</ul>';
  }

  function inspectorFlowHtml(vm, step, c, model) {
    var parts = [];
    parts.push(caseDesignHtml(c));
    parts.push('<div class="ins-card ins-question"><div class="panel-title">' + icon('help_outline') + '业务疑问</div>' +
      '<p>' + esc(vm.question) + '</p></div>');
    if (vm.method) {
      parts.push('<div class="ins-card"><div class="panel-title">' + icon('psychology') + '为什么这样查</div>' +
        '<p>' + esc(vm.method) + '</p></div>');
    }
    if (vm.focus.length) {
      parts.push('<div class="ins-card"><div class="panel-title">' + icon('visibility') + '核心关注点（' + vm.focus.length + '）</div>' +
        focusListHtml(vm.focus) + uedHtml(vm, model) + '</div>');
    } else if (vm.ued) {
      parts.push('<div class="ins-card"><div class="panel-title">' + icon('visibility') + '核心关注点</div>' +
        '<div class="panel-note">该步骤未提供结构化关注点，设计对照图仍按原样提供。</div>' + uedHtml(vm, model) + '</div>');
    }
    if (vm.statement && vm.statement.parameters.length) {
      parts.push('<div class="ins-card" data-ins-section="parameters">' +
        paramsHtml(vm.statement.parameters, 'ins-statement-params') + '</div>');
    }
    parts.push(comparisonCardsHtml(vm));
    parts.push(vm.conclusion
      ? '<div class="ins-card ins-conclusion"><div class="panel-title">' + icon('verified') + '结论</div>' +
        '<p>' + esc(vm.conclusion) + '</p></div>'
      : '<div class="ins-card"><div class="panel-title">' + icon('verified') + '结论</div>' +
        '<p class="panel-note">该步骤未给出结论。</p></div>');
    if (vm.limitations.length && !vm.fallback) {
      parts.push('<div class="ins-card"><div class="panel-title">' + icon('info') + '结论边界</div>' +
        '<ul class="ins-list">' + vm.limitations.map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') +
        '</ul></div>');
    }
    if (vm.fallback && vm.stepRecord) {
      var rec = vm.stepRecord;
      parts.push('<div class="ins-card"><div class="panel-title">' + icon('description') + '步骤记录</div>' +
        '<div class="ins-kv"><span>操作</span><b>' + esc(rec.action || '—') + '</b></div>' +
        '<div class="ins-kv"><span>预期</span><b>' + esc(rec.expected || '—') + '</b></div>' +
        '<div class="ins-kv"><span>实际</span><b>' + esc(rec.actual || '—') + '</b></div>' +
        '<div class="ins-kv"><span>记录状态</span><b>' + esc(statusLabel(rec.status, false)) + '</b></div></div>');
    }
    var ids = evidenceIdsOf(step, vm);
    var repro = reproductionHtml(step, c, model, 'ins-repro');
    parts.push('<details class="ins-details"><summary>' + icon('inventory_2') +
      '<span>原始记录与技术上下文（' + ids.length + ' 条材料）</span></summary>' +
      '<div class="ins-details-body">' +
      (ids.length ? renderEvidenceItems(ids, model.evidenceById) : '<div class="panel-note">该步骤未关联原始材料。</div>') +
      repro + '</div></details>');
    return parts.join('');
  }

  function renderInspector(step, c, model) {
    var vm = buildVerification(step, c);
    var status = inspectorStatus(vm, step);
    return { html: inspectorFlowHtml(vm, step, c, model), status: status };
  }

  /* ---------- 底部复现条（跟随当前步骤） ---------- */
  function reproCopyText(r) {
    return str(r && r.params) || str(r && r.instructions) || str(r && r.label);
  }

  function renderRepro(step, c, model) {
    var r = isObj(step && step.reproduction) ? step.reproduction : null;
    if (!r) {
      return '<span class="repro-badge">' + icon('content_copy') + '复现</span>' +
        '<span class="repro-text">该步骤未提供复现入口与参数。</span>';
    }
    var label = str(r.label) || REPRO_KIND[r.kind] || '复现';
    var prefill = r.prefill || null;
    var url = prefill ? prefillHref(prefill) : (r.urlStatus === 'verified' ? safeHttpsUrl(r.url) : '');
    var lineText = prefill ? prefillSummary(prefill) : (str(r.instructions) || str(r.reason) || '按复现参数执行');
    var actions = '';
    if (prefill) {
      registerCopy('repro-prefill-params', prefillParamText(prefill));
      actions += '<button type="button" class="btn btn-quiet" data-prefill-toggle aria-expanded="false">' +
        icon('data_object') + '查看参数</button>';
    } else if (str(r.params)) {
      registerCopy('repro-params', r.params);
      actions += '<button type="button" class="btn btn-quiet" data-copy-key="repro-params">' + icon('content_copy') + '复制输入参数</button>';
    } else if (str(r.instructions)) {
      registerCopy('repro-instructions', r.instructions);
      actions += '<button type="button" class="btn btn-quiet" data-copy-key="repro-instructions">' + icon('content_copy') + '复制操作说明</button>';
    }
    actions += url
      ? '<a class="btn btn-primary" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + icon('open_in_new') +
        (prefill ? '打开并带入参数' : '打开' + esc(label)) + '</a>'
      : '<span class="btn is-disabled" title="' + esc(str(r.reason) || '入口未核验') + '">' + icon('link_off') + '入口未核验</span>';
    return '<span class="repro-badge">' + icon('content_copy') + '复现</span>' +
      '<span class="repro-kind">' + esc(label) + '</span>' +
      (prefill ? '<span class="repro-chip">' + icon('task_alt') + '打开仅预填，需主动执行</span>' : '') +
      '<span class="repro-text" title="' + esc(lineText) + '">' + esc(lineText) + '</span>' +
      '<div class="repro-actions">' + actions + '</div>';
  }

  /* ---------- 截图缩放/平移（纯函数，便于测试） ---------- */
  function clampPan(z, nw, nh, vw, vh) {
    var scale = num(z && z.scale, 1);
    var w = Math.max(1, num(nw, 1) * scale);
    var h = Math.max(1, num(nh, 1) * scale);
    var tx = num(z && z.tx, 0);
    var ty = num(z && z.ty, 0);
    var vpw = Math.max(1, num(vw, 1));
    var vph = Math.max(1, num(vh, 1));
    tx = w <= vpw ? (vpw - w) / 2 : clamp(tx, vpw - w, 0);
    ty = h <= vph ? (vph - h) / 2 : clamp(ty, vph - h, 0);
    return { scale: scale, tx: tx, ty: ty, mode: (z && z.mode) || 'custom' };
  }

  function fitTo(nw, nh, vw, vh) {
    var width = Math.max(1, num(nw, 1));
    var height = Math.max(1, num(nh, 1));
    var vpw = Math.max(1, num(vw, 1));
    var vph = Math.max(1, num(vh, 1));
    var scale = clamp(Math.min(vpw / width, vph / height), 0.1, 5);
    return clampPan({ scale: scale, tx: 0, ty: 0, mode: 'fit' }, nw, nh, vw, vh);
  }

  function originalSize(nw, nh, vw, vh) {
    return clampPan({ scale: 1, tx: 0, ty: 0, mode: 'original' }, nw, nh, vw, vh);
  }

  function zoomAt(z, factor, px, py, nw, nh, vw, vh) {
    var oldScale = num(z && z.scale, 1);
    var next = clamp(oldScale * num(factor, 1), 0.1, 5);
    var k = next / oldScale;
    var tx = num(px, 0) - (num(px, 0) - num(z && z.tx, 0)) * k;
    var ty = num(py, 0) - (num(py, 0) - num(z && z.ty, 0)) * k;
    return clampPan({ scale: next, tx: tx, ty: ty, mode: 'custom' }, nw, nh, vw, vh);
  }

  function wheelFactor(delta, deltaMode) {
    var d = num(delta, 0) * (deltaMode === 1 ? 16 : (deltaMode === 2 ? 100 : 1));
    return Math.exp(-d * 0.0015);
  }

  /* ---------- 浮层：关注单元格 / 行详情 / 预填参数 / 统一图片灯箱 ---------- */
  var rowDetailTrigger = null;
  var lbState = {
    ids: [], index: 0, size: { nw: 0, nh: 0 }, annotations: [],
    zoom: { scale: 1, tx: 0, ty: 0, mode: 'fit' }, showAnnotations: true,
    trigger: null, drag: null,
  };

  function hideFocusPop() {
    if (!dom || !dom.focusPop) return;
    dom.focusPop.hidden = true;
    dom.focusPop.innerHTML = '';
  }
  function showFocusPop(anchor, key) {
    var entry = focusCellData(key);
    if (!entry || !anchor || !dom || !dom.focusPop) return;
    dom.focusPop.innerHTML = focusPopHtml(entry);
    dom.focusPop.hidden = false;
    hydrateIcons(dom.focusPop);
    var rect = anchor.getBoundingClientRect();
    var box = dom.focusPop.getBoundingClientRect();
    var left = clamp(rect.left + rect.width / 2 - box.width / 2, 8, Math.max(8, window.innerWidth - box.width - 8));
    var top = rect.top - box.height - 8;
    if (top < 8) top = Math.min(window.innerHeight - box.height - 8, rect.bottom + 8);
    dom.focusPop.style.left = Math.round(left) + 'px';
    dom.focusPop.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function currentStageSets() {
    var c = currentCase();
    if (!c) return [];
    var step = currentStep(c);
    return step ? buildStageModel(step, c, modelRef).resultSets : [];
  }
  function openRowDetail(setIndex, rowIndex, trigger) {
    var sets = currentStageSets();
    var set = null;
    for (var i = 0; i < sets.length; i += 1) {
      if (sets[i].index === setIndex) { set = sets[i]; break; }
    }
    if (!set || !set.rows[rowIndex] || !dom || !dom.rowDetail) return;
    rowDetailTrigger = trigger || document.activeElement;
    dom.rowDetail.innerHTML = rowDetailHtml(set, rowIndex);
    dom.rowDetail.hidden = false;
    hydrateIcons(dom.rowDetail);
    var close = dom.rowDetail.querySelector('[data-row-detail-close]');
    if (close) close.focus();
  }
  function closeRowDetail(restoreFocus) {
    if (!dom || !dom.rowDetail || dom.rowDetail.hidden) return;
    var trigger = rowDetailTrigger;
    dom.rowDetail.hidden = true;
    dom.rowDetail.innerHTML = '';
    rowDetailTrigger = null;
    if (restoreFocus !== false && trigger && document.contains(trigger)) trigger.focus();
  }

  function closePrefillPop() {
    if (!dom || !dom.prefillPop) return;
    dom.prefillPop.hidden = true;
    dom.prefillPop.innerHTML = '';
    var btn = dom.repro && dom.repro.querySelector('[data-prefill-toggle]');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function togglePrefillPop(open) {
    var c = currentCase();
    var step = c ? currentStep(c) : null;
    var prefill = step && step.reproduction && step.reproduction.prefill;
    if (!prefill || !dom || !dom.prefillPop) return;
    if (!open) { closePrefillPop(); return; }
    dom.prefillPop.innerHTML = prefillPopHtml(prefill);
    dom.prefillPop.hidden = false;
    hydrateIcons(dom.prefillPop);
    var rect = dom.repro.getBoundingClientRect();
    dom.prefillPop.style.left = Math.round(clamp(rect.left + 8, 8, Math.max(8, window.innerWidth - 368))) + 'px';
    dom.prefillPop.style.bottom = Math.round(window.innerHeight - rect.top + 6) + 'px';
    var btn = dom.repro.querySelector('[data-prefill-toggle]');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function jumpToFocusCell(resultSetIndex, rowIndex, column) {
    if (!dom || !dom.stagePanel) return false;
    var cells = dom.stagePanel.querySelectorAll('[data-focus-cell]');
    for (var i = 0; i < cells.length; i += 1) {
      var entry = focusCellData(cells[i].getAttribute('data-focus-cell'));
      if (!entry) continue;
      if (entry.setIndex !== num(resultSetIndex, -1) || entry.row !== num(rowIndex, -1) || entry.column !== column) continue;
      if (cells[i].scrollIntoView) cells[i].scrollIntoView({ block: 'center', inline: 'center' });
      cells[i].focus();
      showFocusPop(cells[i], cells[i].getAttribute('data-focus-cell'));
      return true;
    }
    showToast('当前步骤结果表里没有该关注单元格', 'warn');
    return false;
  }

  /* 灯箱：图片始终按原图像素放进世界坐标，标注框按同一变换换算到屏幕，
   * 因此缩放/平移后框选位置与原图一致。 */
  function stepImageIds(step, model) {
    if (!step || !model) return [];
    var ids = [];
    if (step.pageView && step.pageView.imageEvidenceId) ids.push(str(step.pageView.imageEvidenceId));
    (step.evidenceIds || []).forEach(function (id) { ids.push(id); });
    var vm = buildVerification(step, currentCase());
    if (vm.ued) ids.push(vm.ued.evidenceId);
    return uniq(ids).filter(function (id) {
      var ev = model.evidenceById[id];
      return ev && ev.type === 'image' && !!safeImgSrc(ev.dataUri || ev.file);
    });
  }
  function annotationsHtml(list) {
    return (list || []).map(function (a, i) {
      var n = a.number || (i + 1);
      return '<div class="lb-anno tone-' + esc(a.tone) + '" data-anno-index="' + i + '" title="' +
        esc(a.label + (a.note ? '：' + a.note : '')) + '">' +
        '<span class="lb-anno-badge">' + circled(n) + '</span>' +
        '<span class="lb-anno-tag">' + esc(a.label) + '</span></div>';
    }).join('');
  }
  function legendHtml(list) {
    return (list || []).map(function (a, i) {
      var n = a.number || (i + 1);
      return '<div class="lb-legend-item"><span class="lb-legend-no">' + circled(n) + '</span>' +
        '<span class="lb-legend-label">' + esc(a.label) + '</span>' +
        (a.note ? '<span class="lb-legend-note">' + esc(a.note) + '</span>' : '') + '</div>';
    }).join('');
  }
  function lbViewport() {
    return { w: Math.max(1, dom.lbStage.clientWidth), h: Math.max(1, dom.lbStage.clientHeight) };
  }
  function lbFit() {
    if (!lbState.size.nw) return;
    var vp = lbViewport();
    lbState.zoom = fitTo(lbState.size.nw, lbState.size.nh, vp.w, vp.h);
    lbApplyZoom();
  }
  function lbActual() {
    if (!lbState.size.nw) return;
    var vp = lbViewport();
    lbState.zoom = originalSize(lbState.size.nw, lbState.size.nh, vp.w, vp.h);
    lbApplyZoom();
  }
  function lbZoomBy(factor, px, py) {
    if (!lbState.size.nw) return;
    var vp = lbViewport();
    var x = px === undefined ? vp.w / 2 : px;
    var y = py === undefined ? vp.h / 2 : py;
    lbState.zoom = zoomAt(lbState.zoom, factor, x, y, lbState.size.nw, lbState.size.nh, vp.w, vp.h);
    lbApplyZoom();
  }
  function lbApplyZoom() {
    if (!dom || !dom.lbWorld) return;
    var z = lbState.zoom;
    dom.lbWorld.style.width = lbState.size.nw + 'px';
    dom.lbWorld.style.height = lbState.size.nh + 'px';
    dom.lbWorld.style.transform = 'translate(' + z.tx + 'px, ' + z.ty + 'px) scale(' + z.scale + ')';
    var pct = Math.round(z.scale * 100) + '%';
    if (dom.lbZoomLabel) dom.lbZoomLabel.textContent = z.mode === 'fit' ? '适应' : pct;
    if (dom.lbZoomValue) dom.lbZoomValue.textContent = pct;
    layoutAnnotations();
  }
  /* 标注框在原图像素坐标上定义，按世界变换换算成屏幕像素；
   * 缩放/平移后框选区域始终压在同一像素位置上（徽标与文字不随图缩放）。 */
  function layoutAnnotationBox(a, zoom) {
    var z = zoom || { scale: 1, tx: 0, ty: 0 };
    var scale = num(z.scale, 1);
    return {
      left: Math.round(num(z.tx, 0) + num(a && a.x, 0) * scale),
      top: Math.round(num(z.ty, 0) + num(a && a.y, 0) * scale),
      width: Math.max(2, Math.round(num(a && a.w, 0) * scale)),
      height: Math.max(2, Math.round(num(a && a.h, 0) * scale)),
    };
  }
  function layoutAnnotations() {
    if (!dom || !dom.lbAnnotations) return;
    var z = lbState.zoom;
    Array.prototype.forEach.call(dom.lbAnnotations.children, function (el) {
      var a = lbState.annotations[num(el.getAttribute('data-anno-index'), -1)];
      if (!a) return;
      var box = layoutAnnotationBox(a, z);
      el.style.left = box.left + 'px';
      el.style.top = box.top + 'px';
      el.style.width = box.width + 'px';
      el.style.height = box.height + 'px';
    });
  }
  function syncAnnoToggle() {
    if (!dom || !dom.lbToggleAnno) return;
    var has = lbState.annotations.length > 0;
    dom.lbToggleAnno.disabled = !has;
    dom.lbToggleAnno.setAttribute('aria-pressed', lbState.showAnnotations ? 'true' : 'false');
    dom.lbToggleAnno.textContent = has ? (lbState.showAnnotations ? '隐藏标注' : '显示标注') : '无标注';
    if (dom.lbAnnoCount) dom.lbAnnoCount.textContent = has ? lbState.annotations.length + ' 处标注' : '未提供标注';
  }
  function setAnnotationsVisible(on) {
    lbState.showAnnotations = !!on;
    if (dom.lbAnnotations) dom.lbAnnotations.hidden = !on;
    if (dom.lbLegend) dom.lbLegend.hidden = !(on && lbState.annotations.length);
    syncAnnoToggle();
    layoutAnnotations();
  }
  function lbShowEmpty(message) {
    if (!dom) return;
    lbState.size = { nw: 0, nh: 0 };
    dom.lbWorld.hidden = true;
    dom.lbEmpty.hidden = false;
    dom.lbEmpty.innerHTML = '<div class="empty-card">' + icon('image') + '<h3>' + esc(message) +
      '</h3><p>只展示报告内已有的图片证据，不生成示意页面。</p></div>';
    if (dom.lbLegend) { dom.lbLegend.hidden = true; dom.lbLegend.innerHTML = ''; }
    if (dom.lbAnnotations) { dom.lbAnnotations.hidden = true; dom.lbAnnotations.innerHTML = ''; }
  }
  function renderLightbox() {
    var ev = modelRef && modelRef.evidenceById[lbState.ids[lbState.index]];
    if (!ev || !dom) return;
    var src = safeImgSrc(ev.dataUri || ev.file);
    var annotations = Array.isArray(ev.annotations) ? ev.annotations : [];
    lbState.annotations = annotations;
    if (dom.lbTitle) dom.lbTitle.textContent = str(ev.title) || '证据图片';
    if (dom.lbMeta) {
      var meta = [];
      if (ev.source) meta.push('来源：' + str(ev.source));
      if (ev.file) meta.push(str(ev.file));
      if (lbState.ids.length > 1) meta.push('第 ' + (lbState.index + 1) + ' / ' + lbState.ids.length + ' 张');
      meta.push(annotations.length ? annotations.length + ' 处标注' : '未提供标注');
      dom.lbMeta.textContent = meta.join(' · ');
    }
    dom.lbWorld.hidden = false;
    dom.lbEmpty.hidden = true;
    dom.lbImage.alt = str(ev.title) || '证据图片';
    dom.lbImage.onload = function () {
      lbState.size = { nw: dom.lbImage.naturalWidth || 1, nh: dom.lbImage.naturalHeight || 1 };
      lbState.zoom = { scale: 1, tx: 0, ty: 0, mode: 'fit' };
      lbFit();
      setAnnotationsVisible(annotations.length > 0);
    };
    dom.lbImage.onerror = function () { lbShowEmpty('图片未能从报告中加载'); };
    dom.lbImage.removeAttribute('src');
    dom.lbImage.setAttribute('src', src);
    dom.lbAnnotations.innerHTML = annotationsHtml(annotations);
    dom.lbLegend.innerHTML = legendHtml(annotations);
    setAnnotationsVisible(annotations.length > 0);
  }
  function openLightbox(evidenceId, trigger) {
    if (!modelRef || !dom) return;
    var ev = modelRef.evidenceById[evidenceId];
    if (!ev || ev.type !== 'image' || !safeImgSrc(ev.dataUri || ev.file)) return;
    var ids = stepImageIds(currentStep(currentCase()), modelRef);
    if (ids.indexOf(evidenceId) === -1) ids = [evidenceId].concat(ids);
    hideFocusPop();
    closePrefillPop();
    lbState.ids = ids;
    lbState.index = Math.max(0, ids.indexOf(evidenceId));
    lbState.zoom = { scale: 1, tx: 0, ty: 0, mode: 'fit' };
    lbState.size = { nw: 0, nh: 0 };
    lbState.annotations = [];
    lbState.showAnnotations = true;
    lbState.drag = null;
    lbState.trigger = trigger || document.activeElement;
    dom.lightbox.hidden = false;
    document.body.classList.add('lb-open');
    renderLightbox();
    var close = dom.lightbox.querySelector('#lb-close');
    if (close) close.focus();
  }
  function closeLightbox() {
    if (!dom || !dom.lightbox || dom.lightbox.hidden) return;
    dom.lightbox.hidden = true;
    document.body.classList.remove('lb-open');
    if (dom.lbImage) dom.lbImage.removeAttribute('src');
    if (dom.lbAnnotations) { dom.lbAnnotations.innerHTML = ''; dom.lbAnnotations.hidden = true; }
    if (dom.lbLegend) { dom.lbLegend.innerHTML = ''; dom.lbLegend.hidden = true; }
    if (dom.lbWorld) dom.lbWorld.hidden = true;
    if (dom.lbZoomLabel) dom.lbZoomLabel.textContent = '适应';
    if (dom.lbZoomValue) dom.lbZoomValue.textContent = '100%';
    lbState.ids = [];
    lbState.index = 0;
    lbState.annotations = [];
    lbState.size = { nw: 0, nh: 0 };
    lbState.zoom = { scale: 1, tx: 0, ty: 0, mode: 'fit' };
    lbState.drag = null;
    var trigger = lbState.trigger;
    lbState.trigger = null;
    if (trigger && document.contains(trigger)) trigger.focus();
  }

  function closeTransient() {
    hideFocusPop();
    closeRowDetail(false);
    closePrefillPop();
    closeLightbox();
  }

  /* ---------- 挂载 ---------- */
  var modelRef = null;
  var state = {
    caseId: '',
    stepIndex: 0,
    filters: defaultFilters(),
    splitRatio: SPLIT.initial,
    inspectorOpen: true,
    zoom: { scale: 1, tx: 0, ty: 0, mode: 'fit' },
    img: null,
  };
  var dom = null;
  var toastTimer = null;

  function currentCase() {
    if (!modelRef) return null;
    for (var i = 0; i < modelRef.cases.length; i += 1) {
      if (modelRef.cases[i].id === state.caseId) return modelRef.cases[i];
    }
    return null;
  }
  function currentStep(c) {
    if (!c || !c.steps.length) return null;
    return c.steps[clamp(state.stepIndex, 0, c.steps.length - 1)];
  }

  function normalizeReportLinks(links) {
    var seen = Object.create(null);
    return (Array.isArray(links) ? links : []).filter(function (link) {
      if (!isObj(link) || !str(link.label).trim()) return false;
      var url = safeHttpsUrl(link.url);
      if (!url || seen[url]) return false;
      try { var parsed = new URL(url); if (parsed.username || parsed.password) return false; } catch (e) { return false; }
      seen[url] = true;
      return true;
    }).map(function (link) { return { label: str(link.label), url: safeHttpsUrl(link.url), kind: str(link.kind) }; });
  }
  function reportLinksHtml(report) {
    return normalizeReportLinks(report && report.links).map(function (link) {
      return '<a class="chip report-link" target="_blank" rel="noopener noreferrer" href="' + esc(link.url) +
        '" title="' + esc(link.label) + '">' + esc(link.label) + ' ↗</a>';
    }).join('');
  }
  function renderReportHeader() {
    if (!dom) return;
    var r = modelRef.report;
    if (dom.reportTitle) dom.reportTitle.textContent = r.title || '';
    if (dom.reportLinks) {
      dom.reportLinks.innerHTML = reportLinksHtml(r);
      dom.reportLinks.hidden = !dom.reportLinks.children.length;
    }
    if (dom.reportEnvironment) {
      if (r.environment) {
        dom.reportEnvironment.hidden = false;
        dom.reportEnvironmentText.textContent = r.environment;
      } else {
        dom.reportEnvironment.hidden = true;
      }
    }
    if (dom.reportExample) dom.reportExample.hidden = !r.example;
    if (dom.reportRevision) {
      dom.reportRevision.hidden = !r.revision;
      dom.reportRevision.textContent = r.revision ? ('版本 ' + r.revision) : '';
    }
    if (dom.reportExecutedAt) dom.reportExecutedAt.textContent = r.executedAt ? ('执行时间 ' + r.executedAt) : '';
    if (r.title) document.title = r.title + ' · 验收工作台';
  }

  function renderFilterRows() {
    var rendered = renderFilters(modelRef, state.filters);
    if (dom.groupFilters) dom.groupFilters.innerHTML = rendered.group;
    dom.statusFilters.innerHTML = rendered.status;
    dom.roleFilters.innerHTML = rendered.role;
    dom.pageFilters.innerHTML = rendered.page;
    var t = rendered.counts.totals;
    dom.sidebarFoot.textContent = '业务 ' + t.business + ' 条 · 审计 ' + t.audit + ' 条';
  }

  function renderCaseList() {
    dom.caseGroups.innerHTML = renderCaseGroups(modelRef, state.filters, state.caseId);
  }

  function renderMain() {
    closeTransient();
    var c = currentCase();
    if (!c) {
      renderEmptyMain();
      return;
    }
    resetCopyStore();
    resetFocusCells();
    var step = currentStep(c);
    dom.caseDetail.hidden = true;
    dom.inspector.hidden = false;
    dom.caseBar.innerHTML = renderCaseBar(modelRef, c, modelRef.report);
    dom.stepsBar.hidden = false;
    dom.stepsStrip.innerHTML = renderSteps(c, state.stepIndex);
    refreshStage();
    refreshInspector();
    scrollStepIntoView();
  }

  function renderEmptyMain() {
    dom.caseBar.innerHTML = '<div class="case-bar-empty">当前筛选没有匹配的用例</div>';
    dom.stepsBar.hidden = true;
    dom.stepsStrip.innerHTML = '';
    dom.repro.innerHTML = '';
    dom.stageBar.innerHTML = '<span class="stage-title">' + icon('image') + '<span>证据</span></span>';
    dom.stageCanvas.hidden = true;
    dom.stagePanel.hidden = false;
    dom.stagePanel.innerHTML = '<div class="empty-card">' + icon('search') +
      '<h3>当前筛选没有匹配的用例</h3>' +
      '<p>状态、目的、类型与搜索为 AND 组合；审计执行不计入业务状态。</p>' +
      '<button type="button" class="btn btn-primary" data-clear-filters>清空筛选</button></div>';
    dom.inspector.hidden = true;
    dom.caseDetail.hidden = true;
    state.img = null;
  }

  function viewport() {
    return { w: dom.stageCanvas.clientWidth, h: dom.stageCanvas.clientHeight };
  }

  function showStageEmpty(message) {
    state.img = null;
    dom.stageAnnotations.hidden = true;
    dom.stageAnnotations.innerHTML = '';
    dom.stageWorld.hidden = true;
    dom.stageImage.removeAttribute('src');
    dom.stageEmpty.hidden = false;
    dom.stageEmpty.innerHTML = '<div class="empty-card">' + icon('image') +
      '<h3>' + esc(message || '该步骤未提供系统截图') + '</h3>' +
      '<p>仅展示验收材料中已提供的原始截图，不用示意内容替代。</p></div>';
    dom.stageCanvas.classList.add('is-empty');
    setZoomControlsEnabled(false);
    if (dom.zoomLabel) dom.zoomLabel.textContent = '—';
  }

  function setZoomControlsEnabled(enabled) {
    ['[data-zoom="out"]', '[data-zoom="in"]', '[data-fit]', '[data-original]'].forEach(function (sel) {
      var el = dom.stageBar.querySelector(sel);
      if (el) el.disabled = !enabled;
    });
  }

  function moduleTitle(step, c) {
    return moduleLabel(step, c, modelRef);
  }

  function refreshStage() {
    var c = currentCase();
    if (!c) return;
    var step = currentStep(c);
    var image = resolveStepImage(step, modelRef.evidenceById);
    var wantPreview = isPageStep(step) && !!image.src;
    dom.stageBar.innerHTML = renderStageBar(step, c, modelRef);
    dom.zoomLabel = dom.stageBar.querySelector('#zoom-label');
    dom.repro.innerHTML = renderRepro(step, c, modelRef);
    dom.caseBar.innerHTML = renderCaseBar(modelRef, c, modelRef.report);
    hydrateIcons(dom.stageBar);
    hydrateIcons(dom.repro);
    hydrateIcons(dom.caseBar);

    if (wantPreview) {
      dom.stageCanvas.hidden = false;
      dom.stagePanel.hidden = true;
      dom.stageCanvas.classList.remove('is-empty');
      dom.stageEmpty.hidden = true;
      dom.stageWorld.hidden = false;
      setZoomControlsEnabled(true);
      renderPreview(image, step);
      return;
    }
    state.img = null;
    dom.stageWorld.hidden = true;
    dom.stageImage.removeAttribute('src');
    dom.stageEmpty.hidden = true;
    dom.stageCanvas.hidden = true;
    dom.stagePanel.hidden = false;
    dom.stagePanel.innerHTML = renderConsole(step, c, modelRef, state.splitRatio);
    hydrateIcons(dom.stagePanel);
  }

  function renderPreview(image, step) {
    if (dom.zoomLabel) dom.zoomLabel.textContent = '适应';
    resetZoom();
    var evidenceId = image.evidence ? str(image.evidence.id) : '';
    state.img = { nw: 0, nh: 0, src: image.src, evidenceId: evidenceId };
    dom.stageAnnotations.innerHTML = annotationsHtml(image.evidence && image.evidence.annotations);
    dom.stageAnnotations.hidden = !dom.stageAnnotations.children.length;
    var img = dom.stageImage;
    img.alt = image.title || moduleTitle(step, currentCase()) || '系统截图';
    img.onload = function () {
      state.img = { nw: img.naturalWidth || img.width, nh: img.naturalHeight || img.height, src: image.src, evidenceId: evidenceId };
      fitStage();
    };
    img.onerror = function () { showStageEmpty('截图未能从报告中加载'); };
    img.removeAttribute('src');
    img.setAttribute('src', image.src);
  }

  function refreshInspector() {
    var c = currentCase();
    if (!c) return;
    var step = currentStep(c);
    var rendered = renderInspector(step, c, modelRef);
    dom.inspectorBody.innerHTML = rendered.html;
    if (dom.inspectorStatus) {
      dom.inspectorStatus.className = 'ins-status' + (rendered.status.key ? ' ' + rendered.status.key : '');
      dom.inspectorStatus.innerHTML = icon(STATUS_ICON[rendered.status.key] || 'dot') +
        '<span>' + esc(rendered.status.text) + '</span>';
      hydrateIcons(dom.inspectorStatus);
    }
    hydrateIcons(dom.inspectorBody);
    setInspectorCollapsed(!state.inspectorOpen);
  }

  function resetZoom() {
    state.zoom = { scale: 1, tx: 0, ty: 0, mode: 'fit' };
    if (dom && dom.stageWorld) {
      dom.stageWorld.style.transform = 'translate(0px, 0px) scale(1)';
    }
  }

  function applyZoom() {
    var z = state.zoom;
    dom.stageWorld.style.transform = 'translate(' + z.tx + 'px, ' + z.ty + 'px) scale(' + z.scale + ')';
    if (dom.zoomLabel) dom.zoomLabel.textContent = z.mode === 'fit' ? '适应' : Math.round(z.scale * 100) + '%';
    var evidence = state.img && modelRef.evidenceById[state.img.evidenceId];
    Array.prototype.forEach.call(dom.stageAnnotations.children, function (el, index) {
      var annotation = evidence && evidence.annotations[index];
      if (!annotation) return;
      var box = layoutAnnotationBox(annotation, z);
      Object.keys(box).forEach(function (key) { el.style[key] = box[key] + 'px'; });
    });
  }

  function fitStage() {
    if (!state.img || !state.img.nw) return;
    var vp = viewport();
    state.zoom = fitTo(state.img.nw, state.img.nh, vp.w, vp.h);
    applyZoom();
  }

  function useOriginalSize() {
    if (!state.img || !state.img.nw) return;
    var vp = viewport();
    state.zoom = originalSize(state.img.nw, state.img.nh, vp.w, vp.h);
    applyZoom();
  }

  function zoomBy(factor) {
    if (!state.img || !state.img.nw) return;
    var vp = viewport();
    state.zoom = zoomAt(state.zoom, factor, vp.w / 2, vp.h / 2, state.img.nw, state.img.nh, vp.w, vp.h);
    applyZoom();
  }

  function scrollStepIntoView() {
    if (!dom.stepsStrip) return;
    var button = dom.stepsStrip.querySelector('.step-card.active');
    if (!button) return;
    var target = button.offsetLeft - dom.stepsStrip.offsetLeft - (dom.stepsStrip.clientWidth - button.offsetWidth) / 2;
    dom.stepsStrip.parentNode.scrollLeft = Math.max(0, target);
  }

  function setInspectorCollapsed(collapsed) {
    state.inspectorOpen = !collapsed;
    if (!dom || !dom.inspector) return;
    dom.inspector.classList.toggle('is-collapsed', !!collapsed);
    var btn = dom.stageBar.querySelector('[data-toggle-inspector]');
    if (btn) {
      btn.classList.toggle('is-on', !collapsed);
      btn.title = collapsed ? '展开检视器' : '收起检视器';
    }
  }

  /* 上下分栏比例只由状态决定；重渲染后按同一比例恢复，不随滚动或步骤切换漂移。 */
  function applySplitRatio(ratio) {
    state.splitRatio = clamp(num(ratio, SPLIT.initial), SPLIT.min, SPLIT.max);
    if (!dom || !dom.stagePanel) return state.splitRatio;
    var split = dom.stagePanel.querySelector('#console-split');
    if (!split) return state.splitRatio;
    var pct = Math.round(state.splitRatio * 1000) / 10;
    split.style.setProperty('--console-ratio', pct + '%');
    var gutter = split.querySelector('[data-split-gutter]');
    if (gutter) gutter.setAttribute('aria-valuenow', String(Math.round(state.splitRatio * 100)));
    return state.splitRatio;
  }

  function selectCase(index) {
    var c = modelRef.cases[index];
    if (!c) return;
    state.caseId = c.id;
    state.stepIndex = defaultStepIndex(c, modelRef.evidenceById);
    renderCaseList();
    renderMain();
  }

  function selectStep(index) {
    var c = currentCase();
    if (!c) return;
    state.stepIndex = clamp(index, 0, c.steps.length - 1);
    renderMain();
  }

  function toggleGroupMenu(open) {
    if (!dom || !dom.groupFilters) return;
    var toggle = dom.groupFilters.querySelector('[data-group-toggle]');
    var menu = dom.groupFilters.querySelector('.group-menu');
    if (!toggle || !menu) return;
    var next = !!open;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    menu.hidden = !next;
  }

  function applyFilters() {
    state.filters = normalizeFilters(state.filters);
    renderFilterRows();
    renderCaseList();
    var visible = filterCases(modelRef, state.filters);
    if (!visible.length) {
      renderEmptyMain();
      return;
    }
    var stillVisible = visible.some(function (c) { return c.id === state.caseId; });
    if (!stillVisible) {
      var first = visible[0];
      state.caseId = first.id;
      state.stepIndex = defaultStepIndex(first, modelRef.evidenceById);
      renderCaseList();
    }
    renderMain();
  }

  function showToast(message, tone) {
    if (!dom || !dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.className = 'toast toast-pop' + (tone ? ' ' + tone : '');
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.hidden = true; }, 1800);
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    if (!text) {
      showToast('没有可复制的内容', 'warn');
      return;
    }
    function fallback() {
      if (legacyCopy(text)) showToast('已复制', 'ok');
      else showToast('复制失败，请手动选择文本', 'warn');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast('已复制', 'ok'); }, fallback);
      return;
    }
    fallback();
  }

  function copyByKey(key) {
    copyText(copyTextByKey(key));
  }

  function setFullscreen(on) {
    if (!dom.stageShell) return;
    dom.stageShell.classList.toggle('is-fullscreen', !!on);
    var btn = dom.stageBar.querySelector('#fullscreen-btn');
    if (btn) {
      var svg = btn.querySelector('svg');
      if (svg) setIcon(svg, on ? 'fullscreen_exit' : 'fullscreen');
      btn.title = on ? '退出全屏' : '全屏查看截图';
    }
    window.setTimeout(function () {
      if (!state.img || !state.img.nw) return;
      if (state.zoom.mode === 'fit') fitStage();
      else {
        var vp = viewport();
        state.zoom = clampPan(state.zoom, state.img.nw, state.img.nh, vp.w, vp.h);
        applyZoom();
      }
    }, 30);
  }

  function toggleCaseDetail() {
    var c = currentCase();
    if (!c) return;
    var open = dom.caseDetail.hidden;
    if (open) {
      dom.caseDetail.innerHTML = renderCaseDetail(c);
      hydrateIcons(dom.caseDetail);
    }
    dom.caseDetail.hidden = !open;
    var btn = dom.caseBar.querySelector('[data-case-detail]');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function bindEvents() {
    dom.caseSearch.addEventListener('input', function () {
      state.filters.query = dom.caseSearch.value;
      applyFilters();
    });

    dom.listPane.addEventListener('click', function (event) {
      var toggle = event.target.closest('[data-group-toggle]');
      if (toggle) {
        toggleGroupMenu(toggle.getAttribute('aria-expanded') !== 'true');
        return;
      }
      var option = event.target.closest('[data-group-value]');
      if (option) {
        state.filters.group = option.getAttribute('data-group-value') || 'all';
        toggleGroupMenu(false);
        applyFilters();
        return;
      }
      var btn = event.target.closest('[data-filter]');
      if (!btn) return;
      var dimension = btn.getAttribute('data-filter');
      var value = btn.getAttribute('data-value');
      if (dimension === 'status' || dimension === 'role' || dimension === 'page') {
        state.filters[dimension] = value;
        applyFilters();
      }
    });

    document.addEventListener('click', function (event) {
      var select = event.target.closest && event.target.closest('[data-group-select]');
      if (!select) toggleGroupMenu(false);
    });

    dom.caseGroups.addEventListener('click', function (event) {
      var item = event.target.closest('[data-case-index]');
      if (!item) return;
      selectCase(parseInt(item.getAttribute('data-case-index'), 10));
    });

    dom.stepsStrip.addEventListener('click', function (event) {
      var btn = event.target.closest('[data-step-index]');
      if (!btn) return;
      selectStep(parseInt(btn.getAttribute('data-step-index'), 10));
    });

    dom.stageBar.addEventListener('click', function (event) {
      if (event.target.closest('[data-zoom="in"]')) zoomBy(1.25);
      else if (event.target.closest('[data-zoom="out"]')) zoomBy(0.8);
      else if (event.target.closest('[data-fit]')) fitStage();
      else if (event.target.closest('[data-original]')) useOriginalSize();
      else if (event.target.closest('[data-stage-annotations]')) {
        dom.stageAnnotations.hidden = !dom.stageAnnotations.hidden;
        var button = event.target.closest('[data-stage-annotations]');
        button.setAttribute('aria-pressed', dom.stageAnnotations.hidden ? 'false' : 'true');
        button.textContent = '重点标注 ' + dom.stageAnnotations.children.length + ' · ' + (dom.stageAnnotations.hidden ? '显示标注' : '隐藏标注');
      }
      else if (event.target.closest('[data-fullscreen]')) setFullscreen(!dom.stageShell.classList.contains('is-fullscreen'));
      else if (event.target.closest('[data-toggle-inspector]')) setInspectorCollapsed(state.inspectorOpen);
    });

    /* 中央核验台分隔条：指针拖动与键盘都只改比例，不重渲染内容（保留滚动位置）。 */
    var splitDrag = null;
    dom.stagePanel.addEventListener('pointerdown', function (event) {
      var gutter = event.target.closest('[data-split-gutter]');
      if (!gutter || event.button !== 0) return;
      var split = gutter.parentNode;
      if (!split) return;
      var box = split.getBoundingClientRect();
      splitDrag = { top: box.top, height: box.height };
      gutter.classList.add('is-dragging');
      try { gutter.setPointerCapture(event.pointerId); } catch (e) { /* 忽略不支持的指针捕获 */ }
      event.preventDefault();
    });
    dom.stagePanel.addEventListener('pointermove', function (event) {
      if (!splitDrag) return;
      applySplitRatio(ratioFromPointer(splitDrag.top, splitDrag.height, event.clientY, SPLIT.min, SPLIT.max));
    });
    function endSplitDrag() {
      if (!splitDrag) return;
      splitDrag = null;
      var dragging = dom.stagePanel.querySelector('[data-split-gutter].is-dragging');
      if (dragging) dragging.classList.remove('is-dragging');
    }
    dom.stagePanel.addEventListener('pointerup', endSplitDrag);
    dom.stagePanel.addEventListener('pointercancel', endSplitDrag);

    dom.stagePanel.addEventListener('keydown', function (event) {
      var gutter = event.target.closest && event.target.closest('[data-split-gutter]');
      if (!gutter) return;
      var next = null;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = stepRatio(state.splitRatio, -SPLIT.step, SPLIT.min, SPLIT.max);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = stepRatio(state.splitRatio, SPLIT.step, SPLIT.min, SPLIT.max);
      else if (event.key === 'Home') next = SPLIT.min;
      else if (event.key === 'End') next = SPLIT.max;
      if (next === null) return;
      event.preventDefault();
      applySplitRatio(next);
    });

    /* 关注单元格：悬停与键盘焦点共用同一张说明卡；离开单元格即收起。 */
    dom.stagePanel.addEventListener('mouseover', function (event) {
      var cell = event.target.closest('[data-focus-cell]');
      if (cell) showFocusPop(cell, cell.getAttribute('data-focus-cell'));
    });
    dom.stagePanel.addEventListener('mouseout', function (event) {
      var cell = event.target.closest('[data-focus-cell]');
      if (!cell) return;
      var to = event.relatedTarget;
      if (to && cell.contains(to)) return;
      hideFocusPop();
    });
    dom.stagePanel.addEventListener('focusin', function (event) {
      var cell = event.target.closest('[data-focus-cell]');
      if (cell) showFocusPop(cell, cell.getAttribute('data-focus-cell'));
    });
    dom.stagePanel.addEventListener('focusout', function (event) {
      var cell = event.target.closest('[data-focus-cell]');
      if (!cell) return;
      var to = event.relatedTarget;
      if (to && cell.contains(to)) return;
      hideFocusPop();
    });
    dom.stagePanel.addEventListener('click', function (event) {
      var cell = event.target.closest('[data-focus-cell]');
      if (cell) showFocusPop(cell, cell.getAttribute('data-focus-cell'));
    });

    dom.caseBar.addEventListener('click', function (event) {
      if (event.target.closest('[data-case-detail]')) toggleCaseDetail();
    });

    dom.caseDetail.addEventListener('click', function (event) {
      if (event.target.closest('[data-case-detail-close]') || event.target === dom.caseDetail) toggleCaseDetail();
    });

    document.addEventListener('click', function (event) {
      var lbTrigger = event.target.closest('[data-lightbox-evidence]');
      if (lbTrigger) {
        event.preventDefault();
        openLightbox(lbTrigger.getAttribute('data-lightbox-evidence'), lbTrigger);
        return;
      }
      if (event.target.closest('[data-lightbox-close]')) { closeLightbox(); return; }
      var lbZoomBtn = event.target.closest('[data-lb-zoom]');
      if (lbZoomBtn) { lbZoomBy(lbZoomBtn.getAttribute('data-lb-zoom') === 'in' ? 1.25 : 0.8); return; }
      if (event.target.closest('[data-lb-fit]')) { lbFit(); return; }
      if (event.target.closest('[data-lb-actual]')) { lbActual(); return; }
      if (event.target.closest('[data-lb-toggle-anno]')) { setAnnotationsVisible(!lbState.showAnnotations); return; }

      var rowBtn = event.target.closest('[data-result-index][data-row-index]');
      if (rowBtn) {
        openRowDetail(parseInt(rowBtn.getAttribute('data-result-index'), 10), parseInt(rowBtn.getAttribute('data-row-index'), 10), rowBtn);
        return;
      }
      if (event.target.closest('[data-row-detail-close]')) { closeRowDetail(); return; }
      if (!dom.rowDetail.hidden && !event.target.closest('.row-detail')) closeRowDetail(false);

      var gotoBtn = event.target.closest('[data-goto-result]');
      if (gotoBtn) {
        jumpToFocusCell(gotoBtn.getAttribute('data-goto-result'), gotoBtn.getAttribute('data-goto-row'), gotoBtn.getAttribute('data-goto-column'));
        return;
      }

      var prefillBtn = event.target.closest('[data-prefill-toggle]');
      if (prefillBtn) {
        var open = prefillBtn.getAttribute('aria-expanded') !== 'true';
        if (open) togglePrefillPop(true); else closePrefillPop();
        return;
      }
      if (event.target.closest('[data-prefill-close]')) { closePrefillPop(); return; }
      if (!dom.prefillPop.hidden && !event.target.closest('.prefill-pop')) closePrefillPop();

      if (!dom.focusPop.hidden && !event.target.closest('[data-focus-cell]')) hideFocusPop();

      var copyBtn = event.target.closest('[data-copy-key]');
      if (copyBtn) {
        copyByKey(copyBtn.getAttribute('data-copy-key'));
        return;
      }
      var codeToggle = event.target.closest('[data-code-toggle]');
      if (codeToggle) {
        toggleCodeView(codeToggle);
        return;
      }
      if (event.target.closest('[data-clear-filters]')) {
        state.filters = defaultFilters();
        if (dom && dom.caseSearch) dom.caseSearch.value = '';
        applyFilters();
      }
    });

    dom.stageCanvas.addEventListener('wheel', function (event) {
      if (!state.img || !state.img.nw) return;
      event.preventDefault();
      var rect = dom.stageCanvas.getBoundingClientRect();
      var vp = viewport();
      state.zoom = zoomAt(state.zoom, wheelFactor(event.deltaY, event.deltaMode),
        event.clientX - rect.left, event.clientY - rect.top, state.img.nw, state.img.nh, vp.w, vp.h);
      applyZoom();
    }, { passive: false });

    var drag = null;
    var stageClick = null;
    var imgClickTimer = null;
    dom.stageCanvas.addEventListener('pointerdown', function (event) {
      if (!state.img || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, tx: state.zoom.tx, ty: state.zoom.ty };
      stageClick = { x: event.clientX, y: event.clientY };
      dom.stageCanvas.classList.add('is-dragging');
      dom.stageCanvas.focus();
      try { dom.stageCanvas.setPointerCapture(event.pointerId); } catch (e) { /* 忽略不支持的指针捕获 */ }
    });
    dom.stageCanvas.addEventListener('pointermove', function (event) {
      if (!drag || !state.img) return;
      var vp = viewport();
      state.zoom = clampPan({
        scale: state.zoom.scale,
        tx: drag.tx + (event.clientX - drag.x),
        ty: drag.ty + (event.clientY - drag.y),
        mode: 'custom',
      }, state.img.nw, state.img.nh, vp.w, vp.h);
      applyZoom();
    });
    function endDrag() {
      drag = null;
      dom.stageCanvas.classList.remove('is-dragging');
    }
    /* 单击打开统一灯箱；轻拖或双击不算点击，双击仍复位缩放。 */
    dom.stageCanvas.addEventListener('pointerup', function (event) {
      var click = stageClick;
      stageClick = null;
      endDrag();
      if (!click || !state.img || !state.img.evidenceId) return;
      if (Math.abs(event.clientX - click.x) > 4 || Math.abs(event.clientY - click.y) > 4) return;
      clearTimeout(imgClickTimer);
      var id = state.img.evidenceId;
      imgClickTimer = setTimeout(function () { openLightbox(id, dom.stageCanvas); }, 220);
    });
    dom.stageCanvas.addEventListener('pointercancel', function () { stageClick = null; endDrag(); });
    dom.stageCanvas.addEventListener('dblclick', function () { clearTimeout(imgClickTimer); fitStage(); });

    /* 灯箱：滚轮锚点缩放、拖动平移、双击复位，与中央截图一致的交互约定。 */
    dom.lbStage.addEventListener('wheel', function (event) {
      if (dom.lightbox.hidden || !lbState.size.nw) return;
      event.preventDefault();
      var rect = dom.lbStage.getBoundingClientRect();
      lbZoomBy(wheelFactor(event.deltaY, event.deltaMode), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    dom.lbStage.addEventListener('pointerdown', function (event) {
      if (dom.lightbox.hidden || !lbState.size.nw || event.button !== 0) return;
      if (event.target.closest('.lb-anno')) return;
      lbState.drag = { x: event.clientX, y: event.clientY, tx: lbState.zoom.tx, ty: lbState.zoom.ty };
      dom.lbStage.classList.add('is-dragging');
      try { dom.lbStage.setPointerCapture(event.pointerId); } catch (e) { /* 忽略不支持的指针捕获 */ }
    });
    dom.lbStage.addEventListener('pointermove', function (event) {
      if (!lbState.drag || !lbState.size.nw) return;
      var vp = lbViewport();
      lbState.zoom = clampPan({
        scale: lbState.zoom.scale,
        tx: lbState.drag.tx + (event.clientX - lbState.drag.x),
        ty: lbState.drag.ty + (event.clientY - lbState.drag.y),
        mode: 'custom',
      }, lbState.size.nw, lbState.size.nh, vp.w, vp.h);
      lbApplyZoom();
    });
    function endLbDrag() {
      lbState.drag = null;
      dom.lbStage.classList.remove('is-dragging');
    }
    dom.lbStage.addEventListener('pointerup', endLbDrag);
    dom.lbStage.addEventListener('pointercancel', endLbDrag);
    dom.lbStage.addEventListener('dblclick', function () { lbFit(); });

    dom.stageCanvas.addEventListener('keydown', function (event) {
      if (!state.img) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(0.8); }
      else if (event.key === '0') { event.preventDefault(); fitStage(); }
      else if (event.key === '1') { event.preventDefault(); useOriginalSize(); }
    });

    function lightboxFocusables() {
      if (!dom || !dom.lightbox) return [];
      return Array.prototype.filter.call(
        dom.lightbox.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
        function (el) { return el.offsetParent !== null; }
      );
    }
    /* 灯箱打开时把 Tab 限制在面板内，关闭后焦点回到触发元素。 */
    function trapLightboxFocus(event) {
      var items = lightboxFocusables();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (!dom.lightbox.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    document.addEventListener('keydown', function (event) {
      if (!dom.lightbox.hidden) {
        if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); return; }
        if (event.key === 'Tab') { trapLightboxFocus(event); return; }
        if (event.key === '+' || event.key === '=') { event.preventDefault(); lbZoomBy(1.25); return; }
        if (event.key === '-' || event.key === '_') { event.preventDefault(); lbZoomBy(0.8); return; }
        if (event.key === '0') { event.preventDefault(); lbFit(); return; }
        if (event.key === '1') { event.preventDefault(); lbActual(); return; }
        return;
      }
      if (event.key !== 'Escape') return;
      if (!dom.rowDetail.hidden) { closeRowDetail(); return; }
      if (!dom.prefillPop.hidden) { closePrefillPop(); return; }
      if (!dom.focusPop.hidden) { hideFocusPop(); return; }
      var groupMenu = dom.groupFilters && dom.groupFilters.querySelector('.group-menu:not([hidden])');
      if (groupMenu) { toggleGroupMenu(false); return; }
      if (dom.stageShell.classList.contains('is-fullscreen')) setFullscreen(false);
      else if (!dom.caseDetail.hidden) toggleCaseDetail();
    });

    if (dom.helpBtn) {
      dom.helpBtn.addEventListener('click', function () { dom.helpPanel.hidden = !dom.helpPanel.hidden; });
    }
    if (dom.helpClose) {
      dom.helpClose.addEventListener('click', function () { dom.helpPanel.hidden = true; });
    }

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!state.img || !state.img.nw) return;
        var vp = viewport();
        if (state.zoom.mode === 'fit') fitStage();
        else {
          state.zoom = clampPan(state.zoom, state.img.nw, state.img.nh, vp.w, vp.h);
          applyZoom();
        }
      }, 120);
    });
  }

  function cacheDom() {
    dom = {
      reportTitle: document.getElementById('report-title'),
      reportEnvironment: document.getElementById('report-environment'),
      reportLinks: document.getElementById('report-links'),
      reportEnvironmentText: document.getElementById('report-environment-text'),
      reportExample: document.getElementById('report-example-badge'),
      reportRevision: document.getElementById('report-revision'),
      reportExecutedAt: document.getElementById('report-executed-at'),
      listPane: document.getElementById('list-pane'),
      sidebarFoot: document.getElementById('sidebar-foot'),
      caseSearch: document.getElementById('case-search'),
      groupFilters: document.getElementById('group-filters'),
      statusFilters: document.getElementById('status-filters'),
      roleFilters: document.getElementById('role-filters'),
      pageFilters: document.getElementById('page-filters'),
      caseGroups: document.getElementById('case-groups'),
      caseBar: document.getElementById('case-bar'),
      stepsBar: document.getElementById('steps-bar'),
      stepsStrip: document.getElementById('steps-strip'),
      workBody: document.getElementById('work-body'),
      stageShell: document.getElementById('stage-shell'),
      stageBar: document.getElementById('stage-bar'),
      stageBody: document.getElementById('stage-body'),
      stageCanvas: document.getElementById('stage-canvas'),
      stageWorld: document.getElementById('stage-world'),
      stageAnnotations: document.getElementById('stage-annotations'),
      stageImage: document.getElementById('stage-image'),
      stageEmpty: document.getElementById('stage-empty'),
      stagePanel: document.getElementById('stage-panel'),
      repro: document.getElementById('repro'),
      inspector: document.getElementById('inspector'),
      inspectorStatus: document.getElementById('inspector-status'),
      inspectorBody: document.getElementById('inspector-body'),
      caseDetail: document.getElementById('case-detail'),
      focusPop: document.getElementById('focus-pop'),
      rowDetail: document.getElementById('row-detail'),
      prefillPop: document.getElementById('prefill-pop'),
      lightbox: document.getElementById('lightbox'),
      lbTitle: document.getElementById('lb-title'),
      lbMeta: document.getElementById('lb-meta'),
      lbStage: document.getElementById('lb-stage'),
      lbWorld: document.getElementById('lb-world'),
      lbImage: document.getElementById('lb-image'),
      lbAnnotations: document.getElementById('lb-annotations'),
      lbEmpty: document.getElementById('lb-empty'),
      lbLegend: document.getElementById('lb-legend'),
      lbZoomLabel: document.getElementById('lb-zoom-label'),
      lbZoomValue: document.getElementById('lb-zoom-value'),
      lbAnnoCount: document.getElementById('lb-anno-count'),
      lbToggleAnno: document.getElementById('lb-toggle-anno'),
      toast: document.getElementById('toast'),
      helpBtn: document.getElementById('btn-help'),
      helpPanel: document.getElementById('help-panel'),
      helpClose: document.getElementById('btn-help-close'),
    };
  }

  function navigateReportHash() {
    var params = new URLSearchParams(location.hash.slice(1));
    var caseId = params.get('case');
    var index = modelRef.cases.findIndex(function (c) { return c.id === caseId; });
    if (index < 0) return;
    state.filters = defaultFilters();
    selectCase(index);
    var stepId = params.get('step');
    var stepIndex = modelRef.cases[index].steps.findIndex(function (s) { return s.id === stepId; });
    if (stepIndex >= 0) selectStep(stepIndex);
    renderFilterRows();
    renderCaseList();
  }

  function boot() {
    var node = document.getElementById('acceptance-data');
    if (!node) {
      document.body.innerHTML = '<div class="list-empty">缺少 #acceptance-data 数据块，无法渲染验收报告。</div>';
      return;
    }
    var payload;
    try {
      payload = JSON.parse(node.textContent || '');
    } catch (error) {
      document.body.innerHTML = '<div class="list-empty">验收数据不是合法 JSON，界面不可用。</div>';
      return;
    }
    try {
      modelRef = buildModel(payload);
    } catch (error) {
      document.body.innerHTML = '<div class="list-empty">验收数据结构无法识别：' + esc(error.message) + '</div>';
      return;
    }
    cacheDom();
    hydrateIcons(document);
    state.filters = defaultFilters();
    var first = modelRef.cases[0];
    if (first) {
      state.caseId = first.id;
      state.stepIndex = defaultStepIndex(first, modelRef.evidenceById);
    }
    renderReportHeader();
    renderFilterRows();
    renderCaseList();
    bindEvents();
    renderMain();
    navigateReportHash();
    window.addEventListener('hashchange', navigateReportHash);
  }

  var api = {
    STATUSES: STATUSES,
    STATUS_LABEL: STATUS_LABEL,
    ROLE_ORDER: ROLE_ORDER,
    ORIGIN_LABEL: ORIGIN_LABEL,
    SPLIT: SPLIT,
    defaultFilters: defaultFilters,
    normalizeFilters: normalizeFilters,
    caseRoleOf: caseRoleOf,
    isAudit: isAudit,
    hasPage: hasPage,
    isPageStep: isPageStep,
    statusKeyOf: statusKeyOf,
    statusLabel: statusLabel,
    roleLabel: roleLabel,
    matchesCase: matchesCase,
    filterCases: filterCases,
    computeCounts: computeCounts,
    buildSearchText: buildSearchText,
    buildModel: buildModel,
    defaultStepIndex: defaultStepIndex,
    normalizeComparison: normalizeComparison,
    buildVerification: buildVerification,
    resolveStepImage: resolveStepImage,
    evidenceIdsOf: evidenceIdsOf,
    evidenceContentText: evidenceContentText,
    readJsonTree: readJsonTree,
    jsonTable: jsonTable,
    buildResultSets: buildResultSets,
    buildResponse: buildResponse,
    buildStageModel: buildStageModel,
    codeViewHtml: codeViewHtml,
    toggleCodeView: toggleCodeView,
    renderCaseGroups: renderCaseGroups,
    renderFilters: renderFilters,
    renderCaseBar: renderCaseBar,
    renderCaseHeader: renderCaseBar,
    renderCaseDetail: renderCaseDetail,
    renderSteps: renderSteps,
    renderStageBar: renderStageBar,
    renderConsole: renderConsole,
    renderInspector: renderInspector,
    ratioFromPointer: ratioFromPointer,
    stepRatio: stepRatio,
    renderRepro: renderRepro,
    renderEvidenceItems: renderEvidenceItems,
    renderEvidenceAccordion: renderEvidenceAccordion,
    statementCopyText: statementCopyText,
    reproCopyText: reproCopyText,
    copyTextByKey: copyTextByKey,
    dumpCopyStore: function () { return copyStore; },
    clampPan: clampPan,
    fitTo: fitTo,
    originalSize: originalSize,
    zoomAt: zoomAt,
    wheelFactor: wheelFactor,
    safeHttpsUrl: safeHttpsUrl,
    safeImgSrc: safeImgSrc,
    normalizeCaseDesign: normalizeCaseDesign,
    normalizeReportLinks: normalizeReportLinks,
    reportLinksHtml: reportLinksHtml,
    normalizeAnnotations: normalizeAnnotations,
    normalizeUed: normalizeUed,
    normalizePrefill: normalizePrefill,
    prefillParamText: prefillParamText,
    prefillHref: prefillHref,
    prefillSummary: prefillSummary,
    prefillPopHtml: prefillPopHtml,
    caseDesignHtml: caseDesignHtml,
    uedHtml: uedHtml,
    focusListHtml: focusListHtml,
    focusRefText: focusRefText,
    buildFocusMap: buildFocusMap,
    circled: circled,
    focusPopHtml: focusPopHtml,
    buildResultSets: buildResultSets,
    rowFields: rowFields,
    rowRawText: rowRawText,
    rowDetailHtml: rowDetailHtml,
    annotationsHtml: annotationsHtml,
    legendHtml: legendHtml,
    layoutAnnotationBox: layoutAnnotationBox,
    renderLightbox: renderLightbox,
    icon: icon,
    setIcon: setIcon,
    ICON_PATHS: ICON_PATHS,
    esc: esc,
    boot: boot,
    __setModel: function (model) { modelRef = model; resetCopyStore(); },
    __copyStore: copyStore,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.StudioViewer = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
