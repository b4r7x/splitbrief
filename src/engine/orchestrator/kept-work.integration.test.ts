import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { getChangedFilesSnapshot } from './approval/file-snapshots/capture.js';
import { captureWorkspaceSnapshot } from './isolation/entry-snapshot.js';
import { changedDeclaredFiles, keptBriefFiles } from './kept-work.js';
import { withAttemptRestoreScope } from './task/restore-scope.js';

afterEach(cleanupTaskProjects);

describe('keptBriefFiles', () => {
  it('keeps every file the brief wrote, its own files first, and no change it did not write', async () => {
    const { projectDir, sessionId } = setupProject({
      'src/main.ts': 'export const main = 0;\n',
      'src/extra.ts': 'export const extra = 0;\n',
    });
    const ref = { projectDir, sessionId };
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      suggestedFiles: ['src/main.ts', 'src/extra.ts'],
      scope: { inBounds: ['src/main.ts', 'src/extra.ts'] },
    });
    const taskStart = await captureWorkspaceSnapshot(projectDir, ref);
    await withAttemptRestoreScope({
      ref,
      dir: projectDir,
      taskStartSnapshot: taskStart,
      run: async () => {
        writeFileSync(join(projectDir, 'src/helper.ts'), 'export const helper = 1;\n');
        writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
      },
    });
    writeFileSync(join(projectDir, 'src/extra.ts'), 'export const extra = 2;\n');
    const state = implementingState([task], {
      currentTaskIndex: 0,
      changedFilesBaseline: {
        head: taskStart.head,
        fingerprints: {},
        activeTaskSnapshot: taskStart,
      },
    });

    expect(
      await keptBriefFiles(projectDir, state, { kind: 'brief', taskId: task.id, attempt: 0 }),
    ).toEqual(['src/main.ts', 'src/helper.ts']);
  });
});

describe('changedDeclaredFiles', () => {
  it('gives no list when the brief start cannot be compared with the code', async () => {
    const { projectDir } = setupProject({ 'src/main.ts': 'export const main = 0;\n' });
    const task = makeTask({ suggestedFiles: ['src/main.ts'] });
    const snapshot = {
      ...(await getChangedFilesSnapshot(projectDir)),
      head: '0123456789abcdef0123456789abcdef01234567',
    };
    writeFileSync(join(projectDir, 'src/main.ts'), 'export const main = 1;\n');
    expect(await changedDeclaredFiles(projectDir, task, snapshot)).toBeUndefined();
  });
});
