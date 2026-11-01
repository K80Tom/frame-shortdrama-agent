/** Rebuildable infrastructure/provider failure: lexical retrieval may degrade. */
export class AssetVectorError extends Error {
  override readonly name = 'AssetVectorError';
}

/** Invalid provider/projection contract: never disguise this as a normal fallback. */
export class AssetVectorContractError extends Error {
  override readonly name = 'AssetVectorContractError';
}

export function isRebuildableVectorDependencyFailure(error: unknown): boolean {
  if (error instanceof AssetVectorError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 4 || code === 5 || code === 14) return true;
  return typeof code === 'string' && [
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'DEADLINE_EXCEEDED', 'UNAVAILABLE',
  ].includes(code);
}
