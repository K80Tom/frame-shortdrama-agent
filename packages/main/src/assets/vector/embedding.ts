import { AssetVectorContractError, AssetVectorError } from './errors';

export interface AssetEmbeddingClient {
  embedText(text: string): Promise<number[]>;
}
export type AssetEmbeddingFetch = typeof fetch;

/** OpenAI-compatible multimodal embedding operation used by 短剧Main's Ark adapter. */
export class DoubaoAssetEmbeddingClient implements AssetEmbeddingClient {
  constructor(private readonly options: {
    endpoint: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
  }, private readonly fetchImpl: AssetEmbeddingFetch = fetch) {}

  async embedText(text: string): Promise<number[]> {
    const input = text.trim();
    if (!input) throw new AssetVectorContractError('Embedding input must not be empty');
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.options.model, input: [{ type: 'text', text: input }] }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      throw new AssetVectorError('Asset embedding request failed');
    }
    if (!response.ok) throw new AssetVectorError(`Asset embedding request failed with status ${response.status}`);
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new AssetVectorContractError('Asset embedding response returned invalid JSON'); }
    const vector = extractAssetEmbeddingVector(payload);
    if (!vector.length || vector.length > 16_384 || vector.some(value => !Number.isFinite(value))) {
      throw new AssetVectorContractError('Asset embedding response does not contain a usable vector');
    }
    return vector;
  }
}

export function extractAssetEmbeddingVector(payload: unknown): number[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = (payload as { data?: unknown }).data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const embedding = (data as { embedding?: unknown }).embedding;
    return numericVector(embedding);
  }
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])) {
    const embedding = (data[0] as { embedding?: unknown }).embedding;
    return numericVector(embedding);
  }
  return [];
}

function numericVector(value: unknown): number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number') ? value : [];
}
