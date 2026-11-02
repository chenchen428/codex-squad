export const GENERATOR_NAME = 'codex-squad-functional-acceptance';
export const GENERATOR_VERSION = '0.12.0';
export const SCHEMA_VERSION = 1;

export const STATUSES = ['passed', 'failed', 'blocked', 'not_run', 'partial'];
export const CASE_ROLES = ['new', 'regression', 'mixed', 'audit', 'unknown'];
export const STEP_TYPES = ['page', 'api', 'data', 'message'];
export const EVIDENCE_TYPES = ['json', 'text', 'image'];
export const EVIDENCE_CATEGORIES = ['api', 'data', 'log', 'source'];
export const RECORDING_FORMATS = ['rrweb', 'chromepilot'];

export const STATEMENT_KINDS = ['sql', 'http', 'hsf', 'message', 'tool'];
export const STATEMENT_ORIGINS = ['executed', 'reconstructed', 'unavailable'];
export const REPRODUCTION_KINDS = ['page', 'lantu', 'hsf', 'db', 'mq', 'trace', 'api', 'ci', 'data'];
export const REPRODUCTION_URL_STATUSES = ['verified', 'unavailable'];
export const ASSET_MODES = ['inline', 'external'];

/* 用例设计依据：测新追溯需求原话/文档，回归追溯规则/影响路径/历史问题。 */
export const CASE_DESIGN_SOURCE_KINDS = ['requirement', 'rule', 'impact', 'history', 'confirmation', 'evidence', 'design'];
/* 截图标注语气：重点核对、上下文、风险。 */
export const ANNOTATION_TONES = ['focus', 'context', 'risk'];

/* 未留存原文的陈述必须显式写出这些事实之一，避免把缺失原文写成执行结果。 */
export const STATEMENT_UNAVAILABLE_MARKERS = ['未留存', '未保留', '未记录', '未获取', '不可得', '没有留存'];
/* 还原/整理出的陈述必须说明来源方式，不能标成执行原文。 */
export const STATEMENT_RECONSTRUCTED_MARKERS = ['还原', '重构', '重建', '整理', '补写', '根据', '据'];
export const STATEMENT_EXECUTED_CLAIMS = ['执行原文', '实际执行记录', '执行记录原文'];

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
export const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const LIMITS = {
  inputBytes: 64 * 1024 * 1024,
  recordingBytes: 256 * 1024 * 1024,
  evidenceBytes: 16 * 1024 * 1024,
  imageBytes: 32 * 1024 * 1024,
  /* 外置资源模式下单页 HTML 的原始请求大小上限（4MiB，需严格小于）。 */
  pageBytes: 4 * 1024 * 1024,
};

export const EXIT = { ok: 0, failed: 1, usage: 2 };
