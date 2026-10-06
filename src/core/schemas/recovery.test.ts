import { describe, expect, it } from 'vitest';
import { RecoveryIssueSchema } from './recovery/schemas.js';

const saved = {
  id: 'rec_2026_04_28_002',
  phase: 'implementing',
  status: 'awaiting-user',
  files: [],
  affectedTaskIds: [],
  message: 'Halted',
  details: [],
  createdAt: '2026-04-28T12:00:00.000Z',
} as const;

describe('RecoveryIssueSchema', () => {
  it('rejects a recommended action that is not available', () => {
    const result = RecoveryIssueSchema.safeParse({
      ...saved,
      reason: 'review-failed',
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'continue',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a selected action that is not available', () => {
    const result = RecoveryIssueSchema.safeParse({
      ...saved,
      reason: 'review-failed',
      status: 'applying',
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
      selectedAction: 'continue',
    });

    expect(result.success).toBe(false);
  });

  it('reads a halt an older run saved with a pause into the actions its halt still offers', () => {
    const issue = RecoveryIssueSchema.parse({
      ...saved,
      reason: 'runner-usage-limit',
      status: 'paused',
      availableActions: [
        'retry-same-worker',
        'route-bigger-worker',
        'switch-seat',
        'skip-current-task',
        'pause-run',
        'end-run',
      ],
      recommendedAction: 'pause-run',
      selectedAction: 'pause-run',
    });

    expect(issue.status).toBe('awaiting-user');
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.selectedAction).toBeUndefined();
  });

  it("maps an old run's revise-spec onto revise and keeps a retired cause readable", () => {
    const issue = RecoveryIssueSchema.parse({
      ...saved,
      reason: 'constitution-check-failed',
      availableActions: ['revise-spec', 'end-run'],
      recommendedAction: 'revise-spec',
    });

    expect(issue.reason).toBe('constitution-check-failed');
    expect(issue.availableActions).toEqual(['revise', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
  });

  it('drops an action the cause no longer offers on its halt', () => {
    const issue = RecoveryIssueSchema.parse({
      ...saved,
      reason: 'checkout-changed',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
    });

    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
  });

  it('keeps End run when nothing an old halt offered is left', () => {
    const issue = RecoveryIssueSchema.parse({
      ...saved,
      reason: 'scope-violation',
      availableActions: ['pause-run', 'planner-split-rebase'],
      recommendedAction: 'pause-run',
    });

    expect(issue.availableActions).toEqual(['end-run']);
    expect(issue.recommendedAction).toBe('end-run');
  });
});

describe('RecoveryIssueSchema, unknown saved actions', () => {
  it('still refuses an action name no release ever offered', () => {
    const result = RecoveryIssueSchema.safeParse({
      ...saved,
      reason: 'retry-exhausted',
      availableActions: ['retry-same-worker', 'teleport'],
      recommendedAction: 'retry-same-worker',
    });

    expect(result.success).toBe(false);
  });
});
