import { setupProject as setupPlainProject } from '#testing/helpers/planning-phase.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { transition } from '../../../core/state/machine.js';
import { ImplementerReportSchema, type ConsultAnswer } from '../../../core/schemas/consult.js';
import { makeTask } from '#testing/helpers/factories/task.js';
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
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';

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

function confirmAnswer(
  diagnosis: string,
  decisions: { what: string; why: string }[],
): ConsultAnswer {
  return { answer: { diagnosis, action: 'confirm', decisions } };
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
  it.each(['guidance', 'protocol', 'bound', 'requirement'] as const)(
    'handles an initial reported deviation through the consult ladder: %s',
    async (scenario) => {
      const { projectDir, sessionId } =
        scenario === 'bound' || scenario === 'protocol' ? setupPlainProject(dirs) : setupProject();
      const task = makeTask({ criteria: ['C1'] });
      const report = {
        status: 'done' as const,
        filesChanged: [],
        touchedNotSuggested: [],
        notes: null,
        decisions: [{ what: 'Changed the approach', why: 'Simpler' }],
      };
      const rewrite = {
        answer: {
          action: 'rewrite-task' as const,
          diagnosis: 'Drop the outcome',
          task: { ...makeTaskSpec({ id: task.id }), criteria: [] },
        },
      };
      const { planner, prompts } = consultPlanner(
        scenario === 'protocol'
          ? []
          : [
              scenario === 'requirement'
                ? rewrite
                : guidanceAnswer('Correct it', 'Apply the correction'),
            ],
      );
      if (scenario === 'protocol')
        planner.typedCall = () => ({
          seat: 'planner',
          typedOutput: 'fallback',
          canResume: false,
          invoke: async () => makeRunnerCallResult({ status: 'completed', text: '{}' }),
        });
      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: true, output: 'corrected', usage: null }),
      });
      const replies: string[] = [];
      const callbacks = makeCallbacks({
        onPlannerReply: async (question) => {
          replies.push(question.text);
          return 'Keep the outcome';
        },
      }).callbacks;
      const { state, result } = await handleRetryAndEscalation({
        wctx: makeWctx({
          ...{ projectDir, sessionId },
          config: makeNoValidationConfig(),
          planner,
          callbacks,
          implementer,
        }),
        task,
        taskStartSnapshot:
          scenario === 'bound' || scenario === 'protocol'
            ? { head: '', files: [], dirtyFileContents: {} }
            : await getChangedFilesSnapshot(projectDir),
        initialError: 'deviation',
        initialDeviation: report,
        currentState: {
          ...makeValidatingStateWithPlan(),
          tasks: [task],
          ...(scenario === 'bound' && { plannerCalls: { used: 10, allowance: 10 } }),
        },
      });
      if (scenario === 'bound' || scenario === 'protocol') {
        expect(result.completed).toBe(false);
        expect(implementer.retry).not.toHaveBeenCalled();
        expect(state.pendingRecovery?.reason).toBe(
          scenario === 'bound' ? 'planner-calls-spent' : 'seat-protocol-error',
        );
      } else {
        expect(result.completed).toBe(true);
        expect(implementer.retry).toHaveBeenCalledTimes(1);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('deviation —');
        if (scenario === 'requirement') expect(replies).toHaveLength(1);
      }
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

  it('consults on a reported deviation and records the confirmed decisions with the task', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const decisions = [
      { what: 'Used node:crypto for the hash', why: 'The brief suggested adding a dependency' },
    ];
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: true,
        output: 'fixed',
        usage: { inputTokens: 10, outputTokens: 5 },
        report: {
          status: 'done',
          filesChanged: ['src/x.ts'],
          touchedNotSuggested: [],
          notes: null,
          decisions,
        },
      }),
    });
    const { planner, prompts } = consultPlanner([
      confirmAnswer('The deviation keeps the accepted criteria intact', decisions),
    ]);

    const { state, result } = await handleRetryAndEscalation({
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
      initialError: 'the implementer reported a deviation',
      currentState: makeValidatingStateWithPlan(),
    });

    // Validation ran on the same attempt after the confirm.
    expect(result.completed).toBe(true);
    expect(prompts[0]).toContain('deviation —');
    expect(prompts[0]).toContain('Used node:crypto for the hash');
    expect(state.plan?.decisions).toEqual([
      { text: 'Keep the bounds in one module', taskId: null },
      {
        text: 'Used node:crypto for the hash — The brief suggested adding a dependency',
        taskId: 'T001',
      },
    ]);
    expect(events.find((e) => e.type === 'consult_answered')).toMatchObject({
      type: 'consult_answered',
      taskId: 'T001',
      reason: 'deviation',
      action: 'confirm',
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
