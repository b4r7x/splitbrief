import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { captureChangedFilesBaseline } from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import { recordedTargetOutput } from '../../../src/engine/orchestrator/evidence/task.js';
import { runImplementation } from '../../../src/engine/orchestrator/task/run-implementation.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeImplementer,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  applyTargetBundle,
  blockEvidenceWrites,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  runTargetWriteCheck,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('direct implementation entry', () => {
  it('runs production invalidation before a direct API call whose new receipt is lost', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn(async () => {
        // The old receipt is already gone when the call is dispatched: production's own
        // invalidation ran before this implementation, not the test on its behalf.
        const entry = readEvidenceLedger(ref)?.tasks.find((candidate) => candidate.id === task.id);
        expect(entry?.promotedFiles ?? []).toEqual([]);
        // From here every receipt write is refused at the filesystem: only the new one is lost.
        blockEvidenceWrites({ ref, keepReadable: true });
        const applyResult = await applyTargetBundle({ projectDir, task, content: 'latest-worker' });
        expect(applyResult.status).toBe('applied');
        return {
          success: true,
          output: 'worker',
          usage: { inputTokens: 1, outputTokens: 1 },
          applyResult,
        };
      }),
    });

    await runImplementation({
      wctx: makeWctx({ projectDir, sessionId: TARGET_WRITE_SESSION_ID, implementer, bus }),
      task,
      state: makeImplState([task]),
      taskStartSnapshot: snapshot,
      setTrackedState: () => {},
      recordApprovalDenial: () => {},
    });

    // The new implementation output was applied; only its receipt failed to persist.
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('latest-worker');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining('failed to persist bundle application evidence'),
      }),
    );
    // Neither the invalidated old receipt nor the lost new one owns the target.
    expect(recordedTargetOutput(ref, task).files).toEqual([]);

    // Historical bytes restored after the loss are unowned, so the continuation stops.
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('does not dispatch a direct call when invalidation cannot persist', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    writePromotedReceipt({ projectDir, task, content: 'original' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const implementer = makeImplementer();
    blockEvidenceWrites({ ref, keepReadable: true });

    await expect(
      runImplementation({
        wctx: makeWctx({ projectDir, sessionId: TARGET_WRITE_SESSION_ID, implementer }),
        task,
        state: makeImplState([task]),
        taskStartSnapshot: snapshot,
        setTrackedState: () => {},
        recordApprovalDenial: () => {},
      }),
    ).rejects.toThrow(/refusing to write through symlink/);
    expect(implementer.implement).not.toHaveBeenCalled();
    // The refusal came before the write, so the recorded ownership is untouched.
    expect(recordedTargetOutput(ref, task).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('original'), mode: 0o644 },
    ]);
  });
});
