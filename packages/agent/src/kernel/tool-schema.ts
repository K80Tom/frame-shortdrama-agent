import { AgentContractError, type ToolJsonSchema } from '@lyra/shared';

/**
 * 工具参数 JSON Schema 校验（只支持契约声明过的子集）。
 *
 * 与通用 JSON Schema 实现的差异：默认 additionalProperties=false。
 * 工具参数必须显式声明，避免模型塞入未审计字段或供应商私有参数。
 */

const MAX_DEPTH = 12;
const MAX_VALUE_NODES = 4096;

export interface ValidationOptions {
  /** 以字节计的输入上限；按 UTF-8 编码计算。 */
  maxBytes?: number;
  /** 数组/对象节点上限，防止超大载荷穿过 schema 校验。 */
  maxNodes?: number;
}

interface ValidationState { nodes: number; maxNodes: number }

function fail(path: string, message: string): never {
  throw new AgentContractError(400, 'AGENT_TOOL_INPUT_INVALID', `${path || '参数'}${message}`);
}

function pathOf(base: string, segment: string | number): string {
  if (typeof segment === 'number') return `${base}[${segment}]`;
  return base ? `${base}.${segment}` : segment;
}

export function validateToolArguments(
  schema: ToolJsonSchema, value: unknown, options: ValidationOptions = {},
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentContractError(400, 'AGENT_TOOL_INPUT_INVALID', '工具参数必须是 JSON 对象。');
  }
  if (options.maxBytes !== undefined) {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > options.maxBytes) {
      throw new AgentContractError(400, 'AGENT_TOOL_INPUT_TOO_LARGE', `工具参数不能超过 ${options.maxBytes} 字节。`);
    }
  }
  const state: ValidationState = { nodes: 0, maxNodes: options.maxNodes ?? MAX_VALUE_NODES };
  validateSchemaShape(schema, 'schema', 0);
  validateValue(schema, value, '', state, 0);
  return value as Record<string, unknown>;
}

/** 输出校验只用于契约声明了 outputSchema 的执行结果；失败表示 Adapter 违约。 */
export function validateToolOutput(schema: ToolJsonSchema, value: unknown): void {
  validateSchemaShape(schema, 'outputSchema', 0);
  validateValue(schema, value, '', { nodes: 0, maxNodes: MAX_VALUE_NODES }, 0, 'AGENT_TOOL_OUTPUT_INVALID');
}

function validateSchemaShape(schema: ToolJsonSchema, path: string, depth: number): void {
  if (depth > MAX_DEPTH) throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path} 嵌套过深。`);
  if (!schema || typeof schema !== 'object') throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path} 必须是对象。`);
  if (schema.type === 'object') {
    if (schema.properties !== undefined) {
      if (!schema.properties || typeof schema.properties !== 'object') throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path}.properties 必须是对象。`);
      for (const [name, child] of Object.entries(schema.properties)) {
        if (!name.trim() || name.length > 64) throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path} 的属性名不合法。`);
        validateSchemaShape(child, `${path}.${name}`, depth + 1);
      }
    }
    if (schema.required) {
      const names = new Set(Object.keys(schema.properties ?? {}));
      for (const name of schema.required) {
        if (!names.has(name)) throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path}.required 引用了未声明属性 ${name}。`);
      }
    }
    return;
  }
  if (schema.type === 'array') {
    if (!schema.items) throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path}.items 必须声明。`);
    validateSchemaShape(schema.items, `${path}[]`, depth + 1);
    return;
  }
  if (schema.type === 'string') {
    if (schema.maxLength !== undefined && (schema.maxLength < 1 || schema.maxLength > 65535)) {
      throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path}.maxLength 必须在 1 到 65535 之间。`);
    }
    if (schema.minLength !== undefined && schema.minLength < 0) throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path}.minLength 不能为负。`);
    return;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.maximum !== undefined && schema.minimum !== undefined && schema.maximum < schema.minimum) {
      throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path} 数值范围颠倒。`);
    }
    return;
  }
  if (schema.type === 'boolean') return;
  if (schema.enum && schema.enum.length > 0) return;
  throw new AgentContractError(500, 'AGENT_TOOL_SCHEMA_INVALID', `${path}.type 不受支持。`);
}

function validateValue(
  schema: ToolJsonSchema, value: unknown, path: string, state: ValidationState, depth: number,
  code = 'AGENT_TOOL_INPUT_INVALID',
): void {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    throw new AgentContractError(400, code, `${path || '参数'}包含过多节点。`);
  }
  if (value === null || value === undefined) {
    // 显式 null 只在允许的枚举里通过；工具契约不接受 null 作为缺省。
    if (path === '') fail(path, ' 不能为 null。');
    return;
  }
  if (depth > MAX_DEPTH) fail(path, ' 嵌套过深。');
  if (schema.enum && schema.enum.length > 0 && !schema.enum.includes(value as string | number | boolean)) {
    fail(path, ` 必须是允许的枚举值。`);
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) fail(path, ' 必须是对象。');
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(record, name) || record[name] === undefined || record[name] === null) {
          fail(pathOf(path, name), ' 为必填参数。');
        }
      }
      for (const [name, item] of Object.entries(record)) {
        const child = properties[name];
        if (!child) {
          if (schema.additionalProperties === true) continue;
          fail(pathOf(path, name), ' 不是允许的参数。');
        }
        validateValue(child, item, pathOf(path, name), state, depth + 1, code);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) fail(path, ' 必须是数组。');
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, ` 最多 ${schema.maxItems} 项。`);
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        validateValue(schema.items!, item, pathOf(path, index), state, depth + 1, code);
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') fail(path, ' 必须是字符串。');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, ` 超过最大长度 ${schema.maxLength}。`);
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, ` 少于最小长度 ${schema.minLength}。`);
      return;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, ' 必须是数字。');
      if (schema.type === 'integer' && !Number.isInteger(value)) fail(path, ' 必须是整数。');
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, ` 不能小于 ${schema.minimum}。`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(path, ` 不能大于 ${schema.maximum}。`);
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') fail(path, ' 必须是布尔值。');
      return;
    }
    default:
      if (schema.enum && schema.enum.length > 0) return;
      throw new AgentContractError(500, code, `${path || '参数'} Schema 缺少可校验类型。`);
  }
}

/** 给只读查询工具的稳定输出投影做裁剪，避免观察污染上下文。 */
export function clipObservation(value: unknown, maxChars: number, maxItems = 20): string {
  const project = Array.isArray(value)
    ? value.slice(0, maxItems)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, maxItems))
      : value;
  const text = JSON.stringify(project ?? null);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…（结果过长已截断）`;
}
