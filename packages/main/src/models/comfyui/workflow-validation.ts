import { createHash } from 'node:crypto';
import type { ComfyUiNodeDefinition } from './native-client';

export const MAX_COMFYUI_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 500;
const MAX_INPUTS = 200;

export interface ComfyUiObjectInfoSource {
  getNodeInfo(classType: string): Promise<ComfyUiNodeDefinition>;
}

export interface InvalidComfyUiInput {
  nodeId: string;
  classType: string;
  input: string;
  value: string;
  allowed: string[];
}

export interface ComfyUiWorkflowValidation {
  valid: boolean;
  checkedNodeCount: number;
  missingNodeClasses: string[];
  invalidModelInputs: InvalidComfyUiInput[];
  message: string;
  workflowHash: string;
}

interface ParsedNode {
  id: string;
  classType: string;
  inputs: Record<string, unknown>;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseWorkflow(raw: unknown): { nodes: ParsedNode[]; error: string | null; hash: string } {
  if (!isPlainRecord(raw)) return { nodes: [], error: 'ComfyUI 工作流必须是 API 格式 JSON 对象。', hash: '' };
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8'); }
  catch { return { nodes: [], error: 'ComfyUI 工作流不能包含循环引用。', hash: '' }; }
  if (bytes > MAX_COMFYUI_WORKFLOW_BYTES) {
    return { nodes: [], error: 'ComfyUI 工作流超过 2 MiB 限制。', hash: '' };
  }
  const entries = Object.entries(raw).filter(([key]) => key !== '_meta');
  if (entries.length > MAX_NODES) return { nodes: [], error: 'ComfyUI 工作流节点数超过 500。', hash: '' };
  const nodes: ParsedNode[] = [];
  for (const [id, value] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/u.test(id)) return { nodes: [], error: `ComfyUI 节点 ID 无效：${id.slice(0, 20)}。`, hash: '' };
    if (!isPlainRecord(value)) return { nodes: [], error: `ComfyUI 节点 ${id} 必须是对象。`, hash: '' };
    const classType = value.class_type;
    if (typeof classType !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(classType)) {
      return { nodes: [], error: `ComfyUI 节点 ${id} 缺少有效 class_type。`, hash: '' };
    }
    if (!isPlainRecord(value.inputs)) return { nodes: [], error: `ComfyUI 节点 ${id} 缺少 inputs 对象。`, hash: '' };
    if (Object.keys(value.inputs).length > MAX_INPUTS) {
      return { nodes: [], error: `ComfyUI 节点 ${id} 输入过多。`, hash: '' };
    }
    nodes.push({ id, classType, inputs: value.inputs });
  }
  if (!nodes.length) return { nodes: [], error: 'ComfyUI 工作流没有任何节点。', hash: '' };
  return { nodes, error: null, hash: hashJson(raw) };
}

function allowedValues(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || !Array.isArray(spec[0])) return null;
  const values = spec[0].filter((item): item is string => typeof item === 'string');
  return values.length === spec[0].length ? values : null;
}

function inputValue(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 120);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Validates ComfyUI API-format workflows against the live `/object_info` of a
 * native instance. It only checks structural validity and enumerated model
 * choices; it never submits a workflow or downloads weights.
 */
export class ComfyUiWorkflowValidator {
  private readonly cache = new Map<string, ComfyUiNodeDefinition | null>();

  constructor(private readonly source: ComfyUiObjectInfoSource) {}

  async validate(raw: unknown): Promise<ComfyUiWorkflowValidation> {
    const parsed = parseWorkflow(raw);
    if (parsed.error) {
      return { valid: false, checkedNodeCount: 0, missingNodeClasses: [], invalidModelInputs: [],
        message: parsed.error, workflowHash: parsed.hash };
    }
    const missing = new Set<string>();
    const invalid: InvalidComfyUiInput[] = [];
    let checked = 0;
    for (const node of parsed.nodes) {
      let definition = this.cache.get(node.classType);
      if (definition === undefined) {
        try { definition = await this.source.getNodeInfo(node.classType); }
        catch { definition = null; }
        if (definition) this.cache.set(node.classType, definition);
      }
      if (!definition) { missing.add(node.classType); continue; }
      checked += 1;
      const specs = { ...(definition.input.optional ?? {}), ...(definition.input.required ?? {}) };
      for (const [name, value] of Object.entries(node.inputs)) {
        const spec = specs[name];
        if (spec === undefined) continue; // Unknown inputs may be plugin extension fields.
        const values = allowedValues(spec);
        const actual = inputValue(value);
        if (values && actual !== null && !values.includes(actual)) {
          invalid.push({ nodeId: node.id, classType: node.classType, input: name.slice(0, 80), value: actual,
            allowed: values.slice(0, 20) });
          if (invalid.length >= 100) break;
        }
      }
      if (invalid.length >= 100) break;
    }
    const valid = missing.size === 0 && invalid.length === 0 && checked === parsed.nodes.length;
    const message = valid ? `已校验 ${checked} 个节点与枚举型模型输入。`
      : missing.size ? `缺少 ComfyUI 节点：${[...missing].slice(0, 20).join(', ')}。`
        : `有 ${invalid.length} 个模型输入不在当前 object_info 允许值内。`;
    return { valid, checkedNodeCount: checked, missingNodeClasses: [...missing].slice(0, 20),
      invalidModelInputs: invalid, message, workflowHash: parsed.hash };
  }
}
