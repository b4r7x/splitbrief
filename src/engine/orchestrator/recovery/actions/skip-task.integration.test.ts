import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAttemptBrief } from '#testing/helpers/factories/attempt-brief.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { evidenceLedgerPath } from '../../../../core/evidence/ledger-storage.js';
import { sessionDir, STATE_FILE } from '../../../../core/paths.js';
import type { IsolationStrategy } from '../../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { transition } from '../../../../core/state/machine.js';
import { saveState } from '../../../../core/state/persistence.js';
import type { SessionRef } from '../../../../core/types/session-ref.js';
import { createRunIsolation } from '../../isolation/create.js';
import { captureWorkspaceSnapshot } from '../../isolation/entry-snapshot.js';
import { withAttemptRestoreScope } from '../../task/restore-scope.js';
import { applyRecoveryAction } from './apply.js';

const SESSION_ID = '2026-11-16-skip-moved-project';
const PARTIAL = 'partial.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

/**
 * The BUILD seat of T001 went down after a partial file, as in a real run: the brief started and
 * dispatched, the run kept its attempt, and the halt that it saved offers Skip.
 */
async function seatDownHalt(strategy: IsolationStrategy) {
  const root = createTempDir('skip-moved-project');
  dirs.push(root);
  const projectDir = join(realpathSync(root), 'project');
  mkdirSync(projectDir);
  createTestGitRepo(projectDir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
  const ref = { projectDir, sessionId: SESSION_ID };
  const config = makeConfig();
  const task = makeTask({ id: 'T001', status: 'in_progress' });
  const isolation = createRunIsolation({ ...ref, strategy, onFallback: () => {} });
  const opened = await isolation.open({ config });
  const taskStart = await captureWorkspaceSnapshot(opened.projectDir, ref);
  const attempt = await isolation.acquire({
    role: 'implementer',
    config,
    brief: { ...makeAttemptBrief(), task },
  });
  await withAttemptRestoreScope({
    ref,
    dir: opened.projectDir,
    taskStartSnapshot: taskStart,
    attemptSnapshot: attempt.snapshot,
    run: async () =>
      writeFileSync(join(opened.projectDir, PARTIAL), 'export const partial = true;\n'),
  });
  await attempt.retain?.();
  await isolation.dispose();
  const dispatched = transition(
    makeImplState([task], {
      workspace: {
        kind: opened.kind,
        path: opened.projectDir,
        base: { snapshotId: 'seat-down', head: opened.head },
      },
      changedFilesBaseline: {
        head: null,
        fingerprints: {},
        activeTaskSnapshot: { ...taskStart, restoreFiles: [] },
      },
      pendingRecovery: makeRecoveryIssue({ reason: 'runner-usage-limit', phase: 'implementing' }),
    }),
    { type: 'RECORD_DISPATCH', taskId: task.id },
  );
  // The brief's start names the attempt's write, as the restore scope of an attempt records it.
  const state = {
    ...dispatched,
    changedFilesBaseline: {
      head: null,
      fingerprints: {},
      activeTaskSnapshot: { ...taskStart, restoreFiles: [PARTIAL] },
    },
  };
  saveState(ref, state);
  return { ref, root, state, workspace: opened.projectDir };
}

/** The bytes of the state, the evidence ledger and the workspace record, by their project path. */
function runFiles(ref: SessionRef): Record<string, string | null> {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  return Object.fromEntries(
    [join(dir, STATE_FILE), evidenceLedgerPath(ref), join(dir, 'retained-workspace.json')].map(
      (path) => [
        relative(ref.projectDir, path),
        existsSync(path) ? readFileSync(path, 'utf8') : null,
      ],
    ),
  );
}

function skip(ref: SessionRef, state: WorkflowState) {
  return applyRecoveryAction({
    ...ref,
    state,
    action: 'skip-current-task',
    bus: makeBusRecorder().bus,
  });
}

describe('a recovery Skip after the project folder moved', () => {
  it.each([
    { strategy: 'staged-copy', run: 'a staged-copy run' },
    { strategy: 'worktree', run: 'a worktree run' },
    { strategy: 'none', run: 'an in-place run' },
  ] as const)(
    'refuses $run with the folder that the run started in and writes no file, and the same Skip works after the move back',
    async ({ strategy }) => {
      const { ref, root, state, workspace } = await seatDownHalt(strategy);
      expect(state.lineages?.T001?.startSnapshot).toBeDefined();
      const moved = { ...ref, projectDir: join(root, 'moved') };
      renameSync(ref.projectDir, moved.projectDir);
      const before = runFiles(moved);

      const refused = await skip(moved, state);

      expect(refused).toMatchObject({
        ok: false,
        code: 'isolation-project-moved',
        message: `This run started in ${ref.projectDir}. Move the project back to that folder and start SPLITBRIEF there to continue the run, or end the run.`,
      });
      expect(runFiles(moved)).toEqual(before);

      renameSync(moved.projectDir, ref.projectDir);
      const skipped = await skip(ref, state);

      expect(skipped).toMatchObject({ ok: true, status: 'skipped-current-task' });
      expect(skipped.state.tasks.map((task) => task.status)).toEqual(['skipped']);
      expect(existsSync(join(workspace, PARTIAL))).toBe(false);
    },
  );

  it('stops on a workspace record that cannot be verified before it writes a file or takes a file back', async () => {
    const { ref, state, workspace } = await seatDownHalt('staged-copy');
    writeFileSync(join(sessionDir(ref.projectDir, ref.sessionId), 'retained-workspace.json'), '{');
    const before = runFiles(ref);

    await expect(skip(ref, state)).rejects.toMatchObject({
      kind: 'isolation-retention-unavailable',
    });

    expect(runFiles(ref)).toEqual(before);
    expect(existsSync(join(workspace, PARTIAL))).toBe(true);
  });
});
