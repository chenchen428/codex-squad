/* 验收用例筛选：状态 / 用例目的 / 页面与接口数据 / 搜索 四条件 AND 组合。
 * 状态按业务口径统计，执行审计记录不计入；审计执行状态单独返回，原 status 不改写。
 * 纯函数，无 DOM 依赖；页面内联时挂到 window，Node 测试通过 CommonJS 读取。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AcceptanceCaseFilter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUSES = ['passed', 'failed', 'blocked', 'partial', 'not_run'];
  var ROLES = ['new', 'regression', 'mixed', 'audit', 'unknown'];
  var PAGE_SCOPES = ['page', 'data'];
  var AUDIT_ROLE = 'audit';

  function statusOf(c) {
    return c && STATUSES.indexOf(c.status) !== -1 ? c.status : 'not_run';
  }
  function roleOf(c) {
    return c && ROLES.indexOf(c.caseRole) !== -1 ? c.caseRole : 'unknown';
  }
  function isAudit(c) {
    return roleOf(c) === AUDIT_ROLE;
  }
  function hasPage(c) {
    return !!c && Array.isArray(c.steps) && c.steps.some(function (step) {
      return step && step.type === 'page';
    });
  }

  function normalize(filters) {
    var f = filters || {};
    return {
      status: f.status || 'all',
      role: f.role || 'all',
      page: f.page || 'all',
      query: f.query || '',
    };
  }

  /* statusScope：'business' 时状态按业务口径筛选（排除审计记录）；'audit' 时只看审计记录自身的执行状态。 */
  function matchCore(c, groupTitle, f, statusScope) {
    if (f.status !== 'all') {
      /* 避免审计执行失败被当成产品失败：业务状态筛选不包含审计记录。 */
      if (statusScope !== 'audit' && isAudit(c) && f.role !== AUDIT_ROLE) return false;
      if (statusOf(c) !== f.status) return false;
    }
    if (f.role !== 'all' && roleOf(c) !== f.role) return false;
    if (f.page === 'page' && !hasPage(c)) return false;
    if (f.page === 'data' && hasPage(c)) return false;
    var q = String(f.query).trim().toLowerCase();
    if (!q) return true;
    var haystack = [c.id, c.title, c.requirement, c.objective, c.caseRoleReason, groupTitle || '']
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.indexOf(q) !== -1;
  }

  function matches(c, groupTitle, filters) {
    return !!c && matchCore(c, groupTitle, normalize(filters), 'business');
  }

  /* 每个选项的数量 = 其余筛选条件不变、仅本维度取该选项时的匹配数；mixed 只按一条计数。 */
  function counts(cases, groups, filters) {
    var list = Array.isArray(cases) ? cases : [];
    var titleById = Object.create(null);
    (Array.isArray(groups) ? groups : []).forEach(function (group) {
      if (group && group.id) titleById[group.id] = group.title;
    });
    var base = normalize(filters);
    function countWith(dimension, value, scope) {
      var probe = { status: base.status, role: base.role, page: base.page, query: base.query };
      probe[dimension] = value;
      return list.filter(function (c) {
        if (!matchCore(c, titleById[c.groupId], probe, scope === 'audit' ? 'audit' : 'business')) return false;
        if (scope === 'business') return !isAudit(c);
        if (scope === 'audit') return isAudit(c);
        return true;
      }).length;
    }
    function facet(dimension, values, scope) {
      var out = { all: countWith(dimension, 'all', scope) };
      values.forEach(function (value) { out[value] = countWith(dimension, value, scope); });
      return out;
    }
    var business = 0;
    var audit = 0;
    list.forEach(function (c) { if (isAudit(c)) audit += 1; else business += 1; });
    return {
      /* status 为业务口径（排除执行审计记录）；auditStatus 为审计记录自身的执行状态。 */
      status: facet('status', STATUSES, 'business'),
      auditStatus: facet('status', STATUSES, 'audit'),
      role: facet('role', ROLES),
      page: facet('page', PAGE_SCOPES),
      totals: { all: list.length, business: business, audit: audit },
    };
  }

  return {
    STATUSES: STATUSES,
    ROLES: ROLES,
    PAGE_SCOPES: PAGE_SCOPES,
    statusOf: statusOf,
    roleOf: roleOf,
    isAudit: isAudit,
    hasPage: hasPage,
    matches: matches,
    counts: counts,
  };
});
