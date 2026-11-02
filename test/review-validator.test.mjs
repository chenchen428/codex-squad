import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {validateReview} from '../skills/stitch-review/scripts/validate-review.mjs';

const TEMPLATE = fileURLToPath(new URL('../skills/stitch-review/assets/review', import.meta.url));
const VALIDATOR = fileURLToPath(new URL('../skills/stitch-review/scripts/validate-review.mjs', import.meta.url));
const NEW_REVIEW = fileURLToPath(new URL('../skills/stitch-review/scripts/new-review.mjs', import.meta.url));

let workspace;
let review;
let data;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'stitch-review-'));
  review = path.join(workspace, 'review');
  await cp(TEMPLATE, review, {recursive: true});
  data = JSON.parse(await readFile(path.join(review, 'data.json'), 'utf8'));
});

afterEach(async () => {
  await rm(workspace, {recursive: true, force: true});
});

async function writeData() {
  await writeFile(path.join(review, 'data.json'), JSON.stringify(data));
}

function runValidator(...arguments_) {
  return spawnSync(process.execPath, [VALIDATOR, review, ...arguments_], {encoding: 'utf8'});
}

test('adopted single-current groups keep original image identities', async () => {
  for (const group of data.groups) group.options = [group.options[0]];
  await writeData();
  const {data: validated, imageCount} = await validateReview(review);
  assert.ok(imageCount > 0);
  assert.ok(validated.groups.every(group => group.options.length === 1));
});

test('group without current is rejected', async () => {
  data.groups[0].options[0].id = 'candidate-only';
  await writeData();
  await assert.rejects(validateReview(review), /每组第一项应为唯一 current/);
});

test('empty group is rejected as invalid review data', async () => {
  data.groups[0].options = [];
  await writeData();
  await assert.rejects(validateReview(review), /每组至少需要当前方案/);
});

test('asset paths cannot escape the review directory, including through symlinks', async () => {
  const asset = data.groups[0].options[0].states[0].asset;
  const escaped = path.join(workspace, 'escaped.svg');
  await cp(path.join(review, asset.image), escaped);

  asset.image = '../escaped.svg';
  await writeData();
  await assert.rejects(validateReview(review), /本地文件缺失或越界/);

  asset.image = 'images/escaped-link.svg';
  await symlink(escaped, path.join(review, 'images/escaped-link.svg'));
  await writeData();
  await assert.rejects(validateReview(review), /本地文件缺失或越界/);
});

test('image dimension and hash mismatches are rejected', async () => {
  const asset = data.groups[0].options[0].states[0].asset;
  const width = asset.width;

  asset.width = width + 1;
  await writeData();
  await assert.rejects(validateReview(review), /完整图片尺寸与登记不符/);

  asset.width = width;
  asset.sha256 = '0'.repeat(64);
  await writeData();
  await assert.rejects(validateReview(review), /图像哈希不符/);
});

test('SVG needs numeric root dimensions and rejects DTD or external entities', async () => {
  const asset = data.groups.find(group => group.id === 'library').options[0].states[0].asset;
  const file = path.join(review, asset.image);
  const unsafe = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="390" height="1510">&xxe;</svg>');
  await writeFile(file, unsafe);
  asset.sha256 = createHash('sha256').update(unsafe).digest('hex');
  await writeData();
  await assert.rejects(validateReview(review), /SVG 不允许 DTD 或外部实体/);

  const unsized = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 1510"></svg>');
  await writeFile(file, unsized);
  asset.sha256 = createHash('sha256').update(unsized).digest('hex');
  await writeData();
  await assert.rejects(validateReview(review), /SVG 无法确定尺寸/);
});

test('data.js must mirror data.json and --sync-data updates only the generated script', async () => {
  data.title = '同步合同验证';
  const dataJson = JSON.stringify(data, null, 2);
  await writeFile(path.join(review, 'data.json'), dataJson);

  const stale = runValidator();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /data\.js 与 data\.json 不一致/);

  const synced = runValidator('--sync-data');
  assert.equal(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /^PASS: 3 groups \/ \d+ image identities; full dimensions and hashes verified/);
  assert.equal(
    await readFile(path.join(review, 'data.js'), 'utf8'),
    `window.REVIEW_DATA = ${JSON.stringify(data, null, 2)};\n`,
  );
  assert.equal(await readFile(path.join(review, 'data.json'), 'utf8'), dataJson);

  const checked = runValidator();
  assert.equal(checked.status, 0, checked.stderr);
});

test('the untouched template validates and syncs without changing its data source', async () => {
  const before = await readFile(path.join(review, 'data.json'), 'utf8');
  const validated = runValidator();
  assert.equal(validated.status, 0, validated.stderr);
  const synced = runValidator('--sync-data');
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(await readFile(path.join(review, 'data.json'), 'utf8'), before);
});

test('new-review refuses to overwrite an existing target', async () => {
  const output = path.join(workspace, 'created');
  const first = spawnSync(process.execPath, [NEW_REVIEW, output], {encoding: 'utf8'});
  assert.equal(first.status, 0, first.stderr);
  await readFile(path.join(output, 'index.html'));
  const second = spawnSync(process.execPath, [NEW_REVIEW, output], {encoding: 'utf8'});
  assert.equal(second.status, 1);
  assert.match(second.stderr, /目标已存在/);
});
