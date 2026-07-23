import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import {
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
  buildRetryExhaustedRecoveryIssue,
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
  it('builds retry-exhausted issues without ordinary retry unless override is explicit', () => {
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
    expect(issue.availableActions).not.toContain('planner-split-rebase');
    expectValidRecoveryIssue(issue);

    const override = buildRetryExhaustedRecoveryIssue({
      task,
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

    expect(explicitlyUnavailableRoute.availableActions).toEqual(
      expect.arrayContaining(['pause-run', 'abort-workflow']),
    );
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
