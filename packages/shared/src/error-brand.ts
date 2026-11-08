/**
 * `file:` dependencies may be installed as physical copies in production
 * images. JavaScript prototype identity is local to one copy, so plain
 * `instanceof` cannot recognize a domain error created by another copy of
 * `@lyra/shared`.
 */
type SharedErrorName = 'ModelError' | 'NovelError';

function brand(name: SharedErrorName): symbol {
  return Symbol.for(`@lyra/shared/error/${name}/v1`);
}

export function brandSharedError(error: Error, name: SharedErrorName): void {
  Object.defineProperty(error, brand(name), {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function hasSharedErrorBrand(value: unknown, name: SharedErrorName): boolean {
  if (!(value instanceof Error)) return false;
  const key = brand(name);
  const error = value as Error & {
    status?: unknown;
    code?: unknown;
    details?: unknown;
  } & Record<symbol, unknown>;
  return Object.prototype.hasOwnProperty.call(error, key)
    && error[key] === true
    && Number.isInteger(error.status)
    && Number(error.status) >= 400
    && Number(error.status) <= 599
    && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
    && typeof error.message === 'string'
    && typeof error.details === 'object'
    && error.details !== null
    && !Array.isArray(error.details);
}
