import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createSteeringPort } from '../../calls/steering.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { settleMidCallDeliveries } from '../queue/mid-call.js';
import type { WorkflowSinks } from '../types.js';
import { installQueueHandler } from './install-queue.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('installQueueHandler', () => {
  it('delivers through the installed handler and records the BUILD correction', async () => {
    const ref = setupProject(dirs);
    let state = makeImplState([makeTask({ id: 'T003' })]);
    saveState(ref, state);
    const steering = createSteeringPort();
    const { bus, events } = makeBusRecorder();
    const sent: string[] = [];
    const detach = steering.attach({
      callId: 'build-1',
      role: 'implementer',
      taskId: 'T003',
      send: async ({ text }) => {
        sent.push(text);
        return 'delivered';
      },
    });
    const installedHandler: { handler: Parameters<WorkflowSinks['setQueueHandler']>[0] } = {
      handler: null,
    };
    installQueueHandler({
      ...ref,
      steering,
      sinks: {
        setAbortHandler: () => {},
        setQueueHandler: (installed) => {
          installedHandler.handler = installed;
        },
      },
      getTrackedState: () => state,
      setTrackedState: (next) => {
        state = next;
      },
      bus,
      config: makeConfig(),
      planner: makePlanner(),
    });

    expect(
      await installedHandler.handler?.(plainUserMessage('Keep the public API'), 'implementing'),
    ).toMatchObject({
      status: 'accepted',
    });
    await settleMidCallDeliveries(ref);
    detach();

    expect(sent).toEqual(['Keep the public API']);
    expect(loadState(ref)?.messageQueue[0]).toMatchObject({ deliveredMidCall: true });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'queue_drained',
        seat: 'build',
        taskId: 'T003',
        via: 'mid-call',
        count: 1,
      }),
    );
    expect(loadState(ref)?.lineages?.['T003']?.corrections).toEqual([
      expect.stringContaining('Keep the public API'),
    ]);
  });
});
