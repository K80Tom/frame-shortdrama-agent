import { findModel } from './models/registry';
import type { ModelConnections } from './models/connections';

export interface AppConfig {
  port: number;
  /**
   * 监听地址。本机运行默认回环；容器部署需通过 HOST=0.0.0.0 放开给同网络的其他容器。
   * 未设置时保持 127.0.0.1，不改变本地安全语义。
   */
  host?: string;
  provider: 'maas' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  reasoningEffort: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxConcurrentCalls: number;
  authType?: 'api-key' | 'bearer';
  endpointUrl?: string;
  connectionRevision?: string;
  /** Runtime-only service. Never serialize AppConfig or return it to the browser. */
  modelConnections?: ModelConnections;
  callBudget?: { active: number };
  /**
   * Opt-in: provider-returned media download URLs may resolve to intranet addresses
   * (e.g. a vendor TOS CDN reachable only inside the corporate network). Localhost
   * and link-local hostnames remain blocked regardless of this flag.
   */
  mediaAllowIntranetSources?: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  // Local project editing remains available before a new model account is configured.
  // Never fall back to the removed company proxy when settings are absent.
  let baseUrl = '';
  if (env.LLM_BASE_URL?.trim()) {
    let url: URL;
    try { url = new URL(env.LLM_BASE_URL.trim()); }
    catch { throw new Error('Invalid LLM_BASE_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(env.LLM_BASE_URL.trim())) {
      throw new Error('LLM_BASE_URL must use HTTPS without credentials, query or fragment');
    }
    baseUrl = url.href.replace(/\/$/, '');
  }
  const apiKey = env.LLM_API_KEY?.trim() ?? '';
  if (/[\r\n]/.test(apiKey)) throw new Error('Invalid LLM_API_KEY');
  const defaultModel = env.LLM_DEFAULT_MODEL ?? 'deepseek-v4.1-flash-1017';
  const model = findModel(defaultModel);
  if (!model) throw new Error('Invalid LLM_DEFAULT_MODEL');
  const reasoningEffort = env.LLM_REASONING_EFFORT ?? 'model-default';
  if (!model.reasoningEfforts.includes(reasoningEffort)) {
    throw new Error('LLM_REASONING_EFFORT is unsupported for LLM_DEFAULT_MODEL');
  }
  const port = integer('PORT', 8788, 1024, 65535);
  // Container deployments must bind 0.0.0.0 so sibling containers can reach the API.
  // Unset keeps the loopback-only default; only letters, digits and . : - are accepted.
  const rawHost = env.HOST?.trim();
  if (rawHost !== undefined && !/^[A-Za-z0-9.:-]{1,64}$/.test(rawHost)) {
    throw new Error('Invalid HOST');
  }
  const host = rawHost || undefined;
  const intranetFlag = env.MEDIA_ALLOW_INTRANET_SOURCES;
  if (intranetFlag !== undefined && !['1', 'true', '0', 'false'].includes(intranetFlag.trim().toLowerCase())) {
    throw new Error('Invalid MEDIA_ALLOW_INTRANET_SOURCES');
  }
  return Object.freeze({ port, ...(host ? { host } : {}), provider: 'maas', baseUrl, apiKey, defaultModel, reasoningEffort,
    maxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 8192, 256, 32768),
    timeoutMs: integer('LLM_TIMEOUT_MS', 180000, 1000, 600000),
    maxConcurrentCalls: integer('LLM_MAX_CONCURRENT_CALLS', 2, 1, 8),
    mediaAllowIntranetSources: intranetFlag !== undefined
      && ['1', 'true'].includes(intranetFlag.trim().toLowerCase()) });
}
