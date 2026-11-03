import {
  EVALUATION_JSONL_SCHEMA_VERSION, EvaluationError, evaluationCaseDigest, evaluationCaseInputDigest,
  parseCreateEvaluationDataset, parseCreateEvaluationRubric, parseEvaluationCase, parseEvaluationDatasetId,
  parseEvaluationRubricId, parseEvaluationRubricRevisionId, parseRubricDimension, type EvaluationCase,
  type EvaluationCatalogKind, type EvaluationDatasetBundle, type EvaluationFieldIssue,
  type EvaluationRubricBundle, type RubricDimension,
} from '@lyra/shared';

/** JSONL 是离线交换格式：首行 manifest，其余为 case 或 dimension 记录。 */

export interface DatasetJsonlManifest {
  schemaVersion: typeof EVALUATION_JSONL_SCHEMA_VERSION;
  type: 'manifest';
  entity: 'dataset';
  datasetId: string;
  kind: EvaluationCatalogKind;
  title: string;
  description: string;
  note: string;
  contentSummary: string;
  slices: string[];
  tags: string[];
  authorization: EvaluationDatasetBundle['revision']['authorization'];
  sensitivity: EvaluationDatasetBundle['revision']['sensitivity'];
  provenance: EvaluationDatasetBundle['revision']['provenance'];
}

export interface DatasetJsonlDocument {
  manifest: DatasetJsonlManifest;
  cases: EvaluationCase[];
  /** caseId → 源文件行号，用于跨目录引用校验回填 line。 */
  caseLines: Record<string, number>;
}

export interface RubricJsonlManifest {
  schemaVersion: typeof EVALUATION_JSONL_SCHEMA_VERSION;
  type: 'manifest';
  entity: 'rubric';
  rubricId: string;
  /** 仅首次导入新量表时使用；已有量表导入会派生新 revision 并重新分配。 */
  revisionId: string | null;
  kind: EvaluationCatalogKind;
  title: string;
  description: string;
  note: string;
  summary: string;
  missingResultPolicy: EvaluationRubricBundle['revision']['missingResultPolicy'];
}

export interface RubricJsonlDocument {
  manifest: RubricJsonlManifest;
  dimensions: RubricDimension[];
}

interface Line {
  line: number;
  value: Record<string, unknown>;
}

const MANIFEST_KEYS = ['type', 'schemaVersion', 'entity', 'datasetId', 'kind', 'title', 'description', 'note',
  'contentSummary', 'slices', 'tags', 'authorization', 'sensitivity', 'provenance'] as const;
const RUBRIC_MANIFEST_KEYS = ['type', 'schemaVersion', 'entity', 'rubricId', 'revisionId', 'kind', 'title',
  'description', 'note', 'summary', 'missingResultPolicy'] as const;

function issue(line: number, path: string, code: string, message: string, caseId?: string): EvaluationFieldIssue {
  return { line, path, code, message, ...(caseId ? { caseId } : {}) };
}

function fail(issues: EvaluationFieldIssue[]): never {
  throw new EvaluationError(400, 'EVALUATION_JSONL_INVALID', 'JSONL 导入校验失败，未写入任何数据。', issues);
}

function readLines(text: string): Line[] {
  const output: Line[] = [];
  text.replace(/\r\n?/gu, '\n').split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail([issue(index + 1, '$', 'EVALUATION_JSONL_LINE_INVALID', '每一行必须是 JSON 对象。')]);
      }
      output.push({ line: index + 1, value: value as Record<string, unknown> });
    } catch (error) {
      if (error instanceof EvaluationError) throw error;
      fail([issue(index + 1, '$', 'EVALUATION_JSONL_LINE_INVALID', 'JSON 解析失败，请检查引号与逗号。')]);
    }
  });
  return output;
}

function expectManifest(lines: Line[], entity: 'dataset' | 'rubric', allowedKeys: readonly string[]): Line {
  if (lines.length === 0) fail([issue(1, 'manifest', 'EVALUATION_JSONL_EMPTY', 'JSONL 为空。')]);
  const first = lines[0]!;
  if (first.value.type !== 'manifest') {
    fail([issue(first.line, 'manifest.type', 'EVALUATION_JSONL_MANIFEST_REQUIRED', '首行必须是 manifest。')]);
  }
  if (first.value.entity !== entity) {
    fail([issue(first.line, 'manifest.entity', 'EVALUATION_JSONL_MANIFEST_REQUIRED', `entity 必须是 ${entity}。`)]);
  }
  for (const key of Object.keys(first.value)) {
    if (!allowedKeys.includes(key)) {
      fail([issue(first.line, `manifest.${key}`, 'EVALUATION_JSONL_UNKNOWN_FIELD', `不支持的字段 ${key}。`)]);
    }
  }
  if (first.value.schemaVersion !== EVALUATION_JSONL_SCHEMA_VERSION) {
    fail([issue(first.line, 'manifest.schemaVersion', 'EVALUATION_JSONL_SCHEMA_MISMATCH',
      `schemaVersion 必须是 ${EVALUATION_JSONL_SCHEMA_VERSION}。`)]);
  }
  return first;
}

function parserIssues(error: unknown, line: number, path: string, caseId?: string): EvaluationFieldIssue[] {
  if (error instanceof EvaluationError) {
    return error.details.length > 0
      ? error.details.map(item => ({ ...item, line, path: item.path || path, ...(caseId ? { caseId } : {}) }))
      : [{ line, path, code: error.code, message: error.message, ...(caseId ? { caseId } : {}) }];
  }
  throw error;
}

export function parseDatasetJsonl(text: string): DatasetJsonlDocument {
  const lines = readLines(text);
  const manifestLine = expectManifest(lines, 'dataset', MANIFEST_KEYS);
  const raw = manifestLine.value;
  const issues: EvaluationFieldIssue[] = [];
  let datasetId = '';
  try {
    datasetId = parseEvaluationDatasetId(String(raw.datasetId ?? ''));
  } catch (error) {
    issues.push(...parserIssues(error, manifestLine.line, 'manifest.datasetId'));
  }
  let manifestBase: ReturnType<typeof parseCreateEvaluationDataset> | null = null;
  try {
    manifestBase = parseCreateEvaluationDataset({
      kind: raw.kind, title: raw.title, description: raw.description, note: raw.note,
      contentSummary: raw.contentSummary, slices: raw.slices, tags: raw.tags,
      authorization: raw.authorization, sensitivity: raw.sensitivity, provenance: raw.provenance, cases: [],
    });
  } catch (error) {
    issues.push(...parserIssues(error, manifestLine.line, 'manifest'));
  }
  const cases: EvaluationCase[] = [];
  const caseLines: Record<string, number> = {};
  for (const item of lines.slice(1)) {
    if (item.value.type === 'manifest') {
      issues.push(issue(item.line, 'manifest.type', 'EVALUATION_JSONL_DUPLICATE_MANIFEST', 'manifest 只能出现一次。'));
      continue;
    }
    if (item.value.type !== 'case') {
      issues.push(issue(item.line, 'type', 'EVALUATION_JSONL_UNKNOWN_RECORD', '只支持 case 记录。'));
      continue;
    }
    const rawCaseId = typeof item.value.caseId === 'string' ? item.value.caseId.slice(0, 64) : undefined;
    const { type: _type, ...caseValue } = item.value;
    if (!manifestBase) continue;
    try {
      const parsed = parseEvaluationCase(caseValue, 'case', manifestBase.kind);
      cases.push(parsed);
      caseLines[parsed.caseId] = item.line;
    } catch (error) {
      issues.push(...parserIssues(error, item.line, 'case', rawCaseId));
    }
  }
  const ids = new Map<string, number>();
  const inputs = new Map<string, EvaluationCase>();
  for (const item of cases) {
    const line = caseLines[item.caseId] ?? 1;
    if (ids.has(item.caseId)) {
      issues.push(issue(line, 'case.caseId', 'EVALUATION_DUPLICATE_CASE_ID', `样例 ID ${item.caseId} 重复。`, item.caseId));
      continue;
    }
    ids.set(item.caseId, line);
    const inputDigest = evaluationCaseInputDigest(item);
    const previous = inputs.get(inputDigest);
    if (previous) {
      const code = evaluationCaseDigest(previous) === evaluationCaseDigest(item)
        ? 'EVALUATION_DUPLICATE_CONTENT' : 'EVALUATION_CASE_CONFLICT';
      const message = code === 'EVALUATION_DUPLICATE_CONTENT'
        ? `样例 ${item.caseId} 与第 ${caseLines[previous.caseId]} 行内容完全重复。`
        : `样例 ${item.caseId} 与第 ${caseLines[previous.caseId]} 行输入相同但期望不同。`;
      issues.push(issue(line, 'case', code, message, item.caseId));
      continue;
    }
    inputs.set(inputDigest, item);
  }
  if (issues.length > 0) fail(issues);
  if (!manifestBase) fail([issue(manifestLine.line, 'manifest', 'EVALUATION_JSONL_MANIFEST_INVALID', 'manifest 无效。')]);
  const manifest: DatasetJsonlManifest = {
    schemaVersion: EVALUATION_JSONL_SCHEMA_VERSION, type: 'manifest', entity: 'dataset',
    datasetId, kind: manifestBase.kind, title: manifestBase.title, description: manifestBase.description,
    note: manifestBase.note, contentSummary: manifestBase.contentSummary, slices: manifestBase.slices,
    tags: manifestBase.tags, authorization: manifestBase.authorization, sensitivity: manifestBase.sensitivity,
    provenance: manifestBase.provenance,
  };
  return { manifest, cases, caseLines };
}

export function parseRubricJsonl(text: string): RubricJsonlDocument {
  const lines = readLines(text);
  const manifestLine = expectManifest(lines, 'rubric', RUBRIC_MANIFEST_KEYS);
  const raw = manifestLine.value;
  const issues: EvaluationFieldIssue[] = [];
  let rubricId = '';
  try {
    rubricId = parseEvaluationRubricId(String(raw.rubricId ?? ''));
  } catch (error) {
    issues.push(...parserIssues(error, manifestLine.line, 'manifest.rubricId'));
  }
  let revisionId: string | null = null;
  if (raw.revisionId !== null && raw.revisionId !== undefined) {
    try {
      revisionId = parseEvaluationRubricRevisionId(String(raw.revisionId));
    } catch (error) {
      issues.push(...parserIssues(error, manifestLine.line, 'manifest.revisionId'));
    }
  }
  let kind: EvaluationCatalogKind | null = null;
  if (raw.kind === 'novel_breakdown' || raw.kind === 'asset_retrieval' || raw.kind === 'shot_review') kind = raw.kind;
  else issues.push(issue(manifestLine.line, 'manifest.kind', 'EVALUATION_INPUT_INVALID', 'kind 不受支持。'));
  const dimensions: RubricDimension[] = [];
  for (const item of lines.slice(1)) {
    if (item.value.type === 'manifest') {
      issues.push(issue(item.line, 'manifest.type', 'EVALUATION_JSONL_DUPLICATE_MANIFEST', 'manifest 只能出现一次。'));
      continue;
    }
    if (item.value.type !== 'dimension') {
      issues.push(issue(item.line, 'type', 'EVALUATION_JSONL_UNKNOWN_RECORD', '只支持 dimension 记录。'));
      continue;
    }
    if (!kind) continue;
    const { type: _type, ...dimensionValue } = item.value;
    try {
      dimensions.push(parseRubricDimension(dimensionValue, 'dimension', kind));
    } catch (error) {
      issues.push(...parserIssues(error, item.line, 'dimension'));
    }
  }
  const keys = new Set<string>();
  for (const dimension of dimensions) {
    if (keys.has(dimension.key)) {
      issues.push(issue(manifestLine.line, 'dimension.key', 'EVALUATION_DUPLICATE_DIMENSION',
        `维度 ${dimension.key} 重复。`));
    }
    keys.add(dimension.key);
  }
  let parsedManifest: ReturnType<typeof parseCreateEvaluationRubric> | null = null;
  if (kind && dimensions.length === 0) {
    issues.push(issue(manifestLine.line, 'dimension', 'EVALUATION_JSONL_EMPTY', '量表 JSONL 必须包含至少一个维度。'));
  } else if (kind) {
    try {
      parsedManifest = parseCreateEvaluationRubric({
        kind, title: raw.title, description: raw.description, note: raw.note, summary: raw.summary,
        missingResultPolicy: raw.missingResultPolicy, dimensions,
      });
    } catch (error) {
      issues.push(...parserIssues(error, manifestLine.line, 'manifest'));
    }
  }
  if (issues.length > 0) fail(issues);
  if (!parsedManifest) fail([issue(manifestLine.line, 'manifest', 'EVALUATION_JSONL_MANIFEST_INVALID', 'manifest 无效。')]);
  const manifest: RubricJsonlManifest = {
    schemaVersion: EVALUATION_JSONL_SCHEMA_VERSION, type: 'manifest', entity: 'rubric', rubricId,
    revisionId, kind: parsedManifest.kind, title: parsedManifest.title, description: parsedManifest.description,
    note: parsedManifest.note, summary: parsedManifest.summary,
    missingResultPolicy: parsedManifest.missingResultPolicy,
  };
  return { manifest, dimensions: parsedManifest.dimensions };
}

function lines(records: unknown[]): string {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

export function serializeDatasetBundle(bundle: EvaluationDatasetBundle,
  dataset: { title: string; description: string },
): { jsonl: string } {
  const manifest: DatasetJsonlManifest = {
    schemaVersion: EVALUATION_JSONL_SCHEMA_VERSION, type: 'manifest', entity: 'dataset',
    datasetId: bundle.revision.datasetId, kind: bundle.revision.kind, title: dataset.title,
    description: dataset.description, note: bundle.revision.note, contentSummary: bundle.revision.contentSummary,
    slices: bundle.revision.slices, tags: bundle.revision.tags, authorization: bundle.revision.authorization,
    sensitivity: bundle.revision.sensitivity, provenance: bundle.revision.provenance,
  };
  const records: unknown[] = [manifest];
  for (const item of [...bundle.cases].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
    records.push({ type: 'case', ...item, contentDigest: evaluationCaseDigest(item) });
  }
  return { jsonl: lines(records) };
}

export function serializeRubricBundle(bundle: EvaluationRubricBundle,
  rubric: { title: string; description: string },
): { jsonl: string } {
  const manifest: RubricJsonlManifest = {
    schemaVersion: EVALUATION_JSONL_SCHEMA_VERSION, type: 'manifest', entity: 'rubric',
    rubricId: bundle.revision.rubricId, kind: bundle.revision.kind, title: rubric.title,
    description: rubric.description, revisionId: bundle.revision.id,
    note: bundle.revision.note, summary: bundle.revision.summary,
    missingResultPolicy: bundle.revision.missingResultPolicy,
  };  const records: unknown[] = [manifest];
  for (const dimension of [...bundle.dimensions].sort((a, b) => a.key.localeCompare(b.key))) {
    records.push({ type: 'dimension', ...dimension });
  }
  return { jsonl: lines(records) };
}
