import fs from 'node:fs';
import path from 'node:path';

export class PathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

/**
 * 检查输入里声明的相对路径，返回数据目录内的真实绝对路径。
 * 拒绝：绝对路径、盘符路径、目录穿越、NUL 字符、指向目录外部的符号链接。
 */
export function resolveInsideDataDir(dataDirReal, declaredPath, fieldPath) {
  const label = fieldPath ? `${fieldPath}: ` : '';
  if (typeof declaredPath !== 'string' || declaredPath.trim() === '') {
    throw new PathError('E_PATH_EMPTY', `${label}路径不能为空`);
  }
  const value = declaredPath.trim();
  if (value.includes('\0')) {
    throw new PathError('E_PATH_INVALID', `${label}路径包含非法字符`);
  }
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    throw new PathError('E_PATH_ABSOLUTE', `${label}不允许绝对路径：${value}`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new PathError('E_PATH_TRAVERSAL', `${label}不允许目录穿越：${value}`);
  }
  const resolved = path.resolve(dataDirReal, value);
  const prefix = dataDirReal.endsWith(path.sep) ? dataDirReal : dataDirReal + path.sep;
  if (resolved !== dataDirReal && !resolved.startsWith(prefix)) {
    throw new PathError('E_PATH_ESCAPE', `${label}路径越出数据目录：${value}`);
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new PathError('E_FILE_MISSING', `${label}文件不存在：${value}`);
  }
  if (real !== dataDirReal && !real.startsWith(prefix)) {
    throw new PathError('E_PATH_SYMLINK_ESCAPE', `${label}符号链接指向数据目录之外：${value}`);
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new PathError('E_FILE_MISSING', `${label}文件不可访问：${value}`);
  }
  if (!stat.isFile()) {
    throw new PathError('E_FILE_NOT_FILE', `${label}不是普通文件：${value}`);
  }
  return { absolute: real, declared: value, stat };
}

export function resolveDataDir(inputPath) {
  const absolute = path.resolve(inputPath);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new PathError('E_INPUT_MISSING', `输入文件不存在：${inputPath}`);
  }
  if (!stat.isFile()) {
    throw new PathError('E_INPUT_NOT_FILE', `输入不是文件：${inputPath}`);
  }
  if (path.extname(absolute).toLowerCase() !== '.json') {
    throw new PathError('E_INPUT_EXTENSION', `输入必须是 .json 文件：${inputPath}`);
  }
  return { inputAbsolute: absolute, dataDirReal: fs.realpathSync(path.dirname(absolute)) };
}

export function assertWritableOutputDir(outDir) {
  const absolute = path.resolve(outDir);
  if (absolute === path.parse(absolute).root) {
    throw new PathError('E_OUTPUT_INVALID', '输出目录不能是文件系统根目录');
  }
  if (fs.existsSync(absolute)) {
    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) {
      throw new PathError('E_OUTPUT_NOT_DIR', `输出路径已存在且不是目录：${outDir}`);
    }
    const entries = fs.readdirSync(absolute);
    if (entries.length > 0) {
      throw new PathError('E_OUTPUT_EXISTS', `输出目录非空，拒绝覆盖：${outDir}`);
    }
  }
  return absolute;
}
