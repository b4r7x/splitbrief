import { abortError, throwIfAborted } from '../../utils/abort.js';

interface SharedProbe<Value> {
  readonly controller: AbortController;
  readonly promise: Promise<Value>;
  subscribers: number;
}

export interface InFlightProbeSharing<Value> {
  share(
    input: Readonly<{
      key: string | undefined;
      signal?: AbortSignal | undefined;
      run: (signal: AbortSignal | undefined) => Promise<Value>;
    }>,
  ): Promise<Value>;
}

function awaitSharedProbe<Value>(
  entry: SharedProbe<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (signal === undefined) return entry.promise;
  const release = new AbortController();
  const cancelled = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(abortError(signal)), {
      once: true,
      signal: release.signal,
    });
  });
  return Promise.race([entry.promise, cancelled]).finally(() => release.abort());
}

/**
 * One read-only probe may serve every caller asking the identical question at
 * the same moment, and nothing else: the key names the observation, never a
 * caller's preparation receipt, and settlement — resolution or rejection —
 * evicts the entry, so the next caller probes afresh instead of inheriting
 * remembered authority. An observation with no shareable identity passes
 * `key: undefined` and always probes alone. Each subscriber cancels only its
 * own wait; the shared work is aborted once the last subscriber has left.
 */
export function createInFlightProbeSharing<Value>(): InFlightProbeSharing<Value> {
  const entries = new Map<string | symbol, SharedProbe<Value>>();

  function start(
    key: string | symbol,
    run: (signal: AbortSignal | undefined) => Promise<Value>,
  ): SharedProbe<Value> {
    const controller = new AbortController();
    const entry: SharedProbe<Value> = {
      controller,
      promise: run(controller.signal),
      subscribers: 0,
    };
    entries.set(key, entry);
    const evict = (): void => {
      if (entries.get(key) === entry) entries.delete(key);
    };
    entry.promise.then(evict, evict);
    return entry;
  }

  return {
    async share(input) {
      const key = input.key ?? Symbol();
      throwIfAborted(input.signal);
      const entry = entries.get(key) ?? start(key, input.run);
      entry.subscribers += 1;
      try {
        return await awaitSharedProbe(entry, input.signal);
      } finally {
        entry.subscribers -= 1;
        if (entry.subscribers === 0 && entries.get(key) === entry) {
          entries.delete(key);
          entry.controller.abort();
        }
      }
    },
  };
}
