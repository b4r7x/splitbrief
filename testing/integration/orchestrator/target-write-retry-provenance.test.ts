import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { captureBundleBaseline } from '../../../src/engine/implementers/bundle-baseline.js';
import { applyFileBundle } from '../../../src/engine/implementers/apply-file-bundle.js';
import { captureChangedFilesBaseline } from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { getChangedFilesSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';
import {
  recordedApiCreatedPaths,
  recordedTargetOutput,
} from '../../../src/engine/orchestrator/evidence/task.js';
import { invalidateTargetWriteEvidence } from '../../../src/engine/orchestrator/evidence/persistence.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  applyTargetBundle,
  blockEvidenceWrites,
  cleanupTargetWriteFixtures,
  createTargetWriteProject,
  createTargetWriteWorkspace,
  freezeDir,
  runTargetWriteCheck,
  runTargetWriteRetry,
  TARGET_WRITE_FILE,
  TARGET_WRITE_SESSION_ID,
  thawDir,
  writeApiReceipt,
  writePromotedReceipt,
} from '#testing/helpers/target-write-fixtures.js';

afterEach(() => {
  cleanupTargetWriteFixtures();
});

describe('retry target provenance', () => {
  it('leaves an operator-settled API target unowned', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const baseline = await captureChangedFilesBaseline(projectDir);
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
    expect((await runTargetWriteCheck({ projectDir, task, baseline })).events).toContainEqual(
      expect.objectContaining({ type: 'paused_external_changes' }),
    );
  });

  it('keeps promotion receipts exact even when the API workspace mode differs', async () => {
    const { projectDir, task: initial } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const task = { ...initial, file: '.gitignore', files: ['.gitignore'] };
    writeFileSync(join(projectDir, '.gitignore'), 'before\n');
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);

    await runTargetWriteRetry({
      projectDir,
      task,
      workspace,
      taskStartSnapshot: snapshot,
      invokeRetry: async ({ projectDir: workerDir }) => {
        const captured = await captureBundleBaseline({ projectDir: workerDir, task });
        if (captured.kind !== 'captured') throw new Error(captured.error);
        const applyResult = await applyFileBundle({
          projectDir: workerDir,
          callId: 'transformed-f3',
          baselines: captured.baselines,
          candidates: [
            {
              path: '.gitignore',
              action: 'modify',
              content: `before\n${SPLITBRIEF_DIR}/\nafter\n`,
            },
          ],
          noops: [],
        });
        chmodSync(join(workerDir, '.gitignore'), 0o664);
        return { success: true, applyResult };
      },
    });

    const target = readFileSync(join(projectDir, '.gitignore'), 'utf8');
    expect(target).toBe('before\nafter\n');
    expect(recordedTargetOutput(ref, task).files).toEqual([
      {
        path: '.gitignore',
        sha256: sha256Hex(target),
        mode: statSync(join(projectDir, '.gitignore')).mode & 0o777,
      },
    ]);
    const apiApply = readEvidenceLedger(ref)?.tasks[0]?.apiApply;
    expect(apiApply?.workspacePath).toBe(workspace.projectDir);
    expect(apiApply?.applied[0]?.afterSha256).not.toBe(sha256Hex(target));
  });

  it('keeps only the exact stopped promotion prefix as target output', async () => {
    const { projectDir, task: initial } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const second = 'src/nested/later.ts';
    const task = { ...initial, files: [TARGET_WRITE_FILE, second] };
    mkdirSync(join(projectDir, 'src', 'nested'), { recursive: true });
    writeFileSync(join(projectDir, second), 'before');
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);

    // The target's nested directory refuses the second promotion write at the filesystem.
    freezeDir(join(projectDir, 'src', 'nested'));
    let outcome: Awaited<ReturnType<typeof runTargetWriteRetry>>;
    try {
      outcome = await runTargetWriteRetry({
        projectDir,
        task,
        workspace,
        taskStartSnapshot: snapshot,
        invokeRetry: async ({ projectDir: workerDir }) => {
          const captured = await captureBundleBaseline({ projectDir: workerDir, task });
          if (captured.kind !== 'captured') throw new Error(captured.error);
          const applyResult = await applyFileBundle({
            projectDir: workerDir,
            callId: 'stopped-f3',
            baselines: captured.baselines,
            candidates: [
              { path: TARGET_WRITE_FILE, action: 'modify', content: 'worker-first' },
              { path: second, action: 'modify', content: 'worker-second' },
            ],
            noops: [],
          });
          return { success: true, applyResult };
        },
      });
    } finally {
      thawDir(join(projectDir, 'src', 'nested'));
    }

    expect(outcome.result?.completed).toBe(false);
    expect(recordedTargetOutput(ref, task).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('worker-first'), mode: 0o644 },
    ]);
    expect(readFileSync(join(projectDir, second), 'utf8')).toBe('before');
    expect(readEvidenceLedger(ref)?.tasks[0]?.apiApply?.workspacePath).toBe(workspace.projectDir);
  });

  it('does not reconstruct a stopped prefix when its target receipt is lost', async () => {
    const { projectDir, task: initial } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const second = 'src/nested/later.ts';
    const task = { ...initial, files: [TARGET_WRITE_FILE, second] };
    mkdirSync(join(projectDir, 'src', 'nested'), { recursive: true });
    writeFileSync(join(projectDir, second), 'before');
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createTargetWriteWorkspace(projectDir);

    freezeDir(join(projectDir, 'src', 'nested'));
    // Every receipt write is refused from here on, so the applied prefix cannot be recorded.
    blockEvidenceWrites({ ref, keepReadable: false });
    let outcome: Awaited<ReturnType<typeof runTargetWriteRetry>>;
    try {
      outcome = await runTargetWriteRetry({
        projectDir,
        task,
        workspace,
        taskStartSnapshot: snapshot,
        invokeRetry: async ({ projectDir: workerDir }) => {
          const captured = await captureBundleBaseline({ projectDir: workerDir, task });
          if (captured.kind !== 'captured') throw new Error(captured.error);
          const applyResult = await applyFileBundle({
            projectDir: workerDir,
            callId: 'unrecorded-prefix-f3',
            baselines: captured.baselines,
            candidates: [
              { path: TARGET_WRITE_FILE, action: 'modify', content: 'worker-first' },
              { path: second, action: 'modify', content: 'worker-second' },
            ],
            noops: [],
          });
          return { success: true, applyResult };
        },
      });
    } finally {
      thawDir(join(projectDir, 'src', 'nested'));
    }

    expect(outcome.result?.completed).toBe(false);
    expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('worker-first');
    expect(recordedTargetOutput(ref, task).files).toEqual([]);
  });

  it('keeps a direct retry receipt through the gate without reconstructing it', async () => {
    const { projectDir, task } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    writePromotedReceipt({ projectDir, task, content: 'old-worker' });
    const snapshot = await getChangedFilesSnapshot(projectDir);
    const direct = {
      projectDir,
      sandboxEnv: {},
      snapshot,
      targetBaseline: undefined,
      cleanup: () => {},
    };

    await runTargetWriteRetry({
      projectDir,
      task,
      workspace: direct,
      taskStartSnapshot: snapshot,
      invokeRetry: async () => ({
        success: true,
        applyResult: await applyTargetBundle({ projectDir, task, content: 'direct-worker' }),
      }),
    });

    expect(recordedTargetOutput(ref, task).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('direct-worker'), mode: 0o644 },
    ]);
    expect(readEvidenceLedger(ref)?.tasks[0]?.apiApply?.workspacePath).toBeUndefined();
  });

  it.each(['success', 'stopped', 'settled', 'lost-receipt'] as const)(
    'retains only proven target creation for an API retry: %s',
    async (scenario) => {
      const { projectDir, task: initial } = createTargetWriteProject();
      const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
      rmSync(join(projectDir, TARGET_WRITE_FILE));
      const second = 'src/nested/z-later.ts';
      mkdirSync(join(projectDir, 'src', 'nested'), { recursive: true });
      writeFileSync(join(projectDir, second), 'before');
      const task = makeTask({ ...initial, action: 'create', files: [TARGET_WRITE_FILE, second] });
      const baseline = await captureChangedFilesBaseline(projectDir);
      const snapshot = await getChangedFilesSnapshot(projectDir);
      const workspace = await createTargetWriteWorkspace(projectDir);
      if (scenario === 'stopped') freezeDir(join(projectDir, 'src', 'nested'));
      if (scenario === 'lost-receipt') blockEvidenceWrites({ ref, keepReadable: false });

      try {
        await runTargetWriteRetry({
          projectDir,
          task,
          workspace,
          taskStartSnapshot: snapshot,
          invokeRetry: async ({ projectDir: workerDir }) => {
            const captured = await captureBundleBaseline({ projectDir: workerDir, task });
            if (captured.kind !== 'captured') throw new Error(captured.error);
            const applyResult = await applyFileBundle({
              projectDir: workerDir,
              callId: 'create-retry-f3',
              baselines: captured.baselines,
              candidates: [
                { path: TARGET_WRITE_FILE, action: 'create', content: 'worker-created' },
                { path: second, action: 'modify', content: 'worker-second' },
              ],
              noops: [],
            });
            if (scenario === 'settled') {
              const workerBytes = readFileSync(join(workerDir, TARGET_WRITE_FILE));
              const workerMode = statSync(join(workerDir, TARGET_WRITE_FILE)).mode & 0o777;
              writeFileSync(join(projectDir, TARGET_WRITE_FILE), workerBytes);
              chmodSync(join(projectDir, TARGET_WRITE_FILE), workerMode);
              expect(readFileSync(join(projectDir, TARGET_WRITE_FILE))).toEqual(workerBytes);
              expect(statSync(join(projectDir, TARGET_WRITE_FILE)).mode & 0o777).toBe(workerMode);
            }
            return { success: true, applyResult };
          },
        });
      } finally {
        if (scenario === 'stopped') thawDir(join(projectDir, 'src', 'nested'));
      }
      expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('worker-created');
      expect(readFileSync(join(projectDir, second), 'utf8')).toBe(
        scenario === 'stopped' ? 'before' : 'worker-second',
      );
      const proven = scenario === 'success' || scenario === 'stopped';
      const createdByThisTask = recordedApiCreatedPaths(ref, task);
      expect(createdByThisTask).toEqual(proven ? [TARGET_WRITE_FILE] : []);
      expect(
        recordedTargetOutput(ref, task).files.some((file) => file.path === TARGET_WRITE_FILE),
      ).toBe(proven);
      const next = await captureBundleBaseline({ projectDir, task, createdByThisTask });
      expect(next.kind).toBe(proven ? 'captured' : 'rejected');
      if (scenario !== 'success' || next.kind !== 'captured') return;
      const modified = await applyFileBundle({
        projectDir,
        callId: 'modify-created-anchor-f3',
        baselines: next.baselines,
        candidates: [{ path: TARGET_WRITE_FILE, action: 'modify', content: 'worker-modified' }],
        noops: [],
      });
      expect(modified.status).toBe('applied');
      writeApiReceipt({ projectDir, task, result: modified });
      expect(readFileSync(join(projectDir, TARGET_WRITE_FILE), 'utf8')).toBe('worker-modified');
      expect(recordedApiCreatedPaths(ref, task)).toEqual([TARGET_WRITE_FILE]);
      expect(
        recordedTargetOutput(ref, task).files.find((file) => file.path === TARGET_WRITE_FILE),
      ).toEqual({
        path: TARGET_WRITE_FILE,
        sha256: sha256Hex('worker-modified'),
        mode: 0o600,
      });
      invalidateTargetWriteEvidence({ ref, task });
      expect(recordedApiCreatedPaths(ref, task)).toEqual([TARGET_WRITE_FILE]);
      expect(recordedTargetOutput(ref, task).files).toEqual([]);
      writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'operator');
      expect((await runTargetWriteCheck({ projectDir, task, baseline })).result.stopped).toBe(true);
    },
  );

  it('keeps ownership when additional current-code context refreshes', async () => {
    const { projectDir, task: initial } = createTargetWriteProject();
    const ref = { projectDir, sessionId: TARGET_WRITE_SESSION_ID };
    const task = {
      ...initial,
      files: [TARGET_WRITE_FILE, 'src/second.ts'],
      currentCodeByFile: { 'src/second.ts': 'before' },
    };
    const baseline = await captureChangedFilesBaseline(projectDir);
    writePromotedReceipt({ projectDir, task, content: 'worker' });
    writeFileSync(join(projectDir, TARGET_WRITE_FILE), 'worker');
    const refreshed = { ...task, currentCodeByFile: { 'src/second.ts': 'after' } };
    expect(recordedTargetOutput(ref, refreshed).files).toEqual([
      { path: TARGET_WRITE_FILE, sha256: sha256Hex('worker'), mode: 0o644 },
    ]);
    expect(
      (await runTargetWriteCheck({ projectDir, task: refreshed, baseline })).result.stopped,
    ).toBe(false);
  });
});
