import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import type { SeatSwapContext } from './task.js';
import {
  buildPlannerCallFailedRecoveryIssue,
  buildPlanSessionHaltRecoveryIssue,
} from './planner.js';

const createdAt = '2026-04-28T12:00:00.000Z';
const plannerRunner = makeConfig({ planner: { kind: 'cli', tool: 'codex' } }).planner;

function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}

const plannerSeatSwap: SeatSwapContext = {
  seat: 'plan',
  currentTool: 'codex',
  detectedTools: [
    { tool: 'claude-code', ready: true },
    { tool: 'codex', ready: true },
    { tool: 'opencode', ready: false },
  ],
};

describe('buildPlannerCallFailedRecoveryIssue', () => {
  it('offers a re-issue and an end, and no task actions', () => {
    const issue = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'call-failed', message: 'Planning failed.' },
      phase: 'planning',
      runner: plannerRunner,
      createdAt,
    });

    expect(issue.reason).toBe('planner-call-failed');
    expect(issue.seat).toBe('plan');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.taskId).toBeUndefined();
    expectValidRecoveryIssue(issue);
  });

  it('adds the seat swap only when another ready tool was detected', () => {
    const issue = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'call-failed', message: 'Planning failed.' },
      phase: 'planning',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(issue.switchSeat).toEqual({
      seat: 'plan',
      candidates: [{ tool: 'claude-code' }],
    });
    expect(issue.availableActions).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  describe('on an OpenCode route refusal (provider.no-route)', () => {
    const route = 'ollama-cloud/deepseek-v4.1-flash';
    const words = `provider.no-route: Model unavailable: ${route}`;
    const runner = makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: route } }).planner;
    const halt = (
      routeAuth: NonNullable<
        Parameters<typeof buildPlannerCallFailedRecoveryIssue>[0]['seatSwap']
      >['routeAuth'],
      detectedTools: readonly { tool: string; ready: boolean }[] = [
        { tool: 'claude-code', ready: true },
      ],
    ) =>
      buildPlannerCallFailedRecoveryIssue({
        diagnosis: {
          failure: 'missing-model',
          message: `Planning failed: ${words}`,
          tool: 'OpenCode CLI',
          words,
        },
        phase: 'planning',
        runner,
        seatSwap: {
          seat: 'plan',
          currentTool: 'opencode',
          currentModel: route,
          detectedTools,
          routeAuth,
        },
        createdAt,
      });

    it("halts as the seat-down sign-out, in doctor's words, when the route has no credential", () => {
      const issue = halt({ kind: 'needs-sign-in', tool: 'opencode', provider: 'ollama-cloud' });

      expect(issue.reason).toBe('runner-unauthenticated');
      expect(issue.message).toBe(
        'OpenCode CLI has no credential for ollama-cloud. Run `opencode auth login ollama-cloud` in a separate terminal, then retry.',
      );
      expect(issue.facts).toMatchObject({ tool: 'OpenCode CLI', provider: 'ollama-cloud' });
      expect(issue.details).toContain(`OpenCode CLI reported: ${words}`);
      expectValidRecoveryIssue(issue);
    });

    it('halts as a model the tool does not list, recommending another seat, when the route has a credential', () => {
      const issue = halt({ kind: 'configured', source: 'api' });

      expect(issue.reason).toBe('planner-call-failed');
      expect(issue.message).toBe(
        `Model ${route} is not listed by OpenCode CLI; pick a listed model`,
      );
      expect(issue.facts).toMatchObject({ tool: 'OpenCode CLI', refusal: 'wrong-model' });
      expect(issue.details).toContain(
        'The run stopped instead of spending retries on a model the tool refuses.',
      );
      expect(issue.switchSeat?.candidates).toEqual([{ tool: 'claude-code' }, { tool: 'opencode' }]);
      expect(issue.recommendedAction).toBe('switch-seat');
      expectValidRecoveryIssue(issue);
    });

    it('names both causes when the credential listing could not be read', () => {
      const issue = halt({ kind: 'unknown', reason: 'exit-failure' });

      expect(issue.reason).toBe('planner-call-failed');
      expect(issue.message).toBe(
        `OpenCode CLI cannot use ${route}: sign in with \`opencode auth login ollama-cloud\` if ollama-cloud has no credential, or pick a listed model`,
      );
      expect(issue.facts).toMatchObject({ refusal: 'unknown' });
      expect(issue.recommendedAction).toBe('switch-seat');
    });

    it("offers the seat's own tool when the machine has no other", () => {
      const issue = halt({ kind: 'configured', source: 'listed' }, []);

      expect(issue.switchSeat).toEqual({ seat: 'plan', candidates: [{ tool: 'opencode' }] });
      expect(issue.recommendedAction).toBe('switch-seat');
    });
  });

  it('builds the one seat-down halt for a quota halt and a sign-out', () => {
    const limit = buildPlannerCallFailedRecoveryIssue({
      diagnosis: {
        failure: 'usage-limit',
        message: 'OpenAI Codex CLI hit its usage limit.',
        tool: 'OpenAI Codex CLI',
        resetsAt: new Date('2026-08-08T15:27:00.000Z'),
        words: "You've hit your usage limit.",
        seatDown: {
          classification: { class: 'rate-limited', resetAt: new Date('2026-08-08T15:27:00.000Z') },
        },
      },
      phase: 'planning',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });
    const signedOut = buildPlannerCallFailedRecoveryIssue({
      diagnosis: {
        failure: 'unauthenticated',
        message: 'OpenAI Codex CLI is signed out.',
        tool: 'OpenAI Codex CLI',
        words: 'HTTP 403',
        seatDown: { classification: { class: 'account', cause: 'auth' } },
      },
      phase: 'planning',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(limit.reason).toBe('runner-usage-limit');
    expect(limit.resetAt).toBe('2026-08-08T15:27:00.000Z');
    expect(limit.facts?.tool).toBe('OpenAI Codex CLI');
    expect(limit.facts?.cause).toBe('rate-limit');
    expect(limit.recommendedAction).toBe('switch-seat');
    expect(limit.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'retry-later',
      'end-run',
    ]);
    expect(signedOut.reason).toBe('runner-unauthenticated');
    expect(signedOut.recommendedAction).toBe('switch-seat');
    expectValidRecoveryIssue(limit);
    expectValidRecoveryIssue(signedOut);
  });

  it('names the brief a hint halted on and can skip it; a review halt names none', () => {
    const task = makeTask({ id: 'T004', suggestedFiles: ['src/alpha.ts'] });
    const hint = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'usage-limit', message: 'Codex hit its usage limit.' },
      task,
      phase: 'escalating',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });
    const review = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'usage-limit', message: 'Codex hit its usage limit.' },
      seat: 'review',
      phase: 'final-review',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(hint).toMatchObject({
      seat: 'plan',
      taskId: 'T004',
      files: ['src/alpha.ts'],
      affectedTaskIds: ['T004'],
    });
    expect(hint.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(review.seat).toBe('review');
    expect(review.taskId).toBeUndefined();
    expect(review.availableActions).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
    expectValidRecoveryIssue(hint);
    expectValidRecoveryIssue(review);
  });

  it('names every file of a brief with no scope patterns, not only the first', () => {
    const issue = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'input-too-large', message: 'Prompt is too long' },
      task: makeTask({ id: 'T001', suggestedFiles: ['lib/clamp.js', 'test.js'] }),
      phase: 'escalating',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(issue.files).toEqual(['lib/clamp.js', 'test.js']);
  });

  it('handles a command-line overflow diagnosis with no retry, offering fallback first or end-run only', () => {
    const argvRunner = makeConfig({
      planner: { kind: 'cli', tool: 'opencode', authChannel: 'provider-dependent' },
    }).planner;
    const diagnosis = {
      failure: 'input-too-large' as const,
      message: 'Planning failed: the prompt is too large',
      tool: 'OpenCode CLI',
      details: [
        'The prompt is 186,486 bytes; OpenCode CLI takes at most 120,000 on its command line.',
      ],
      inputSize: { unit: 'bytes', size: 186_486, limit: 120_000 } as const,
    };

    const withFallback = buildPlannerCallFailedRecoveryIssue({
      diagnosis,
      phase: 'planning',
      runner: argvRunner,
      seatSwap: {
        seat: 'plan',
        currentTool: 'opencode',
        detectedTools: [
          { tool: 'claude-code', model: 'sonnet', ready: true },
          { tool: 'codex', ready: true },
        ],
        fallback: { tool: 'claude-code', model: 'sonnet' },
      },
      createdAt,
    });

    expect(withFallback.facts).toMatchObject({
      tool: 'OpenCode CLI',
      bytes: 186_486,
      maxBytes: 120_000,
    });
    expect(withFallback.availableActions).not.toContain('retry-same-worker');
    expect(withFallback.switchSeat?.candidates[0]).toEqual({
      tool: 'claude-code',
      model: 'sonnet',
    });
    expect(withFallback.recommendedAction).toBe('switch-seat');
    expectValidRecoveryIssue(withFallback);

    const emptySwap = buildPlannerCallFailedRecoveryIssue({
      diagnosis,
      phase: 'planning',
      runner: argvRunner,
      seatSwap: {
        seat: 'plan',
        currentTool: 'opencode',
        detectedTools: [],
      },
      createdAt,
    });

    expect(emptySwap.availableActions).not.toContain('retry-same-worker');
    expect(emptySwap.switchSeat).toBeUndefined();
    expect(emptySwap.availableActions).toEqual(['end-run']);
    expect(emptySwap.recommendedAction).toBe('end-run');
    expectValidRecoveryIssue(emptySwap);
  });
});

describe('the planner-output halts', () => {
  it.each(['plan-questions-exhausted', 'plan-checks-failed'] as const)(
    'a planning session halt (%s) keeps the plan seat and recommends the correction',
    (reason) => {
      const issue = buildPlanSessionHaltRecoveryIssue({
        reason,
        phase: 'planning',
        message: 'The planning session stopped.',
        details: ['uncovered-criterion: Criterion C2 is served by no task.'],
        createdAt,
      });

      expect(issue.reason).toBe(reason);
      expect(issue.seat).toBe('plan');
      expect(issue.availableActions).toEqual(['retry-same-worker', 'revise', 'end-run']);
      expect(issue.recommendedAction).toBe('revise');
      expect(issue.details).toEqual(['uncovered-criterion: Criterion C2 is served by no task.']);
      expectValidRecoveryIssue(issue);
    },
  );
});
