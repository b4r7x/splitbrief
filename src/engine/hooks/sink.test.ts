import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeCommandHookEntry } from '#testing/helpers/factories/hook-entry.js';
import { taskId } from '../../core/schemas/task.js';
import { abortError } from '../../utils/abort.js';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../events/workflow-cancel.js';
import * as dispatch from './dispatch.js';
import { createHookSink } from './sink.js';

const taskCompleted: EngineEvent = {
  type: 'task_completed',
  ts: 1,
  phase: 'implementing',
  taskId: taskId('T001'),
  title: 'my task',
  method: 'local',
  retries: 0,
  duration: 100,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createHookSink stop', () => {
  it('publishes no warning for a hook the run stop ended, and reports the next hook', async () => {
    const controller = new AbortController();
    controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    vi.spyOn(dispatch, 'hookTrustRefusal').mockReturnValue(null);
    vi.spyOn(dispatch, 'runTrustedHook').mockImplementation(async (entry) => {
      if (entry.name === 'stopped') throw abortError(controller.signal);
      return { kind: 'warn', message: 'reported' };
    });
    const bus = createEventBus();
    const firstWarning = new Promise<string>((resolve) => {
      bus.subscribe((published) => {
        if (published.type === 'warning') resolve(published.message);
      });
    });
    const hooks = {
      post_task: [
        makeCommandHookEntry({ name: 'stopped' }),
        makeCommandHookEntry({ name: 'next' }),
      ],
    };

    createHookSink(
      hooks,
      () => ({ projectDir: '/tmp', workspaceDir: '/tmp', sessionId: 'sess-1' }),
      bus,
    )(taskCompleted);

    expect(await firstWarning).toBe('[hook post_task next] reported');
  });
});
