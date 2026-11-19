import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import { createdAt, expectValidRecoveryIssue } from '#testing/helpers/recovery-issue.js';
import { buildCheckoutChangedRecoveryIssue, buildLeftIsolationRecoveryIssue } from './isolation.js';

describe('buildLeftIsolationRecoveryIssue', () => {
  const runner = makeConfig({ implementer: { kind: 'cli', tool: 'antigravity' } }).implementer;
  const toolMessage = 'searched ~ with run_command: find ~ -name "process-invoke.ts" 2>/dev/null';

  it('halts the brief on the evidence and recommends a retry', () => {
    const issue = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage,
      attempts: 0,
      createdAt,
    });

    expect(issue.reason).toBe('implementer-left-isolation');
    expect(issue.seat).toBe('build');
    expect(issue.message).toBe(
      `T004 left the isolation directory · Google Antigravity CLI ${toolMessage}`,
    );
    expect(issue.details).toEqual([
      `Google Antigravity CLI ${toolMessage}`,
      "Your checkout gets the run's changes only through Apply.",
    ]);
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

  it('says the files stay on a kept halt, and the put-back folder on a halt that puts them back, never promoted', () => {
    const left = buildLeftIsolationRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage: 'wrote to ~/x with Bash: touch ~/x',
      attempts: 0,
      inPlace,
      createdAt,
    });
    const changed = buildCheckoutChangedRecoveryIssue({
      task: makeTask({ id: 'T004' }),
      runner,
      toolMessage: 'branch topic',
      attempts: 0,
      inPlace,
      createdAt,
    });

    expect(left.details[1]).toBe('The files this attempt changed stay in your checkout.');
    expect(changed.details[1]).toBe(
      'SPLITBRIEF puts back checkout files it can attribute to this attempt. The replaced files are saved in .splitbrief/sessions/s1/reverted when it puts files back. The git change stays for you to check.',
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
      createdAt,
    });

    expect(issue.reason).toBe('checkout-changed');
    expect(issue.seat).toBe('build');
    expect(issue.message).toBe('Repository changed under T001 · branch escaped · hook pre-commit');
    expect(issue.details).toEqual([
      'Changed while Google Antigravity CLI ran; the audit cannot tell who made the change.',
      "Your checkout gets the run's changes only through Apply, and nothing in your checkout was reverted.",
    ]);
    expect(issue.facts).toEqual({
      tool: 'Google Antigravity CLI',
      changes: 'branch escaped · hook pre-commit',
    });
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.switchSeat).toBeUndefined();
    expectValidRecoveryIssue(issue);
  });

  // In a real run, another session created a worktree on a new branch during T004's call. The
  // checkout's HEAD, branch and files stayed as they were, and final-group.ts is only T004's file.
  it('names the branch another session created, not the brief file, in its headline', () => {
    const issue = buildCheckoutChangedRecoveryIssue({
      task: makeTask({
        id: 'T004',
        suggestedFiles: ['src/engine/runners/cli-tools/final-group.ts'],
      }),
      runner: makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } }).implementer,
      toolMessage: 'branch fix/implementer-never-runs-gates',
      attempts: 0,
      createdAt,
    });

    expect(formatRecoveryHeadline(issue)).toBe(
      'Repository changed under T004 · branch fix/implementer-never-runs-gates',
    );
    // The Error row and the recovery headline are one sentence with one separator (UI debt #55).
    expect(issue.message).toBe(formatRecoveryHeadline(issue));
    expect(issue.files).toEqual([]);
    expect(issue.details.join(' ')).not.toContain('final-group.ts');
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
