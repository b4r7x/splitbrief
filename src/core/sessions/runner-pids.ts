import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { rejectSymlinkTarget, writeSecureFile } from '../../lib/fs.js';
import { isENOENT } from '../../lib/process/errors.js';
import { warnStderr } from '../../lib/warn.js';
import { sessionDir } from '../paths.js';
import type { SessionRef } from '../types/session-ref.js';
import { sessionRelativePath } from './ownership-marker.js';

export const RUNNER_PIDS_FILE = 'runner-pids.jsonl';

const RunnerPidEntrySchema = z.object({
  pid: z.number().int().positive(),
  startTimeMs: z.number().finite().nonnegative().nullable(),
});

export type RunnerPidEntry = z.infer<typeof RunnerPidEntrySchema>;

function runnerPidsPath(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), RUNNER_PIDS_FILE);
}

export function readRunnerPids(ref: SessionRef): RunnerPidEntry[] {
  const filePath = runnerPidsPath(ref);
  const label = sessionRelativePath(ref.sessionId, RUNNER_PIDS_FILE);
  try {
    rejectSymlinkTarget(filePath);
  } catch {
    warnStderr(`Warning: skipped ${label}: it is a symbolic link`);
    return [];
  }

  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    // The last release removes the ledger, also while another process reads it.
    if (isENOENT(err)) return [];
    throw err;
  }
  const entries: RunnerPidEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const result = RunnerPidEntrySchema.safeParse(JSON.parse(line));
      if (result.success) {
        entries.push(result.data);
      } else {
        warnStderr(
          `Warning: skipped a line of ${label} that is not valid: ${result.error.message}`,
        );
      }
    } catch (err) {
      warnStderr(`Warning: skipped a line of ${label} that is not valid: ${String(err)}`);
    }
  }
  return entries;
}

function writeRunnerPids(ref: SessionRef, entries: RunnerPidEntry[]): void {
  const filePath = runnerPidsPath(ref);
  if (entries.length === 0) {
    rmSync(filePath, { force: true });
    return;
  }
  writeSecureFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

export function recordRunnerPid(ref: SessionRef, pid: number, startTimeMs: number | null): void {
  const entries = readRunnerPids(ref).filter((entry) => entry.pid !== pid);
  entries.push({ pid, startTimeMs });
  writeRunnerPids(ref, entries);
}

export function releaseRunnerPid(ref: SessionRef, pid: number): void {
  writeRunnerPids(
    ref,
    readRunnerPids(ref).filter((entry) => entry.pid !== pid),
  );
}

function entryKey(entry: RunnerPidEntry): string {
  return `${entry.pid}:${entry.startTimeMs}`;
}

// Re-reads the ledger and writes back only entries that do not match one of
// the reaped pid+startTimeMs pairs, so a pid recorded by a concurrently
// resumed session after the snapshot was taken (e.g. during the orphan
// reaper's SIGKILL grace) survives instead of being wiped by a wholesale clear.
export function releaseRunnerPids(ref: SessionRef, reaped: readonly RunnerPidEntry[]): void {
  const reapedKeys = new Set(reaped.map(entryKey));
  writeRunnerPids(
    ref,
    readRunnerPids(ref).filter((entry) => !reapedKeys.has(entryKey(entry))),
  );
}
