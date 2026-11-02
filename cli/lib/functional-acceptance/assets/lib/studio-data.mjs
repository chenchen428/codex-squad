/**
 * studio 视图的数据适配器（纯函数，无 DOM 依赖）。
 *
 * 只读取 CLI 内联的标准 payload：cases/steps/evidence 保持原字段，status/actual/checks
 * 一律透传，不推断、不改写。左侧导航使用 displayTitle 语义名称，缺省回退 title；
 * id 只用于关联、搜索和详情。旧数据没有 verification/reproduction 时给出明确提示，
 * 由视图按 action/expected/actual 展示三步逻辑，不把采集元数据摊平成业务结果。
 */

export const LEGACY_VERIFICATION_NOTICE = '该步骤未提供查询原文与对比结论（verification），这里按动作、预期与实际结果展示；如需核对查询原文，请补充该步骤的 verification 后重新生成。';

export function isFilled(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function groupLabel(group) {
  if (!group) return '';
  return isFilled(group.displayTitle) ? group.displayTitle : group.title;
}

export function caseLabel(item) {
  if (!item) return '';
  return isFilled(item.displayTitle) ? item.displayTitle : item.title;
}

export function stepLabel(step) {
  if (!step) return '';
  return isFilled(step.displayTitle) ? step.displayTitle : step.title;
}

function resolveList(ids, getEvidence) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => getEvidence(id)).filter(Boolean);
}

export function normalizePageView(view) {
  if (!view || typeof view !== 'object') return null;
  return {
    ...view,
    caption: isFilled(view.caption) ? view.caption : null,
  };
}

export function normalizeVerification(verification, getEvidence) {
  if (!verification || typeof verification !== 'object') return null;
  const focus = Array.isArray(verification.focus)
    ? verification.focus.map((item) => ({
      label: item.label,
      reason: item.reason,
      actual: item.actual,
      evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.slice() : [],
      evidence: resolveList(item.evidenceIds, getEvidence),
    }))
    : [];
  const comparison = Array.isArray(verification.comparison)
    ? verification.comparison.map((item) => ({
      label: item.label,
      expected: item.expected,
      actual: item.actual,
      /* status 完全来自 Agent，视图与适配器都不根据 expected === actual 改写。 */
      status: item.status,
      evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.slice() : [],
      evidence: resolveList(item.evidenceIds, getEvidence),
    }))
    : [];
  let statement = null;
  if (verification.statement && typeof verification.statement === 'object') {
    const raw = verification.statement;
    statement = {
      kind: raw.kind,
      text: typeof raw.text === 'string' ? raw.text : '',
      origin: raw.origin,
      explanation: isFilled(raw.explanation) ? raw.explanation : null,
      parameters: Array.isArray(raw.parameters)
        ? raw.parameters.map((item) => ({ name: item.name, value: item.value, reason: item.reason }))
        : [],
      /* executed 才代表原始执行文本；reconstructed/unavailable 由视图按原文展示边界。 */
      executed: raw.origin === 'executed',
    };
  }
  return {
    question: isFilled(verification.question) ? verification.question : null,
    method: isFilled(verification.method) ? verification.method : null,
    focus,
    statement,
    comparison,
    conclusion: isFilled(verification.conclusion) ? verification.conclusion : null,
    limitations: Array.isArray(verification.limitations) ? verification.limitations.slice() : [],
  };
}

export function normalizeReproduction(reproduction, getEvidence) {
  if (!reproduction || typeof reproduction !== 'object') return null;
  const verified = reproduction.urlStatus === 'verified' && isFilled(reproduction.url);
  return {
    kind: reproduction.kind,
    label: reproduction.label,
    urlStatus: reproduction.urlStatus,
    /* 未核验时永不保留可点地址，避免用占位/未核验地址冒充入口。 */
    url: verified ? reproduction.url : null,
    openable: verified,
    reason: isFilled(reproduction.reason) ? reproduction.reason : null,
    /* params 是复制用的请求/模板文本，不是返回结果。 */
    params: isFilled(reproduction.params) ? reproduction.params : null,
    instructions: isFilled(reproduction.instructions) ? reproduction.instructions : null,
    constraints: Array.isArray(reproduction.constraints) ? reproduction.constraints.slice() : [],
    sourceIds: Array.isArray(reproduction.sourceIds) ? reproduction.sourceIds.slice() : [],
    sources: resolveList(reproduction.sourceIds, getEvidence),
  };
}

export function normalizeStep(step, getEvidence) {
  const verification = normalizeVerification(step.verification, getEvidence);
  return {
    id: step.id,
    title: stepLabel(step),
    displayTitle: isFilled(step.displayTitle) ? step.displayTitle : null,
    type: step.type,
    page: step.page || null,
    status: step.status,
    action: step.action,
    expected: step.expected,
    actual: step.actual,
    durationMs: step.durationMs,
    evidenceIds: Array.isArray(step.evidenceIds) ? step.evidenceIds.slice() : [],
    evidence: resolveList(step.evidenceIds, getEvidence),
    pageView: normalizePageView(step.pageView),
    verification,
    verificationState: verification ? 'provided' : 'legacy',
    legacyNotice: verification ? null : LEGACY_VERIFICATION_NOTICE,
    reproduction: normalizeReproduction(step.reproduction, getEvidence),
    raw: step,
  };
}

export function createStudioModel(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('studio 适配器需要 CLI 生成的 acceptance payload');
  }
  const evidenceList = Array.isArray(payload.evidence) ? payload.evidence : [];
  const evidenceById = new Map(evidenceList.map((item) => [item.id, item]));
  const getEvidence = (id) => evidenceById.get(id) || null;

  const groups = (Array.isArray(payload.groups) ? payload.groups : []).map((group) => ({
    id: group.id,
    title: groupLabel(group),
    displayTitle: isFilled(group.displayTitle) ? group.displayTitle : null,
    requirement: group.requirement || null,
    raw: group,
  }));

  let legacySteps = 0;
  let legacyWithoutReproduction = 0;
  const cases = (Array.isArray(payload.cases) ? payload.cases : []).map((item) => {
    const steps = (Array.isArray(item.steps) ? item.steps : []).map((step) => {
      const normalized = normalizeStep(step, getEvidence);
      if (normalized.verificationState === 'legacy') legacySteps += 1;
      if (!normalized.reproduction) legacyWithoutReproduction += 1;
      return normalized;
    });
    return {
      id: item.id,
      groupId: item.groupId,
      title: caseLabel(item),
      displayTitle: isFilled(item.displayTitle) ? item.displayTitle : null,
      requirement: item.requirement || null,
      objective: item.objective,
      status: item.status,
      caseRole: item.caseRole || 'unknown',
      caseRoleReason: item.caseRoleReason || null,
      caseRoleSources: Array.isArray(item.caseRoleSources) ? item.caseRoleSources.slice() : [],
      preconditions: Array.isArray(item.preconditions) ? item.preconditions.slice() : [],
      steps,
      checks: Array.isArray(item.checks) ? item.checks : [],
      raw: item,
    };
  });

  const nav = groups.map((group) => ({
    id: group.id,
    label: group.title,
    cases: cases
      .filter((item) => item.groupId === group.id)
      .map((item) => ({
        id: item.id,
        label: item.title,
        status: item.status,
        steps: item.steps.map((step) => ({ id: step.id, label: step.title, type: step.type, status: step.status })),
      })),
  }));

  return {
    schemaVersion: payload.schemaVersion,
    assetMode: payload.assetMode || 'inline',
    report: payload.report,
    groups,
    cases,
    nav,
    recordings: Array.isArray(payload.recordings) ? payload.recordings : [],
    evidence: evidenceList,
    getEvidence,
    legacy: {
      stepsWithoutVerification: legacySteps,
      stepsWithoutReproduction: legacyWithoutReproduction,
      notice: LEGACY_VERIFICATION_NOTICE,
    },
  };
}

export default createStudioModel;
