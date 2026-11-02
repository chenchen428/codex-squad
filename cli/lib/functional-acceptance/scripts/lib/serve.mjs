import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GENERATOR_NAME } from './constants.mjs';
import { PathError, resolveInsideDataDir } from './paths.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 63352;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
};

export class PackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new PackageError('E_PACKAGE_INCOMPLETE', `验收包缺少 ${label}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PackageError('E_PACKAGE_INVALID', `${label} 不是合法 JSON`);
  }
}

/**
 * 只读校验已生成的验收包：生成器身份、输入指纹与 index.html 内容指纹。
 * 不读取任何云端接口、问答缓存或本机 OAuth 凭据。
 */
export function loadAcceptancePackage(directory) {
  const absolute = path.resolve(directory);
  let root;
  try {
    root = fs.realpathSync(absolute);
  } catch {
    throw new PackageError('E_PACKAGE_MISSING', `验收包目录不存在：${directory}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new PackageError('E_PACKAGE_NOT_DIR', `验收包路径不是目录：${directory}`);
  }

  const manifest = readJson(path.join(root, 'manifest.json'), 'manifest.json');
  if (!manifest || typeof manifest !== 'object' || manifest.generator?.name !== GENERATOR_NAME) {
    throw new PackageError('E_PACKAGE_INVALID', 'manifest.json 不是本工具生成的验收包');
  }
  const inputSha256 = manifest.input?.sha256;
  if (typeof inputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(inputSha256)) {
    throw new PackageError('E_PACKAGE_INVALID', 'manifest.json 缺少有效的输入指纹');
  }
  const entries = Array.isArray(manifest.output) ? manifest.output : [];
  const indexEntry = entries.find((entry) => entry?.path === 'index.html');
  if (!indexEntry || typeof indexEntry.sha256 !== 'string') {
    throw new PackageError('E_PACKAGE_INCOMPLETE', 'manifest.json 未登记 index.html');
  }
  let html;
  try {
    html = fs.readFileSync(path.join(root, 'index.html'));
  } catch {
    throw new PackageError('E_PACKAGE_INCOMPLETE', '验收包缺少 index.html');
  }
  if (sha256(html) !== indexEntry.sha256) {
    throw new PackageError('E_PACKAGE_TAMPERED', 'index.html 与 manifest.json 记录的内容指纹不一致');
  }
  if (!/<script type="application\/json" id="acceptance-data" nonce="[0-9a-f]+">/.test(html.toString('utf8'))) {
    throw new PackageError('E_PACKAGE_INVALID', 'index.html 缺少验收数据载荷');
  }
  return { root, manifest, inputSha256 };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function isLoopbackHost(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const value = hostHeader.trim().toLowerCase();
  return value === `${LOOPBACK_HOST}:${port}` || value === `localhost:${port}`;
}

function resolveRequestPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl || '/', `http://${LOOPBACK_HOST}`).pathname);
  } catch {
    return null;
  }
  if (pathname === '/') return resolveInsideOrNull(root, 'index.html');
  const relative = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!relative) return null;
  return resolveInsideOrNull(root, relative);
}

function resolveInsideOrNull(root, relative) {
  try {
    return resolveInsideDataDir(root, relative, '请求路径').absolute;
  } catch (error) {
    if (error instanceof PathError) return null;
    throw error;
  }
}

export async function startAcceptanceServer({ directory, port = DEFAULT_PORT, host = LOOPBACK_HOST } = {}) {
  if (host !== LOOPBACK_HOST) throw new PackageError('E_SERVE_HOST', '验收报告只能绑定 127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PackageError('E_SERVE_PORT', '端口范围为 0–65535');
  const { root, manifest, inputSha256 } = loadAcceptancePackage(directory);

  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method Not Allowed\n', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      return;
    }
    const boundPort = server.address()?.port;
    if (!isLoopbackHost(request.headers.host, boundPort)) {
      send(response, 403, 'Forbidden\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const contentLength = Number(request.headers['content-length'] || 0);
    if (contentLength > 0) {
      send(response, 413, 'Payload Too Large\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const file = resolveRequestPath(root, request.url);
    if (!file) {
      send(response, 404, 'Not Found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      send(response, 404, 'Not Found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(response, 200, request.method === 'HEAD' ? undefined : bytes, {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, resolve);
  });

  return {
    url: `http://${LOOPBACK_HOST}:${server.address().port}/`,
    host: LOOPBACK_HOST,
    port: server.address().port,
    directory: root,
    inputSha256,
    report: { id: manifest.report?.id || null, title: manifest.report?.title || null },
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
