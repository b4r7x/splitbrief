import { error } from './error.js';

export const timeoutError = {
  elapsed: (ms: number) => error('timeout-elapsed', `Timed out after ${ms}ms`, { ms }),
} as const;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError.elapsed(ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
