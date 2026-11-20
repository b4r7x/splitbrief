import { expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCommandHookEntry } from '#testing/helpers/factories/hook-entry.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeTaskWorkflowContext } from '#testing/helpers/orchestrator-task-context.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { runPreTaskHooksAndPublish } from './start.js';

it('publishes the pre-task denial once on the brief that was skipped', async () => {
  const home = useTrustHome('pre-task-denial');
  try {
    await withTempDir('denied-brief', async (projectDir) => {
      const sessionId = 'denied';
      ensureSessionDir(projectDir, sessionId);
      const hooks = {
        pre_task: [
          makeCommandHookEntry({
            command: 'node',
            args: [
              '-e',
              'console.log(JSON.stringify({decision:"deny",message:"already covered"}))',
            ],
          }),
        ],
      };
      markHooksConfigTrusted(projectDir, hooks);
      const task = makeTask({ id: 'T002' });
      const { bus, events } = makeBusRecorder();
      const wctx = makeTaskWorkflowContext({
        projectDir,
        sessionId,
        bus,
        config: makeConfig({ hooks }),
      });
      await runPreTaskHooksAndPublish({
        wctx,
        task,
        state: makeImplState([task]),
        index: 0,
        totalTasks: 1,
        setTrackedState: () => {},
      });
      expect(events.find((event) => event.type === 'task_skipped')).toMatchObject({
        taskId: task.id,
        reason: 'already covered',
      });
      expect(events.filter((event) => event.type === 'warning')).toEqual([]);
    });
  } finally {
    home.restore();
  }
});
