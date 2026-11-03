import { SecurityGuardError } from './url-guard';

export type SupportedMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'model/gltf-binary';

export interface FileGuardOptions {
  maxBytes?: number;
  allowedTypes?: readonly SupportedMediaType[];
}

export function detectFileSignature(buffer: Buffer): SupportedMediaType | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: RIFF .... WEBP
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 // RIFF
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) { // WEBP
    return 'image/webp';
  }

  // GLB: 67 6C 54 46 (glTF)
  if (buffer[0] === 0x67 && buffer[1] === 0x6c && buffer[2] === 0x54 && buffer[3] === 0x46) {
    return 'model/gltf-binary';
  }

  // MP4: ....ftyp
  if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return 'video/mp4';
  }

  return null;
}

export function validateMediaBuffer(buffer: Buffer, declaredMime: string, options: FileGuardOptions = {}): {
  mediaType: SupportedMediaType;
  sizeBytes: number;
} {
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024; // 默认 200MB 上限
  const allowedTypes = options.allowedTypes ?? ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'model/gltf-binary'];

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new SecurityGuardError(400, 'SECURITY_FILE_EMPTY', '文件内容为空或格式无效。');
  }

  if (buffer.length > maxBytes) {
    throw new SecurityGuardError(413, 'SECURITY_FILE_TOO_LARGE', `文件体积 (${(buffer.length / (1024 * 1024)).toFixed(1)}MB) 超出安全上限 (${(maxBytes / (1024 * 1024)).toFixed(1)}MB)。`);
  }

  const detected = detectFileSignature(buffer);
  if (!detected) {
    throw new SecurityGuardError(415, 'SECURITY_FILE_SIGNATURE_UNKNOWN', '无法识别文件真实二进制签名（Magic Header），拒绝入库。');
  }

  if (!allowedTypes.includes(detected)) {
    throw new SecurityGuardError(415, 'SECURITY_FILE_TYPE_FORBIDDEN', `检测到不支持的文件类型 ${detected}。`);
  }

  const normalizedDeclared = declaredMime.split(';', 1)[0]!.trim().toLowerCase();
  if (normalizedDeclared !== detected) {
    throw new SecurityGuardError(415, 'SECURITY_FILE_MIME_MISMATCH', `声明的 MIME (${declaredMime}) 与文件真实签名 (${detected}) 不匹配，存在格式欺骗风险。`);
  }

  return { mediaType: detected, sizeBytes: buffer.length };
}
