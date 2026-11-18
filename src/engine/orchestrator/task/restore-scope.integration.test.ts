import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeState, setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { WorkflowStateSchema } from '../../../core/schemas/workflow/state.js';
import { statePath } from '../../../core/state/file.js';
import { withLineage } from '../../../core/state/lineage.js';
import { transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { commitWorkflowState } from '../state-ops/commit.js';
import { withAttemptRestoreScope } from './restore-scope.js';

it('keeps an equal-length dispatch and records the attempt writes at the same mtime', async () => {
  const ref = setupProject();
  const dir = ref.projectDir;
  try {
    createTestGitRepo(dir, { 'tracked.txt': 'before\n' });
    const task = makeTask({ id: 'T001', revision: 2 });
    const taskStartSnapshot = { ...(await captureWorkspaceSnapshot(dir, ref)), restoreFiles: [] };
    const state = withLineage(
      makeState({
        stateRevision: 16,
        tasks: [task],
        changedFilesBaseline: {
          head: null,
          fingerprints: {},
          activeTaskSnapshot: taskStartSnapshot,
        },
      }),
      task.id,
      (lineage) => ({
        ...lineage,
        dispatchedRevision: { [task.id]: 1 },
        startSnapshot: taskStartSnapshot,
      }),
    );
    saveState(ref, state);
    const path = statePath(ref);
    const tick = 1_700_000_000;
    utimesSync(path, tick, tick);

    const sentinel = Symbol('attempt result');
    const result = await withAttemptRestoreScope({
      ref,
      dir,
      taskStartSnapshot,
      run: async () => {
        const before = statSync(path, { bigint: true });
        expect(loadState(ref)?.stateRevision).toBe(16);
        const dispatched = transition(state, { type: 'RECORD_DISPATCH', taskId: task.id });
        expect(commitWorkflowState({ ref, expected: state, next: dispatched }).kind).toBe(
          'committed',
        );
        utimesSync(path, tick, tick);
        const after = statSync(path, { bigint: true });
        expect(after.size).toBe(before.size);
        expect(after.mtimeNs).toBe(before.mtimeNs);
        writeFileSync(join(dir, 'tracked.txt'), 'after\n');
        return sentinel;
      },
    });

    expect(result).toBe(sentinel);
    const persisted = WorkflowStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(persisted.stateRevision).toBe(18);
    expect(persisted.lineages?.[task.id]?.dispatchedRevision[task.id]).toBe(2);
    expect(persisted.changedFilesBaseline?.activeTaskSnapshot?.restoreFiles).toEqual([
      'tracked.txt',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});
