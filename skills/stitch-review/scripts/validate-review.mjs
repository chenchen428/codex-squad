#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile, realpath, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const KINDS = new Set(['illustration', 'stitch-original', 'browser-repaired', 'product-capture']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function numericDimension(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function parseStartTag(text, start, label) {
  if (text[start] !== '<') fail(`SVG 无法确定尺寸：${label}`);
  let index = start + 1;
  const name = /^[A-Za-z_][-\w:.]*/.exec(text.slice(index));
  if (!name) fail(`SVG 无法确定尺寸：${label}`);
  index += name[0].length;
  const attributes = new Map();
  for (;;) {
    while (/\s/.test(text[index] ?? '')) index++;
    if (text.startsWith('/>', index) || text[index] === '>') return {name: name[0], attributes};
    const attribute = /^[A-Za-z_:][-\w:.]*/.exec(text.slice(index));
    if (!attribute) fail(`SVG 无法确定尺寸：${label}`);
    index += attribute[0].length;
    while (/\s/.test(text[index] ?? '')) index++;
    if (text[index] !== '=') fail(`SVG 无法确定尺寸：${label}`);
    index++;
    while (/\s/.test(text[index] ?? '')) index++;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") fail(`SVG 无法确定尺寸：${label}`);
    const end = text.indexOf(quote, index + 1);
    if (end < 0) fail(`SVG 无法确定尺寸：${label}`);
    attributes.set(attribute[0], text.slice(index + 1, end));
    index = end + 1;
  }
}

function svgDimensions(raw, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  } catch {
    fail(`SVG 无法确定尺寸：${label}`);
  }
  text = text.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail(`SVG 不允许 DTD 或外部实体：${label}`);
  let index = 0;
  for (;;) {
    while (/\s/.test(text[index] ?? '')) index++;
    if (text.startsWith('<?', index)) {
      const end = text.indexOf('?>', index + 2);
      if (end < 0) fail(`SVG 无法确定尺寸：${label}`);
      index = end + 2;
    } else if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end < 0) fail(`SVG 无法确定尺寸：${label}`);
      index = end + 3;
    } else {
      break;
    }
  }
  const root = parseStartTag(text, index, label);
  const width = numericDimension(root.attributes.get('width'));
  const height = numericDimension(root.attributes.get('height'));
  if (width === null || height === null) fail(`SVG 无法确定尺寸：${label}`);
  return {width, height};
}

function pngDimensions(raw, label) {
  if (raw.length < 24 || raw.toString('ascii', 12, 16) !== 'IHDR') fail(`PNG 结构无效，无法确定尺寸：${label}`);
  return {width: raw.readUInt32BE(16), height: raw.readUInt32BE(20)};
}

export async function validateReview(directory) {
  if (typeof directory !== 'string' || !directory.trim()) fail('缺少审阅目录');
  let root;
  try {
    root = await realpath(path.resolve(directory));
  } catch {
    fail(`审阅目录不存在：${directory}`);
  }
  let data;
  try {
    data = JSON.parse(await readFile(path.join(root, 'data.json'), 'utf8'));
  } catch (error) {
    fail(error.code === 'ENOENT' ? '缺少 data.json' : `data.json 无法读取或解析：${error.message}`);
  }

  async function localFile(name) {
    requireValue(
      typeof name === 'string' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) && !name.startsWith('/'),
      '素材和交互稿需用相对路径',
    );
    const candidate = path.resolve(root, name.split(/[?#]/, 1)[0]);
    let resolved;
    let info;
    try {
      resolved = await realpath(candidate);
      info = await stat(resolved);
    } catch {
      fail(`本地文件缺失或越界：${name}`);
    }
    requireValue(contained(root, resolved) && info.isFile(), `本地文件缺失或越界：${name}`);
    return resolved;
  }

  async function hashedFile(item, label) {
    requireValue(item && typeof item.path === 'string', `缺少原始 HTML 身份：${label}`);
    const file = await localFile(item.path);
    requireValue(sha256(await readFile(file)) === item.sha256, `原始来源哈希不符：${path.basename(file)}`);
  }

  const assetIds = new Map();
  async function asset(entry) {
    requireValue(entry && typeof entry === 'object', '缺少图像登记');
    const file = await localFile(entry.image);
    requireValue(KINDS.has(entry.kind), `来源类型不明：${entry.id}`);
    requireValue(
      typeof entry.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
        && typeof entry.height === 'number' && Number.isFinite(entry.height) && entry.height > 0,
      '图像尺寸必须为正',
    );
    const raw = await readFile(file);
    requireValue(sha256(raw) === entry.sha256, `图像哈希不符：${entry.id}`);
    let dimensions;
    if (path.extname(file) === '.svg') dimensions = svgDimensions(raw, entry.id);
    else if (raw.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) dimensions = pngDimensions(raw, entry.id);
    else fail('模板校验目前支持完整 PNG / SVG；其他格式先无裁切转换并记录来源。');
    requireValue(
      dimensions.width === entry.width && dimensions.height === entry.height,
      `完整图片尺寸与登记不符：${entry.id}`,
    );
    const fingerprint = JSON.stringify([entry.image, entry.sha256, entry.kind]);
    requireValue(!assetIds.has(entry.id) || assetIds.get(entry.id) === fingerprint, `同一图像 ID 指向不同来源：${entry.id}`);
    assetIds.set(entry.id, fingerprint);
    if (entry.preview) await localFile(entry.preview);
    if (entry.kind === 'stitch-original' || entry.kind === 'browser-repaired') {
      requireValue(entry.screen && entry.projectId && entry.file, '缺少确切 Stitch screen/file 身份');
      await hashedFile(entry.originalHTML, entry.id);
    }
    if (entry.kind === 'browser-repaired') {
      requireValue(entry.repairs && entry.render?.viewport, '浏览器修复稿缺少修复与渲染记录');
    }
    if (entry.kind === 'product-capture') {
      const capture = entry.capture ?? {};
      requireValue(
        ['page', 'state', 'viewport', 'capturedAt', 'build'].every(key => capture[key]),
        '产品截图缺少实测上下文',
      );
      requireValue(capture.viewport.width === entry.width, '截图宽度与实测视口不符');
    }
  }

  requireValue(data && typeof data === 'object', '缺少审阅身份');
  requireValue(data.schemaVersion === 1 && data.id && data.revision, '缺少审阅身份');
  requireValue(Array.isArray(data.groups) && data.groups.length > 0, '至少需要一组');
  const groupIds = new Set();
  for (const group of data.groups) {
    requireValue(group && typeof group.id === 'string' && !groupIds.has(group.id), '组 ID 重复');
    groupIds.add(group.id);
    requireValue(Array.isArray(group.options) && group.options.length > 0, '每组至少需要当前方案');
    const optionIds = group.options.map(option => option?.id);
    requireValue(
      optionIds.every(id => typeof id === 'string') && new Set(optionIds).size === optionIds.length && optionIds[0] === 'current',
      '每组第一项应为唯一 current',
    );
    for (const option of group.options) {
      requireValue(option.version && option.tradeoff, '候选缺少版本或实质取舍');
      requireValue(Array.isArray(option.states) && option.states.length > 0, '状态 ID 缺失或重复');
      const stateIds = option.states.map(state => state?.id);
      requireValue(
        stateIds.every(id => typeof id === 'string' && id) && new Set(stateIds).size === stateIds.length,
        '状态 ID 缺失或重复',
      );
      for (const state of option.states) await asset(state.asset);
    }
    requireValue(Array.isArray(group.issues), '问题记录缺失');
    for (const issue of group.issues) {
      requireValue(issue?.id && issue.quote && issue.page && issue.state, '问题缺少原话或页面状态');
    }
    requireValue(group.implementation && typeof group.implementation === 'object', '缺少实现验收记录');
    for (const capture of group.implementation.captures ?? []) {
      const option = group.options.find(item => item.id === capture?.optionId);
      requireValue(
        option && option.states.some(state => state.id === capture.stateId),
        '实现截图未绑定准确方案/状态',
      );
      requireValue(capture.asset?.kind === 'product-capture', '实现证据必须为真实产品截图');
      await asset(capture.asset);
    }
  }
  return {data, imageCount: assetIds.size};
}

async function main() {
  let directory;
  let syncData = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === '--sync-data') syncData = true;
    else if (argument.startsWith('-')) fail(`未知参数：${argument}`);
    else if (directory) fail('只接受一个审阅目录');
    else directory = argument;
  }
  if (!directory) fail('用法：node validate-review.mjs <目录> [--sync-data]');
  const {data, imageCount} = await validateReview(directory);
  const expected = `window.REVIEW_DATA = ${JSON.stringify(data, null, 2)};\n`;
  const dataScript = path.join(path.resolve(directory), 'data.js');
  if (syncData) {
    await writeFile(dataScript, expected);
  } else {
    let actual;
    try {
      actual = await readFile(dataScript, 'utf8');
    } catch {
      fail('data.js 与 data.json 不一致；校验后用 --sync-data 同步');
    }
    requireValue(actual === expected, 'data.js 与 data.json 不一致；校验后用 --sync-data 同步');
  }
  console.log(`PASS: ${data.groups.length} groups / ${imageCount} image identities; full dimensions and hashes verified`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}
