import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LIMITS, IMAGE_EXTENSIONS, IMAGE_MIME } from './constants.mjs';

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

export function readTextFile(file, limit) {
  const stat = fs.statSync(file);
  const max = limit || LIMITS.evidenceBytes;
  if (stat.size > max) {
    const error = new Error(`文件过大：${stat.size} bytes，上限 ${max} bytes`);
    error.code = 'E_FILE_TOO_LARGE';
    throw error;
  }
  return { text: fs.readFileSync(file, 'utf8'), bytes: stat.size };
}

export function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function loadImageFile(file, declaredPath) {
  const stat = fs.statSync(file);
  if (stat.size > LIMITS.imageBytes) {
    const error = new Error(`图片过大：${stat.size} bytes，上限 ${LIMITS.imageBytes} bytes`);
    error.code = 'E_IMAGE_TOO_LARGE';
    throw error;
  }
  const ext = path.extname(declaredPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    const error = new Error(`图片类型不支持（仅 PNG/JPEG/WebP）：${declaredPath}`);
    error.code = 'E_IMAGE_EXTENSION';
    throw error;
  }
  const buffer = fs.readFileSync(file);
  const mime = detectImageMime(buffer);
  if (!mime) {
    const error = new Error(`图片内容不是有效的 PNG/JPEG/WebP：${declaredPath}`);
    error.code = 'E_IMAGE_CONTENT';
    throw error;
  }
  if (mime !== IMAGE_MIME[ext]) {
    const error = new Error(`图片扩展名与内容不一致：${declaredPath}（${mime}）`);
    error.code = 'E_IMAGE_TYPE_MISMATCH';
    throw error;
  }
  return {
    ...imageDimensions(buffer, mime),
    mime,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    dataUri: `data:${mime};base64,${buffer.toString('base64')}`,
    buffer,
  };
}

export function imageDimensions(buffer, mime = detectImageMime(buffer)) {
  if (mime === 'image/png' && buffer.length >= 24) return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
  if (mime === 'image/jpeg') {
    let offset=2;
    while(offset+4<=buffer.length) {
      if(buffer[offset]!==255){offset++;continue;}
      const marker=buffer[offset+1];offset+=2;
      if(marker===0xd9||marker===0xda)break;
      if(marker===0xd8||marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      const length=buffer.readUInt16BE(offset);if(length<2||offset+length>buffer.length)break;
      if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)&&length>=7)return {width:buffer.readUInt16BE(offset+5),height:buffer.readUInt16BE(offset+3)};
      offset+=length;
    }
  }
  if(mime==='image/webp'){
    const kind=buffer.subarray(12,16).toString('ascii');
    if(kind==='VP8X'&&buffer.length>=30)return {width:buffer.readUIntLE(24,3)+1,height:buffer.readUIntLE(27,3)+1};
    if(kind==='VP8L'&&buffer.length>=25&&buffer[20]===0x2f){const bits=buffer.readUInt32LE(21);return {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};}
    if(kind==='VP8 '&&buffer.length>=30&&buffer.subarray(23,26).equals(Buffer.from([0x9d,0x01,0x2a])))return {width:buffer.readUInt16LE(26)&0x3fff,height:buffer.readUInt16LE(28)&0x3fff};
  }
  return {};
}

export function inlineAsset(file, mime) {
  const buffer = fs.readFileSync(file);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
