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
import { createInitialState, transition } from '../../../core/state/machine.js';
import {
  createProcessScope,
  currentProcessScope,
  type ProcessScope,
} from '../../../lib/process/registry.js';
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
      processScope: createProcessScope(),
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

  it("starts the planner turn of a message the composer queues in the run's process scope", async () => {
    const ref = setupProject(dirs);
    let state = transition(createInitialState('scope fixture'), { type: 'START' });
    saveState(ref, state);
    const scope = createProcessScope();
    const injectedIn = Promise.withResolvers<ProcessScope | undefined>();
    const installedHandler: { handler: Parameters<WorkflowSinks['setQueueHandler']>[0] } = {
      handler: null,
    };
    installQueueHandler({
      ...ref,
      processScope: scope,
      steering: createSteeringPort(),
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
      bus: makeBusRecorder().bus,
      config: makeConfig(),
      planner: makePlanner({
        injectUserTurn: async () => {
          injectedIn.resolve(currentProcessScope());
          return { status: 'not-delivered', reason: 'not-ready' };
        },
      }),
    });

    expect(currentProcessScope()).toBeUndefined();
    expect(
      await installedHandler.handler?.(plainUserMessage('Use the old parser'), state.phase),
    ).toMatchObject({ status: 'accepted' });
    expect(await injectedIn.promise).toBe(scope);
  });
});
