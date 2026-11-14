import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  createEvidenceLedger,
  findOrSeed,
  upsertEvidenceTask,
} from '../../../core/evidence/ledger-state.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { restoreInterruptedTaskFiles } from './rollback.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('restoreInterruptedTaskFiles', () => {
  it('restores workspace-only changes and preserves the checkout bytes', async () => {
    const projectDir = createTempDir('rollback-checkout');
    const workspaceDir = createTempDir('rollback-workspace');
    dirs.push(projectDir, workspaceDir);
    for (const dir of [projectDir, workspaceDir]) {
      createTestGitRepo(dir, { 'a.ts': 'export const a = 1;\n' });
    }
    const { bus, events } = makeBusRecorder();
    writeFileSync(join(projectDir, 'operator.txt'), 'checkout edit\n');
    writeFileSync(join(workspaceDir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(workspaceDir, 'b.ts'), 'earlier task\n');
    const taskStartSnapshot = await getChangedFilesSnapshot(workspaceDir);
    writeFileSync(join(workspaceDir, 'a.ts'), 'export const a = 3;\n');
    writeFileSync(join(workspaceDir, 'c.ts'), 'unfinished task\n');
    writeFileSync(join(workspaceDir, 'd.ts'), 'unplanned attempt write\n');
    taskStartSnapshot.restoreFiles = ['a.ts', 'c.ts', 'd.ts'];
    const task = makeTask({ id: 'T002', suggestedFiles: ['a.ts'] });
    const sessionId = 'interrupted-rollback';
    ensureSessionDir(projectDir, sessionId);
    const ref = { projectDir, sessionId };
    const initialLedger = createEvidenceLedger({ sessionId, feature: 'rollback', tasks: [task] });
    const ledger = upsertEvidenceTask(initialLedger, {
      ...findOrSeed(initialLedger, task),
      promotedBriefHash: hashTaskBrief([task]),
      promotedFiles: [
        { path: 'c.ts', sha256: sha256Hex('unfinished task\n'), mode: 0o644, created: true },
      ],
      apiCreatedPaths: ['c.ts'],
    });
    writeEvidenceLedger(ref, ledger);

    await restoreInterruptedTaskFiles({
      wctx: { projectDir, workspaceDir, sessionId, bus },
      phase: 'implementing',
      task,
      taskStartSnapshot,
    });

    expect(readFileSync(join(workspaceDir, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(existsSync(join(workspaceDir, 'c.ts'))).toBe(false);
    expect(existsSync(join(workspaceDir, 'd.ts'))).toBe(false);
    expect(readFileSync(join(workspaceDir, 'b.ts'), 'utf8')).toBe('earlier task\n');
    expect(readFileSync(join(projectDir, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(readFileSync(join(projectDir, 'operator.txt'), 'utf8')).toBe('checkout edit\n');
    expect(existsSync(join(projectDir, 'c.ts'))).toBe(false);
    expect(readEvidenceLedger(ref)).toEqual(ledger);
    expect(existsSync(join(workspaceDir, '.splitbrief'))).toBe(false);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        message: 'Restored 3 unfinished changes from the interrupted T002: a.ts, c.ts, d.ts',
      }),
    ]);
  });
});
