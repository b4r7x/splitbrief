import { Text } from 'ink';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
import { readRunEvents } from '../../engine/events/replay.js';
import {
  withContinuationLoop,
  type ContinuationLoopBodyArgs,
} from '../../engine/orchestrator/continuation.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
import { finalizeEndedRun } from '../../engine/orchestrator/session-lifecycle/finalize.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { routerStore } from '../../stores/navigation/router.js';
import { stopStore } from '../../stores/workflow/stop.js';
import {
  clearAllHandlers,
  consumeBoundaryPause,
  requestBoundaryPause,
  requestSteer,
} from './handlers.js';
import { useInputMode } from './hooks/use-input-mode.js';
import { useRunContinue } from './hooks/use-run-continue.js';
import { useRunLoop, type RunWorkflowFn } from './hooks/use-run-loop.js';

function Harness({ prepared, engine }: { prepared: PreparedExecution; engine: RunWorkflowFn }) {
  const inputMode = useInputMode();
  const continuation = useRunContinue({ prepared, inputMode });
  useRunLoop({ prepared, inputMode, continuation, runWorkflow: engine });
  return <Text>{inputMode.mode}</Text>;
}

let projectDir: string;
let mounted: ReturnType<typeof renderFeature> | undefined;
let cleanup: ReturnType<typeof Promise.withResolvers<void>>;
let finish: ReturnType<typeof Promise.withResolvers<void>>;
let settled: ReturnType<typeof Promise.withResolvers<void>>;

beforeEach(() => {
  projectDir = createTempDir('send-now-handlers-');
  cleanup = Promise.withResolvers<void>();
  finish = Promise.withResolvers<void>();
  settled = Promise.withResolvers<void>();
  resetAllStores();
  clearAllHandlers();
});

afterEach(async () => {
  cleanup.resolve();
  finish.resolve();
  mounted?.unmount();
  mounted = undefined;
  await settled.promise;
  clearAllHandlers();
  resetAllStores();
  cleanupTempDir(projectDir);
});

it.each([false, true])(
  'interrupts a live BUILD call and delivers attachments when its park lands, pending pause = %s',
  async (pendingPause) => {
    const ref = { projectDir, sessionId: 'send-now-session' };
    const task = makeTask({ id: 'T001', status: 'in_progress' });
    const state = makeImplState([task]);
    ensureSessionDir(projectDir, ref.sessionId);
    saveState(ref, state);
    const config = makeConfig();
    const prepared = makePreparedExecution({
      ...ref,
      feature: state.feature,
      resumeState: state,
      active: reactivateExistingSession(ref),
      config,
    });
    const calls: ContinuationLoopBodyArgs[] = [];
    const parks: UserMessageInput[] = [];
    const workflowSignals: Array<AbortSignal | undefined> = [];
    const engine: RunWorkflowFn = async (options) => {
      workflowSignals.push(options.signal);
      let finalState = state;
      try {
        if (options.sinks === undefined) throw new Error('Missing run-loop sinks');
        const continued = await withContinuationLoop({
          ctx: {
            ...ref,
            signal: options.signal,
            sinks: options.sinks,
            bus: createRecoveryBus({ ...ref, sink: options.tuiSink }),
            callbacks: {
              ...options.callbacks,
              onContinuationNeeded: async (partial, at) => {
                const message = await options.callbacks.onContinuationNeeded?.(partial, at, []);
                if (message === undefined) throw new Error('Missing continuation callback');
                parks.push(message);
                return message;
              },
            },
          },
          state,
          step: { kind: 'brief', taskId: task.id, attempt: 0 },
          body: async (input) => {
            calls.push(input);
            if (calls.length > 1) {
              await finish.promise;
              return;
            }
            input.recordOutput('Partial BUILD output');
            await new Promise<void>((resolve) => {
              input.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            await cleanup.promise;
            throw input.signal.reason;
          },
        });
        finalState = continued.state;
      } catch (cause) {
        if (!options.signal?.aborted) throw cause;
        const saved = loadState(ref);
        if (saved === null) throw new Error('Missing stopped state');
        finalState = saved;
      } finally {
        settled.resolve();
      }
      return finalizeEndedRun({ ref, active: prepared.session.active, state: finalState });
    };
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref }),
      execution: { kind: 'local', prepared },
    });
    mounted = renderFeature(<Harness prepared={prepared} engine={engine} />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    if (pendingPause) requestBoundaryPause();
    const displayText = 'Keep the greeting API. @/tmp/send-now-note.md';
    const message: UserMessageInput = {
      text: `${displayText}\n\nSEND_NOW_ATTACHMENT_FINAL_LINE`,
      displayText,
      images: [
        {
          id: 'send-now-image',
          kind: 'image',
          path: '/tmp/send-now-image.png',
          mimeType: 'image/png',
          sizeBytes: 123,
        },
      ],
      attachedInputs: [{ path: '/tmp/send-now-note.md', kind: 'text' }],
    };

    expect(requestSteer(message)).toBe(true);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(workflowSignals[0]?.aborted).toBe(false);
    expect(calls).toHaveLength(1);
    expect(parks).toEqual([]);
    cleanup.resolve();
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(parks).toEqual([message]);
    expect(calls[1]?.steerInput).toEqual(message);
    expect(calls[1]?.steer).toContain(message.text);
    expect(calls[1]?.partial).toBe('Partial BUILD output');
    expect(calls[1]?.signal.aborted).toBe(false);
    expect(consumeBoundaryPause()).toBe(false);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', parked: null });
    expect(loadState(ref)).toMatchObject({
      phase: 'implementing',
      tasks: [{ id: 'T001', status: 'in_progress' }],
      awaitingContinue: false,
    });
    expect(
      (await readRunEvents(ref)).events.filter((event) => event.type === 'turn_interrupted'),
    ).toEqual([
      expect.objectContaining({
        phase: 'implementing',
        source: 'user',
        at: 'mid-step',
        step: { kind: 'brief', taskId: 'T001', attempt: 0 },
      }),
    ]);
    finish.resolve();
    await settled.promise;
  },
);
