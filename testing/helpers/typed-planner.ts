import { makeTaskSpec } from './factories/plan.js';
import { vi, type Mock } from 'vitest';
import type { PlanProposal, PlanResult } from '../../src/core/schemas/plan.js';
import type { ClarificationQuestion } from '../../src/core/schemas/question.js';
import type { ConsultAnswer } from '../../src/core/schemas/consult.js';
import type {
  ReviewAnswer,
  ReviewChecksPlan,
  ReviewVerdict,
} from '../../src/core/schemas/review.js';
import type { ReviewScope } from '../../src/core/review/verdict.js';
import { taskId, type Task } from '../../src/core/schemas/task.js';
import type {
  Planner,
  PlannerOutputCallbacks,
  TypedCallContext,
} from '../../src/engine/planners/types.js';
import type { TypedSchemaInput, TypedSeatCall } from '../../src/engine/runners/typed-output.js';
import type { RunnerCallResult } from '../../src/engine/calls/types.js';
import { makeRunnerCallResult } from './factories/runner-call.js';

const REVIEW_PROMPT_MARKER = '# Final Implementation Review';

function isReviewPrompt(prompt: string): boolean {
  return prompt.includes(REVIEW_PROMPT_MARKER);
}

type TypedInvokeInput = { prompt: string; schema?: TypedSchemaInput | undefined };

/**
 * The reviewer seat receives the review answer schema natively, so a mock answers it
 * by that schema's name; the prompt marker keeps a fallback seat answerable too.
 */
function isReviewCall(input: TypedInvokeInput): boolean {
  return input.schema?.name === 'review_answer' || isReviewPrompt(input.prompt);
}

/** The plan call the reviewer seat answers before a review's verdict. */
function isReviewChecksCall(input: TypedInvokeInput): boolean {
  return input.schema?.name === 'review_checks';
}

/** The plan-call answer a fake reviewer gives when a test scripts none: no command, and why. */
export const NO_REVIEW_CHECKS: ReviewChecksPlan = {
  commands: [],
  declined: [],
  reason: 'The fake reviewer chooses no command for this test.',
};

/**
 * What a fake reviewer answers to a review-seat call the test does not script: the plan call
 * gets `NO_REVIEW_CHECKS`, the verdict a passing one. Any other call is the caller's.
 */
function unscriptedReviewAnswer(
  input: TypedInvokeInput,
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): RunnerCallResult | null {
  if (isReviewChecksCall(input)) {
    return makeRunnerCallResult({
      status: 'completed',
      text: JSON.stringify(NO_REVIEW_CHECKS),
      usage: usage ?? null,
    });
  }
  if (!isReviewCall(input)) return null;
  return makeRunnerCallResult({
    status: 'completed',
    text: JSON.stringify(passingReviewVerdict(input.prompt)),
    usage: usage ?? null,
  });
}

function mockTypedOutput(seat: TypedCallContext['seat']): TypedSeatCall['typedOutput'] {
  return seat === 'reviewer' ? 'strict-native' : 'fallback';
}

function promptIds(prompt: string, label: string): string[] {
  const match = new RegExp(`^${label} (.+)$`, 'm').exec(prompt);
  const value = match?.[1]?.trim() ?? 'none';
  if (value === '' || value === 'none') return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/** The answer that passes `scope`: every task met, every criterion passed, no findings. */
export function passingVerdict(scope: ReviewScope): ReviewAnswer {
  return {
    tasks: scope.taskIds.map((id) => ({ id: taskId(id), plan: 'met' as const, note: '' })),
    criteria: scope.criterionIds.map((id) => ({ id, status: 'pass' as const, evidence: '' })),
    findings: [],
    fixTasks: [],
    rejected: [],
    verify: [],
    ask: null,
  };
}

/**
 * The verdict a fake review seat answers with when a test scripts none: every
 * id the prompt's Required Results lists, each met and passed, no findings.
 */
export function passingReviewVerdict(prompt: string): ReviewAnswer {
  return passingVerdict({
    kind: prompt.includes('# Task Implementation Review') ? 'task' : 'final',
    taskIds: promptIds(prompt, 'Task ids:'),
    criterionIds: promptIds(prompt, 'Criterion ids:'),
  });
}

/** A passing verdict carrying one blocking finding, so the review fails. */
export function failedReviewVerdict(
  prompt: string,
  text: string,
  finding?: Partial<ReviewVerdict['findings'][number]>,
): ReviewAnswer {
  const base = passingReviewVerdict(prompt);
  return {
    ...base,
    fixTasks: [
      {
        ...makeTaskSpec({
          id: 'T900',
          criteria: [],
          suggestedFiles: [finding?.file ?? 'src/alpha.ts'],
        }),
        findingIds: [finding?.id ?? 'F1'],
      },
    ],
    findings: [
      {
        id: 'F1',
        kind: 'defect',
        severity: 'blocking',
        taskId: null,
        file: null,
        line: null,
        text,
        acceptance: null,
        checkIds: null,
        criterionId: null,
        ...finding,
      },
    ],
  };
}

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
      typedOutput: mockTypedOutput(ctx.seat),
      canResume: false,
      invoke: async ({ prompt, schema }) => {
        const review = unscriptedReviewAnswer({ prompt, schema });
        if (review !== null) return review;
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
      required: false,
    }));
    return {
      id: task.id,
      title: task.title,
      intent: task.description,
      criteria: ['C1'],
      checks:
        task.checks ??
        (tests.length > 0
          ? tests
          : [{ id: `${task.id}-K1`, kind: 'cmd' as const, value: 'true', required: false }]),
      suggestedFiles: [...task.suggestedFiles],
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
 * object. What `answer` throws, the call throws. A review call is answered with a passing verdict
 * instead, so a run that reaches its final review parses.
 */
export function typedCallAnswering(
  answer: (prompt: string, ctx: TypedCallContext) => PlanResult | Promise<PlanResult>,
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): Mock<Planner['typedCall']> {
  return vi.fn((ctx: TypedCallContext) => ({
    seat: ctx.seat,
    typedOutput: mockTypedOutput(ctx.seat),
    canResume: false,
    invoke: async ({ prompt, schema }: TypedInvokeInput) =>
      unscriptedReviewAnswer({ prompt, schema }, usage) ??
      makeRunnerCallResult({
        status: 'completed',
        text: JSON.stringify({ result: await answer(prompt, ctx) }),
        usage: usage ?? null,
      }),
  }));
}

export function typedCallPlanAndReview(
  plan: () => PlanResult,
  review: (
    prompt: string,
    call: number,
    callbacks: PlannerOutputCallbacks,
  ) => ReviewVerdict | string,
  usage?:
    | Readonly<{
        plan?: Readonly<{ inputTokens: number; outputTokens: number }>;
        review?: Readonly<{ inputTokens: number; outputTokens: number }>;
      }>
    | undefined,
  /** The plan-call answer the reviewer gives before each verdict; no command by default. */
  checks?: ((prompt: string) => ReviewChecksPlan) | undefined,
): Mock<Planner['typedCall']> {
  let reviewCalls = 0;
  return vi.fn((ctx: TypedCallContext) => ({
    seat: ctx.seat,
    typedOutput: mockTypedOutput(ctx.seat),
    canResume: false,
    invoke: async ({ prompt, schema }: TypedInvokeInput) => {
      if (isReviewChecksCall({ prompt, schema })) {
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify(checks?.(prompt) ?? NO_REVIEW_CHECKS),
          usage: usage?.review ?? null,
        });
      }
      if (!isReviewCall({ prompt, schema }))
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify({ result: plan() }),
          usage: usage?.plan ?? null,
        });
      const answered = review(prompt, ++reviewCalls, ctx.callbacks);
      return makeRunnerCallResult({
        status: 'completed',
        text:
          typeof answered === 'string'
            ? answered
            : JSON.stringify({ fixTasks: [], rejected: [], verify: [], ask: null, ...answered }),
        usage: usage?.review ?? null,
      });
    },
  }));
}

/** A planner seat whose every typed call returns the plan the scripted briefs stand for. */
export function typedCallFromTasks(
  tasks: readonly Task[],
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): Mock<Planner['typedCall']> {
  return typedCallAnswering(() => planFromTasks(tasks), usage);
}

/**
 * A planner seat whose typed consult calls answer with what `answer` returns,
 * sent as the `{ answer }` object. What `answer` throws, the call throws.
 */
export function consultCallAnswering(
  answer: (prompt: string, ctx: TypedCallContext) => ConsultAnswer,
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): Mock<Planner['typedCall']> {
  return vi.fn((ctx: TypedCallContext) => ({
    seat: ctx.seat,
    typedOutput: mockTypedOutput(ctx.seat),
    canResume: false,
    invoke: async ({ prompt, schema }: TypedInvokeInput) =>
      unscriptedReviewAnswer({ prompt, schema }, usage) ??
      makeRunnerCallResult({
        status: 'completed',
        text: JSON.stringify(answer(prompt, ctx)),
        usage: usage ?? null,
      }),
  }));
}

/** A guidance consult answer; the default answer for a ladder that consults but never lands. */
export function guidanceConsult(instructions = 'Try a different approach.'): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'The attempt failed',
      action: 'guidance',
      instructions,
      context: null,
    },
  };
}

/**
 * A planner seat that answers both kinds of typed call: the plan session gets `plan` as
 * its `{ result }` object, a consult call — recognized by the consult prompt's title —
 * gets `consult` through `consultCallAnswering` as its raw answer object, and a review
 * call gets a passing verdict.
 */
export function typedCallPlanAndConsult(
  plan: () => PlanResult,
  consult: () => ConsultAnswer,
  usage?: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
): Mock<Planner['typedCall']> {
  const consultCall = consultCallAnswering(() => consult(), usage);
  return vi.fn((ctx: TypedCallContext) => {
    const call = consultCall(ctx);
    return {
      ...call,
      invoke: async ({ prompt, schema }: TypedInvokeInput) =>
        unscriptedReviewAnswer({ prompt, schema }, usage) ??
        (prompt.includes('# Consult')
          ? call.invoke({ prompt })
          : makeRunnerCallResult({
              status: 'completed',
              text: JSON.stringify({ result: plan() }),
              usage: usage ?? null,
            })),
    };
  });
}
