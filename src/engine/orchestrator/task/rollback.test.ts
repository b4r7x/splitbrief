import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { restoreAttemptFiles } from './rollback.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('restoreAttemptFiles', () => {
  it("restores only the retry attempt's files, over the first attempt's changes", async () => {
    const dir = createTempDir('attempt-rollback');
    dirs.push(dir);
    createTestGitRepo(dir, { 'a.ts': 'export const a = 1;\n' });
    const { bus, events } = makeBusRecorder();

    // The earlier done task T001 changed a.ts and committed it.
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    execSync('git add a.ts && git commit -qm T001', { cwd: dir, stdio: 'pipe' });

    // T002's first attempt changed b.ts; the retry's snapshot sees both.
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
    const attemptSnapshot = await getChangedFilesSnapshot(dir);

    // The retry changed a.ts and c.ts.
    writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n');
    writeFileSync(join(dir, 'c.ts'), 'export const c = 1;\n');

    await restoreAttemptFiles({
      wctx: { projectDir: dir, sessionId: 'attempt-rollback', bus },
      phase: 'escalating',
      attemptSnapshot,
    });

    // a.ts goes back to what it held after T001, c.ts is removed, and the
    // first attempt's b.ts is left as it was.
    expect(readFileSync(join(dir, 'a.ts'), 'utf-8')).toBe('export const a = 2;\n');
    expect(existsSync(join(dir, 'c.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'b.ts'), 'utf-8')).toBe('export const b = 1;\n');
    expect(events.flatMap((event) => (event.type === 'warning' ? [event.message] : []))).toContain(
      'Restored 2 change(s) from the failed attempt: a.ts, c.ts',
    );
  });
});
