import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readEvidenceLedger,
  writeEvidenceLedger,
} from '../../../src/core/evidence/ledger-storage.js';
import { captureChangedFilesBaseline } from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import { recordedTargetOutput } from '../../../src/engine/orchestrator/evidence/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import {
  applyTargetBundle,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  createTargetWriteWorkspace,
  freezeDir,
  runTargetWriteCheck,
  runTargetWriteGate,
  startOperatorReplacementWhenWritten,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  thawDir,
  writeApiReceipt,
  writePromotedReceipt,
  writeStoppedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

/** Marks the direct response's bytes; the operator actor waits for this exact head. */
const CANDIDATE_MARKER = 'direct-response-marker\n';
/** Enough bytes that the verification's hash outlasts the operator's reaction by design. */
const CANDIDATE_BYTES = 32 * 1024 * 1024;

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('current receipt authority', () => {
  it.each([
    'stopped-success',
    'success-stopped',
    'stopped-api',
    'api-stopped',
    'api-success',
    'success-api',
  ])('only the latest writer owns the target after %s', async (order) => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    for (const [index, writer] of order.split('-').entries()) {
      const content = index === 0 ? 'old-worker' : 'latest-worker';
      if (writer === 'api') {
        writeApiReceipt({
          projectDir,
          task,
          result: await applyTargetBundle({ projectDir, task, content }),
        });
      } else {
        writeFileSync(join(projectDir, TARGET_WRITE_FILE), content);
        if (writer === 'stopped') writeStoppedReceipt({ projectDir, task, content });
        else writePromotedReceipt({ projectDir, task, content });
      }
    }
    const own = await runTargetWriteCheck({ projectDir, task, baseline });
    expect(own.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        category: 'user-edit',
        code: 'own_partial_output_kept',
      }),
    );
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    const external = await runTargetWriteCheck({ projectDir, task, baseline });
    expect(external.result.stopped).toBe(true);
    expect(external.events).toContainEqual(
      expect.objectContaining({
        type: 'paused_external_changes',
        conflict: expect.objectContaining({ kind: 'current-task-conflict' }),
      }),
    );
  });

  it('keeps a real stopped promotion prefix as the latest target receipt', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const second = 'src/nested/later.ts';
    // The second target arrives only in the workspace: the target has an empty nested
    // directory that refuses the promotion write the way a full disk does.
    mkdirSync(join(projectDir, 'src', 'nested'), { recursive: true });
    const baseline = await captureChangedFilesBaseline(projectDir);
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);
    writeFileSync(join(workspace.projectDir, TARGET_WRITE_FILE), 'partial-worker');
    mkdirSync(join(workspace.projectDir, 'src', 'nested'), { recursive: true });
    writeFileSync(join(workspace.projectDir, second), 'later');
    freezeDir(join(projectDir, 'src', 'nested'));
    let outcome: Awaited<ReturnType<typeof runTargetWriteGate>>;
    try {
      outcome = await runTargetWriteGate({
        projectDir,
        task,
        workspace,
        taskStartSnapshot: snapshot,
      });
    } finally {
      thawDir(join(projectDir, 'src', 'nested'));
    }
    expect(outcome.outcome).toBe('error');
    expect(
      readEvidenceLedger({ projectDir, sessionId: TARGET_WRITE_SESSION_ID })?.tasks[0]
        ?.promotedFiles,
    ).toEqual([{ path: TARGET_WRITE_FILE, sha256: sha256Hex('partial-worker'), mode: 0o644 }]);
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(false);
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'operator');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('does not replace an exact direct API receipt with later operator bytes at the gate', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const result = await applyTargetBundle({ projectDir, task, content: 'worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'operator');
    writeApiReceipt({ projectDir, task, result });
    expect(
      (
        await runTargetWriteGate({
          projectDir,
          task,
          workspace: undefined,
          taskStartSnapshot: snapshot,
        })
      ).outcome,
    ).toBe('allow');
    expect(
      recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task).files,
    ).toEqual([{ path: TARGET_WRITE_FILE, sha256: sha256Hex('worker'), mode: 0o644 }]);
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('operator');
  });

  it('does not claim a direct API save an operator replaced before verification', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    // The response is large enough that the verification's own hashing is still ahead when
    // the operator overwrites the file the moment the write lands. The read-back then finds
    // neither the response nor the baseline, so no save can be claimed.
    const content = `${CANDIDATE_MARKER}${'x'.repeat(CANDIDATE_BYTES)}`;
    const operator = startOperatorReplacementWhenWritten({
      targetPath: join(projectDir, TARGET_WRITE_FILE),
      writtenPrefix: CANDIDATE_MARKER,
      replacement: 'operator',
    });
    await operator.ready;
    const result = await applyTargetBundle({ projectDir, task, content });
    await operator.done();

    if (result.status !== 'failed') {
      throw new Error(`expected the application to fail verification, got ${result.status}`);
    }
    expect(result.code).toBe('write-uncertain');
    expect(result.failedPath).toBe(TARGET_WRITE_FILE);
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('operator');

    writeApiReceipt({ projectDir, task, result });
    expect(
      recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task).files,
    ).toEqual([]);
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('preserves deletion receipts and rejects a restored historical file', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);
    rmSync(join(workspace.projectDir, TARGET_WRITE_FILE));
    expect(
      (await runTargetWriteGate({ projectDir, task, workspace, taskStartSnapshot: snapshot }))
        .outcome,
    ).toBe('allow');
    expect(
      recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task).files,
    ).toEqual([{ path: TARGET_WRITE_FILE, sha256: null, mode: null }]);
    const own = await runTargetWriteCheck({ projectDir, task, baseline });
    expect(own.events.some((event) => event.type === 'paused_external_changes')).toBe(false);
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('rejects a changed mode even when content matches the receipt', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'worker');
    writePromotedReceipt({ projectDir, task, content: 'worker' });
    chmodSync(join(projectDir, TARGET_WRITE_FILE), 0o755);
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('does not infer a write when the target already holds the staged bytes', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);
    writeFileSync(join(workspace.projectDir, TARGET_WRITE_FILE), 'same');
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'same');
    expect(
      (await runTargetWriteGate({ projectDir, task, workspace, taskStartSnapshot: snapshot }))
        .outcome,
    ).toBe('allow');
    expect(
      recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task).files,
    ).toEqual([]);
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).events).toContainEqual(
      expect.objectContaining({ type: 'paused_external_changes' }),
    );
  });

  it('requires acknowledgement for legacy stopped output without latest-write authority', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writeStoppedReceipt({ projectDir, task, content: 'old-worker' });
    const ledger = readEvidenceLedger({ projectDir, sessionId: TARGET_WRITE_SESSION_ID });
    if (ledger === null) throw new Error('missing ledger');
    writeEvidenceLedger(
      { projectDir, sessionId: TARGET_WRITE_SESSION_ID },
      {
        ...ledger,
        tasks: ledger.tasks.map(
          ({ promotedFiles: _files, promotedBriefHash: _hash, ...entry }) => entry,
        ),
      },
    );
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('does not lend ownership to a revised brief that reuses the task ID', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const baseline = await captureChangedFilesBaseline(projectDir);
    writePromotedReceipt({ projectDir, task, content: 'worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'worker');
    expect(
      (
        await runTargetWriteCheck({
          projectDir,
          task: { ...task, title: 'Revised requirement' },
          baseline,
        })
      ).result.stopped,
    ).toBe(true);
  });

  it("does not revive another task's old receipt after a later task writes the same path", async () => {
    const { projectDir, task } = createTargetWriteProject();
    const nextTask = makeTask({ id: 'T002', status: 'in_progress', file: TARGET_WRITE_FILE });
    const baseline = await captureChangedFilesBaseline(projectDir);
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    writePromotedReceipt({ projectDir, task: nextTask, content: 'latest-worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'old-worker');
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
  });

  it('keeps worker-only API receipts outside target ownership', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const result = await applyTargetBundle({ projectDir, task, content: 'workspace-worker' });
    writeApiReceipt({ projectDir, task, result, workspacePath: '/worker' });
    expect(recordedTargetOutput({ projectDir, sessionId: TARGET_WRITE_SESSION_ID }, task)).toEqual({
      files: [],
      hasOutput: false,
    });
  });
});
