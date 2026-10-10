import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeResearchingState, setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { saveState } from '../../core/state/persistence.js';
import { createSteeringPort, deliverToRunningCall } from '../calls/steering.js';
import { sessionResumeExpiredError } from '../session-expiry.js';
import { askPlannerSession } from './planner-session.js';

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
