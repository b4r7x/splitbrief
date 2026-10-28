import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeResearchingState, setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { error } from '../../utils/error.js';
import { createSteeringPort, deliverToRunningCall } from '../calls/steering.js';
import { sessionResumeExpiredError } from '../session-expiry.js';
import { askPlannerSession, type PlannerSessionTurn } from './planner-session.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('askPlannerSession steering', () => {
  it.each([false, true])(
    'delivers on the planner thread, expired session = %s',
    async (expired) => {
      const ref = setupProject(dirs);
      const state = { ...makeResearchingState(), plannerSessionId: 'old-thread' };
      saveState(ref, state);
      const { bus } = makeBusRecorder();
      const steering = createSteeringPort();
      const sent: string[] = [];
      const outcomes: string[] = [];
      const prompts: string[] = [];
      let attempt = 0;
      const planner = makePlanner();
      planner.capabilities.supportsSessionResume = true;
      planner.typedCall = (ctx) => ({
        seat: ctx.seat,
        typedOutput: 'strict-native',
        canResume: true,
        invoke: async ({ prompt }) => {
          prompts.push(prompt);
          attempt += 1;
          if (expired && attempt === 1)
            throw sessionResumeExpiredError('old-thread', 'session not found');
          const detach = ctx.callbacks.steering?.attach({
            callId: 'planner-thread',
            role: 'planner',
            taskId: null,
            send: async ({ text }) => {
              sent.push(text);
              return 'delivered';
            },
          });
          try {
            outcomes.push(
              await deliverToRunningCall(steering.current(), {
                id: 'message-1',
                text: 'Keep the API',
              }),
            );
            return makeRunnerCallResult({
              status: 'completed',
              text: JSON.stringify({ answer: 'ok' }),
            });
          } finally {
            detach?.();
          }
        },
      });

      const answer = await askPlannerSession(
        { ...ref, bus, state, planner, steering },
        {
          schema: z.object({ answer: z.string() }),
          jsonSchema: { type: 'object' },
          schemaName: 'answer',
          compose: ({ onSession }) => (onSession ? 'continue' : 'rebuild'),
        },
      );

      expect(answer.result).toMatchObject({ value: { answer: 'ok' } });
      expect(prompts).toEqual(
        expired
          ? [expect.stringMatching(/^continue/), expect.stringMatching(/^rebuild/)]
          : [expect.stringMatching(/^continue/)],
      );
      expect(outcomes).toEqual(['delivered']);
      expect(sent).toEqual(['Keep the API']);
      expect(steering.current()).toBeNull();
    },
  );

  it('leaves a helper call without a steering port', async () => {
    const ref = setupProject(dirs);
    const state = makeResearchingState();
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const ports: unknown[] = [];
    const planner = makePlanner({
      typedCall: (ctx) => {
        ports.push(ctx.callbacks.steering);
        return {
          seat: ctx.seat,
          typedOutput: 'strict-native',
          canResume: false,
          invoke: async () =>
            makeRunnerCallResult({
              status: 'completed',
              text: JSON.stringify({ answer: 'guidance' }),
            }),
        };
      },
    });

    const answer = await askPlannerSession(
      { ...ref, bus, state, planner },
      {
        schema: z.object({ answer: z.string() }),
        jsonSchema: { type: 'object' },
        schemaName: 'answer',
        compose: () => 'consult',
      },
    );

    expect(answer.result).toMatchObject({ value: { answer: 'guidance' } });
    expect(ports).toEqual([undefined]);
  });
});

describe('askPlannerSession on a refused thread', () => {
  const refused = () =>
    error('input-too-large', 'Prompt is too long', {
      error: { code: 'input-too-large', message: 'Prompt is too long' },
    });
  const call = (turns: PlannerSessionTurn[]) => ({
    schema: z.object({ answer: z.string() }),
    jsonSchema: { type: 'object' },
    schemaName: 'answer',
    compose: (turn: PlannerSessionTurn) => {
      turns.push(turn);
      return turn.onSession ? 'continue' : 'rebuild';
    },
  });

  it('reissues the call once on a fresh session and keeps the new thread', async () => {
    const ref = setupProject(dirs);
    const state = { ...makeResearchingState(), plannerSessionId: 'S' };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const turns: PlannerSessionTurn[] = [];
    let attempt = 0;
    const planner = makePlanner();
    planner.capabilities.supportsSessionResume = true;
    planner.typedCall = (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'strict-native',
      canResume: true,
      invoke: async () => {
        attempt += 1;
        // Claude Code reports "Prompt is too long" as a failed call, not a throw.
        if (attempt === 1)
          return makeRunnerCallResult({
            status: 'failed',
            text: '',
            error: { code: 'input-too-large', message: 'Prompt is too long' },
          });
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify({ answer: 'ok' }),
          nativeSessionId: 'S2',
        });
      },
    });

    const answer = await askPlannerSession({ ...ref, bus, state, planner }, call(turns));

    expect(answer.result).toMatchObject({ value: { answer: 'ok' } });
    expect(turns.map((turn) => turn.onSession)).toEqual([true, false]);
    expect(turns[1]?.priorMessages).toBeDefined();
    expect(loadState(ref)?.plannerSessionId).toBe('S2');
    expect(answer.state.plannerSessionId).toBe('S2');
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        category: 'planner',
        code: 'planner_session_refused',
        message: expect.stringContaining('refused the session as too long'),
      }),
    ]);
  });

  it('rethrows the refusal of a call that resumed no thread', async () => {
    const ref = setupProject(dirs);
    const state = makeResearchingState();
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const turns: PlannerSessionTurn[] = [];
    const planner = makePlanner();
    planner.capabilities.supportsSessionResume = true;
    planner.typedCall = (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'strict-native',
      canResume: true,
      invoke: async () => {
        throw refused();
      },
    });

    await expect(
      askPlannerSession({ ...ref, bus, state, planner }, call(turns)),
    ).rejects.toMatchObject({ kind: 'input-too-large' });
    expect(turns).toHaveLength(1);
  });
});

describe('askPlannerSession repair', () => {
  it('says why it asks again on the planner thread', async () => {
    const ref = setupProject(dirs);
    const state = { ...makeResearchingState(), plannerSessionId: 'thread' };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const prompts: string[] = [];
    const answers = ['{"answer":1}', '{"answer":"ok"}'];
    const planner = makePlanner();
    planner.capabilities.supportsSessionResume = true;
    planner.typedCall = (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'fallback',
      canResume: true,
      invoke: async ({ prompt }) => {
        prompts.push(prompt);
        return makeRunnerCallResult({
          status: 'completed',
          text: answers[prompts.length - 1] ?? '',
          nativeSessionId: 'thread',
        });
      },
    });

    const answer = await askPlannerSession(
      { ...ref, bus, state, planner },
      {
        schema: z.object({ answer: z.string() }),
        jsonSchema: { type: 'object' },
        schemaName: 'answer',
        compose: () => 'continue',
      },
    );

    expect(answer.result).toMatchObject({ value: { answer: 'ok' } });
    expect(prompts[1]).toMatch(/^Your previous answer failed validation/);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      expect.objectContaining({
        category: 'planner',
        code: 'seat_answer_refused',
        message:
          'The planner seat answer did not match its contract. Wrong or missing value in answer. Asking the seat again.',
      }),
    ]);
  });
});
