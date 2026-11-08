export interface RuntimeSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface WorkerProcessLifetime {
  /** Resolves only after a signal requested shutdown and cleanup completed. */
  readonly done: Promise<void>;
  stop(): Promise<void>;
  isReferenced(): boolean;
}

/**
 * Worker poll timers are deliberately unref'ed so unit tests and embedded mode
 * can close naturally. A worker-only process therefore owns this one explicit,
 * referenced lifetime handle and releases it before running graceful cleanup.
 */
export function startWorkerProcessLifetime(
  shutdown: () => Promise<void>,
  options: { signals?: RuntimeSignalSource; intervalMs?: number } = {},
): WorkerProcessLifetime {
  const signals = options.signals ?? process;
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error('Invalid worker keepalive interval');
  }
  const timer = setInterval(() => undefined, intervalMs);
  let active = true;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  let stopping: Promise<void> | undefined;

  const onSignal = () => { void stop().catch(() => undefined); };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    clearInterval(timer);
    active = false;
    signals.removeListener('SIGINT', onSignal);
    signals.removeListener('SIGTERM', onSignal);
    stopping = shutdown().then(resolveDone, error => { rejectDone(error); throw error; });
    return stopping;
  };

  signals.once('SIGINT', onSignal);
  signals.once('SIGTERM', onSignal);
  return { done, stop, isReferenced: () => active && timer.hasRef() };
}
