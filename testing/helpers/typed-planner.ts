import { vi, type Mock } from 'vitest';
import type { PlanProposal, PlanResult } from '../../src/core/schemas/plan.js';
import type { ClarificationQuestion } from '../../src/core/schemas/question.js';
import { taskFiles, type Task } from '../../src/core/schemas/task.js';
import type { Planner, TypedCallContext } from '../../src/engine/planners/types.js';
import type { TypedSeatCall } from '../../src/engine/runners/typed-output.js';
import { makeRunnerCallResult } from './factories/runner-call.js';

/**
 * A planner seat whose typed calls answer from a script, in order: a `PlanResult` is sent as the
 * `{ result }` object, a string as the raw answer text, and an `Error` is what the call throws.
 */
export function scriptedTypedCall(script: Array<PlanResult | string | Error>): {
  typedCall: Planner['typedCall'];
  prompts: string[];
  contexts: TypedCallContext[];
} {
  const prompts: string[] = [];
  const contexts: TypedCallContext[] = [];
  const typedCall = (ctx: TypedCallContext): TypedSeatCall => {
    contexts.push(ctx);
    return {
      seat: ctx.seat,
      typedOutput: 'fallback',
      canResume: false,
      invoke: async ({ prompt }) => {
        prompts.push(prompt);
        const next = script.shift();
        if (next === undefined) throw new Error('the planner was asked once too often');
        if (next instanceof Error) throw next;
        return makeRunnerCallResult({
          status: 'completed',
          text: typeof next === 'string' ? next : JSON.stringify({ result: next }),
        });
      },
    };
  };
  return { typedCall, prompts, contexts };
}

/**
 * The plan a planner mock that still scripts Task Briefs stands for: each brief a task, its tests
 * as test checks (one command check when it lists none), one criterion every task serves.
 */
export function planFromTasks(tasks: readonly Task[]): PlanProposal {
  const specs = tasks.map((task) => {
    const tests = task.tests.map((value, index) => ({
      id: `${task.id}-K${index + 1}`,
      kind: 'test' as const,
      value,
      required: true,
    }));
    return {
      id: task.id,
      title: task.title,
      intent: task.description,
      criteria: ['C1'],
      checks:
        tests.length > 0
          ? tests
          : [{ id: `${task.id}-K1`, kind: 'cmd' as const, value: 'true', required: true }],
      suggestedFiles: [...taskFiles(task)],
      contextFiles: task.scope?.inBounds ?? [],
      exclusions: task.scope?.outOfBounds ?? [],
      protectedOperations: null,
      steps: task.implementationSteps.length > 0 ? task.implementationSteps : null,
      dependsOn: task.dependsOn,
      batch: 1,
    };
  });
  const firstCheck = specs[0]?.checks[0]?.id;
  return {
    kind: 'plan',
    summary: 'Plan from the scripted briefs',
    decisions: [],
    criteria: [
      { id: 'C1', text: 'The briefs are built', checkIds: firstCheck ? [firstCheck] : [] },
    ],
    checks: [],
    validation: null,
    tasks: specs,
  };
}

export function planQuestionsFrom(
  questions: readonly ClarificationQuestion[],
  text: string,
): PlanResult {
  const asked =
    questions.length > 0
      ? questions.map((question) => ({
          id: question.id,
          text: question.text,
          choices: question.type === 'choice' ? question.options : null,
          default:
            typeof question.default === 'boolean'
              ? question.default
                ? 'Yes'
                : 'No'
              : (question.default ?? ''),
        }))
      : [{ id: 'reply', text, choices: null, default: '' }];
  return { kind: 'questions', questions: asked.slice(0, 3) };
}

/**
 * A planner seat whose typed calls all answer with what `answer` returns, sent as the `{ result }`
 * object. What `answer` throws, the call throws.
 */
export function typedCallAnswering(
  answer: (prompt: string, ctx: TypedCallContext) => PlanResult | Promise<PlanResult>,
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): Mock<Planner['typedCall']> {
  return vi.fn((ctx: TypedCallContext) => ({
    seat: ctx.seat,
    typedOutput: 'fallback' as const,
    canResume: false,
    invoke: async ({ prompt }: { prompt: string }) =>
      makeRunnerCallResult({
        status: 'completed',
        text: JSON.stringify({ result: await answer(prompt, ctx) }),
        usage: usage ?? null,
      }),
  }));
}

/** A planner seat whose every typed call returns the plan the scripted briefs stand for. */
export function typedCallFromTasks(
  tasks: readonly Task[],
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): Mock<Planner['typedCall']> {
  return typedCallAnswering(() => planFromTasks(tasks), usage);
}
