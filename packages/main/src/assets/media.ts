import { createHash } from 'node:crypto';
import { AssetError, localAssetUrl, parseAssetMetadata, type AssetRecord } from '@lyra/shared';

export const MAX_ASSET_BYTES = 6 * 1024 * 1024;
export interface AssetMedia { bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; sha256: string }
function invalid(): never { throw new AssetError(400, 'INVALID_ASSET_IMAGE', '请选择完整的 PNG、JPEG 或静态 WebP 图片，最长边不超过 8192 像素、总像素不超过 3200 万。'); }
function dimensions(width: number, height: number) {
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000) invalid();
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bound and inspect raster containers. This is not visual quality or full decoder validation. */
export function inspectAssetImage(bytes: Buffer): AssetMedia['mimeType'] {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
    throw new AssetError(413, 'ASSET_IMAGE_TOO_LARGE', '图片不能为空，且最多为 6 MiB。');
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let position = 8; let data = false; let header = false;
    while (position + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(position);
      const end = position + 12 + length;
      if (end > bytes.length) invalid();
      const type = bytes.toString('ascii', position + 4, position + 8);
      if (!/^[A-Za-z]{4}$/.test(type) || bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(position + 4, end - 4))) invalid();
      if (!header) {
        if (type !== 'IHDR' || length !== 13) invalid();
        dimensions(bytes.readUInt32BE(position + 8), bytes.readUInt32BE(position + 12));
        const depth = bytes[position + 16]!; const color = bytes[position + 17]!;
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[color]?.includes(depth) || bytes[position + 18] !== 0 || bytes[position + 19] !== 0 || bytes[position + 20]! > 1) invalid();
        header = true;
      } else if (type === 'IHDR' || type === 'acTL') invalid();
      if (type === 'IDAT' && length > 0) data = true;
      if (type === 'IEND') {
        if (!data || length !== 0 || end !== bytes.length) invalid();
        return 'image/png';
      }
      position = end;
    }
    return invalid();
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let position = 2; let frame = false; let scan = false;
    while (position < bytes.length) {
      if (bytes[position++] !== 0xff) invalid();
      while (bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === 0xd9) {
        if (!frame || !scan || position !== bytes.length) invalid();
        return 'image/jpeg';
      }
      if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || position + 2 > bytes.length) invalid();
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) invalid();
        dimensions(bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3));
        frame = true;
      }
      position += length;
      if (marker === 0xda) {
        if (!frame) invalid();
        scan = true;
        while (position < bytes.length) {
          if (bytes[position] !== 0xff) { position++; continue; }
          const next = bytes[position + 1];
          if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { position += 2; continue; }
          break;
        }
      }
    }
    return invalid();
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    let position = 12; let imageCount = 0;
    while (position + 8 <= bytes.length) {
      const type = bytes.toString('ascii', position, position + 4);
      const length = bytes.readUInt32LE(position + 4); const start = position + 8;
      const end = start + length + (length % 2);
      if (end > bytes.length || type === 'ANIM' || type === 'ANMF') invalid();
      if (type === 'VP8X') {
        if (length !== 10 || (bytes[start]! & 2)) invalid();
        dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
      } else if (type === 'VP8 ') {
        if (length < 10 || (bytes[start]! & 1) || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) invalid();
        dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff); imageCount++;
      } else if (type === 'VP8L') {
        if (length < 5 || bytes[start] !== 0x2f) invalid();
        const bits = bytes.readUInt32LE(start + 1);
        if (bits >>> 29) invalid();
        dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); imageCount++;
      }
      position = end;
    }
    if (position !== bytes.length || imageCount !== 1) invalid();
    return 'image/webp';
  }
  return invalid();
}

/** 只解析图片字节与摘要，供「重新上传图片」复用同一套格式/大小校验。 */
export function decodeAssetMedia(contentBase64: unknown): AssetMedia {
  if (typeof contentBase64 !== 'string') invalid();
  if (contentBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4) throw new AssetError(413, 'ASSET_IMAGE_TOO_LARGE', '图片最多为 6 MiB。');
  if (contentBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) invalid();
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.toString('base64') !== contentBase64) invalid();
  const mimeType = inspectAssetImage(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, mimeType, sha256 };
}

export function parseAssetMediaReplacement(input: unknown): AssetMedia {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !('contentBase64' in input)) invalid();
  return decodeAssetMedia((input as Record<string, unknown>).contentBase64);
}

export function parseAssetImport(input: unknown): { record: AssetRecord; media: AssetMedia } {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 4 || Object.keys(input).some(key => !['kind', 'name', 'description', 'contentBase64'].includes(key))) invalid();
  const value = input as Record<string, unknown>;
  const metadata = parseAssetMetadata(value);
  if (typeof value.contentBase64 !== 'string') invalid();
  if (value.contentBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4) throw new AssetError(413, 'ASSET_IMAGE_TOO_LARGE', '图片最多为 6 MiB。');
  if (value.contentBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.contentBase64)) invalid();
  const bytes = Buffer.from(value.contentBase64, 'base64');
  if (bytes.toString('base64') !== value.contentBase64) invalid();
  const mimeType = inspectAssetImage(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Exact retries (same bytes and metadata) address the same immutable import.
  const id = `asset_${createHash('sha256').update(JSON.stringify([metadata.kind, metadata.name, metadata.description, sha256])).digest('hex').slice(0, 32)}`;
  return { record: { ...metadata, id, resourceUrl: localAssetUrl(id), createdAt: new Date().toISOString() }, media: { bytes, mimeType, sha256 } };
}
