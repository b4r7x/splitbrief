import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { readReviewChanges } from '../../../src/core/evidence/review-changes.js';
import { captureChangedFilesBaseline } from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import {
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  createTargetWriteWorkspace,
  runTargetWriteCheck,
  runTargetWriteGate,
  startOperatorReplacementWhenWritten,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writePromotedReceipt,
  writeStoppedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

/**
 * A second promoted file, big enough that the promotion is still running when the
 * operator edits the first, so the edit lands between promotion and the receipt.
 */
const PROMOTION_WINDOW_FILE = 'src/z-promotion-window.bin';
const PROMOTION_WINDOW_BYTES = 16 * 1024 * 1024;

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('target output ownership across stopped runs', () => {
  it('announces an operator edit before any promotion', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'operator');
    const { events } = await runTargetWriteCheck({ projectDir, task, baseline });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      conflict: { kind: 'future-task-stale-input', files: [TARGET_WRITE_FILE] },
    });
    expect(events.some((event) => event.type === 'warning')).toBe(false);
  });

  it('halts when operator bytes replace the latest promotion', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writePromotedReceipt({ projectDir, task, content: 'worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'operator');
    const { result } = await runTargetWriteCheck({ projectDir, task, baseline });
    expect(result.stopped).toBe(true);
  });

  it('halts when an operator restores an old stopped-promotion version', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeStoppedReceipt({ projectDir, task, content: 'old-worker' });
    writePromotedReceipt({ projectDir, task, content: 'latest-worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    const { result, events } = await runTargetWriteCheck({ projectDir, task, baseline });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      conflict: { kind: 'current-task-conflict', files: [TARGET_WRITE_FILE] },
    });
    expect(result.stopped).toBe(true);
  });

  it('records promoted bytes when an operator writes between promotion and receipt recording', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);
    writeFileSync(join(workspace.projectDir, TARGET_WRITE_FILE), 'worker');
    writeFileSync(
      join(workspace.projectDir, PROMOTION_WINDOW_FILE),
      'x'.repeat(PROMOTION_WINDOW_BYTES),
    );
    // The operator edits the target the moment the promoted bytes are visible there —
    // while the second file still holds the promotion open, so the edit lands after the
    // promotion and before the receipt is recorded, a window no await in the test can open.
    const operator = startOperatorReplacementWhenWritten({
      targetPath: join(projectDir, TARGET_WRITE_FILE),
      writtenPrefix: 'worker',
      replacement: 'operator',
    });
    await operator.ready;

    const gate = await runTargetWriteGate({ projectDir, task, workspace, taskStartSnapshot });
    await operator.done();
    expect(gate.outcome).toBe('allow');

    // The receipt owns the promoted bytes, not the operator's later edit.
    const entry = readEvidenceLedger(ref)?.tasks.find((candidate) => candidate.id === task.id);
    expect(entry?.promotedFiles).toContainEqual({
      path: TARGET_WRITE_FILE,
      sha256: sha256Hex('worker'),
      mode: 0o644,
    });
    // The review capture read the operator's bytes, proving the edit landed inside the
    // window instead of after the receipt was already recorded.
    const review = readReviewChanges(ref);
    expect(review?.changes.find((change) => change.path === TARGET_WRITE_FILE)).toMatchObject({
      kind: 'unknown',
      reason: 'output-changed',
    });
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('operator');
  });
});
