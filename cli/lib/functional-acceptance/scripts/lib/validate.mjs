import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveDataDir, PathError } from './paths.mjs';
import { validateStructure } from './contract.mjs';
import { loadResources } from './resources.mjs';
import { LIMITS } from './constants.mjs';

export class InputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

/**
 * 读取并校验输入。结构错误存在时不再读资产文件，避免产生级联噪声。
 */
export function loadAndValidate(inputPath) {
  const { inputAbsolute, dataDirReal } = resolveDataDir(inputPath);
  const stat = fs.statSync(inputAbsolute);
  if (stat.size > LIMITS.inputBytes) {
    throw new InputError('E_INPUT_TOO_LARGE', `输入文件过大：${stat.size} bytes`);
  }
  const buffer = fs.readFileSync(inputAbsolute);
  const inputSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  let text;
  try {
    text = buffer.toString('utf8');
  } catch {
    throw new InputError('E_INPUT_ENCODING', '输入必须是 UTF-8 文本');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new InputError('E_INPUT_JSON', `输入不是合法 JSON：${error.message}`);
  }

  const structural = validateStructure(data);
  const result = {
    ok: false,
    inputAbsolute,
    dataDirReal,
    inputSha256,
    inputBytes: stat.size,
    data,
    errors: structural.errors.slice(),
    warnings: structural.warnings.slice(),
    recordings: new Map(),
    evidence: new Map(),
  };

  if (structural.errors.length === 0) {
    const resources = loadResources(data, dataDirReal);
    result.errors.push(...resources.errors);
    result.warnings.push(...resources.warnings);
    result.recordings = resources.recordings;
    result.evidence = resources.evidence;
  }

  result.ok = result.errors.length === 0;
  return result;
}

export { PathError };
