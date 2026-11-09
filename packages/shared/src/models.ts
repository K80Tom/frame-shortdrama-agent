import { Type, type Static } from '@sinclair/typebox';
import Ajv from 'ajv';
import { brandSharedError, hasSharedErrorBrand } from './error-brand';

const Text = Type.String({ minLength: 1, maxLength: 1000000, pattern: '\\S' });
const ContentPart = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Text }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('image'),
    mediaType: Type.Union([Type.Literal('image/jpeg'), Type.Literal('image/png')]),
    dataBase64: Type.String({ minLength: 1, maxLength: 400000 }) }, { additionalProperties: false }),
]);
const Message = Type.Object({
  role: Type.Union([Type.Literal('system'), Type.Literal('assistant'), Type.Literal('user')]),
  content: Type.Union([Text, Type.Array(ContentPart, { minItems: 1, maxItems: 8 })]),
}, { additionalProperties: false });

export const CallSchema = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  messages: Type.Array(Message, { minItems: 1, maxItems: 100 }),
  reasoningEffort: Type.Optional(Type.Literal('model-default')),
  thinking: Type.Optional(Type.Literal('disabled')),
  jsonOutput: Type.Optional(Type.Literal(true)),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 32768 })),
  allowPaid: Type.Literal(true),
}, { additionalProperties: false });

export type ModelCall = Static<typeof CallSchema>;
export const validateCall = new Ajv({ allErrors: false }).compile<ModelCall>(CallSchema);
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export class ModelError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly details: Record<string, unknown> = {}) {
    super(message);
    brandSharedError(this, 'ModelError');
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return hasSharedErrorBrand(value, 'ModelError');
  }
}

export function parseCall(value: unknown): ModelCall {
  if (!validateCall(value)) throw new ModelError(400, 'INVALID_REQUEST',
    '请求不符合模型调用契约；必须 allowPaid:true，当前只接受文本消息。');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REQUEST_BYTES) {
    throw new ModelError(413, 'INPUT_TOO_LARGE', '请求超过本项目 10 MiB 限制。');
  }
  if (!value.messages.some(message => message.role === 'user')) {
    throw new ModelError(400, 'INVALID_REQUEST', '至少需要一条 user 消息。');
  }
  return value;
}
