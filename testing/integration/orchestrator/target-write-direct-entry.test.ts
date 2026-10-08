import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import { recordedTargetOutput } from '../../../src/engine/orchestrator/evidence/task.js';
import { runImplementation } from '../../../src/engine/orchestrator/task/run-implementation.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCopyingIsolation,
  makeBusRecorder,
  makeImplementer,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  applyTargetBundle,
  blockEvidenceWrites,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('isolated implementation entry', () => {
  it('keeps target ownership when a workspace API call loses its new receipt', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn(async ({ projectDir: workspaceDir }) => {
        const entry = readEvidenceLedger(ref)?.tasks.find((candidate) => candidate.id === task.id);
        expect(entry?.promotedFiles).toEqual([
          { path: TARGET_WRITE_FILE, sha256: sha256Hex('old-worker'), mode: 0o644 },
        ]);
        // From here every receipt write is refused at the filesystem: only the new one is lost.
        blockEvidenceWrites({ ref, keepReadable: true });
        const applyResult = await applyTargetBundle({
          projectDir: workspaceDir,
          task,
          content: 'latest-worker',
        });
        expect(applyResult.status).toBe('applied');
        return {
          success: true,
          output: 'worker',
          usage: { inputTokens: 1, outputTokens: 1 },
          applyResult,
        };
      }),
    });

    const result = await runImplementation({
      wctx: makeWctx({
        projectDir,
        sessionId: TARGET_WRITE_SESSION_ID,
        implementer,
        bus,
        isolation: makeCopyingIsolation({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }),
      }),
      task,
      state: makeImplState([task]),
      taskStartSnapshot: snapshot,
      setTrackedState: () => {},
      recordApprovalDenial: () => {},
    });

    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.workspace.projectDir).not.toBe(projectDir);
    expect(readFileSync(join(result.workspace.projectDir, TARGET_WRITE_FILE), 'utf8')).toBe(
      'latest-worker',
    );
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('old-worker');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining('failed to persist bundle application evidence'),
      }),
    );
    expect(recordedTargetOutput(ref, task).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('old-worker'), mode: 0o644 },
    ]);
  });

  it('dispatches a workspace call without invalidating the unchanged target receipt', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    writePromotedReceipt({ projectDir, task, content: 'original' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const implementer = makeImplementer();
    blockEvidenceWrites({ ref, keepReadable: true });

    const result = await runImplementation({
      wctx: makeWctx({
        projectDir,
        sessionId: TARGET_WRITE_SESSION_ID,
        implementer,
        isolation: makeCopyingIsolation({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }),
      }),
      task,
      state: makeImplState([task]),
      taskStartSnapshot: snapshot,
      setTrackedState: () => {},
      recordApprovalDenial: () => {},
    });
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.workspace.projectDir).not.toBe(projectDir);
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('original');
    expect(recordedTargetOutput(ref, task).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('original'), mode: 0o644 },
    ]);
  });
});
