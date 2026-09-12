import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import {
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
  buildRetryExhaustedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
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
    costPosture: 'No capable implementer profile; no cost tier selected',
    reason: 'No capable implementer profile can fit this task prompt',
    rejected: [
      {
        profile: 'local-qwen',
        costTier: 'local',
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
      expect.arrayContaining([
        'route-bigger-worker',
        'skip-current-task',
        'pause-run',
        'abort-workflow',
      ]),
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
      'abort-workflow',
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
      expect.arrayContaining(['route-bigger-worker', 'pause-run', 'abort-workflow']),
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
    expect(withoutRoute.availableActions).toEqual(
      expect.arrayContaining(['pause-run', 'abort-workflow']),
    );
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
      expect.arrayContaining(['pause-run', 'abort-workflow']),
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
      expect.arrayContaining(['skip-current-task', 'pause-run', 'abort-workflow']),
    );
    expect(issue.availableActions).not.toContain('planner-split-rebase');
    expect(issue.recommendedAction).toBe('pause-run');
    expectValidRecoveryIssue(issue);
  });
});
