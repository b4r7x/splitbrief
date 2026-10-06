import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import {
  buildApprovalDeniedRecoveryIssue,
  buildCheckoutChangedRecoveryIssue,
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
  buildImplementerUnavailableRecoveryIssue,
  buildLeftIsolationRecoveryIssue,
  buildMissingModelRecoveryIssue,
  buildRecipeInvalidRecoveryIssue,
  buildRepeatedTimeoutRecoveryIssue,
  buildRetryExhaustedRecoveryIssue,
  buildReviewFailedRecoveryIssue,
  buildRunnerInputTooLargeRecoveryIssue,
  buildRunnerUnauthenticatedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  buildSnapshotFailedRecoveryIssue,
  recoveryBuilderForRunnerOutcome,
  switchSeatOffer,
} from './task.js';

const createdAt = '2026-04-28T12:00:00.000Z';

function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}

function overflowRoutingDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    taskId: makeTask().id,
    requiredWriteMode: 'extracted-code',
    fit: 'overflow',
    estimatedTokens: 45_000,
    untruncatedEstimatedTokens: 48_000,
    contextLength: 32_768,
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    reason: 'No capable implementer profile can fit this task prompt',
    rejected: [
      {
        profile: 'local-qwen',
        profileWriteMode: 'extracted-code',
        requiredWriteMode: 'extracted-code',
        reason: 'Estimated 45000 tokens overflows 32768-token context',
        fit: 'overflow',
        estimatedTokens: 45_000,
        untruncatedEstimatedTokens: 48_000,
        contextLength: 32_768,
        currentCodeTruncated: false,
        currentCodeContextMode: 'whole-file',
      },
    ],
    ...overrides,
  };
}

describe('buildRetryExhaustedRecoveryIssue', () => {
  it('offers skip and end without the retry by default, and recommends skip', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      maxAttempts: 3,
    });

    expect(issue.reason).toBe('retry-exhausted');
    expect(issue.phase).toBe('escalating');
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });

  it('offers retry only when allowRetryOverride is explicit', () => {
    const override = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      maxAttempts: 3,
      allowRetryOverride: true,
    });
    expect(override.availableActions).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'end-run',
    ]);
    expect(override.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(override);
  });

  const bothVoices = {
    task: makeTask({ id: 'T012' }),
    createdAt,
    validationSummary: 'tsc failed',
    attempts: 4,
    maxAttempts: 3,
    allowRetryOverride: true,
  };

  it('quotes the implementer hand-back', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack: 'I could not find the prop.',
    });

    expect(issue.details).toContain('Attempts: 4');
    expect(issue.details).toContain('Implementer said: I could not find the prop.');
    expectValidRecoveryIssue(issue);
  });

  it('adds no hand-back row when the implementer did not speak', () => {
    const issue = buildRetryExhaustedRecoveryIssue(bothVoices);

    expect(issue.details.some((row) => row.startsWith('Implementer said:'))).toBe(false);
  });

  it('states a bare count over the max attempts', () => {
    const issue = buildRetryExhaustedRecoveryIssue(bothVoices);

    expect(issue.details).toContain('Attempts: 4');
    expect(issue.details.some((row) => row.includes('4/3'))).toBe(false);
  });

  it('names the last error and drops any Validation detail', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      validationSummary: 'tsc failed',
      attempts: 4,
      maxAttempts: 3,
    });

    expect(issue.details[0]).toBe('Last error: tsc failed');
    expect(issue.details.some((row) => row.startsWith('Validation'))).toBe(false);
  });

  it('bounds a long hand-back row to the summary length', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack: 'x'.repeat(2000),
    });
    const row = issue.details.find((detail) => detail.startsWith('Implementer said:'));

    expect(row).toBe(`Implementer said: …${'x'.repeat(300)}`);
  });

  it('quotes the tail of a long hand-back where an implementer that stopped says why', () => {
    const tail = 'May I edit src/consumer.ts?';
    const handBack = `${'x'.repeat(2000 - tail.length)}${tail}`;
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack,
    });
    const row = issue.details.find((detail) => detail.startsWith('Implementer said:'));

    expect(row?.startsWith('Implementer said: …')).toBe(true);
    expect(row?.endsWith(tail)).toBe(true);
    expect(row?.length).toBeLessThanOrEqual(320);
  });

  it('omits attempts row at zero attempts and formats other attempt counts', () => {
    const zeroAttempts = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 0,
      maxAttempts: 3,
    });
    expect(zeroAttempts.details.some((row) => row.startsWith('Attempts'))).toBe(false);

    const one = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 1,
    });
    expect(one.details).toContain('Attempts: 1/3');

    const five = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 5,
      maxAttempts: 3,
    });
    expect(five.details).toContain('Attempts: 5');
  });

  it('defaults to task failed when neither verdict nor hook reason is set', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
    });
    expect(issue.message).toBe('T012 failed');
  });

  it('sets message and fact when escalationBlockedBy is provided', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T012' }),
      createdAt,
      escalationBlockedBy: 'policy',
    });
    expect(issue.message).toBe('T012 escalation blocked by pre_escalation hook: policy');
    expect(issue.facts?.escalationBlockedBy).toBe('policy');
    expect(formatRecoveryHeadline(issue)).toBe(issue.message);
  });
});

describe('buildRunnerUsageLimitRecoveryIssue', () => {
  // Captured live from `codex exec --json` on 2026-08-06.
  const codexLimit =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";

  it('records the reset time, keeps the tool message verbatim, and never suggests logging in', () => {
    const issue = buildRunnerUsageLimitRecoveryIssue({
      task: makeTask({ id: 'T003' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: codexLimit,
      attempts: 1,
      maxAttempts: 3,
      createdAt,
    });

    expect(issue.reason).toBe('runner-usage-limit');
    // The message is stored, so it names no clock; every surface spells `resetAt` when it is read.
    expect(issue.message).toBe(
      'OpenAI Codex CLI hit its usage limit. Wait for the limit to reset or change the BUILD tool, then continue.',
    );
    expect(issue.resetAt).toBe(new Date(2026, 7, 8, 15, 27).toISOString());
    expect(issue.details.join('\n')).toContain(codexLimit);
    expect(issue.details.join('\n')).toContain('stopped instead of escalating');
    expect(issue.facts?.resetsAt).toMatch(/^2026-08-08T/);
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('offers the other detected ready tools as seats to switch to', () => {
    const issue = buildRunnerUsageLimitRecoveryIssue({
      task: makeTask({ id: 'T003' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: codexLimit,
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'claude-code', model: 'sonnet', ready: true },
          { tool: 'opencode', ready: false },
        ],
      },
    });

    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expect(issue.details.join('\n')).not.toContain('claude-code');
    expect(issue.resetAt).toMatch(/^2026-08-08T/);
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('switch-seat');
    expectValidRecoveryIssue(issue);
  });

  it('omits the seat switch when nothing else is detected ready', () => {
    const issue = buildRunnerUsageLimitRecoveryIssue({
      task: makeTask({ id: 'T003' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: codexLimit,
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'opencode', ready: false },
        ],
      },
    });

    expect(issue.switchSeat).toBeUndefined();
    expect(issue.availableActions).not.toContain('switch-seat');
    expectValidRecoveryIssue(issue);
  });
});

describe('a seat whose account the provider refuses', () => {
  // Recorded on 2026-10-05: opencode on a spent DeepSeek account.
  const balance =
    'provider.quota: Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';
  const runner = makeConfig({
    implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
  }).implementer;
  const seatSwap = {
    seat: 'build' as const,
    currentTool: 'opencode',
    detectedTools: [
      { tool: 'opencode', ready: true },
      { tool: 'claude-code', model: 'sonnet', ready: true },
    ],
  };

  it('halts on the spent balance with the seat switch recommended and the provider words kept', () => {
    const issue = buildRunnerUsageLimitRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      runner,
      toolMessage: balance,
      attempts: 1,
      maxAttempts: 1,
      seatSwap,
      createdAt,
    });

    expect(issue.reason).toBe('runner-usage-limit');
    expect(issue.resetAt).toBeUndefined();
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expect(issue.details).toContain(`OpenCode CLI reported: ${balance}`);
    expectValidRecoveryIssue(issue);
  });

  it('offers the seat switch beside the login when the account is signed out', () => {
    const issue = buildRunnerUnauthenticatedRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      runner,
      toolMessage: 'HTTP 403 Forbidden',
      attempts: 1,
      maxAttempts: 1,
      seatSwap,
      createdAt,
    });

    expect(issue.reason).toBe('runner-unauthenticated');
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expect(issue.details).toContain('OpenCode CLI reported: HTTP 403 Forbidden');
    expectValidRecoveryIssue(issue);
  });
});

describe('switchSeatOffer', () => {
  it('offers only tools the seat can host', () => {
    expect(
      switchSeatOffer({
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'a-tool-no-seat-hosts', ready: true },
          { tool: 'claude-code', ready: true },
        ],
      }),
    ).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
  });

  it('offers nothing when no ready tool can host the seat', () => {
    expect(
      switchSeatOffer({
        seat: 'plan',
        currentTool: 'codex',
        detectedTools: [{ tool: 'a-tool-no-seat-hosts', ready: true }],
      }),
    ).toBeUndefined();
  });
});

describe('buildContextOverflowRecoveryIssue', () => {
  it('offers a retry, skip or end and recommends the retry', () => {
    const task = makeTask({ id: 'T013', suggestedFiles: ['src/large.ts'] });

    const issue = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision: overflowRoutingDecision({ taskId: task.id }),
    });

    expect(issue.reason).toBe('context-overflow');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.facts).toMatchObject({ estimatedTokens: 45_000, contextLength: 32_768 });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildImplementerUnavailableRecoveryIssue', () => {
  it('offers a retry, skip or end and recommends the retry', () => {
    const issue = buildImplementerUnavailableRecoveryIssue({
      task: makeTask({ id: 'T014' }),
      createdAt,
      tool: 'codex',
      availabilityReason: 'not installed',
    });

    expect(issue.reason).toBe('implementation-error');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRunnerUnauthenticatedRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer;

  it('offers a retry, skip or end and recommends the retry', () => {
    const issue = buildRunnerUnauthenticatedRecoveryIssue({
      task: makeTask({ id: 'T015' }),
      runner,
      toolMessage: 'Not logged in',
      createdAt,
    });

    expect(issue.reason).toBe('runner-unauthenticated');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('offers the seat switch when another ready tool was detected, still recommending the retry', () => {
    const issue = buildRunnerUnauthenticatedRecoveryIssue({
      task: makeTask({ id: 'T015' }),
      runner,
      toolMessage: 'Not logged in',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [{ tool: 'claude-code', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildDependencyBlockedRecoveryIssue', () => {
  it('builds dependency-blocked issues with affected tasks and safe actions', () => {
    const dependency = makeTask({ id: 'T018', suggestedFiles: ['src/base.ts'], status: 'failed' });
    const task = makeTask({
      id: 'T019',
      suggestedFiles: ['src/followup.ts'],
      dependsOn: ['T018'],
    });

    const issue = buildDependencyBlockedRecoveryIssue({
      createdAt,
      task,
      blockedByTasks: [dependency],
    });

    expect(issue.reason).toBe('dependency-blocked');
    expect(issue.files).toEqual(['src/base.ts', 'src/followup.ts']);
    expect(issue.affectedTaskIds).toEqual([dependency.id, task.id]);
    expect(issue.details).toEqual(['Blocked dependencies: T018 (failed)']);
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRecipeInvalidRecoveryIssue', () => {
  it('names the tool that refused the command line and offers a retry or end', () => {
    const issue = buildRecipeInvalidRecoveryIssue({
      task: makeTask({ id: 'T022' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: "error: unknown option '--nope'",
      createdAt,
    });

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toContain('rejected the command');
    expect(issue.details.join('\n')).toContain("unknown option '--nope'");
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildLeftIsolationRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'antigravity' } }).implementer;
  const toolMessage = 'searched ~ with run_command: find ~ -name "process-invoke.ts" 2>/dev/null';

  it('halts the brief on the evidence and recommends a retry', () => {
    const issue = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage,
      attempts: 0,
      maxAttempts: 2,
      createdAt,
    });

    expect(issue.reason).toBe('implementer-left-isolation');
    expect(issue.seat).toBe('build');
    expect(issue.message).toBe(
      `T004 left the isolation directory — Google Antigravity CLI ${toolMessage}`,
    );
    expect(issue.details).toEqual([
      `Google Antigravity CLI ${toolMessage}`,
      "Your checkout gets the run's changes only through Apply.",
    ]);
    expect(issue.attempts).toBeUndefined();
    expect(issue.facts).toEqual({ tool: 'Google Antigravity CLI' });
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('offers the seat switch when another ready tool was detected', () => {
    const issue = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage,
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'antigravity',
        detectedTools: [{ tool: 'codex', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'codex' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('isolation halts of a call that ran in the checkout itself', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }).implementer;
  const inPlace = { revertedDir: '.splitbrief/sessions/s1/reverted' };

  it('says the attempt was put back and where the replaced bytes are, never promoted', () => {
    const left = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage: 'wrote to ~/x with Bash: touch ~/x',
      attempts: 0,
      maxAttempts: 2,
      inPlace,
      createdAt,
    });
    const changed = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage: 'branch topic',
      attempts: 0,
      maxAttempts: 2,
      inPlace,
      createdAt,
    });

    expect(left.details[1]).toBe(
      'SPLITBRIEF put back what this attempt changed in your checkout; the bytes it replaced are in .splitbrief/sessions/s1/reverted.',
    );
    expect(changed.details[1]).toBe(
      'SPLITBRIEF put back the files this attempt changed in your checkout (the bytes it replaced are in .splitbrief/sessions/s1/reverted); the git change stays for you to check.',
    );
    for (const issue of [left, changed]) {
      expect(issue.details.join(' ')).not.toContain('promoted');
      expectValidRecoveryIssue(issue);
    }
  });
});

describe('buildCheckoutChangedRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'antigravity' } }).implementer;

  it('names what changed without blaming the implementer, and recommends a retry', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      runner,
      toolMessage: 'branch escaped · hook pre-commit',
      attempts: 0,
      maxAttempts: 2,
      createdAt,
    });

    expect(issue.reason).toBe('checkout-changed');
    expect(issue.seat).toBe('build');
    expect(issue.message).toBe(
      'Your checkout changed under T001 — branch escaped · hook pre-commit',
    );
    expect(issue.details).toEqual([
      'Changed while Google Antigravity CLI ran: branch escaped · hook pre-commit',
      "Your checkout gets the run's changes only through Apply, and nothing in your checkout was reverted.",
    ]);
    expect(issue.attempts).toBeUndefined();
    expect(issue.facts).toEqual({ tool: 'Google Antigravity CLI' });
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.switchSeat).toBeUndefined();
    expectValidRecoveryIssue(issue);
  });

  it('offers no seat switch even when another ready tool was detected', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      runner,
      toolMessage: 'branch escaped',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'antigravity',
        detectedTools: [{ tool: 'codex', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.switchSeat).toBeUndefined();
  });
});

describe('buildMissingModelRecoveryIssue', () => {
  it('names the unlisted model and the tool that does not list it', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T023' }),
      runner: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-nope' },
      }).implementer,
      toolMessage: 'model not found: gpt-nope',
      createdAt,
    });

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toBe(
      'Model gpt-nope is not listed by OpenAI Codex CLI; pick a listed model',
    );
    expect(issue.facts?.model).toBe('gpt-nope');
    expectValidRecoveryIssue(issue);
  });

  it('a recipe-invalid halt offers the seat switch', () => {
    const issue = buildMissingModelRecoveryIssue({
      task: makeTask({ id: 'T023' }),
      runner: makeConfig({
        implementer: { kind: 'cli', tool: 'codex', model: 'gpt-nope' },
      }).implementer,
      toolMessage: 'model not found: gpt-nope',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'claude-code', model: 'sonnet', ready: true },
        ],
      },
    });

    expect(issue.message).toContain('pick a listed model');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRepeatedTimeoutRecoveryIssue', () => {
  it('reports the repeated timeout and recommends the retry when no other tool is ready', () => {
    const issue = buildRepeatedTimeoutRecoveryIssue({
      task: makeTask({ id: 'T024' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: 'implementer timed out',
      attempts: 2,
      maxAttempts: 3,
      createdAt,
    });

    expect(issue.reason).toBe('runner-timeout-repeated');
    expect(issue.message).toContain('timed out twice in a row on T024');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('offers and recommends the seat switch when another ready tool exists', () => {
    const issue = buildRepeatedTimeoutRecoveryIssue({
      task: makeTask({ id: 'T024' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: 'implementer timed out',
      attempts: 2,
      maxAttempts: 3,
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [{ tool: 'claude-code', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildApprovalDeniedRecoveryIssue', () => {
  it('carries the denied files and the denial reason', () => {
    const issue = buildApprovalDeniedRecoveryIssue({
      task: makeTask({ id: 'T025', suggestedFiles: ['src/main.ts'] }),
      createdAt,
      deniedFiles: ['src/secret.ts'],
      denialReason: 'operator denied',
    });

    expect(issue.reason).toBe('approval-denied');
    expect(issue.files).toEqual(['src/secret.ts']);
    expect(issue.details.join('\n')).toContain('Denied: operator denied');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildSnapshotFailedRecoveryIssue', () => {
  it('explains that scope cannot be enforced and offers the retry', () => {
    const issue = buildSnapshotFailedRecoveryIssue({
      task: makeTask({ id: 'T026' }),
      createdAt,
      detail: 'git status failed: not a repository',
    });

    expect(issue.reason).toBe('snapshot-failed');
    expect(issue.details).toEqual([
      'git status failed: not a repository',
      'Scope and revert cannot be enforced without the snapshot.',
    ]);
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildReviewFailedRecoveryIssue', () => {
  it('counts the blocking findings and offers a correction or the end, recommending the correction', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 3,
      detail: 'Critical: missing test for the new route',
    });

    expect(issue.reason).toBe('review-failed');
    expect(issue.phase).toBe('final-review');
    expect(issue.message).toBe('Final review failed with 3 blocking findings');
    expect(issue.availableActions).toEqual(['revise', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it('offers accept as is on a reviewed workspace', () => {
    const issue = buildReviewFailedRecoveryIssue({ createdAt, blocking: 1, acceptAsIs: true });

    expect(issue.availableActions).toEqual(['revise', 'accept-as-is', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it('offers a retry on the review seat when the review reached no verdict', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      failure: { kind: 'call-failed', code: 'exit-1', message: 'Review call failed.' },
    });

    expect(issue.seat).toBe('review');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRunnerInputTooLargeRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer;

  it('halts the seat with no retry, since a retry sends the same prompt', () => {
    const issue = buildRunnerInputTooLargeRecoveryIssue({
      task: makeTask({ id: 'T030' }),
      runner,
      toolMessage: 'Input exceeds the maximum length',
      createdAt,
    });

    expect(issue.reason).toBe('context-overflow');
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });

  it('offers and recommends the seat switch when another ready tool exists', () => {
    const issue = buildRunnerInputTooLargeRecoveryIssue({
      task: makeTask({ id: 'T030' }),
      runner,
      toolMessage: 'Input exceeds the maximum length',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [{ tool: 'claude-code', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual(['switch-seat', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('recoveryBuilderForRunnerOutcome', () => {
  it('maps every runner defect to its builder and nothing else', () => {
    expect(recoveryBuilderForRunnerOutcome('implementer-recipe-invalid')).toBe(
      buildRecipeInvalidRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('missing-model')).toBe(buildMissingModelRecoveryIssue);
    expect(recoveryBuilderForRunnerOutcome('implementer-left-isolation')).toBe(
      buildLeftIsolationRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('checkout-changed')).toBe(
      buildCheckoutChangedRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('runner-timeout-repeated')).toBe(
      buildRepeatedTimeoutRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('timeout')).toBeUndefined();
    expect(recoveryBuilderForRunnerOutcome('unauthenticated')).toBeUndefined();
  });
});
