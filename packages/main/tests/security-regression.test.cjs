const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAndValidateSafeUrl,
  isPublicInternetAddress,
  isNonLocalIntranetAddress,
  detectFileSignature,
  validateMediaBuffer,
  sanitizeSecrets,
  sanitizeError,
  sanitizeObject,
  SecurityGuardError,
} = require('../dist/security');

test('Security URL Guard: SSRF 与内网穿透拦截', async (t) => {
  await t.test('必须拒绝危险协议 (file:, http:, ftp:, javascript:)', () => {
    const dangerousProtocols = [
      'file:///etc/passwd',
      'http://example.com/video.mp4', // 默认仅允许 https:
      'ftp://ftp.example.com/asset.png',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    ];
    for (const url of dangerousProtocols) {
      assert.throws(
        () => parseAndValidateSafeUrl(url),
        (err) => err instanceof SecurityGuardError && (err.code === 'SECURITY_PROTOCOL_FORBIDDEN' || err.code === 'SECURITY_URL_INVALID'),
        `应该拦截协议: ${url}`
      );
    }
  });

  await t.test('必须拒绝带用户名或密码凭证的 URL', () => {
    assert.throws(
      () => parseAndValidateSafeUrl('https://admin:secret123@cdn.example.com/video.mp4'),
      (err) => err instanceof SecurityGuardError && err.code === 'SECURITY_URL_CREDENTIALS_FORBIDDEN'
    );
  });

  await t.test('必须拒绝非 443 敏感端口', () => {
    const dangerousPorts = [
      'https://cdn.example.com:22/video.mp4',
      'https://cdn.example.com:8080/video.mp4',
      'https://cdn.example.com:3306/video.mp4',
      'https://cdn.example.com:6379/video.mp4',
    ];
    for (const url of dangerousPorts) {
      assert.throws(
        () => parseAndValidateSafeUrl(url),
        (err) => err instanceof SecurityGuardError && err.code === 'SECURITY_PORT_FORBIDDEN',
        `应该拦截端口: ${url}`
      );
    }
  });

  await t.test('必须拦截所有本机主机名与保留主机名', () => {
    const localHostnames = [
      'https://localhost/video.mp4',
      'https://api.localhost/video.mp4',
      'https://service.local/video.mp4',
      'https://backend.internal/video.mp4',
      'https://router.lan/video.mp4',
      'https://test.home.arpa/video.mp4',
    ];
    for (const url of localHostnames) {
      assert.throws(
        () => parseAndValidateSafeUrl(url),
        (err) => err instanceof SecurityGuardError && err.code === 'SECURITY_ADDRESS_FORBIDDEN',
        `应该拦截保留域: ${url}`
      );
    }
  });

  await t.test('必须拦截所有私网、回环与云厂商元数据 IP (SSRF 核心)', () => {
    const privateIps = [
      '127.0.0.1',       // Loopback
      '127.0.0.2',
      '10.0.0.1',        // RFC1918 Class A
      '10.254.1.1',
      '172.16.0.1',      // RFC1918 Class B
      '172.31.255.255',
      '192.168.1.1',     // RFC1918 Class C
      '192.168.0.254',
      '169.254.169.254', // AWS / GCP / Azure metadata endpoint!
      '0.0.0.0',         // Current network
      '::1',             // IPv6 Loopback
      'fe80::1',         // IPv6 Link-local
    ];
    for (const ip of privateIps) {
      assert.equal(isPublicInternetAddress(ip), false, `公网校验应拦截: ${ip}`);
      assert.throws(
        () => parseAndValidateSafeUrl(`https://${ip.includes(':') ? `[${ip}]` : ip}/video.mp4`),
        (err) => err instanceof SecurityGuardError && err.code === 'SECURITY_ADDRESS_FORBIDDEN',
        `URL Guard 应拦截: ${ip}`
      );
    }
  });

  await t.test('合规公网 HTTPS 443 URL 正常放行', () => {
    const valid = 'https://cdn.vendor.com/assets/video_123.mp4';
    const parsed = parseAndValidateSafeUrl(valid);
    assert.equal(parsed.hostname, 'cdn.vendor.com');
    assert.equal(parsed.protocol, 'https:');
  });

  await t.test('当显式开启 allowIntranet 时，放行合规企业内网，但仍拦截 loopback 与元数据 IP', () => {
    assert.equal(isNonLocalIntranetAddress('192.168.1.100', 4), true);
    assert.equal(isNonLocalIntranetAddress('10.0.1.5', 4), true);
    // 但必须仍然拦截 127.0.0.1 和 169.254.169.254
    assert.equal(isNonLocalIntranetAddress('127.0.0.1', 4), false);
    assert.equal(isNonLocalIntranetAddress('169.254.169.254', 4), false);
  });
});

test('Security File Guard: 二进制文件签名安检与防欺骗', async (t) => {
  await t.test('识别合法文件的真实二进制魔数', () => {
    // PNG
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    assert.equal(detectFileSignature(pngBuf), 'image/png');

    // JPEG
    const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.equal(detectFileSignature(jpegBuf), 'image/jpeg');

    // WebP
    const webpBuf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    assert.equal(detectFileSignature(webpBuf), 'image/webp');

    // GLB (glTF)
    const glbBuf = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
    assert.equal(detectFileSignature(glbBuf), 'model/gltf-binary');

    // MP4
    const mp4Buf = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    assert.equal(detectFileSignature(mp4Buf), 'video/mp4');
  });

  await t.test('拦截 MIME 欺骗（例如将可执行文件/HTML 伪装成 PNG）', () => {
    const fakePng = Buffer.from('<html><script>alert(1)</script></html>');
    assert.throws(
      () => validateMediaBuffer(fakePng, 'image/png'),
      (err) => err instanceof SecurityGuardError && err.code === 'SECURITY_FILE_SIGNATURE_UNKNOWN'
    );

    const actualJpegDeclaredPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    assert.throws(
      () => validateMediaBuffer(actualJpegDeclaredPng, 'image/png'),
      (err) => err instanceof SecurityGuardError && err.code === 'SECURITY_FILE_MIME_MISMATCH'
    );
  });

  await t.test('超大文件超限拦截 (防炸弹攻击)', () => {
    const smallLimit = 10;
    const buf = Buffer.alloc(20);
    buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
    assert.throws(
      () => validateMediaBuffer(buf, 'image/jpeg', { maxBytes: smallLimit }),
      (err) => err instanceof SecurityGuardError && err.code === 'SECURITY_FILE_TOO_LARGE'
    );
  });
});

test('Security Sanitizer: 凭据与敏感信息清洗脱敏', async (t) => {
  await t.test('清洗常见 API Key 与 Token', () => {
    const raw = 'Error calling OpenAI: api_key=sk-proj-1234567890abcdef1234567890 with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef';
    const sanitized = sanitizeSecrets(raw);
    assert.match(sanitized, /sk-\*\*\*\[REDACTED\]/);
    assert.match(sanitized, /Bearer \*\*\*\[REDACTED\]/);
    assert.doesNotMatch(sanitized, /sk-proj-1234567890abcdef1234567890/);
    assert.doesNotMatch(sanitized, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  });

  await t.test('清洗 URL 中的敏感查询参数', () => {
    const raw = 'https://api.provider.com/v1/generate?apiKey=super_secret_key_123&format=mp4';
    const sanitized = sanitizeSecrets(raw);
    assert.equal(sanitized, 'https://api.provider.com/v1/generate?apiKey=***[REDACTED]&format=mp4');
  });

  await t.test('递归清洗复杂对象中的敏感字段', () => {
    const obj = {
      model: 'seedance-2.0',
      apiKey: 'sk-12345678901234567890',
      nested: {
        authToken: 'token_abc123',
        description: 'normal text',
      },
    };
    const sanitized = sanitizeObject(obj);
    assert.equal(sanitized.apiKey, '***[REDACTED]');
    assert.equal(sanitized.nested.authToken, '***[REDACTED]');
    assert.equal(sanitized.nested.description, 'normal text');
  });

  await t.test('清洗 Error 堆栈中的敏感信息', () => {
    const err = new Error('Failed to connect with token sk-9999999999999999999999');
    const sanitized = sanitizeError(err);
    assert.match(sanitized, /sk-\*\*\*\[REDACTED\]/);
    assert.doesNotMatch(sanitized, /sk-9999999999999999999999/);
  });
});
