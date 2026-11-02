import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadAndValidate, InputError } from './validate.mjs';
import { assertWritableOutputDir, PathError } from './paths.mjs';
import { renderIndexHtml, createNonce, resolveViewer, SKILL_ROOT, BuildError } from './render.mjs';
import { GENERATOR_NAME, GENERATOR_VERSION, ASSET_MODES, LIMITS } from './constants.mjs';
import { auditQuality } from './quality.mjs';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readVendorText(relative) {
  return fs.readFileSync(path.join(SKILL_ROOT, 'assets', 'vendor', relative), 'utf8');
}

function buildNotices() {
  const sections = [
    'THIRD-PARTY NOTICES',
    '===================',
    '',
    '本验收包把下列第三方资源内联进 index.html，运行时不再请求任何 CDN 或远程字体。',
    '',
    '--- rrweb 2.1.1 (MIT) ---',
    '上游：https://github.com/rrweb-io/rrweb',
    '许可来源：https://raw.githubusercontent.com/rrweb-io/rrweb/3deb6e7da4528ddb33b5b7ff6a3e805d4ed14930/LICENSE',
    '',
    readVendorText(path.join('rrweb', 'LICENSE')),
    '',
    '--- sql-formatter 15.9.0 (MIT) ---',
    '上游：https://github.com/sql-formatter-org/sql-formatter',
    '用途：验收报告内 SQL 格式化（仅 mysql 方言，构建期 tree-shake 后内联）',
    '',
    readVendorText(path.join('code-view', 'LICENSE-sql-formatter.txt')),
    '',
    '--- highlight.js 11.12.0 (BSD-3-Clause) ---',
    '上游：https://github.com/highlightjs/highlight.js',
    '用途：验收报告内语法高亮（仅 sql / json / http / java 四种语言）',
    '',
    readVendorText(path.join('code-view', 'LICENSE-highlightjs.txt')),
    '',
    '--- Inter (SIL Open Font License 1.1) ---',
    '上游：https://github.com/rsms/inter',
    '',
    readVendorText(path.join('fonts', 'licenses', 'LICENSE-Inter.txt')),
    '',
    '--- JetBrains Mono (SIL Open Font License 1.1) ---',
    '上游：https://github.com/JetBrains/JetBrainsMono',
    '',
    readVendorText(path.join('fonts', 'licenses', 'LICENSE-JetBrainsMono.txt')),
    '',
    '--- Material Symbols Outlined (Apache License 2.0) ---',
    '上游：https://github.com/google/material-design-icons',
    '',
    readVendorText(path.join('fonts', 'licenses', 'LICENSE-MaterialSymbols.txt')),
    '',
  ];
  return sections.join('\n');
}

function writeNewFile(outAbsolute, relativePath, content) {
  const file = path.join(outAbsolute, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx' });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { path: relativePath.split(path.sep).join('/'), sha256: sha256(buffer), bytes: buffer.length };
}

function imageExtension(declaredFile) {
  const ext = path.extname(declaredFile).toLowerCase().replace('.', '');
  return ext === 'jpeg' ? 'jpeg' : ext;
}

/* 相同字节的图片按 sha256 只保留一份；不同证据仍各自保留引用与指纹。 */
function collectImages(evidenceList) {
  const images = new Map();
  evidenceList.forEach((ev) => {
    if (ev.type !== 'image' || !ev.sha256 || !ev.buffer) return;
    let entry = images.get(ev.sha256);
    if (!entry) {
      entry = {
        sha256: ev.sha256,
        mime: ev.mime,
        bytes: ev.bytes,
        ext: imageExtension(ev.file || ''),
        buffer: ev.buffer,
        evidenceIds: [],
      };
      images.set(ev.sha256, entry);
    }
    if (!entry.evidenceIds.includes(ev.id)) entry.evidenceIds.push(ev.id);
  });
  return [...images.values()];
}

export function buildPackage(inputPath, outDir, options = {}) {
  const assetMode = options.assetMode === undefined ? 'inline' : options.assetMode;
  if (!ASSET_MODES.includes(assetMode)) {
    throw new InputError('E_ASSET_MODE', `assetMode 只能是 ${ASSET_MODES.join(' / ')}，收到：${assetMode}`);
  }

  const validation = loadAndValidate(inputPath);
  if (!validation.ok) {
    return {
      ok: false,
      stage: 'validate',
      errors: validation.errors,
      warnings: validation.warnings,
      inputAbsolute: validation.inputAbsolute,
    };
  }

  const outAbsolute = assertWritableOutputDir(outDir);
  const builtAt = new Date().toISOString();
  const nonce = createNonce();
  const { data, recordings, evidence, inputSha256, inputAbsolute, dataDirReal } = validation;

  let viewer;
  try {
    viewer = resolveViewer();
  } catch (error) {
    if (error instanceof BuildError) {
      return {
        ok: false,
        stage: 'assets',
        errors: [{ code: error.code, path: '$', message: error.message }],
        warnings: validation.warnings,
        inputAbsolute,
      };
    }
    throw error;
  }
  const viewerWarnings = viewer.warnings || [];
  if (options.requireQuality || validation.data.report.example !== true) {
    const quality = auditQuality(validation);
    if (!quality.ok) return {ok:false,stage:'quality',errors:quality.errors,warnings:quality.warnings,repairTasks:quality.repairTasks};
  }

  const recordingList = [...recordings.values()];
  const evidenceList = [...evidence.values()];
  const recordingEvents = Object.create(null);
  recordingList.forEach((rec) => {
    recordingEvents[rec.id] = rec.events;
  });

  const images = collectImages(evidenceList);
  const imageBySha = new Map(images.map((image) => [image.sha256, image]));

  const payloadEvidence = evidenceList.map((ev) => {
    const { buffer, ...rest } = ev;
    const item = { ...rest };
    if (assetMode === 'external' && ev.type === 'image') {
      const image = imageBySha.get(ev.sha256);
      if (image) {
        item.dataUri = `./images/${image.sha256}.${image.ext}`;
        item.assetPath = item.dataUri;
      }
    }
    return item;
  });

  const payload = {
    schemaVersion: 1,
    assetMode,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION, builtAt },
    inputSha256,
    report: data.report,
    groups: data.groups,
    cases: data.cases,
    recordings: recordingList.map((rec) => ({
      id: rec.id,
      title: rec.title,
      format: rec.format,
      declaredFormat: rec.declaredFormat,
      file: rec.file,
      fileSha256: rec.fileSha256,
      bytes: rec.bytes,
      eventCount: rec.eventCount,
      durationMs: rec.durationMs,
      startTime: rec.startTime,
      endTime: rec.endTime,
      viewport: rec.viewport,
      sourceMeta: rec.sourceMeta,
      wrappedInRecJs: rec.wrappedInRecJs,
    })),
    recordingEvents,
    evidence: payloadEvidence,
  };

  let html;
  try {
    html = renderIndexHtml({ templateText: viewer.templateText, payload, nonce, viewer });
  } catch (error) {
    if (error instanceof BuildError) {
      return {
        ok: false,
        stage: 'render',
        errors: [{ code: error.code, path: '$', message: error.message }],
        warnings: validation.warnings.concat(viewerWarnings),
      };
    }
    throw error;
  }

  const indexBytes = Buffer.from(html, 'utf8');
  const warnings = validation.warnings.concat(viewerWarnings);
  if (assetMode === 'external' && indexBytes.length >= LIMITS.pageBytes) {
    return {
      ok: false,
      stage: 'render',
      errors: [{
        code: 'E_PAGE_TOO_LARGE',
        path: 'index.html',
        message: `外置模式下单页原始请求为 ${indexBytes.length} bytes，必须小于 ${LIMITS.pageBytes} bytes；文本证据不得为减体积删除，图片应走 images/ 相对资源。`,
      }],
      warnings,
    };
  }
  if (assetMode === 'inline' && indexBytes.length >= LIMITS.pageBytes) {
    warnings.push({
      code: 'W_PAGE_LARGE',
      path: 'index.html',
      message: `内联单页为 ${indexBytes.length} bytes，超过 ${LIMITS.pageBytes} bytes；交付给受保护独立入口时改用 --asset-mode external。`,
    });
  }

  const notices = buildNotices();
  const stats = {
    cases: data.cases.length,
    steps: data.cases.reduce((sum, item) => sum + (Array.isArray(item.steps) ? item.steps.length : 0), 0),
    checks: data.cases.reduce((sum, item) => sum + (Array.isArray(item.checks) ? item.checks.length : 0), 0),
    evidence: evidenceList.length,
    images: images.length,
    recordings: recordingList.length,
    pages: data.cases.reduce((sum, item) => sum + (item.steps || []).filter((step) => step.type === 'page').length, 0),
  };

  const outputEntries = [
    { path: 'index.html', sha256: sha256(indexBytes), bytes: indexBytes.length },
    { path: 'manifest.json', sha256: null, bytes: null },
    { path: 'THIRD-PARTY-NOTICES.txt', sha256: sha256(Buffer.from(notices, 'utf8')), bytes: Buffer.byteLength(notices) },
  ];
  const imageEntries = assetMode === 'external'
    ? images.map((image) => ({
      path: `images/${image.sha256}.${image.ext}`,
      sha256: image.sha256,
      bytes: image.bytes,
    }))
    : [];

  const manifest = {
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    builtAt,
    node: process.version,
    assetMode,
    viewer: { id: viewer.id, legacy: viewer.legacy === true },
    input: {
      file: path.basename(inputAbsolute),
      sha256: inputSha256,
      dataDir: path.basename(dataDirReal),
      bytes: validation.inputBytes,
    },
    stats,
    report: {
      id: data.report.id,
      title: data.report.title,
      environment: data.report.environment,
      revision: data.report.revision || null,
      executedAt: data.report.executedAt || null,
      example: data.report.example,
    },
    output: outputEntries.concat(imageEntries),
    resources: {
      images: images.map((image) => ({
        sha256: image.sha256,
        mime: image.mime,
        bytes: image.bytes,
        path: assetMode === 'external' ? `images/${image.sha256}.${image.ext}` : null,
        embedded: assetMode === 'inline',
        evidenceIds: image.evidenceIds,
      })),
      duplicatedBytes: evidenceList.filter((ev) => ev.type === 'image').length - images.length,
    },
    assets: {
      rrweb: {
        version: '2.1.1',
        license: 'MIT',
        sha256: sha256(fs.readFileSync(path.join(SKILL_ROOT, 'assets', 'vendor', 'rrweb', 'rrweb.umd.min.js'))),
      },
      codeView: {
        sqlFormatter: {
          version: '15.9.0',
          license: 'MIT',
          dialect: 'mysql',
          file: 'vendor/code-view/sql-formatter.mysql.min.js',
          sha256: sha256(fs.readFileSync(path.join(SKILL_ROOT, 'assets', 'vendor', 'code-view', 'sql-formatter.mysql.min.js'))),
        },
        highlighter: {
          version: '11.12.0',
          license: 'BSD-3-Clause',
          languages: ['sql', 'json', 'http', 'java'],
          file: 'vendor/code-view/highlight-sql-json-http-java.min.js',
          sha256: sha256(fs.readFileSync(path.join(SKILL_ROOT, 'assets', 'vendor', 'code-view', 'highlight-sql-json-http-java.min.js'))),
        },
        formatterFallback: '格式化失败或文本疑似被截断时保留原文并标注原因',
      },
      fonts: ['Inter (OFL-1.1)', 'JetBrains Mono (OFL-1.1)', 'Material Symbols Outlined (Apache-2.0)'],
      viewer: viewer.id,
    },
    recordings: recordingList.map((rec) => ({
      id: rec.id,
      format: rec.format,
      file: rec.file,
      fileSha256: rec.fileSha256,
      events: rec.eventCount,
      durationMs: rec.durationMs,
    })),
    evidence: evidenceList.map((ev) => ({
      id: ev.id,
      type: ev.type,
      category: ev.category || null,
      file: ev.file || null,
      sha256: ev.sha256 || null,
      assetPath: assetMode === 'external' && ev.type === 'image' && imageBySha.has(ev.sha256)
        ? `images/${ev.sha256}.${imageBySha.get(ev.sha256).ext}`
        : null,
    })),
    warnings,
    validation: { errors: 0, warnings: warnings.length },
    offline: {
      csp: true,
      externalRequests: 'blocked by CSP (default-src none)',
      runtimeDependencies: 'none',
      pageBytes: indexBytes.length,
      pageBytesLimit: LIMITS.pageBytes,
    },
  };

  // 清单不声明自身指纹；包含自身哈希会产生无法满足的自引用。
  const manifestText = JSON.stringify(manifest, null, 2);

  const createdDir = !fs.existsSync(outAbsolute);
  const written = [];
  try {
    fs.mkdirSync(outAbsolute, { recursive: true });
    written.push(writeNewFile(outAbsolute, 'index.html', html));
    written.push(writeNewFile(outAbsolute, 'manifest.json', manifestText));
    written.push(writeNewFile(outAbsolute, 'THIRD-PARTY-NOTICES.txt', notices));
    if (assetMode === 'external') {
      for (const image of images) {
        written.push(writeNewFile(outAbsolute, `images/${image.sha256}.${image.ext}`, image.buffer));
      }
    }
  } catch (error) {
    try {
      for (const entry of written) fs.rmSync(path.join(outAbsolute, entry.path), { force: true });
      fs.rmSync(path.join(outAbsolute, 'images'), { recursive: true, force: true });
      if (createdDir) fs.rmSync(outAbsolute, { recursive: true, force: true });
    } catch {
      /* 清理失败不应掩盖原始错误 */
    }
    if (error instanceof PathError) throw error;
    const wrapped = new Error(`写入验收包失败：${error.message}`);
    wrapped.code = 'E_WRITE';
    throw wrapped;
  }

  return {
    ok: true,
    outDir: outAbsolute,
    assetMode,
    viewer: { id: viewer.id, legacy: viewer.legacy === true },
    files: written,
    stats,
    warnings,
    manifest,
    indexBytes: indexBytes.length,
  };
}
