import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeAttemptBrief } from '#testing/helpers/factories/attempt-brief.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createRunIsolation } from './create.js';
import { taskId } from '../../../core/schemas/task.js';
import { publishRetainedWorkspaceNotice } from './kept-notice.js';
import { readWorkspaceRecord } from './retention.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('retained workspace of a moved project', () => {
  async function movedRun(sessionId: string) {
    const root = createTempDir('retention-moved');
    dirs.push(root);
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'source.txt'), 'original\n');
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'staged-copy',
      onFallback: () => {},
    });
    const workspace = await isolation.acquire({
      role: 'implementer',
      config: makeConfig(),
      brief: makeAttemptBrief(),
    });
    await workspace.retain?.();
    await isolation.dispose();
    const startedIn = realpathSync(projectDir);
    const movedDir = join(root, 'moved');
    renameSync(projectDir, movedDir);
    return {
      ref: { projectDir: movedDir, sessionId },
      startedIn,
      workspaceDir: workspace.projectDir,
    };
  }

  it('names the folder a run started in when the project folder moved', async () => {
    const { ref, startedIn } = await movedRun('retention-moved-read');

    await expect(readWorkspaceRecord(ref)).rejects.toMatchObject({
      kind: 'isolation-project-moved',
      message: `This run started in ${startedIn}. Move the project back to that folder and start SPLITBRIEF there to continue the run, or end the run.`,
    });
  });

  it('publishes no row for a moved project', async () => {
    const { ref, workspaceDir } = await movedRun('retention-moved-notice');
    const state = makeImplState([], {
      workspace: {
        kind: 'staged-copy',
        path: workspaceDir,
        base: { snapshotId: 'workspace-base', head: null },
      },
      lastFailure: {
        message: 'moved',
        step: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
        at: '2026-10-10T00:00:00.000Z',
      },
    });
    const { bus, events } = makeBusRecorder();

    await expect(publishRetainedWorkspaceNotice({ ...ref, state, bus })).resolves.toBe(false);

    const rows = events.filter((event) => event.type === 'warning' || event.type === 'error');
    expect(rows).toEqual([]);
  });
});
