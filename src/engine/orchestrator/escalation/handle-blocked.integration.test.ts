import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { useTrustHome } from '#testing/helpers/trust-home.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { ImplementerReportSchema, type ConsultAnswer } from '../../../core/schemas/consult.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { Planner, TypedCallContext } from '../../planners/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { handleRetryAndEscalation } from './handle.js';

vi.setConfig({ testTimeout: 60_000 });

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('escalation-handle-blocked-trust-home');
});

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
  trustHome.restore();
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'escalation-blocked-test',
    sessionId: 'sess-blocked',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  let state = makeImplState([task]);
  state = transition(state, { type: 'TASK_SENT' });
  return state;
}

function makeValidatingStateWithPlan(): WorkflowState {
  return {
    ...makeValidatingState(),
    plan: {
      summary: 'Bound the pipeline with named constants.',
      decisions: [{ text: 'Keep the bounds in one module', taskId: null }],
      criteria: [],
      checks: [],
      validation: null,
    },
  };
}

function guidanceAnswer(diagnosis: string, instructions: string): ConsultAnswer {
  return { answer: { diagnosis, action: 'guidance', instructions, context: null } };
}

function consultPlanner(script: readonly ConsultAnswer[]): {
  planner: Planner;
  prompts: string[];
} {
  const answers = [...script];
  const prompts: string[] = [];
  const typedCall = (ctx: TypedCallContext): TypedSeatCall => ({
    seat: ctx.seat,
    typedOutput: 'fallback',
    canResume: false,
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      const next = answers.shift();
      if (next === undefined) throw new Error('the planner was asked once too often');
      return makeRunnerCallResult({
        status: 'completed',
        text: JSON.stringify(next),
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  });
  return { planner: makePlanner({ typedCall }), prompts };
}

describe('handleRetryAndEscalation — a blocked implementer', () => {
  it.each(['rewrite-task', 'split-task'] as const)(
    'asks once about a guarded %s and delivers the operator answer as guidance',
    async (action) => {
      const { projectDir, sessionId } = setupProject();
      const task = makeTask({ criteria: ['C1', 'C2'] });
      const currentState = { ...makeValidatingState(), tasks: [task] };
      const answer = 'Keep both criteria and repair the existing implementation.';
      const onPlannerReply = vi.fn().mockResolvedValue(plainUserMessage(answer));
      const { callbacks } = makeCallbacks({ onPlannerReply });
      const { bus, events } = makeBusRecorder();
      const implementer = makeImplementer();
      const replacement = makeTaskSpec({ id: 'T001', criteria: ['C2'] });
      const { planner, prompts } = consultPlanner([
        {
          answer:
            action === 'rewrite-task'
              ? { action, diagnosis: 'The brief needs repair.', task: replacement }
              : {
                  action,
                  diagnosis: 'The brief needs repair.',
                  tasks: [replacement, makeTaskSpec({ id: 'T002', criteria: ['C2'] })],
                },
        },
      ]);

      const outcome = await handleRetryAndEscalation({
        wctx: makeWctx({
          projectDir,
          sessionId,
          config: makeNoValidationConfig(),
          planner,
          callbacks,
          implementer,
          bus,
        }),
        task,
        initialError: 'Implementer is blocked.',
        currentState,
        initialBlocked: { status: 'blocked', question: 'How should I proceed?', filesNeeded: [] },
      });

      expect(onPlannerReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          seat: 'plan',
          text: expect.stringContaining('SPLITBRIEF asked the planner to fix T001'),
          questions: [expect.objectContaining({ text: expect.stringContaining('C1') })],
        }),
      );
      expect(prompts).toHaveLength(1);
      expect(outcome.result).toMatchObject({ completed: true, method: 'consulted', attempts: 1 });
      expect(outcome.state.pendingRecovery).toBeUndefined();
      expect(outcome.state.tasks).toHaveLength(1);
      expect(outcome.state.tasks[0]?.criteria).toEqual(['C1', 'C2']);
      expect(outcome.state.tasks[0]?.revision).toBeUndefined();
      expect(implementer.retry).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ error: expect.stringContaining(answer) }),
      );
      expect(vi.mocked(implementer.retry).mock.calls[0]?.[0].error).not.toContain(
        'How should T001 proceed?',
      );
      expect(events.filter((event) => event.type === 'task_retry')).toEqual([]);
      expect(events.filter((event) => event.type === 'user_message')).toEqual([
        expect.objectContaining({ text: answer, qa: [expect.objectContaining({ answer })] }),
      ]);
      expect(
        events.filter((event) => event.type === 'task_replaced' || event.type === 'tasks_inserted'),
      ).toEqual([]);
    },
  );

  it('consults the planner at once when the first attempt stopped to ask', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: null }),
    });
    const { planner, prompts } = consultPlanner([
      guidanceAnswer('The consumer may be edited', 'Edit src/consumer.ts within scope.'),
    ]);

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'Implementer is blocked: May I edit src/consumer.ts?',
      currentState: makeValidatingState(),
      initialBlocked: {
        status: 'blocked',
        question: 'May I edit src/consumer.ts?',
        filesNeeded: ['src/consumer.ts'],
      },
    });

    // No local retry ran before the consult; the only retry is the answer's.
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
    expect(result.method).toBe('consulted');
    expect(prompts[0]).toContain('blocked —');
    expect(prompts[0]).toContain('May I edit src/consumer.ts?');
    expect(events.find((e) => e.type === 'consult_answered')).toMatchObject({
      type: 'consult_answered',
      taskId: 'T001',
      reason: 'blocked',
      action: 'guidance',
    });
  });

  it('ends the local rung and consults with reason blocked when a retry reports blocked', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const blocked = {
      question: 'May I edit src/consumer.ts?',
      filesNeeded: ['src/consumer.ts'],
    };
    const implementer = makeImplementer({
      retry: vi
        .fn()
        .mockResolvedValueOnce({
          success: false,
          output: JSON.stringify({
            status: 'blocked',
            question: blocked.question,
            filesNeeded: blocked.filesNeeded,
          }),
          error: `Implementer is blocked: ${blocked.question}`,
          blocked,
        })
        .mockResolvedValueOnce({ success: true, output: 'fixed', usage: null }),
    });
    const { planner, prompts } = consultPlanner([
      guidanceAnswer('The consumer may be edited', 'Edit src/consumer.ts within scope.'),
    ]);

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingState(),
    });

    // One local attempt reported blocked; the remaining local retry was not spent.
    expect(events.filter((e) => e.type === 'task_retry')).toHaveLength(1);
    expect(implementer.retry).toHaveBeenCalledTimes(2);
    expect(result.completed).toBe(true);
    expect(result.method).toBe('consulted');
    expect(prompts[0]).toContain('blocked —');
    expect(prompts[0]).toContain('Blocked: May I edit src/consumer.ts?');
    expect(events.find((e) => e.type === 'consult_answered')).toMatchObject({
      type: 'consult_answered',
      taskId: 'T001',
      reason: 'blocked',
      action: 'guidance',
    });
  });

  it('completes a passing attempt whose report names a touched file with no reason', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const report = ImplementerReportSchema.parse({
      status: 'done',
      filesChanged: ['src/x.ts'],
      touchedNotSuggested: [{ file: 'src/y.ts' }],
      notes: null,
    });
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: null, report }),
    });
    const { planner } = consultPlanner([]);

    const { result } = await handleRetryAndEscalation({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig(),
        planner,
        callbacks,
        implementer,
        bus,
      }),
      task: makeTask(),
      initialError: 'type error',
      currentState: makeValidatingStateWithPlan(),
    });

    expect(report).toMatchObject({
      status: 'done',
      touchedNotSuggested: [{ file: 'src/y.ts', reason: '' }],
    });
    expect(result.completed).toBe(true);
  });
});
