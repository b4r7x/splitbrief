import { describe, it, expect, afterEach, vi } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getChangedFilesSinceSnapshot, getChangedFilesSnapshot } from './capture.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

// A headless run redirected into the project (`--json > run.ndjson`) keeps
// appending to its own sink during every task window. The sink must never be
// reported as a task-window change: attributing it poisons the evidence
// ledger, which in turn defeats the pre-run-baseline excuse in drift analysis.
vi.mock('../../../../lib/process/stdio-sinks.js', () => ({
  isProcessOutputSink: (path: string) => path.endsWith('run.ndjson'),
}));

let dir: string | undefined;

afterEach(() => {
  if (dir) cleanupTempDir(dir);
  dir = undefined;
});

describe('getChangedFilesSinceSnapshot with a process output sink in the project', () => {
  it('reports implementer changes but never the growing sink file', async () => {
    dir = createTempDir('capture-sinks');
    createTestGitRepo(dir);
    writeFileSync(join(dir, 'run.ndjson'), '{"type":"phase_started"}\n');

    const snapshot = await getChangedFilesSnapshot(dir);
    expect(snapshot.files).toContain('run.ndjson');

    appendFileSync(join(dir, 'run.ndjson'), '{"type":"task_started"}\n');
    writeFileSync(join(dir, 'feature.ts'), 'export const feature = true;\n');

    const changed = await getChangedFilesSinceSnapshot(dir, snapshot);

    expect(changed).toContain('feature.ts');
    expect(changed).not.toContain('run.ndjson');
  });
});
