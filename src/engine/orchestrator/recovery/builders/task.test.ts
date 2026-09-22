import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import {
  buildApprovalDeniedRecoveryIssue,
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
  buildMissingModelRecoveryIssue,
  buildRecipeInvalidRecoveryIssue,
  buildRepeatedTimeoutRecoveryIssue,
  buildRetryExhaustedRecoveryIssue,
  buildReviewFailedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  buildScopeViolationRecoveryIssue,
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
  it('escalates to a bigger worker without offering ordinary retry', () => {
    const task = makeTask({ id: 'T012' });

    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      maxAttempts: 3,
      routeBiggerProfile: 'agent-cli',
    });

    expect(issue.reason).toBe('retry-exhausted');
    expect(issue.phase).toBe('escalating');
    expect(issue.recommendedAction).toBe('route-bigger-worker');
    expect(issue.availableActions).toEqual(
      expect.arrayContaining(['route-bigger-worker', 'skip-current-task', 'pause-run', 'end-run']),
    );
    expect(issue.availableActions).not.toContain('retry-same-worker');
    expect(issue.availableActions).not.toContain('planner-split-rebase');
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
    expect(override.availableActions).toContain('retry-same-worker');
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

  it('quotes both voices and spells the hinted attempt', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      hintRungRan: true,
      handBack: 'I could not find the prop.',
      plannerHint: 'Add a default instead.',
    });

    expect(issue.details).toContain('Attempts: 4 (3 local, then 1 with planner hints)');
    expect(issue.details).toContain('Implementer said: I could not find the prop.');
    expect(issue.details).toContain('Planner said: Add a default instead.');
    expect(issue.facts?.hintRungRan).toBe(true);
    expect(issue.facts?.plannerVerdict).toBeUndefined();
    expectValidRecoveryIssue(issue);
  });

  it('adds no voice rows when neither party spoke', () => {
    const issue = buildRetryExhaustedRecoveryIssue({ ...bothVoices, hintRungRan: true });

    expect(issue.details.some((row) => row.startsWith('Implementer said:'))).toBe(false);
    expect(issue.details.some((row) => row.startsWith('Planner said:'))).toBe(false);
  });

  it('states a bare count and no hint-rung fact when the hint rung did not run', () => {
    const issue = buildRetryExhaustedRecoveryIssue(bothVoices);

    expect(issue.details).toContain('Attempts: 4');
    expect(issue.details.some((row) => row.includes('4/3'))).toBe(false);
    expect(issue.facts?.hintRungRan).toBeUndefined();
  });

  it('bounds a long hand-back row to the summary length', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      handBack: 'x'.repeat(2000),
    });
    const row = issue.details.find((detail) => detail.startsWith('Implementer said:'));

    expect(row?.length).toBeLessThanOrEqual(320);
    expect(row?.endsWith('...')).toBe(true);
  });

  it('names the brief-is-wrong verdict with the planner diagnosis', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      ...bothVoices,
      attempts: 1,
      handBack: 'May I edit src/consumer.ts?',
      plannerHint: 'VERDICT: brief — the export was already deleted\nNothing to retry.',
      plannerVerdict: 'brief',
    });

    expect(issue.details).toContain(
      'Planner verdict: the brief itself is wrong — the export was already deleted',
    );
    expect(issue.facts?.plannerVerdict).toBe('brief');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRunnerUsageLimitRecoveryIssue', () => {
  // Captured live from `codex exec --json` on 2026-08-06.
  const codexLimit =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 3:27 PM.";

  it('names the reset time, keeps the tool message verbatim, and never suggests logging in', () => {
    const issue = buildRunnerUsageLimitRecoveryIssue({
      task: makeTask({ id: 'T003' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: codexLimit,
      attempts: 1,
      maxAttempts: 3,
      createdAt,
    });

    expect(issue.reason).toBe('runner-usage-limit');
    expect(issue.message).toContain('hit its usage limit');
    expect(issue.message).toContain('Aug 8, 2026, 3:27 PM');
    expect(issue.message).not.toMatch(/log ?in|log ?out/i);
    expect(issue.details.join('\n')).toContain(codexLimit);
    expect(issue.details.join('\n')).toContain('stopped instead of escalating');
    expect(issue.facts?.resetsAt).toMatch(/^2026-08-08T/);
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'pause-run',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('pause-run');
    expectValidRecoveryIssue(issue);
  });

  it('offers and recommends the profile switch when a bigger worker exists', () => {
    const issue = buildRunnerUsageLimitRecoveryIssue({
      task: makeTask({ id: 'T003' }),
      runner: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
        },
      }).implementer,
      toolMessage:
        'Rate limit reached for model `llama-3.3-70b-versatile`. Please try again in 7.66s.',
      routeBiggerProfile: 'cloud-big',
      createdAt,
    });

    expect(issue.availableActions).toContain('route-bigger-worker');
    expect(issue.recommendedAction).toBe('route-bigger-worker');
    expect(issue.facts?.routeBiggerProfile).toBe('cloud-big');
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
    expect(issue.availableActions).toContain('switch-seat');
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
  it('builds context-overflow issues with route-bigger only when a larger worker is available', () => {
    const task = makeTask({ id: 'T013', file: 'src/large.ts' });
    const routingDecision = overflowRoutingDecision({ taskId: task.id });

    const withRoute = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision,
      routeBiggerProfile: 'frontier-big',
    });

    expect(withRoute.reason).toBe('context-overflow');
    expect(withRoute.recommendedAction).toBe('route-bigger-worker');
    expect(withRoute.availableActions).toEqual(
      expect.arrayContaining(['route-bigger-worker', 'pause-run', 'end-run']),
    );
    expect(withRoute.availableActions).not.toContain('planner-split-rebase');
    expect(withRoute.facts).toMatchObject({
      estimatedTokens: 45_000,
      contextLength: 32_768,
      routeBiggerProfile: 'frontier-big',
    });
    expectValidRecoveryIssue(withRoute);

    const withoutRoute = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision,
    });

    expect(withoutRoute.recommendedAction).toBe('pause-run');
    expect(withoutRoute.availableActions).toEqual(expect.arrayContaining(['pause-run', 'end-run']));
    expect(withoutRoute.availableActions).not.toContain('planner-split-rebase');
    expectValidRecoveryIssue(withoutRoute);

    const explicitlyUnavailableRoute = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision,
      routeBiggerProfile: 'frontier-big',
      canRouteBigger: false,
    });

    expect(explicitlyUnavailableRoute.recommendedAction).toBe('pause-run');
    expect(explicitlyUnavailableRoute.availableActions).toEqual(
      expect.arrayContaining(['pause-run', 'end-run']),
    );
    expect(explicitlyUnavailableRoute.availableActions).not.toContain('route-bigger-worker');
    expect(explicitlyUnavailableRoute.availableActions).not.toContain('planner-split-rebase');
    expectValidRecoveryIssue(explicitlyUnavailableRoute);
  });
});

describe('buildDependencyBlockedRecoveryIssue', () => {
  it('builds dependency-blocked issues with affected tasks and safe actions', () => {
    const dependency = makeTask({ id: 'T018', file: 'src/base.ts', status: 'failed' });
    const task = makeTask({
      id: 'T019',
      file: 'src/followup.ts',
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
    expect(issue.availableActions).toEqual(
      expect.arrayContaining(['skip-current-task', 'pause-run', 'end-run']),
    );
    expect(issue.availableActions).not.toContain('planner-split-rebase');
    expect(issue.recommendedAction).toBe('pause-run');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildScopeViolationRecoveryIssue', () => {
  it('lists the undeclared writes and recommends the revert retry', () => {
    const issue = buildScopeViolationRecoveryIssue({
      task: makeTask({ id: 'T021', file: 'src/main.ts' }),
      createdAt,
      undeclaredFiles: ['src/other.ts', 'README.md'],
      attempts: 1,
      maxAttempts: 2,
      tool: 'Codex',
    });

    expect(issue.reason).toBe('scope-violation');
    expect(issue.files).toEqual(['README.md', 'src/other.ts']);
    expect(issue.details.join('\n')).toContain('Undeclared writes: src/other.ts, README.md');
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.facts?.tool).toBe('Codex');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRecipeInvalidRecoveryIssue', () => {
  it('names the tool that refused the command line and never recommends a retry', () => {
    const issue = buildRecipeInvalidRecoveryIssue({
      task: makeTask({ id: 'T022' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: "error: unknown option '--nope'",
      createdAt,
    });

    expect(issue.reason).toBe('implementer-recipe-invalid');
    expect(issue.message).toContain('rejected the command');
    expect(issue.details.join('\n')).toContain("unknown option '--nope'");
    expect(issue.recommendedAction).toBe('pause-run');
    expect(issue.availableActions).not.toContain('skip-current-task');
    expect(issue.availableActions).not.toContain('switch-seat');
    expectValidRecoveryIssue(issue);
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
    expect(issue.availableActions).toContain('switch-seat');
    expect(issue.switchSeat).toEqual({
      seat: 'build',
      candidates: [{ tool: 'claude-code', model: 'sonnet' }],
    });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildRepeatedTimeoutRecoveryIssue', () => {
  it('reports the repeated timeout without offering a bigger worker', () => {
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
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'pause-run',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('pause-run');
    expectValidRecoveryIssue(issue);
  });

  it('offers the seat switch and the bigger worker when both exist', () => {
    const issue = buildRepeatedTimeoutRecoveryIssue({
      task: makeTask({ id: 'T024' }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }).implementer,
      toolMessage: 'implementer timed out',
      attempts: 2,
      maxAttempts: 3,
      routeBiggerProfile: 'cloud-big',
      createdAt,
      seatSwap: {
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [{ tool: 'claude-code', ready: true }],
      },
    });

    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'route-bigger-worker',
      'switch-seat',
      'skip-current-task',
      'pause-run',
      'end-run',
    ]);
    expect(issue.facts?.routeBiggerProfile).toBe('cloud-big');
    expect(issue.switchSeat).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
    expectValidRecoveryIssue(issue);
  });
});

describe('buildApprovalDeniedRecoveryIssue', () => {
  it('carries the denied files and the denial reason', () => {
    const issue = buildApprovalDeniedRecoveryIssue({
      task: makeTask({ id: 'T025', file: 'src/main.ts' }),
      createdAt,
      deniedFiles: ['src/secret.ts'],
      denialReason: 'operator denied',
    });

    expect(issue.reason).toBe('approval-denied');
    expect(issue.files).toEqual(['src/secret.ts']);
    expect(issue.details.join('\n')).toContain('Denied: operator denied');
    expect(issue.recommendedAction).toBe('pause-run');
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
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildReviewFailedRecoveryIssue', () => {
  it('counts the blocking findings and leaves only pause or abort', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 3,
      detail: 'Critical: missing test for the new route',
    });

    expect(issue.reason).toBe('review-failed');
    expect(issue.phase).toBe('final-review');
    expect(issue.message).toBe('Final review failed with 3 blocking findings');
    expect(issue.availableActions).toEqual(['pause-run', 'end-run']);
    expect(issue.recommendedAction).toBe('pause-run');
    expectValidRecoveryIssue(issue);
  });
});

describe('recoveryBuilderForRunnerOutcome', () => {
  it('maps every runner defect to its builder and nothing else', () => {
    expect(recoveryBuilderForRunnerOutcome('implementer-recipe-invalid')).toBe(
      buildRecipeInvalidRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('missing-model')).toBe(buildMissingModelRecoveryIssue);
    expect(recoveryBuilderForRunnerOutcome('runner-timeout-repeated')).toBe(
      buildRepeatedTimeoutRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('timeout')).toBeUndefined();
    expect(recoveryBuilderForRunnerOutcome('unauthenticated')).toBeUndefined();
  });
});
