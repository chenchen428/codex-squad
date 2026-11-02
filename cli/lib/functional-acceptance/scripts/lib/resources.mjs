import { resolveInsideDataDir, PathError } from './paths.mjs';
import { readTextFile, loadImageFile, sha256File } from './assets.mjs';
import { parseRecordingText, RecordingError } from './recordings.mjs';
import { LIMITS } from './constants.mjs';

function statusOf(object) {
  return object && typeof object.status === 'string' ? object.status : 'not_run';
}

/**
 * 读取 recordings / evidence 指向的文件，做路径边界、格式和事件时序校验。
 * 返回已归一化（可直接内联进页面）的资源，以及错误/警告列表。
 */
export function loadResources(data, dataDirReal) {
  const errors = [];
  const warnings = [];
  const err = (code, path, message) => errors.push({ code, path, message });
  const warn = (code, path, message) => warnings.push({ code, path, message });

  const recordings = new Map();
  const evidence = new Map();

  const rawRecordings = Array.isArray(data.recordings) ? data.recordings : [];
  const rawEvidence = Array.isArray(data.evidence) ? data.evidence : [];

  /* recordings */
  rawRecordings.forEach((rec, index) => {
    if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || typeof rec.file !== 'string') return;
    const fieldPath = `recordings[${index}].file`;
    let resolved;
    try {
      resolved = resolveInsideDataDir(dataDirReal, rec.file, fieldPath);
    } catch (error) {
      if (error instanceof PathError) {
        err(error.code, fieldPath, error.message);
        return;
      }
      throw error;
    }
    if (resolved.stat.size > LIMITS.recordingBytes) {
      err('E_RECORDING_TOO_LARGE', fieldPath, `录制文件过大：${resolved.stat.size} bytes`);
      return;
    }
    let text;
    try {
      text = readTextFile(resolved.absolute, LIMITS.recordingBytes).text;
    } catch (error) {
      err(error.code || 'E_RECORDING_READ', fieldPath, error.message);
      return;
    }
    let parsed;
    try {
      parsed = parseRecordingText(text, {
        declaredPath: resolved.declared,
        format: typeof rec.format === 'string' ? rec.format : 'rrweb',
        label: fieldPath,
      });
    } catch (error) {
      if (error instanceof RecordingError) {
        err(error.code, fieldPath, error.message);
        return;
      }
      throw error;
    }
    recordings.set(rec.id, {
      id: rec.id,
      title: typeof rec.title === 'string' ? rec.title : rec.id,
      format: parsed.sourceFormat,
      declaredFormat: rec.format,
      file: resolved.declared,
      fileSha256: sha256File(resolved.absolute),
      bytes: resolved.stat.size,
      eventCount: parsed.eventCount,
      durationMs: parsed.durationMs,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      viewport: parsed.viewport,
      sourceMeta: parsed.sourceMeta,
      wrappedInRecJs: parsed.wrappedInRecJs,
      events: parsed.events,
    });
  });

  /* evidence */
  rawEvidence.forEach((ev, index) => {
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string') return;
    const base = `evidence[${index}]`;
    const item = {
      id: ev.id,
      title: typeof ev.title === 'string' ? ev.title : ev.id,
      type: typeof ev.type === 'string' ? ev.type : 'text',
      category: typeof ev.category === 'string' ? ev.category : undefined,
      source: typeof ev.source === 'string' ? ev.source : undefined,
    };
    /* 截图制作方式、补拍说明等来源事实只进证据详情，不被生成器删除或改写。 */
    for (const [key, value] of Object.entries(ev)) {
      if (['id', 'title', 'type', 'category', 'source', 'file', 'value'].includes(key)) continue;
      if (!(key in item)) item[key] = value;
    }
    if (typeof ev.file === 'string' && ev.file) {
      let resolved;
      try {
        resolved = resolveInsideDataDir(dataDirReal, ev.file, `${base}.file`);
      } catch (error) {
        if (error instanceof PathError) {
          err(error.code, `${base}.file`, error.message);
          return;
        }
        throw error;
      }
      if (item.type === 'image') {
        try {
          const image = loadImageFile(resolved.absolute, resolved.declared);
          Object.assign(item, {
            file: resolved.declared,
            mime: image.mime,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
            sha256: image.sha256,
            dataUri: image.dataUri,
            content: `（图片证据，${image.mime}，${image.bytes} bytes）`,
            buffer: image.buffer,
          });
        } catch (error) {
          err(error.code || 'E_IMAGE', `${base}.file`, error.message);
          return;
        }
      } else {
        let text;
        try {
          text = readTextFile(resolved.absolute, LIMITS.evidenceBytes).text;
        } catch (error) {
          err(error.code || 'E_EVIDENCE_READ', `${base}.file`, error.message);
          return;
        }
        if (item.type === 'json') {
          let parsedJson;
          try {
            parsedJson = JSON.parse(text);
          } catch (error) {
            err('E_EVIDENCE_JSON_PARSE', `${base}.file`, `证据不是合法 JSON：${error.message}`);
            return;
          }
          item.content = text;
        } else {
          item.content = text;
        }
        Object.assign(item, {
          file: resolved.declared,
          sha256: sha256File(resolved.absolute),
          bytes: resolved.stat.size,
          mime: 'text/plain; charset=utf-8',
        });
      }
    } else if (ev.value !== undefined) {
      item.content = typeof ev.value === 'string' ? ev.value : JSON.stringify(ev.value, null, 2);
    }
    evidence.set(ev.id, item);
  });

  /* 用例内引用与时间点 */
  const usedRecordings = new Set();
  const usedEvidence = new Set();
  const cases = Array.isArray(data.cases) ? data.cases : [];
  cases.forEach((item, caseIndex) => {
    if (!item || typeof item !== 'object') return;
    const steps = Array.isArray(item.steps) ? item.steps : [];
    const checks = Array.isArray(item.checks) ? item.checks : [];
    const passedPageSteps = [];
    steps.forEach((step, stepIndex) => {
      if (!step || typeof step !== 'object') return;
      const stepBase = `cases[${caseIndex}].steps[${stepIndex}]`;
      if (Array.isArray(step.evidenceIds)) step.evidenceIds.forEach((id) => usedEvidence.add(id));
      if (step.recordingId) usedRecordings.add(step.recordingId);
      if (step.verification && typeof step.verification === 'object') {
        const focus = Array.isArray(step.verification.focus) ? step.verification.focus : [];
        focus.forEach((item) => {
          if (item && Array.isArray(item.evidenceIds)) item.evidenceIds.forEach((id) => usedEvidence.add(id));
        });
        const comparison = Array.isArray(step.verification.comparison) ? step.verification.comparison : [];
        comparison.forEach((item) => {
          if (item && Array.isArray(item.evidenceIds)) item.evidenceIds.forEach((id) => usedEvidence.add(id));
        });
        if (step.verification.ued && typeof step.verification.ued.evidenceId === 'string') {
          usedEvidence.add(step.verification.ued.evidenceId);
        }
      }
      if (step.reproduction && typeof step.reproduction === 'object' && Array.isArray(step.reproduction.sourceIds)) {
        step.reproduction.sourceIds.forEach((id) => usedEvidence.add(id));
      }
      if (step.type !== 'page') return;
      if (!step.recordingId) return;
      const rec = recordings.get(step.recordingId);
      if (!rec) return;
      if (Number.isInteger(step.atMs)) {
        if (step.atMs > rec.durationMs) {
          err('E_TIME_OUT_OF_RANGE', `${stepBase}.atMs`, `atMs ${step.atMs}ms 超出录制时长 ${rec.durationMs}ms（${rec.id}）`);
        }
        if (Number.isInteger(step.endMs) && step.endMs > rec.durationMs) {
          err('E_END_OUT_OF_RANGE', `${stepBase}.endMs`, `endMs ${step.endMs}ms 超出录制时长 ${rec.durationMs}ms（${rec.id}）`);
        }
        if (statusOf(step) === 'passed') passedPageSteps.push(step);
      }
    });
    checks.forEach((check, checkIndex) => {
      if (!check || typeof check !== 'object') return;
      if (Array.isArray(check.evidenceIds)) check.evidenceIds.forEach((id) => usedEvidence.add(id));
      if (statusOf(check) === 'passed' && (!Array.isArray(check.evidenceIds) || check.evidenceIds.length === 0)) {
        if (!passedPageSteps.length) {
          warn('W_PASSED_CHECK_WITHOUT_EVIDENCE', `cases[${caseIndex}].checks[${checkIndex}]`,
            'passed 核对项没有证据引用，也没有指向有效录制的 passed 页面步骤');
        }
      }
    });
  });

  recordings.forEach((rec) => {
    if (!usedRecordings.has(rec.id)) warn('W_UNUSED_RECORDING', `recordings`, `录制未被任何步骤引用：${rec.id}`);
  });
  rawEvidence.forEach((ev, index) => {
    if (ev && typeof ev.id === 'string' && !usedEvidence.has(ev.id)) {
      warn('W_UNUSED_EVIDENCE', `evidence[${index}]`, `证据未被任何步骤或核对项引用：${ev.id}`);
    }
  });

  return { errors, warnings, recordings, evidence };
}
