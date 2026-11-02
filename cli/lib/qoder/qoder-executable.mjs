import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const INSTALL_DIRS = ['.local/bin', '.qoder/bin'];

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function notFound(command) {
  return new Error(`Qoder CLI 未在 PATH、~/.local/bin 或 ~/.qoder/bin 中找到，且不会自动安装：${command}`);
}

/** Keep the caller's explicit environment, and only append existing Qoder install directories to PATH. */
export function qoderRuntimeEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const home = env.HOME || homedir();
  const dirs = [
    ...(env.PATH || '').split(delimiter).filter(Boolean),
    ...INSTALL_DIRS.map((dir) => join(home, dir)),
  ];
  env.PATH = [...new Set(dirs)].join(delimiter);
  return env;
}

/** Resolve a pre-installed qodercli binary; this never installs or rewrites the user's environment. */
export function resolveQoderAcpCommand(command = 'qodercli', { env = process.env } = {}) {
  const configured = String(command || '').trim();
  if (!configured || /[\r\n\0]/.test(configured)) throw notFound(configured || '(empty)');
  if (configured.includes('/') || configured.includes('\\')) {
    const candidate = isAbsolute(configured) ? configured : resolve(configured);
    if (isExecutable(candidate)) return candidate;
    throw notFound(configured);
  }
  if (/\s/.test(configured)) throw new Error(`Qoder CLI 命令必须是可执行文件名或路径：${configured}`);
  const runtimeEnv = qoderRuntimeEnv(env);
  for (const dir of runtimeEnv.PATH.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, configured);
    if (isExecutable(candidate)) return candidate;
  }
  throw notFound(configured);
}
