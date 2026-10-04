import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import { recordedTargetOutput } from '../../../src/engine/orchestrator/evidence/task.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import {
  applyTargetBundle,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  createTargetWriteWorkspace,
  runTargetWriteRetry,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('retry target provenance', () => {
  it('leaves an operator-settled API target unowned', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);

    await runTargetWriteRetry({
      projectDir,
      task,
      workspace,
      taskStartSnapshot: snapshot,
      invokeRetry: async ({ projectDir: workerDir }) => {
        const applyResult = await applyTargetBundle({
          projectDir: workerDir,
          task,
          content: 'operator-and-worker-same',
        });
        writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'operator-and-worker-same');
        return { success: true, applyResult };
      },
    });

    // The target is the operator's: an identical staged entry settles the promotion without
    // rewriting the file, and nothing records it as this task's own output.
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe(
      'operator-and-worker-same',
    );
    expect(recordedTargetOutput(ref, task).files).toEqual([]);
    expect(readEvidenceLedger(ref)?.tasks[0]?.apiApply?.workspacePath).toBe(workspace.projectDir);
  });

  it('keeps ownership when additional current-code context refreshes', async () => {
    const { projectDir, task: initial } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const task = {
      ...initial,
      files: [TARGET_WRITE_FILE, 'src/second.ts'],
      currentCodeByFile: { 'src/second.ts': 'before' },
    };
    writePromotedReceipt({ projectDir, task, content: 'worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'worker');
    const refreshed = { ...task, currentCodeByFile: { 'src/second.ts': 'after' } };
    expect(recordedTargetOutput(ref, refreshed).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('worker'), mode: 0o644 },
    ]);
  });
});
