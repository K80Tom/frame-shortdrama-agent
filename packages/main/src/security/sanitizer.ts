const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // OpenAI / standard sk- keys
  { pattern: /\b(sk-[a-zA-Z0-9_\-]{20,})\b/gu, replacement: 'sk-***[REDACTED]' },
  // Bearer tokens
  { pattern: /\bBearer\s+([a-zA-Z0-9_\-\.]{20,})\b/giu, replacement: 'Bearer ***[REDACTED]' },
  // Anthropic api keys
  { pattern: /\b(sk-ant-[a-zA-Z0-9_\-]{20,})\b/gu, replacement: 'sk-ant-***[REDACTED]' },
  // Generic token or api key parameter in query strings: ?key=... or &api_key=... or ?token=...
  { pattern: /([?&](?:api[_-]?key|access[_-]?token|key|token|auth)=)([^&\s]+)/giu, replacement: '$1***[REDACTED]' },
  // Basic auth in URLs: https://user:pass@host
  { pattern: /(https?:\/\/)([^:@\s]+):([^@\s]+)@/giu, replacement: '$1$2:***[REDACTED]@' },
];

export function sanitizeSecrets(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  let sanitized = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

export function sanitizeError(error: unknown): string {
  if (!error) return 'Unknown error';
  let message = '';
  if (error instanceof Error) {
    message = `${error.name}: ${error.message}`;
    if (error.stack) {
      // 抹除堆栈中的敏感路径或 token
      message += `\n${error.stack.split('\n').slice(0, 3).join('\n')}`;
    }
  } else if (typeof error === 'object') {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  } else {
    message = String(error);
  }
  return sanitizeSecrets(message);
}

export function sanitizeObject<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    return sanitizeSecrets(input) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map(item => sanitizeObject(item)) as unknown as T;
  }
  if (typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const lower = key.toLowerCase();
      if (lower.includes('secret') || lower.includes('apikey') || lower.includes('token') || lower.includes('authorization') || lower.includes('password')) {
        output[key] = '***[REDACTED]';
      } else {
        output[key] = sanitizeObject(value);
      }
    }
    return output as T;
  }
  return input;
}
