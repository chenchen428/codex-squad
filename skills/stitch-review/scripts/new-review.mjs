#!/usr/bin/env node
import {cp, lstat, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('../assets/review/', import.meta.url));

async function main() {
  const output = process.argv[2];
  if (!output || output.startsWith('-') || process.argv.length > 3) {
    throw new Error('用法：node new-review.mjs <目录>');
  }
  const target = path.resolve(output);
  try {
    await lstat(target);
    throw new Error('目标已存在；请更新既有审阅页，或选一个新的目录，避免覆盖决定。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(target, {recursive: true});
  await cp(source, target, {recursive: true});
  console.log(`已创建中性演示模板：${path.join(target, 'index.html')}`);
  console.log('替换 data.json 和素材后运行 validate-review.mjs --sync-data；不要把演示图标成实测。');
}

main().catch(error => {
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
