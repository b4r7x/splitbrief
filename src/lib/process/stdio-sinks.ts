import { fstatSync, statSync, type Stats } from 'node:fs';

// When a headless run redirects its own output into the project
// (`splitbrief start --json > run.ndjson 2> run.err`), those files grow with
// the run's own events during every task window. Change detection that
// attributes them to the implementer poisons the evidence ledger, and the
// ledger then defeats the pre-run-baseline excuse in drift analysis — the
// run ends up reporting its own event sink as implementer drift. Identify
// the redirect targets by file identity (dev:ino of fd 1/2) so detection can
// exclude them at the source.

function fileKey(stat: Pick<Stats, 'dev' | 'ino'>): string {
  return `${stat.dev}:${stat.ino}`;
}

export function stdioSinkKeys(fds: readonly number[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const fd of fds) {
    try {
      const stat = fstatSync(fd);
      if (stat.isFile()) keys.add(fileKey(stat));
    } catch {
      // closed or invalid fd: nothing is redirected there
    }
  }
  return keys;
}

export function matchesStdioSink(keys: ReadonlySet<string>, path: string): boolean {
  if (keys.size === 0) return false;
  try {
    return keys.has(fileKey(statSync(path)));
  } catch {
    return false;
  }
}

let cachedKeys: ReadonlySet<string> | undefined;

// Shell redirection fixes the fd targets before the process starts, so the
// keys are computed once per process.
export function isProcessOutputSink(path: string): boolean {
  cachedKeys ??= stdioSinkKeys([1, 2]);
  return matchesStdioSink(cachedKeys, path);
}
