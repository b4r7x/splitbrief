import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readEvidenceLedger,
  writeEvidenceLedger,
} from '../../../src/core/evidence/ledger-storage.js';
import { captureChangedFilesBaseline } from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { invalidateTargetWriteEvidence } from '../../../src/engine/orchestrator/evidence/persistence.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import {
  recordPromotedFilesEvidence,
  recordedTargetOutput,
} from '../../../src/engine/orchestrator/evidence/task.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import {
  applyTargetBundle,
  blockEvidenceWrites,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  createTargetWriteWorkspace,
  runTargetWriteCheck,
  runTargetWriteGate,
  startEvidenceBlockAfterInvalidation,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

/**
 * A second promoted file, big enough that the promotion is still running when the
 * evidence actor arms: the receipt that follows the promotion is the refused write.
 */
const PROMOTION_WINDOW_FILE = 'src/z-promotion-window.bin';
const PROMOTION_WINDOW_BYTES = 16 * 1024 * 1024;

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('receipt persistence failures', () => {
  it('cannot revive an older receipt when a promoted receipt cannot be saved', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);
    writeFileSync(join(workspace.projectDir, TARGET_WRITE_FILE), 'latest-worker');
    writeFileSync(
      join(workspace.projectDir, PROMOTION_WINDOW_FILE),
      'x'.repeat(PROMOTION_WINDOW_BYTES),
    );
    // The old receipt is intact when production receives control. The actor refuses evidence
    // writes only after production's own invalidation removes that receipt from the ledger,
    // so the write that follows the promotion is the only one that is lost.
    const blocker = startEvidenceBlockAfterInvalidation({
      ref,
      invalidatedSha256: sha256Hex('old-worker'),
    });
    await blocker.ready;

    const gate = await runTargetWriteGate({
      projectDir,
      task,
      workspace,
      taskStartSnapshot: snapshot,
    });
    await blocker.done();
    expect(gate.outcome).toBe('allow');

    // The new output landed and its receipt failed to persist; the invalidated old one never
    // came back, so nothing owns the target.
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('latest-worker');
    expect(
      readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id)?.promotedFiles ?? [],
    ).toEqual([]);

    // Historical bytes restored after the loss remain unowned: the continuation stops on them.
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('does not promote when previous ownership cannot be invalidated', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    writePromotedReceipt({ projectDir, task, content: 'original' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);
    writeFileSync(join(workspace.projectDir, TARGET_WRITE_FILE), 'worker');
    blockEvidenceWrites({ ref, keepReadable: true });

    expect(
      (
        await runTargetWriteGate({
          projectDir,
          task,
          workspace,
          taskStartSnapshot: snapshot,
        })
      ).outcome,
    ).toBe('error');
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('original');
    // The invalidation itself persisted nothing, so the recorded ownership stands.
    expect(recordedTargetOutput(ref, task).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('original'), mode: 0o644 },
    ]);
  });

  it('invalidates direct writer ownership before application while preserving unrelated receipts', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const baseline = await captureChangedFilesBaseline(projectDir);
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    const ledger = readEvidenceLedger(ref);
    if (ledger === null) throw new Error('missing ledger');
    writeEvidenceLedger(
      ref,
      recordPromotedFilesEvidence({
        ledger,
        task,
        files: [{ path: 'src/unrelated.ts', sha256: sha256Hex('unrelated'), mode: 0o644 }],
      }),
    );
    invalidateTargetWriteEvidence({ ref, task });
    await applyTargetBundle({ projectDir, task, content: 'latest-worker' });
    // A process lost the application result before it could persist its receipt.
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
    expect(recordedTargetOutput(ref, task).files.map((file) => file.path)).toEqual([
      'src/unrelated.ts',
    ]);
  });
});
