import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import { createdAt, expectValidRecoveryIssue } from '#testing/helpers/recovery-issue.js';
import { buildContextOverflowRecoveryIssue } from './context-overflow.js';

function overflowRoutingDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    taskId: makeTask().id,
    requiredWriteMode: 'extracted-code',
    fit: 'overflow',
    estimatedTokens: 45_000,
    untruncatedEstimatedTokens: 48_000,
    contextLength: 32_768,
    usedConservativeContextLength: true,
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
