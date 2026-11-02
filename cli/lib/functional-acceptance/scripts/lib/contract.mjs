import {
  SCHEMA_VERSION,
  STATUSES,
  CASE_ROLES,
  STEP_TYPES,
  EVIDENCE_TYPES,
  EVIDENCE_CATEGORIES,
  RECORDING_FORMATS,
  STATEMENT_KINDS,
  STATEMENT_ORIGINS,
  REPRODUCTION_KINDS,
  REPRODUCTION_URL_STATUSES,
  CASE_DESIGN_SOURCE_KINDS,
  ANNOTATION_TONES,
  STATEMENT_UNAVAILABLE_MARKERS,
  STATEMENT_RECONSTRUCTED_MARKERS,
  STATEMENT_EXECUTED_CLAIMS,
} from './constants.mjs';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}
function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item));
}

/* 地址里出现这些片段说明仍是模板或占位，不能当作已核验入口。 */
function hasUrlPlaceholder(url) {
  return /[{}<>]|%7B|%7D|\$\{|\.\.\.|your[-_]/i.test(url) || /(^|\.)example\.(com|org|net)(:\d+)?(\/|$)/i.test(url);
}

/* 还原出来的陈述若声明“执行原文”，需确认不是“非执行原文”这类否定表达。 */
function claimsExecutedText(text) {
  for (const claim of STATEMENT_EXECUTED_CLAIMS) {
    let index = text.indexOf(claim);
    while (index !== -1) {
      const before = text.slice(Math.max(0, index - 8), index);
      const negated = /(非|不是|并非|未|没有|无)[^，。；]{0,4}$/.test(before);
      if (!negated) return true;
      index = text.indexOf(claim, index + claim.length);
    }
  }
  return false;
}

function checkEvidenceRefs(value, fieldPath, evidenceIds, err, code) {
  if (value === undefined) return;
  if (!stringArray(value)) {
    err('E_EVIDENCE_REF_TYPE', fieldPath, 'evidenceIds 必须是字符串数组');
    return;
  }
  value.forEach((id, index) => {
    if (!evidenceIds.has(id)) err(code, `${fieldPath}[${index}]`, `证据引用不存在：${id}`);
  });
}

function checkHttpsLink(value, fieldPath, err, code) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) {
    err(code, fieldPath, '链接必须是非空 https 地址');
    return;
  }
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    err(code, fieldPath, `不是合法 URL：${url}`);
    return;
  }
  if (parsed.protocol !== 'https:') err(code, fieldPath, '链接必须使用 https');
  if (hasUrlPlaceholder(url)) err(code, fieldPath, '链接不能包含占位符或模板片段');
}

/* 用例设计依据：why 说明为什么需要此用例，sources 保留原话、出处或链接。 */
function validateCaseDesign(design, base, err) {
  if (!isObject(design)) {
    err('E_CASE_DESIGN', base, 'caseDesign 必须是 {why,sources} 对象');
    return;
  }
  if (!nonEmptyString(design.why)) {
    err('E_CASE_DESIGN_WHY', `${base}.why`, 'caseDesign.why 必须说明为什么需要此用例及覆盖的风险');
  }
  if (!Array.isArray(design.sources) || design.sources.length === 0) {
    err('E_CASE_DESIGN_SOURCES', `${base}.sources`, 'caseDesign.sources 至少需要一项设计依据');
    return;
  }
  design.sources.forEach((source, index) => {
    const sourceBase = `${base}.sources[${index}]`;
    if (!isObject(source)) {
      err('E_CASE_DESIGN_SOURCE', sourceBase, '设计依据必须是 {kind,label,quote|ref|url} 对象');
      return;
    }
    if (!CASE_DESIGN_SOURCE_KINDS.includes(source.kind)) {
      err('E_CASE_DESIGN_SOURCE_KIND', `${sourceBase}.kind`, `kind 只能是 ${CASE_DESIGN_SOURCE_KINDS.join(' / ')}`);
    }
    if (!nonEmptyString(source.label)) {
      err('E_CASE_DESIGN_SOURCE_LABEL', `${sourceBase}.label`, '设计依据 label 必须是非空字符串');
    }
    for (const key of ['quote', 'ref', 'note']) {
      if (source[key] !== undefined && !nonEmptyString(source[key])) {
        err('E_CASE_DESIGN_SOURCE_FIELD', `${sourceBase}.${key}`, `${key} 填写时必须是非空字符串`);
      }
    }
    if (source.url !== undefined) checkHttpsLink(source.url, `${sourceBase}.url`, err, 'E_CASE_DESIGN_SOURCE_URL');
    if (!nonEmptyString(source.quote) && !nonEmptyString(source.ref) && !nonEmptyString(source.url)) {
      err('E_CASE_DESIGN_SOURCE_EVIDENCE', sourceBase, '设计依据至少保留原话 quote、出处 ref 或可跳转 url 之一');
    }
  });
}

function validateUed(ued, base, evidenceIds, evidenceTypeById, err) {
  if (!isObject(ued)) {
    err('E_VERIFICATION_UED', base, 'ued 必须是 {evidenceId,...} 对象');
    return;
  }
  if (!nonEmptyString(ued.evidenceId)) {
    err('E_VERIFICATION_UED_EVIDENCE', `${base}.evidenceId`, 'ued.evidenceId 必须是非空字符串');
  } else if (!evidenceIds.has(ued.evidenceId)) {
    err('E_VERIFICATION_UED_EVIDENCE_UNKNOWN', `${base}.evidenceId`, `ued 指向不存在的证据：${ued.evidenceId}`);
  } else if (evidenceTypeById && evidenceTypeById[ued.evidenceId] !== 'image') {
    err('E_VERIFICATION_UED_EVIDENCE_TYPE', `${base}.evidenceId`, 'ued.evidenceId 必须指向 image 证据');
  }
  for (const key of ['title', 'caption', 'note']) {
    if (ued[key] !== undefined && !nonEmptyString(ued[key])) {
      err('E_VERIFICATION_UED_FIELD', `${base}.${key}`, `ued.${key} 填写时必须是非空字符串`);
    }
  }
  if (ued.sourceUrl !== undefined) checkHttpsLink(ued.sourceUrl, `${base}.sourceUrl`, err, 'E_VERIFICATION_UED_URL');
}

function validatePrefill(prefill, base, err) {
  if (!isObject(prefill)) {
    err('E_REPRODUCTION_PREFILL', base, 'prefill 必须是 {url,parameters} 对象');
    return;
  }
  if (!nonEmptyString(prefill.url)) {
    err('E_REPRODUCTION_PREFILL_URL', `${base}.url`, 'prefill.url 必须提供已核验的预填地址');
  } else {
    checkHttpsLink(prefill.url, `${base}.url`, err, 'E_REPRODUCTION_PREFILL_URL');
  }
  if (!Array.isArray(prefill.parameters) || prefill.parameters.length === 0) {
    err('E_REPRODUCTION_PREFILL_PARAMETERS', `${base}.parameters`, 'prefill.parameters 至少需要一项 {name,value}');
  } else {
    prefill.parameters.forEach((item, index) => {
      const paramBase = `${base}.parameters[${index}]`;
      if (!isObject(item)) {
        err('E_REPRODUCTION_PREFILL_PARAMETERS', paramBase, '预填参数必须是 {name,value} 对象');
        return;
      }
      for (const key of ['name', 'value']) {
        if (!nonEmptyString(item[key])) {
          err('E_REPRODUCTION_PREFILL_PARAMETERS', `${paramBase}.${key}`, `预填参数 ${key} 必须是非空字符串`);
        }
      }
    });
  }
  for (const key of ['environment', 'note']) {
    if (prefill[key] !== undefined && !nonEmptyString(prefill[key])) {
      err('E_REPRODUCTION_PREFILL_FIELD', `${base}.${key}`, `prefill.${key} 填写时必须是非空字符串`);
    }
  }
}

function validateStatement(statement, base, err) {
  if (!isObject(statement)) {
    err('E_VERIFICATION_STATEMENT', base, 'statement 必须是对象');
    return;
  }
  if (!STATEMENT_KINDS.includes(statement.kind)) {
    err('E_VERIFICATION_STATEMENT_KIND', `${base}.kind`, `statement.kind 只能是 ${STATEMENT_KINDS.join(' / ')}`);
  }
  if (!STATEMENT_ORIGINS.includes(statement.origin)) {
    err('E_VERIFICATION_STATEMENT_ORIGIN', `${base}.origin`, `statement.origin 只能是 ${STATEMENT_ORIGINS.join(' / ')}`);
    return;
  }
  if (statement.text !== undefined && typeof statement.text !== 'string') {
    err('E_VERIFICATION_STATEMENT_TEXT', `${base}.text`, 'statement.text 必须是纯文本字符串');
  }
  if (statement.explanation !== undefined && !nonEmptyString(statement.explanation)) {
    err('E_VERIFICATION_STATEMENT_EXPLANATION', `${base}.explanation`, 'statement.explanation 填写时必须是非空字符串');
  }
  if (statement.parameters !== undefined) {
    if (!Array.isArray(statement.parameters)) {
      err('E_VERIFICATION_STATEMENT_PARAMETERS', `${base}.parameters`, 'statement.parameters 必须是数组');
    } else {
      statement.parameters.forEach((item, index) => {
        const paramBase = `${base}.parameters[${index}]`;
        if (!isObject(item)) {
          err('E_VERIFICATION_STATEMENT_PARAMETERS', paramBase, '参数必须是 {name,value,reason} 对象');
          return;
        }
        for (const key of ['name', 'value', 'reason']) {
          if (!nonEmptyString(item[key])) {
            err('E_VERIFICATION_STATEMENT_PARAMETERS', `${paramBase}.${key}`, `参数 ${key} 必须是非空字符串`);
          }
        }
      });
    }
  }

  if (statement.origin === 'unavailable') {
    if (nonEmptyString(statement.text)) {
      err('E_VERIFICATION_STATEMENT_UNAVAILABLE', `${base}.text`, 'origin 为 unavailable 时 text 必须留空，不能把缺失原文写成已获取的原文');
    }
    if (!nonEmptyString(statement.explanation)) {
      err('E_VERIFICATION_STATEMENT_UNAVAILABLE', `${base}.explanation`, 'origin 为 unavailable 时必须用 explanation 明确原文未留存');
    } else if (!STATEMENT_UNAVAILABLE_MARKERS.some((marker) => statement.explanation.includes(marker))) {
      err('E_VERIFICATION_STATEMENT_UNAVAILABLE', `${base}.explanation`, 'origin 为 unavailable 时 explanation 必须明确写出原文未留存/未记录');
    }
    return;
  }

  if (!nonEmptyString(statement.text)) {
    err('E_VERIFICATION_STATEMENT_TEXT', `${base}.text`, 'statement.text 必须是非空字符串');
  }
  if (statement.origin === 'reconstructed') {
    if (!nonEmptyString(statement.explanation)) {
      err('E_VERIFICATION_STATEMENT_RECONSTRUCTED', `${base}.explanation`, 'origin 为 reconstructed 时必须用 explanation 说明还原方式');
    } else if (!STATEMENT_RECONSTRUCTED_MARKERS.some((marker) => statement.explanation.includes(marker))) {
      err('E_VERIFICATION_STATEMENT_RECONSTRUCTED', `${base}.explanation`, 'origin 为 reconstructed 时 explanation 必须说明是还原/整理所得');
    }
    const claims = [statement.text, statement.explanation].filter((item) => typeof item === 'string');
    if (claims.some((item) => claimsExecutedText(item))) {
      err('E_VERIFICATION_STATEMENT_RECONSTRUCTED', base, 'origin 为 reconstructed 时不能把还原内容标成执行原文');
    }
  }
}

function validateVerification(verification, base, evidenceIds, evidenceTypeById, err) {
  if (!isObject(verification)) {
    err('E_VERIFICATION', base, 'verification 必须是对象');
    return;
  }
  for (const key of ['question', 'method', 'conclusion']) {
    if (verification[key] !== undefined && !nonEmptyString(verification[key])) {
      err('E_VERIFICATION_FIELD', `${base}.${key}`, `verification.${key} 填写时必须是非空字符串`);
    }
  }
  if (verification.limitations !== undefined && !nonEmptyStringArray(verification.limitations)) {
    err('E_VERIFICATION_LIMITATIONS', `${base}.limitations`, 'limitations 必须是非空字符串数组');
  }
  const resultSetItems = Array.isArray(verification.resultSets) ? verification.resultSets : [];
  if (verification.response !== undefined) {
    const response = verification.response, location = base + '.response';
    if (!isObject(response) || !nonEmptyString(response.evidenceId)) err('E_VERIFICATION_RESPONSE',location,'响应需要明确的evidenceId');
    else {
      if (!evidenceIds.has(response.evidenceId) || !['text','json'].includes(evidenceTypeById[response.evidenceId])) err('E_VERIFICATION_RESPONSE_EVIDENCE',location+'.evidenceId','响应必须引用已存在的文本或JSON原件');
      if (response.jsonPointer !== undefined && (!nonEmptyString(response.jsonPointer) || response.jsonPointer[0]!=='/')) err('E_VERIFICATION_RESPONSE_POINTER',location+'.jsonPointer','响应路径必须是JSON Pointer');
    }
  }
  if (verification.focus !== undefined) {
    if (!Array.isArray(verification.focus)) {
      err('E_VERIFICATION_FOCUS', `${base}.focus`, 'focus 必须是数组');
    } else {
      verification.focus.forEach((item, index) => {
        const focusBase = `${base}.focus[${index}]`;
        if (!isObject(item)) {
          err('E_VERIFICATION_FOCUS', focusBase, 'focus 项必须是 {label,reason,expected,actual,evidenceIds,cellRefs} 对象');
          return;
        }
        for (const key of ['label', 'reason', 'actual']) {
          if (!nonEmptyString(item[key])) {
            err('E_VERIFICATION_FOCUS_FIELD', `${focusBase}.${key}`, `focus.${key} 必须是非空字符串`);
          }
        }
        if (item.expected !== undefined && !nonEmptyString(item.expected)) {
          err('E_VERIFICATION_FOCUS_FIELD', `${focusBase}.expected`, 'focus.expected 填写时必须是非空字符串');
        }
        checkEvidenceRefs(item.evidenceIds, `${focusBase}.evidenceIds`, evidenceIds, err, 'E_VERIFICATION_FOCUS_EVIDENCE_UNKNOWN');
        if (item.cellRefs !== undefined) {
          if (!Array.isArray(item.cellRefs) || item.cellRefs.length === 0) {
            err('E_VERIFICATION_FOCUS_CELL_REFS', `${focusBase}.cellRefs`, 'cellRefs 填写时必须是非空数组');
          } else {
            item.cellRefs.forEach((ref, refIndex) => {
              const refBase = `${focusBase}.cellRefs[${refIndex}]`;
              if (!isObject(ref)) {
                err('E_VERIFICATION_FOCUS_CELL_REFS', refBase, 'cellRefs 项必须是 {resultSet,row,column} 对象');
                return;
              }
              if (!Number.isInteger(ref.resultSet) || ref.resultSet < 0 || ref.resultSet >= resultSetItems.length) {
                err('E_VERIFICATION_FOCUS_CELL_REFS', `${refBase}.resultSet`,
                  `cellRefs.resultSet 必须是 0 到 ${Math.max(0, resultSetItems.length - 1)} 之间的整数`);
              }
              if (!Number.isInteger(ref.row) || ref.row < 0) {
                err('E_VERIFICATION_FOCUS_CELL_REFS', `${refBase}.row`, 'cellRefs.row 必须是非负整数');
              }
              if (!nonEmptyString(ref.column)) {
                err('E_VERIFICATION_FOCUS_CELL_REFS', `${refBase}.column`, 'cellRefs.column 必须是结果字段名');
              }
              if (ref.note !== undefined && !nonEmptyString(ref.note)) {
                err('E_VERIFICATION_FOCUS_CELL_REFS', `${refBase}.note`, 'cellRefs.note 填写时必须是非空字符串');
              }
            });
          }
        }
      });
    }
  }
  if (verification.resultSets !== undefined) {
    if (!Array.isArray(verification.resultSets)) {
      err('E_VERIFICATION_RESULT_SETS', `${base}.resultSets`, 'resultSets 必须是数组');
    } else {
      verification.resultSets.forEach((item, index) => {
        const setBase = `${base}.resultSets[${index}]`;
        if (!isObject(item)) {
          err('E_VERIFICATION_RESULT_SET', setBase, 'resultSets 项必须是 {evidenceId,label,jsonPointer} 对象');
          return;
        }
        if (!nonEmptyString(item.evidenceId)) {
          err('E_VERIFICATION_RESULT_SET_EVIDENCE', `${setBase}.evidenceId`, 'resultSets.evidenceId 必须是非空字符串');
        } else if (!evidenceIds.has(item.evidenceId)) {
          err('E_VERIFICATION_RESULT_SET_EVIDENCE_UNKNOWN', `${setBase}.evidenceId`,
            `resultSets 指向不存在的证据：${item.evidenceId}`);
        }
        if (item.label !== undefined && !nonEmptyString(item.label)) {
          err('E_VERIFICATION_RESULT_SET_LABEL', `${setBase}.label`, 'resultSets.label 填写时必须是非空字符串');
        }
        if (item.columnLabels !== undefined && (!isObject(item.columnLabels) || Object.values(item.columnLabels).some(label => !nonEmptyString(label)))) {
          err('E_VERIFICATION_RESULT_SET_COLUMN_LABELS', `${setBase}.columnLabels`, 'columnLabels 必须是字段名到非空业务名称的对象');
        }
        if (item.jsonPointer !== undefined) {
          if (!nonEmptyString(item.jsonPointer) || item.jsonPointer.charAt(0) !== '/') {
            err('E_VERIFICATION_RESULT_SET_POINTER', `${setBase}.jsonPointer`, 'jsonPointer 必须以 / 开头');
          }
        }
      });
    }
  }
  if (verification.statement !== undefined) {
    validateStatement(verification.statement, `${base}.statement`, err);
  }
  if (verification.comparison !== undefined) {
    if (!Array.isArray(verification.comparison)) {
      err('E_VERIFICATION_COMPARISON', `${base}.comparison`, 'comparison 必须是数组');
    } else {
      verification.comparison.forEach((item, index) => {
        const cmpBase = `${base}.comparison[${index}]`;
        if (!isObject(item)) {
          err('E_VERIFICATION_COMPARISON', cmpBase, 'comparison 项必须是 {label,expected,actual,status,evidenceIds} 对象');
          return;
        }
        for (const key of ['label', 'expected', 'actual']) {
          if (!nonEmptyString(item[key])) {
            err('E_VERIFICATION_COMPARISON_FIELD', `${cmpBase}.${key}`, `comparison.${key} 必须是非空字符串`);
          }
        }
        if (!STATUSES.includes(item.status)) {
          err('E_VERIFICATION_COMPARISON_STATUS', `${cmpBase}.status`,
            `comparison.status 必须由 Agent 提供，且只能是 ${STATUSES.join(' / ')}；生成器不根据预期/实际推断`);
        }
        checkEvidenceRefs(item.evidenceIds, `${cmpBase}.evidenceIds`, evidenceIds, err, 'E_VERIFICATION_COMPARISON_EVIDENCE_UNKNOWN');
      });
    }
  }
  if (verification.ued !== undefined) {
    validateUed(verification.ued, `${base}.ued`, evidenceIds, evidenceTypeById, err);
  }
}

function validateReproduction(reproduction, base, evidenceIds, err) {
  if (!isObject(reproduction)) {
    err('E_REPRODUCTION', base, 'reproduction 必须是对象');
    return;
  }
  if (!REPRODUCTION_KINDS.includes(reproduction.kind)) {
    err('E_REPRODUCTION_KIND', `${base}.kind`, `reproduction.kind 只能是 ${REPRODUCTION_KINDS.join(' / ')}`);
  }
  if (!nonEmptyString(reproduction.label)) {
    err('E_REPRODUCTION_LABEL', `${base}.label`, 'reproduction.label 必须是非空字符串');
  }
  if (!REPRODUCTION_URL_STATUSES.includes(reproduction.urlStatus)) {
    err('E_REPRODUCTION_URL_STATUS', `${base}.urlStatus`, `reproduction.urlStatus 只能是 ${REPRODUCTION_URL_STATUSES.join(' / ')}`);
    return;
  }
  if (reproduction.url !== undefined && reproduction.url !== null && typeof reproduction.url !== 'string') {
    err('E_REPRODUCTION_URL', `${base}.url`, 'reproduction.url 必须为 null 或字符串');
  }
  if (reproduction.urlStatus === 'verified') {
    const url = typeof reproduction.url === 'string' ? reproduction.url.trim() : '';
    if (!url) {
      err('E_REPRODUCTION_URL', `${base}.url`, 'urlStatus 为 verified 时必须提供已核验的 https 地址');
    } else {
      let parsed = null;
      try {
        parsed = new URL(url);
      } catch {
        err('E_REPRODUCTION_URL_INVALID', `${base}.url`, `已核验地址不是合法 URL：${url}`);
      }
      if (parsed && parsed.protocol !== 'https:') {
        err('E_REPRODUCTION_URL_HTTPS', `${base}.url`, '已核验地址必须使用 https');
      }
      if (hasUrlPlaceholder(url)) {
        err('E_REPRODUCTION_URL_PLACEHOLDER', `${base}.url`, '已核验地址不能包含占位符或模板片段');
      }
    }
    if (!nonEmptyString(reproduction.reason)) {
      err('E_REPRODUCTION_REASON', `${base}.reason`, 'urlStatus 为 verified 时需在 reason 写明核验来源');
    }
  } else {
    if (reproduction.url !== null) {
      err('E_REPRODUCTION_URL_UNAVAILABLE', `${base}.url`, 'urlStatus 为 unavailable 时 url 必须为 null，不能用未核验或占位地址冒充入口');
    }
    if (!nonEmptyString(reproduction.reason)) {
      err('E_REPRODUCTION_REASON', `${base}.reason`, 'urlStatus 为 unavailable 时必须写明不可用原因');
    }
  }
  if (reproduction.params !== undefined && !nonEmptyString(reproduction.params)) {
    err('E_REPRODUCTION_PARAMS', `${base}.params`, 'params 填写时必须是可复制的请求/模板文本');
  }
  if (reproduction.instructions !== undefined && !nonEmptyString(reproduction.instructions)) {
    err('E_REPRODUCTION_INSTRUCTIONS', `${base}.instructions`, 'instructions 填写时必须是非空字符串');
  }
  if (reproduction.constraints !== undefined && !nonEmptyStringArray(reproduction.constraints)) {
    err('E_REPRODUCTION_CONSTRAINTS', `${base}.constraints`, 'constraints 必须是非空字符串数组');
  }
  if (reproduction.prefill !== undefined) {
    validatePrefill(reproduction.prefill, `${base}.prefill`, err);
  }
  checkEvidenceRefs(reproduction.sourceIds, `${base}.sourceIds`, evidenceIds, err, 'E_REPRODUCTION_SOURCE_UNKNOWN');
}

export function validateStructure(data) {
  const errors = [];
  const warnings = [];
  const err = (code, path, message) => errors.push({ code, path, message });
  const warn = (code, path, message) => warnings.push({ code, path, message });

  if (!isObject(data)) {
    err('E_ROOT_TYPE', '$', '输入必须是 JSON 对象');
    return { errors, warnings };
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    err('E_SCHEMA_VERSION', 'schemaVersion', `schemaVersion 必须为 ${SCHEMA_VERSION}`);
  }

  /* report */
  const report = data.report;
  if (!isObject(report)) {
    err('E_REPORT', 'report', '缺少 report 对象');
  } else {
    for (const key of ['id', 'title', 'environment']) {
      if (!nonEmptyString(report[key])) err('E_REPORT_FIELD', `report.${key}`, `report.${key} 必须是非空字符串`);
    }
    if (typeof report.example !== 'boolean') {
      err('E_REPORT_EXAMPLE', 'report.example', 'report.example 必须是布尔值');
    }
    if (report.links !== undefined) {
      if (!Array.isArray(report.links) || report.links.length > 12) err('E_REPORT_LINKS', 'report.links', '关联资料最多12条链接');
      else report.links.forEach((link, index) => {
        const base = 'report.links[' + index + ']';
        if (!isObject(link) || !nonEmptyString(link.label) || link.label.length > 80) { err('E_REPORT_LINK_LABEL', base, '链接需要80字以内的明确标签'); return; }
        checkHttpsLink(link.url, base + '.url', err, 'E_REPORT_LINK_URL');
        try { const value = new URL(link.url); if (value.username || value.password) err('E_REPORT_LINK_URL', base + '.url', '关联链接不得包含身份凭据'); } catch {}
      });
    }
    for (const key of ['revision', 'executedAt']) {
      if (report[key] !== undefined && !nonEmptyString(report[key])) {
        err('E_REPORT_FIELD', `report.${key}`, `report.${key} 填写时必须是非空字符串`);
      }
    }
    if (nonEmptyString(report.executedAt) && Number.isNaN(Date.parse(report.executedAt))) {
      warn('W_EXECUTED_AT_FORMAT', 'report.executedAt', 'executedAt 不是可解析的时间格式，界面将按原文展示');
    }
  }

  /* groups */
  const groupIds = new Set();
  if (!Array.isArray(data.groups) || data.groups.length === 0) {
    err('E_GROUPS', 'groups', 'groups 至少需要一项');
  } else {
    data.groups.forEach((group, index) => {
      const base = `groups[${index}]`;
      if (!isObject(group)) {
        err('E_GROUP_TYPE', base, '分组必须是对象');
        return;
      }
      if (!nonEmptyString(group.id)) err('E_GROUP_ID', `${base}.id`, '分组 id 必须是非空字符串');
      else if (groupIds.has(group.id)) err('E_GROUP_DUPLICATE', `${base}.id`, `分组 id 重复：${group.id}`);
      else groupIds.add(group.id);
      if (!nonEmptyString(group.title)) err('E_GROUP_TITLE', `${base}.title`, '分组 title 必须是非空字符串');
      if (group.displayTitle !== undefined && !nonEmptyString(group.displayTitle)) {
        err('E_GROUP_DISPLAY_TITLE', `${base}.displayTitle`, 'group.displayTitle 填写时必须是非空语义名称');
      }
      if (group.requirement !== undefined && !nonEmptyString(group.requirement)) {
        err('E_GROUP_REQUIREMENT', `${base}.requirement`, '分组 requirement 填写时必须是非空字符串');
      }
    });
  }

  /* recordings */
  const recordingIds = new Set();
  if (data.recordings !== undefined && !Array.isArray(data.recordings)) {
    err('E_RECORDINGS_TYPE', 'recordings', 'recordings 必须是数组');
  } else if (Array.isArray(data.recordings)) {
    data.recordings.forEach((rec, index) => {
      const base = `recordings[${index}]`;
      if (!isObject(rec)) {
        err('E_RECORDING_TYPE', base, '录制必须是对象');
        return;
      }
      if (!nonEmptyString(rec.id)) err('E_RECORDING_ID', `${base}.id`, '录制 id 必须是非空字符串');
      else if (recordingIds.has(rec.id)) err('E_RECORDING_DUPLICATE', `${base}.id`, `录制 id 重复：${rec.id}`);
      else recordingIds.add(rec.id);
      if (!RECORDING_FORMATS.includes(rec.format)) {
        err('E_RECORDING_FORMAT', `${base}.format`, `format 只能是 ${RECORDING_FORMATS.join(' / ')}`);
      }
      if (!nonEmptyString(rec.file)) err('E_RECORDING_FILE', `${base}.file`, '录制必须填写 file');
      if (rec.title !== undefined && !nonEmptyString(rec.title)) {
        err('E_RECORDING_TITLE', `${base}.title`, '录制 title 填写时必须是非空字符串');
      }
    });
  }

  /* evidence */
  const evidenceIds = new Set();
  const evidenceTypeById = Object.create(null);
  if (data.evidence !== undefined && !Array.isArray(data.evidence)) {
    err('E_EVIDENCE_TYPE', 'evidence', 'evidence 必须是数组');
  } else if (Array.isArray(data.evidence)) {
    data.evidence.forEach((ev, index) => {
      const base = `evidence[${index}]`;
      if (!isObject(ev)) {
        err('E_EVIDENCE_ITEM', base, '证据必须是对象');
        return;
      }
      if (!nonEmptyString(ev.id)) err('E_EVIDENCE_ID', `${base}.id`, '证据 id 必须是非空字符串');
      else if (evidenceIds.has(ev.id)) err('E_EVIDENCE_DUPLICATE', `${base}.id`, `证据 id 重复：${ev.id}`);
      else evidenceIds.add(ev.id);
      if (!nonEmptyString(ev.title)) err('E_EVIDENCE_TITLE', `${base}.title`, '证据 title 必须是非空字符串');
      if (!EVIDENCE_TYPES.includes(ev.type)) {
        err('E_EVIDENCE_KIND', `${base}.type`, `type 只能是 ${EVIDENCE_TYPES.join(' / ')}`);
      }
      if (nonEmptyString(ev.id)) evidenceTypeById[ev.id] = ev.type;
      if (ev.annotations !== undefined) {
        if (ev.type !== 'image') {
          err('E_EVIDENCE_ANNOTATIONS_TYPE', `${base}.annotations`, 'annotations 只能用于 image 证据');
        } else if (!Array.isArray(ev.annotations) || ev.annotations.length === 0) {
          err('E_EVIDENCE_ANNOTATIONS', `${base}.annotations`, 'annotations 填写时必须是非空数组');
        } else {
          ev.annotations.forEach((anno, annoIndex) => {
            const annoBase = `${base}.annotations[${annoIndex}]`;
            if (!isObject(anno)) {
              err('E_EVIDENCE_ANNOTATION', annoBase, '标注必须是 {label,x,y,w,h} 对象');
              return;
            }
            if (!nonEmptyString(anno.label)) {
              err('E_EVIDENCE_ANNOTATION_LABEL', `${annoBase}.label`, '标注 label 必须是非空字符串');
            }
            if (anno.number !== undefined && (!Number.isInteger(anno.number) || anno.number < 1)) {
              err('E_EVIDENCE_ANNOTATION_NUMBER', `${annoBase}.number`, 'number 填写时必须是正整数序号');
            }
            if (anno.tone !== undefined && !ANNOTATION_TONES.includes(anno.tone)) {
              err('E_EVIDENCE_ANNOTATION_TONE', `${annoBase}.tone`, `tone 只能是 ${ANNOTATION_TONES.join(' / ')}`);
            }
            for (const key of ['x', 'y']) {
              if (!Number.isFinite(anno[key]) || anno[key] < 0) {
                err('E_EVIDENCE_ANNOTATION_GEOMETRY', `${annoBase}.${key}`, `${key} 必须是非负数值（原图像素坐标）`);
              }
            }
            for (const key of ['w', 'h']) {
              if (!Number.isFinite(anno[key]) || anno[key] <= 0) {
                err('E_EVIDENCE_ANNOTATION_GEOMETRY', `${annoBase}.${key}`, `${key} 必须是大于 0 的数值（原图像素坐标）`);
              }
            }
            if (anno.note !== undefined && !nonEmptyString(anno.note)) {
              err('E_EVIDENCE_ANNOTATION_NOTE', `${annoBase}.note`, 'note 填写时必须是非空字符串');
            }
          });
        }
      }
      if (ev.category !== undefined && !EVIDENCE_CATEGORIES.includes(ev.category)) {
        err('E_EVIDENCE_CATEGORY', `${base}.category`, `category 只能是 ${EVIDENCE_CATEGORIES.join(' / ')}`);
      }
      if (ev.source !== undefined && !nonEmptyString(ev.source)) {
        err('E_EVIDENCE_SOURCE', `${base}.source`, 'source 填写时必须是非空字符串');
      }
      const hasFile = ev.file !== undefined;
      const hasValue = ev.value !== undefined;
      if (hasFile && hasValue) {
        err('E_EVIDENCE_BOTH', base, 'file 与 value 不能同时填写');
      } else if (!hasFile && !hasValue) {
        err('E_EVIDENCE_EMPTY', base, 'file 与 value 至少填写一个');
      }
      if (hasFile && !nonEmptyString(ev.file)) err('E_EVIDENCE_FILE', `${base}.file`, 'file 必须是非空字符串');
      if (ev.type === 'image') {
        if (!hasFile) err('E_EVIDENCE_IMAGE_FILE', base, 'image 证据必须使用 file，不能内联 value');
        if (hasValue) err('E_EVIDENCE_IMAGE_VALUE', base, 'image 证据不支持 value');
      }
      if (ev.type === 'json' && hasValue) {
        if (!isObject(ev.value) && !Array.isArray(ev.value)) {
          err('E_EVIDENCE_JSON_VALUE', `${base}.value`, 'json 证据的 value 必须是对象或数组');
        }
      }
      if ((ev.type === 'text') && hasValue && typeof ev.value === 'object') {
        err('E_EVIDENCE_TEXT_VALUE', `${base}.value`, 'text 证据的 value 必须是字符串');
      }
    });
  }

  /* cases */
  const caseIds = new Set();
  const stepIdsByCase = new Map();
  const checkIdsByCase = new Map();
  if (!Array.isArray(data.cases) || data.cases.length === 0) {
    err('E_CASES', 'cases', 'cases 至少需要一项');
  } else {
    data.cases.forEach((item, index) => {
      const base = `cases[${index}]`;
      if (!isObject(item)) {
        err('E_CASE_TYPE', base, '用例必须是对象');
        return;
      }
      if (!nonEmptyString(item.id)) err('E_CASE_ID', `${base}.id`, '用例 id 必须是非空字符串');
      else if (caseIds.has(item.id)) err('E_CASE_DUPLICATE', `${base}.id`, `用例 id 重复：${item.id}`);
      else caseIds.add(item.id);
      if (!nonEmptyString(item.groupId)) err('E_CASE_GROUP', `${base}.groupId`, '用例必须填写 groupId');
      else if (groupIds.size && !groupIds.has(item.groupId)) {
        err('E_CASE_GROUP_UNKNOWN', `${base}.groupId`, `groupId 指向不存在的分组：${item.groupId}`);
      }
      for (const key of ['title', 'objective']) {
        if (!nonEmptyString(item[key])) err('E_CASE_FIELD', `${base}.${key}`, `用例 ${key} 必须是非空字符串`);
      }
      if (item.displayTitle !== undefined && !nonEmptyString(item.displayTitle)) {
        err('E_CASE_DISPLAY_TITLE', `${base}.displayTitle`, 'case.displayTitle 填写时必须是非空语义导航名称');
      }
      if (!STATUSES.includes(item.status)) {
        err('E_CASE_STATUS', `${base}.status`, `用例 status 只能是 ${STATUSES.join(' / ')}`);
      }
      const role = item.caseRole === undefined ? 'unknown' : item.caseRole;
      if (!CASE_ROLES.includes(role)) {
        err('E_CASE_ROLE', `${base}.caseRole`, `caseRole 只能是 ${CASE_ROLES.join(' / ')}`);
      }
      if (item.caseRoleReason !== undefined && !nonEmptyString(item.caseRoleReason)) {
        err('E_CASE_ROLE_REASON', `${base}.caseRoleReason`, 'caseRoleReason 填写时必须是非空字符串');
      }
      if (item.caseRoleSources !== undefined && (!stringArray(item.caseRoleSources) || item.caseRoleSources.some((source) => !nonEmptyString(source)))) {
        err('E_CASE_ROLE_SOURCES', `${base}.caseRoleSources`, 'caseRoleSources 必须是非空字符串组成的数组');
      }
      if (CASE_ROLES.includes(role) && role !== 'unknown') {
        if (!nonEmptyString(item.caseRoleReason)) {
          err('E_CASE_ROLE_REASON_REQUIRED', `${base}.caseRoleReason`, `caseRole 为 ${role} 时必须填写 caseRoleReason`);
        }
        if (!Array.isArray(item.caseRoleSources) || item.caseRoleSources.length === 0) {
          err('E_CASE_ROLE_SOURCES_REQUIRED', `${base}.caseRoleSources`, `caseRole 为 ${role} 时必须提供非空 caseRoleSources`);
        }
      }
      if (item.requirement !== undefined && !nonEmptyString(item.requirement)) {
        err('E_CASE_REQUIREMENT', `${base}.requirement`, 'requirement 填写时必须是非空字符串');
      }
      if (item.preconditions !== undefined && !stringArray(item.preconditions)) {
        err('E_CASE_PRECONDITIONS', `${base}.preconditions`, 'preconditions 必须是字符串数组');
      }
      if (item.caseDesign !== undefined) {
        validateCaseDesign(item.caseDesign, `${base}.caseDesign`, err);
      }

      const steps = item.steps;
      const localStepIds = new Set();
      stepIdsByCase.set(item.id, localStepIds);
      if (!Array.isArray(steps) || steps.length === 0) {
        err('E_STEPS', `${base}.steps`, 'steps 至少需要一项');
      } else {
        steps.forEach((step, stepIndex) => {
          const stepBase = `${base}.steps[${stepIndex}]`;
          if (!isObject(step)) {
            err('E_STEP_TYPE', stepBase, '步骤必须是对象');
            return;
          }
          if (!nonEmptyString(step.id)) err('E_STEP_ID', `${stepBase}.id`, '步骤 id 必须是非空字符串');
          else if (localStepIds.has(step.id)) err('E_STEP_DUPLICATE', `${stepBase}.id`, `用例内步骤 id 重复：${step.id}`);
          else localStepIds.add(step.id);
          if (!STEP_TYPES.includes(step.type)) {
            err('E_STEP_KIND', `${stepBase}.type`, `type 只能是 ${STEP_TYPES.join(' / ')}`);
          }
          for (const key of ['title', 'action', 'expected', 'actual']) {
            if (!nonEmptyString(step[key])) err('E_STEP_FIELD', `${stepBase}.${key}`, `步骤 ${key} 必须是非空字符串`);
          }
          if (step.displayTitle !== undefined && !nonEmptyString(step.displayTitle)) {
            err('E_STEP_DISPLAY_TITLE', `${stepBase}.displayTitle`, 'step.displayTitle 填写时必须是非空语义标题');
          }
          if (!STATUSES.includes(step.status)) {
            err('E_STEP_STATUS', `${stepBase}.status`, `步骤 status 只能是 ${STATUSES.join(' / ')}`);
          }
          if (step.durationMs !== undefined && (!Number.isInteger(step.durationMs) || step.durationMs < 500 || step.durationMs > 60000)) {
            err('E_STEP_DURATION', `${stepBase}.durationMs`, 'durationMs 必须为500到60000之间的整数');
          }
          if (step.pageView !== undefined) {
            const view=step.pageView, vp=`${stepBase}.pageView`;
            if(step.type!=='page' || !isObject(view)) err('E_PAGE_VIEW',vp,'pageView 仅用于页面步骤，必须为对象');
            else {
              for(const key of ['title','subtitle','breadcrumb','url','focus','caption']) {
                if(view[key]!==undefined && typeof view[key]!=='string')err('E_PAGE_VIEW_FIELD',`${vp}.${key}`,'必须为字符串');
              }
              if (view.caption !== undefined && !nonEmptyString(view.caption)) {
                err('E_PAGE_VIEW_CAPTION', `${vp}.caption`, 'pageView.caption 填写时必须是非空业务名称');
              }
              function fields(value,p) {
                if(value===undefined)return;
                if(!Array.isArray(value) || value.some(f=>!isObject(f)||typeof f.label!=='string'||typeof f.value!=='string'))err('E_PAGE_VIEW_FIELDS',p,'字段必须为 {label,value} 字符串对象数组');
              }
              function buttons(value,p) { if(value!==undefined && !stringArray(value))err('E_PAGE_VIEW_BUTTONS',p,'按钮必须为字符串数组'); }
              fields(view.fields,`${vp}.fields`);buttons(view.buttons,`${vp}.buttons`);
              if(view.table!==undefined) {
                const tb=view.table;
                if(!isObject(tb)||!stringArray(tb.columns)||!Array.isArray(tb.rows)||tb.rows.some(row=>!stringArray(row)||row.length!==tb.columns.length))err('E_PAGE_VIEW_TABLE',`${vp}.table`,'table 需要 columns 字符串数组和等列数的 rows 二维字符串数组');
              }
              if(view.dialog!==undefined) {
                if(!isObject(view.dialog)||!nonEmptyString(view.dialog.title))err('E_PAGE_VIEW_DIALOG',`${vp}.dialog`,'弹窗必须为包含title的对象');
                else { fields(view.dialog.fields,`${vp}.dialog.fields`);buttons(view.dialog.buttons,`${vp}.dialog.buttons`); }
              }
              if(view.imageEvidenceId!==undefined) {
                const ev=Array.isArray(data.evidence)&&data.evidence.find(e=>e&&e.id===view.imageEvidenceId);
                if(!ev||ev.type!=='image')err('E_PAGE_VIEW_IMAGE',`${vp}.imageEvidenceId`,'必须引用顶层image证据');
              }
            }
          }
          if (step.verification !== undefined) {
            validateVerification(step.verification, `${stepBase}.verification`, evidenceIds, evidenceTypeById, err);
          }
          if (step.reproduction !== undefined) {
            validateReproduction(step.reproduction, `${stepBase}.reproduction`, evidenceIds, err);
          }
          if (step.type === 'page' && !nonEmptyString(step.page)) {
            err('E_STEP_PAGE', `${stepBase}.page`, '页面步骤必须填写页面名称 page');
          }
          if (step.atMs !== undefined) {
            if (!Number.isInteger(step.atMs) || step.atMs < 0) {
              err('E_STEP_AT_MS', `${stepBase}.atMs`, 'atMs 必须是非负整数（毫秒）');
            }
            if (step.type !== 'page') {
              warn('W_AT_MS_ON_NON_PAGE', `${stepBase}.atMs`, '非页面步骤的 atMs 不参与回放定位');
            }
          }
          if (step.endMs !== undefined) {
            if (!Number.isInteger(step.endMs) || step.endMs < 0) {
              err('E_STEP_END_MS', `${stepBase}.endMs`, 'endMs 必须是非负整数（毫秒）');
            } else if (Number.isInteger(step.atMs) && step.endMs < step.atMs) {
              err('E_STEP_END_BEFORE_START', `${stepBase}.endMs`, 'endMs 不能小于 atMs');
            }
          }
          if (step.recordingId !== undefined && !nonEmptyString(step.recordingId)) {
            err('E_STEP_RECORDING', `${stepBase}.recordingId`, 'recordingId 填写时必须是非空字符串');
          }
          if (step.evidenceIds !== undefined) {
            if (!stringArray(step.evidenceIds)) {
              err('E_STEP_EVIDENCE_TYPE', `${stepBase}.evidenceIds`, 'evidenceIds 必须是字符串数组');
            } else {
              step.evidenceIds.forEach((id, i) => {
                if (!evidenceIds.has(id)) {
                  err('E_STEP_EVIDENCE_UNKNOWN', `${stepBase}.evidenceIds[${i}]`, `证据引用不存在：${id}`);
                }
              });
            }
          }
          if (step.recordingId !== undefined && !recordingIds.has(step.recordingId)) {
            err('E_STEP_RECORDING_UNKNOWN', `${stepBase}.recordingId`, `recordingId 指向不存在的录制：${step.recordingId}`);
          }
        });
      }

      const checks = item.checks;
      const localCheckIds = new Set();
      checkIdsByCase.set(item.id, localCheckIds);
      if (!Array.isArray(checks)) {
        err('E_CHECKS', `${base}.checks`, 'checks 必须是数组（可以为空）');
      } else {
        checks.forEach((check, checkIndex) => {
          const checkBase = `${base}.checks[${checkIndex}]`;
          if (!isObject(check)) {
            err('E_CHECK_TYPE', checkBase, '核对项必须是对象');
            return;
          }
          if (!nonEmptyString(check.id)) err('E_CHECK_ID', `${checkBase}.id`, '核对项 id 必须是非空字符串');
          else if (localCheckIds.has(check.id)) err('E_CHECK_DUPLICATE', `${checkBase}.id`, `用例内核对项 id 重复：${check.id}`);
          else localCheckIds.add(check.id);
          for (const key of ['title', 'expected', 'actual']) {
            if (!nonEmptyString(check[key])) err('E_CHECK_FIELD', `${checkBase}.${key}`, `核对项 ${key} 必须是非空字符串`);
          }
          if (!STATUSES.includes(check.status)) {
            err('E_CHECK_STATUS', `${checkBase}.status`, `核对项 status 只能是 ${STATUSES.join(' / ')}`);
          }
          if (check.stepId !== undefined) {
            if (!nonEmptyString(check.stepId)) err('E_CHECK_STEP', `${checkBase}.stepId`, 'stepId 填写时必须是非空字符串');
            else if (!localStepIds.has(check.stepId)) {
              err('E_CHECK_STEP_UNKNOWN', `${checkBase}.stepId`, `stepId 指向本用例不存在的步骤：${check.stepId}`);
            }
          }
          if (check.evidenceIds !== undefined) {
            if (!stringArray(check.evidenceIds)) {
              err('E_CHECK_EVIDENCE_TYPE', `${checkBase}.evidenceIds`, 'evidenceIds 必须是字符串数组');
            } else {
              check.evidenceIds.forEach((id, i) => {
                if (!evidenceIds.has(id)) {
                  err('E_CHECK_EVIDENCE_UNKNOWN', `${checkBase}.evidenceIds[${i}]`, `证据引用不存在：${id}`);
                }
              });
            }
          }
        });
      }

      /* 通过状态的自洽性 */
      if (item.status === 'passed' && Array.isArray(steps) && Array.isArray(checks)) {
        const badSteps = steps.filter((step) => isObject(step) && step.status !== 'passed');
        const badChecks = checks.filter((check) => isObject(check) && check.status !== 'passed');
        if (badSteps.length) {
          err('E_PASSED_CASE_STEP_CONTRADICTION', base, `用例声明 passed，但 ${badSteps.length} 个步骤不是 passed`);
        }
        if (badChecks.length) {
          err('E_PASSED_CASE_CHECK_CONTRADICTION', base, `用例声明 passed，但 ${badChecks.length} 个核对项不是 passed`);
        }
        if (!checks.some((check) => isObject(check) && check.status === 'passed')) {
          err('E_PASSED_CASE_NO_CHECK', base, '用例声明 passed 时必须至少有一个 passed 核对项');
        }
      }
    });
  }

  return { errors, warnings, indexes: { groupIds, recordingIds, evidenceIds, caseIds, stepIdsByCase, checkIdsByCase } };
}
