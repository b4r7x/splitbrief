import { describe, expect, it, vi } from 'vitest';
import type { RecoveryProviderRequest } from '../../../core/schemas/brief-recovery/provider-call.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';
import { createInitialState } from '../../../core/state/machine.js';
import { createEventBus } from '../../events/bus.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import {
  createBriefRecoveryProvider,
  type BriefRecoveryCallEvent,
} from './brief-recovery-provider.js';
import { runPlannerReview } from '../planner-review.js';

const request: RecoveryProviderRequest = {
  sessionId: 'session-1',
  epochId: 'epoch-1',
  operationId: 'operation-1',
  requestId: 'request-1',
  prompt: 'repair the brief',
  projectDir: '/tmp/project',
};

const callContext: RunnerCallContext = {
  callId: 'call-1',
  role: 'review',
  backendKind: 'api',
  runnerName: 'fixture-runner',
  model: 'fixture-model',
  attempt: 1,
};

function started(): RunnerCallEvent {
  return { type: 'call_started', ts: 1, ...callContext };
}

function usage(): RunnerCallEvent {
  return {
    type: 'call_usage',
    ts: 2,
    ...callContext,
    usage: { inputTokens: 7, outputTokens: 3 },
    semantics: 'final',
  };
}

function completed(): RunnerCallEvent {
  return {
    type: 'call_completed',
    ts: 3,
    ...callContext,
    status: 'completed',
    error: null,
    startedAt: 1,
    endedAt: 3,
    durationMs: 2,
    partial: false,
    usage: { inputTokens: 7, outputTokens: 3 },
    nativeSessionId: null,
  };
}

function failed(): RunnerCallEvent {
  return {
    type: 'call_error',
    ts: 3,
    ...callContext,
    status: 'failed',
    error: { code: 'provider_rejected', message: 'provider rejected the request' },
    startedAt: 1,
    endedAt: 3,
    durationMs: 2,
    partial: false,
    usage: { inputTokens: 4, outputTokens: 1 },
    nativeSessionId: null,
  };
}

describe('createBriefRecoveryProvider', () => {
  it('returns a completed result with operation-bound normalized events and usage', async () => {
    const events: BriefRecoveryCallEvent[] = [];
    const planner = makePlanner({
      review: vi.fn(async (_prompt, _projectDir, callbacks) => {
        callbacks.onCallEvent?.(started());
        callbacks.onCallEvent?.(usage());
        callbacks.onCallEvent?.(completed());
        return { text: 'repaired brief', usage: null };
      }),
    });
    const provider = createBriefRecoveryProvider({
      planner,
      onCallEvent: (event) => events.push(event),
    });

    const result = await provider.dispatch(request);

    expect(result).toMatchObject({
      kind: 'completed',
      requestId: 'request-1',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      text: 'repaired brief',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, estimated: false },
    });
    expect(events[0]).toMatchObject({
      type: 'call_started',
      callId: 'call-1',
      sessionId: 'session-1',
      epochId: 'epoch-1',
      operationId: 'operation-1',
      requestId: 'request-1',
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])(
    'marks %s planner usage as unknown instead of zero-cost usage',
    async (_label, inputTokens) => {
      const planner = makePlanner({
        review: vi.fn().mockResolvedValue({
          text: 'repaired brief',
          usage: { inputTokens, outputTokens: 3 },
        }),
      });
      const provider = createBriefRecoveryProvider({ planner });

      const result = await provider.dispatch(request);

      expect(result).toMatchObject({
        kind: 'completed',
        text: 'repaired brief',
        usage: null,
      });
    },
  );

  it('marks malformed runner-event usage as unknown even after a valid sample', async () => {
    const planner = makePlanner({
      review: vi.fn(async (_prompt, _projectDir, callbacks) => {
        callbacks.onCallEvent?.(usage());
        callbacks.onCallEvent?.({
          ...completed(),
          usage: { inputTokens: Number.NaN, outputTokens: 3 },
        } as unknown as RunnerCallEvent);
        return { text: 'repaired brief', usage: null };
      }),
    });
    const provider = createBriefRecoveryProvider({ planner });

    const result = await provider.dispatch(request);

    expect(result).toMatchObject({ kind: 'completed', usage: null });
  });

  it('does not let malformed planner usage fall back to an earlier valid event sample', async () => {
    const planner = makePlanner({
      review: vi.fn(async (_prompt, _projectDir, callbacks) => {
        callbacks.onCallEvent?.(usage());
        return {
          text: 'repaired brief',
          usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 3 },
        };
      }),
    });
    const provider = createBriefRecoveryProvider({ planner });

    const result = await provider.dispatch(request);

    expect(result).toMatchObject({ kind: 'completed', usage: null });
  });

  it('classifies a rejection before the dispatch fence as definite and not-dispatched', async () => {
    const planner = makePlanner({
      review: vi.fn().mockRejectedValue(new Error('preflight failed')),
    });
    const provider = createBriefRecoveryProvider({ planner });

    const result = await provider.dispatch(request);

    expect(result).toMatchObject({
      kind: 'definite-failure',
      dispatchPossibility: 'none',
      remoteObservation: 'not-dispatched',
      text: null,
    });
  });

  it('classifies a provider terminal failure after the fence as confirmed-final', async () => {
    const planner = makePlanner({
      review: vi.fn(async (_prompt, _projectDir, callbacks) => {
        callbacks.onCallEvent?.(started());
        callbacks.onCallEvent?.(failed());
        throw new Error('review failed');
      }),
    });
    const provider = createBriefRecoveryProvider({ planner });

    const result = await provider.dispatch(request);

    expect(result).toMatchObject({
      kind: 'definite-failure',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      providerCode: 'provider_rejected',
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, estimated: false },
    });
  });

  it('classifies an abort after the fence as ambiguous without retrying', async () => {
    const controller = new AbortController();
    const planner = makePlanner({
      review: vi.fn((_prompt, _projectDir, callbacks) => {
        callbacks.onCallEvent?.(started());
        return new Promise<{ text: string; usage: null }>(() => {});
      }),
    });
    const provider = createBriefRecoveryProvider({ planner });

    const pending = provider.dispatch({ ...request, signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({
      kind: 'ambiguous-failure',
      dispatchPossibility: 'possible',
      remoteObservation: 'unknown',
      providerCode: 'aborted',
    });
    expect(planner.review).toHaveBeenCalledTimes(1);
  });

  it('refuses a duplicate operation without a second planner invocation', async () => {
    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }) });
    const provider = createBriefRecoveryProvider({ planner });

    const first = await provider.dispatch(request);
    const duplicate = await provider.dispatch({ ...request, requestId: 'request-2' });

    expect(first.kind).toBe('completed');
    expect(duplicate).toMatchObject({
      kind: 'definite-failure',
      providerCode: 'duplicate-operation',
      dispatchPossibility: 'none',
      remoteObservation: 'not-dispatched',
    });
    expect(planner.review).toHaveBeenCalledTimes(1);
  });
});

describe('runPlannerReview recovery option', () => {
  it('delegates to the explicit provider and keeps workflow state untouched', async () => {
    const planner = makePlanner();
    const dispatch = vi.fn().mockResolvedValue({
      kind: 'completed',
      requestId: 'request-1',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      text: 'recovered',
      providerCode: null,
      usage: null,
    });
    const state = createInitialState('feature');

    const result = await runPlannerReview({
      planner,
      prompt: 'repair the brief',
      projectDir: '/tmp/project',
      sessionId: 'session-1',
      bus: createEventBus(),
      state,
      briefRecovery: {
        epochId: 'epoch-1',
        operationId: 'operation-1',
        requestId: 'request-1',
        provider: { dispatch },
      },
    });

    expect(result).toMatchObject({ text: 'recovered', recovery: { kind: 'completed' } });
    expect(result.state).toBe(state);
    expect(dispatch).toHaveBeenCalledWith({
      sessionId: 'session-1',
      epochId: 'epoch-1',
      operationId: 'operation-1',
      requestId: 'request-1',
      prompt: 'repair the brief',
      projectDir: '/tmp/project',
    });
    expect(planner.review).not.toHaveBeenCalled();
  });
});
