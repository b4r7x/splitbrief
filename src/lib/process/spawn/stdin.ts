import type { Writable } from 'node:stream';
import { spawnPipeError } from './fatal.js';
import { invokeVoidGuarded, terminate } from './terminate.js';
import type { SpawnRun, SpawnStdinWriter } from './types.js';

function isStdinReaderGone(err: Error): boolean {
  return 'code' in err && (err.code === 'EPIPE' || err.code === 'ENOTCONN');
}

/** True when the child closed before its required prompt was written and ended. */
export function promptIncomplete<T>(run: SpawnRun<T>): boolean {
  const { opts } = run;
  return (
    opts.stdin !== undefined &&
    !opts.stdinOptional &&
    (!run.stdinWriteComplete || (opts.onStdinReady === undefined && !run.stdinEndComplete))
  );
}

export function onStdinError<T>(run: SpawnRun<T>, err: NodeJS.ErrnoException): void {
  const { opts } = run;
  if (opts.onStdinReady !== undefined && run.stdinWriteComplete) return;
  if ((opts.stdin === undefined || opts.stdinOptional) && isStdinReaderGone(err)) return;
  terminate(
    run,
    opts.stdin === undefined
      ? { kind: 'error', error: err }
      : { kind: 'stdin-incomplete', cause: err },
  );
}

export function startStdin<T>(run: SpawnRun<T>, stdin: Writable): void {
  const { opts } = run;
  const writer: SpawnStdinWriter = {
    write: (text) =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        if (run.phase !== 'active' || stdin.destroyed || stdin.writableEnded) {
          rejectWrite(spawnPipeError.stdinClosed());
          return;
        }
        stdin.write(text, (err) => {
          if (err) rejectWrite(err);
          else resolveWrite();
        });
      }),
    end: () => {
      if (stdin.destroyed || stdin.writableEnded) return;
      stdin.end(() => {
        run.stdinEndComplete = true;
      });
    },
  };
  if (opts.stdin === undefined && opts.onStdinReady !== undefined) {
    invokeVoidGuarded(run, () => opts.onStdinReady?.(writer));
    return;
  }
  if (opts.stdin === undefined) {
    stdin.end(() => {
      run.stdinEndComplete = true;
    });
    return;
  }

  stdin.write(opts.stdin, (err) => {
    if (err) {
      if (opts.stdinOptional && isStdinReaderGone(err)) return;
      terminate(run, { kind: 'stdin-incomplete', cause: err });
      return;
    }
    run.stdinWriteComplete = true;
    if (opts.onStdinReady !== undefined) {
      invokeVoidGuarded(run, () => opts.onStdinReady?.(writer));
    }
  });
  if (opts.onStdinReady !== undefined) return;
  stdin.end(() => {
    run.stdinEndComplete = true;
  });
}
