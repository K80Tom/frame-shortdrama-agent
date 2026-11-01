export interface ModelSpec {
  id: string;
  imageInput: boolean;
  configuredContextTokens: number | null;
  reasoningEfforts: readonly string[];
  defaultReasoningEffort: string;
  note?: string;
}

// Known legacy text profile. Saved connections may select an exact custom ID;
// unknown models never inherit capability claims from this registry.
export const MODELS: readonly ModelSpec[] = Object.freeze([
  Object.freeze({ id: 'deepseek-v4.1-flash-1017', imageInput: false,
    configuredContextTokens: null, reasoningEfforts: Object.freeze(['model-default']),
    defaultReasoningEffort: 'model-default',
    note: '当前仅接入文本调用；上下文窗口、图片能力及额外推理参数尚未核实。' }),
]);

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find(model => model.id === id);
}

/** Custom IDs are allowed only when explicitly saved as this connection's default. */
export function configuredModel(id: string, configuredId: string): ModelSpec | undefined {
  return findModel(id) ?? (id && id === configuredId ? { id, imageInput: false, configuredContextTokens: null,
    reasoningEfforts: ['model-default'], defaultReasoningEffort: 'model-default',
    note: '用户自定义兼容文本模型；能力与连接可用性未经核实。' } : undefined);
}
