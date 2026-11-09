import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';
import { AgentContractError } from '@lyra/shared';

/**
 * ZIP 安全解压（无第三方依赖）。
 *
 * 方法包是用户上传的不可信压缩包：只接受 store/deflate，拒绝加密、ZIP64、
 * 符号链接、可执行权限与路径穿越；解压前先按 central directory 的总大小
 * 预检，inflate 时再用 maxOutputLength 防 zip bomb。
 */

export interface SkillFile {
  path: string;
  bytes: Buffer;
}

const MAX_ENTRIES = 1000;
const MAX_TOTAL_UNCOMPRESSED = 30 * 1024 * 1024;
const MAX_FILE_UNCOMPRESSED = 8 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_DEPTH = 32;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function extractSkillZip(input: Uint8Array): SkillFile[] {
  const archive = Buffer.from(input);
  if (archive.length < 22) throw importError('ZIP 文件过小。');
  const eocd = findEocd(archive);
  if (!eocd) throw importError('ZIP 缺少 End of Central Directory。');

  const diskNumber = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0) throw importError('ZIP 不支持分卷压缩。');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw importError('ZIP64 不受支持。');
  }
  if (entryCount > MAX_ENTRIES) throw importError(`ZIP 条目数超过 ${MAX_ENTRIES}。`);
  if (centralOffset + centralSize > archive.length) throw importError('ZIP central directory 越界。');

  const entries: Array<{
    path: string; method: number; flags: number; compressedSize: number; uncompressedSize: number;
    localOffset: number; externalAttrs: number;
  }> = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw importError('ZIP central directory 损坏。');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const externalAttrs = archive.readUInt32LE(cursor + 38);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw importError('ZIP64 不受支持。');
    }
    if (nameLength === 0 || cursor + 46 + nameLength > archive.length) throw importError('ZIP 条目名损坏。');
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) throw importError('ZIP 不支持加密条目。');
    if (method !== 0 && method !== 8) throw importError(`ZIP 压缩方法不受支持：${method}。`);
    if (uncompressedSize > MAX_FILE_UNCOMPRESSED) throw importError(`ZIP 单文件超过 ${MAX_FILE_UNCOMPRESSED} 字节。`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw importError('ZIP 解压后总大小超过 30MB。');
    if (isSymlink(externalAttrs)) throw importError('ZIP 包含符号链接，已拒绝。');

    const normalized = normalizeZipPath(rawName);
    if (normalized === null) { cursor += 46 + nameLength + extraLength + commentLength; continue; }
    entries.push({ path: normalized, method, flags, compressedSize, uncompressedSize, localOffset, externalAttrs });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor > centralOffset + centralSize) throw importError('ZIP central directory 长度不一致。');

  const seen = new Map<string, string>();
  const files: SkillFile[] = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== undefined) throw importError(`ZIP 存在大小写冲突路径：${existing} / ${entry.path}`);
    seen.set(lower, entry.path);

    const offset = entry.localOffset;
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
      throw importError(`ZIP 本地头损坏：${entry.path}`);
    }
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const localName = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (normalizeZipPath(localName) !== entry.path) throw importError(`ZIP 本地头文件名不一致：${entry.path}`);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > archive.length) throw importError(`ZIP 数据越界：${entry.path}`);

    if (entry.path.endsWith('/')) continue;
    const compressed = archive.subarray(dataStart, dataEnd);
    let bytes: Buffer;
    if (entry.method === 0) {
      if (compressed.length !== entry.uncompressedSize) throw importError(`ZIP store 条目大小不一致：${entry.path}`);
      bytes = Buffer.from(compressed);
    } else {
      try {
        bytes = inflateRawSync(compressed, { maxOutputLength: MAX_FILE_UNCOMPRESSED });
      } catch {
        throw importError(`ZIP 解压失败或超过大小上限：${entry.path}`);
      }
    }
    if (bytes.length !== entry.uncompressedSize) throw importError(`ZIP 解压大小与声明不一致：${entry.path}`);
    files.push({ path: entry.path, bytes });
  }
  if (files.length === 0) throw importError('ZIP 中没有文件。');
  return files;
}

/** 规范化 ZIP 内路径；目录返回 null，危险路径抛错。 */
export function normalizeZipPath(raw: string): string | null {
  let name = raw.normalize('NFC').replace(/\\/g, '/');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw importError('ZIP 路径包含控制字符。');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw importError('ZIP 不允许绝对路径。');
  if (name.length > MAX_PATH_LENGTH) throw importError('ZIP 路径超过 512 个字符。');
  if (name.endsWith('/')) name = name.slice(0, -1);
  const segments = name.split('/');
  if (segments.length > MAX_PATH_DEPTH) throw importError('ZIP 路径超过 32 层。');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw importError('ZIP 路径包含空段或 ..。');
    if (segment.length > 255) throw importError('ZIP 路径单段超过 255 个字符。');
  }
  if (segments[0] === '__MACOSX') return null;
  if (segments[segments.length - 1] === '.DS_Store') return null;
  return segments.join('/');
}

function findEocd(archive: Buffer): number | null {
  const min = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= min; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return null;
}

function isSymlink(externalAttrs: number): boolean {
  const unixMode = (externalAttrs >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function importError(message: string): AgentContractError {
  return new AgentContractError(400, 'SKILL_IMPORT_ZIP_INVALID', message);
}
