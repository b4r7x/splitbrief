import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OwnedResumeState } from '../../../core/state/resume-hydration.js';
import { createInitialState } from '../../../core/state/machine.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';
import { continueRun, type ContinueRunDeps } from './continue.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';

const REF = { projectDir: '/tmp/project', sessionId: 'sess-1' };

function makeDeps(overrides: Partial<ContinueRunDeps> & { loaded?: OwnedResumeState }): {
  deps: ContinueRunDeps;
  parked: UserMessageInput[];
  restarted: { state: WorkflowState; steer: UserMessageInput | undefined }[];
} {
  const parked: UserMessageInput[] = [];
  const restarted: { state: WorkflowState; steer: UserMessageInput | undefined }[] = [];
  const deps: ContinueRunDeps = {
    resumeParked:
      overrides.resumeParked ??
      ((steer) => {
        parked.push(steer);
        return false;
      }),
    loadState: overrides.loadState ?? (() => overrides.loaded ?? { kind: 'missing' }),
    restart: overrides.restart ?? ((input) => restarted.push(input)),
  };
  return { deps, parked, restarted };
}

function openState(): WorkflowState {
  return { ...createInitialState('feat'), phase: 'implementing' };
}

describe('continueRun', () => {
  it.each([true, false])(
    'sanitizes typed text and preserves attached content when parked is %s',
    (isParked) => {
      const displayText = ' \x1b[31mUse\x1b[0m @notes.md\x00\r\n ';
      const suffix = '\n\n--- @notes.md ---\nfirst\r\n\x1b[31mred\x1b[0m\rfinal\x00\n  ';
      const message: UserMessageInput = {
        ...plainUserMessage(displayText),
        text: displayText + suffix,
        attachedInputs: [{ path: '/real/notes.md', kind: 'text' }],
      };
      const state = openState();
      const { deps, parked, restarted } = makeDeps({
        loaded: { kind: 'loaded', state },
        resumeParked: (steer) => {
          parked.push(steer);
          return isParked;
        },
      });
      const expected = { ...message, displayText: 'Use @notes.md', text: `Use @notes.md${suffix}` };

      expect(continueRun({ ref: REF, steer: message, deps }).kind).toBe(
        isParked ? 'continued-in-place' : 'restarted',
      );
      expect(parked).toEqual([expected]);
      expect(parked[0]?.text.slice(expected.displayText.length)).toBe(suffix);
      expect(restarted).toEqual(isParked ? [] : [{ state, steer: expected }]);
      if (!isParked) {
        expect(restarted[0]?.steer?.text.slice(expected.displayText.length)).toBe(suffix);
      }
    },
  );

  it('preserves the full attached message through parked and restarted paths', () => {
    const message = {
      ...plainUserMessage('Use @notes.md'),
      text: 'Use @notes.md\n\nPELICAN-42\n  ',
      attachedInputs: [{ path: '/real/notes.md', kind: 'text' as const }],
    };
    const state = openState();
    const { deps, parked, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });
    continueRun({ ref: REF, steer: message, deps });
    expect(parked).toEqual([message]);
    expect(restarted).toEqual([{ state, steer: message }]);
  });

  it('settles a park this process holds and never touches the state', () => {
    let loads = 0;
    const { deps, parked } = makeDeps({
      resumeParked: (steer) => {
        parked.push(steer);
        return true;
      },
      loadState: () => {
        loads += 1;
        return { kind: 'missing' };
      },
    });

    expect(
      continueRun({ ref: REF, steer: plainUserMessage('try the other helper'), deps }),
    ).toEqual({
      kind: 'continued-in-place',
    });
    expect(parked).toEqual([plainUserMessage('try the other helper')]);
    expect(loads).toBe(0);
  });

  it('settles a park with an empty steer when the operator only asked to continue', () => {
    const settled: UserMessageInput[] = [];
    const { deps } = makeDeps({
      resumeParked: (steer) => {
        settled.push(steer);
        return true;
      },
    });

    expect(continueRun({ ref: REF, deps }).kind).toBe('continued-in-place');
    expect(settled).toEqual([plainUserMessage('')]);
  });

  it('re-enters a run at rest on its saved state, carrying the steer', () => {
    const state = openState();
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    expect(
      continueRun({ ref: REF, steer: plainUserMessage('  keep the old API  '), deps }),
    ).toEqual({
      kind: 'restarted',
      state,
    });
    expect(restarted).toEqual([{ state, steer: plainUserMessage('keep the old API') }]);
  });

  it('re-enters with no steer when the operator typed nothing', () => {
    const state = openState();
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    continueRun({ ref: REF, steer: plainUserMessage('   '), deps });

    expect(restarted).toEqual([{ state, steer: undefined }]);
  });

  it('keeps only what a paste may carry in the steer, on both paths into the run', () => {
    const state = openState();
    const { deps, parked, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    continueRun({
      ref: REF,
      steer: plainUserMessage('\x03\x03fix\x00 the\ttest\r\nnext\x1a'),
      deps,
    });

    expect(parked).toEqual([plainUserMessage('fix the\ttest\nnext')]);
    expect(restarted).toEqual([{ state, steer: plainUserMessage('fix the\ttest\nnext') }]);
  });

  // cursor and opencode carry the prompt in argv, and Node refuses to spawn an argument with a NUL.
  it('hands the run a steer that a prompt in argv can carry', () => {
    const state = openState();
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });
    const typed = 'fix\x00 it';
    const promptArgv = (steer: string | undefined) => [
      '-e',
      '0',
      '--',
      composeContinuation({ basePrompt: 'Build T001.', steer }),
    ];
    expect(() => spawnSync(process.execPath, promptArgv(typed))).toThrow(/null bytes/);

    continueRun({ ref: REF, steer: plainUserMessage(typed), deps });

    const spawned = spawnSync(process.execPath, promptArgv(restarted[0]?.steer?.text));
    expect(spawned.error).toBeUndefined();
    expect(spawned.status).toBe(0);
  });

  it('refuses a run that was ended', () => {
    const state: WorkflowState = {
      ...openState(),
      closed: { at: '2026-01-01T00:00:00.000Z', as: 'ended' },
    };
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    const outcome = continueRun({ ref: REF, deps });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'closed' });
    expect(restarted).toEqual([]);
  });

  it('refuses a run that passed its final review', () => {
    const state: WorkflowState = {
      ...openState(),
      phase: 'complete',
      reviewStatus: 'passed',
    };
    const { deps } = makeDeps({ loaded: { kind: 'loaded', state } });

    const outcome = continueRun({ ref: REF, deps });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'closed' });
    expect(outcome.kind === 'refused' && outcome.message).toContain('complete');
  });

  it('refuses when there is no saved state', () => {
    const { deps } = makeDeps({ loaded: { kind: 'missing' } });

    expect(continueRun({ ref: REF, deps })).toMatchObject({ kind: 'refused', reason: 'missing' });
  });

  it('refuses with the loader reason when the state cannot be read', () => {
    const { deps } = makeDeps({
      loaded: { kind: 'invalid', code: 'future-version', message: 'written by a newer version' },
    });

    expect(continueRun({ ref: REF, deps })).toEqual({
      kind: 'refused',
      reason: 'invalid',
      message: 'written by a newer version',
    });
  });
});

describe('continueRun on a run ready to apply', () => {
  it('refuses and offers Apply or Discard', () => {
    const state: WorkflowState = {
      ...openState(),
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: { kind: 'worktree', path: '/tmp/wt', base: { snapshotId: 'b', head: null } },
    };
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    const outcome = continueRun({ ref: REF, deps });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'ready-to-apply' });
    expect(outcome.kind === 'refused' && outcome.message).toMatch(/Apply.*Discard/);
    expect(restarted).toEqual([]);
  });
});

describe('continueRun on a halt whose action reads no typed words', () => {
  const WORDS = plainUserMessage('mind the lockfile');
  const WORKTREE = {
    kind: 'worktree' as const,
    path: '/tmp/wt',
    base: { snapshotId: 'b', head: null },
  };
  const CHECKOUT = {
    kind: 'checkout' as const,
    path: '/tmp/project',
    base: { snapshotId: 'b', head: null },
  };

  function halted(
    issue: Partial<RecoveryIssue>,
    workspace: WorkflowState['workspace'] = WORKTREE,
  ): WorkflowState {
    return {
      ...openState(),
      phase: 'complete',
      workspace,
      pendingRecovery: makeRecoveryIssue({ taskId: undefined, phase: 'complete', ...issue }),
    };
  }

  /** A failed review an older build saved half answered: Accept as is chosen, not yet applied. */
  const OLDER_ACCEPT: Partial<RecoveryIssue> = {
    reason: 'review-failed',
    seat: 'review',
    availableActions: ['revise', 'accept-as-is', 'end-run'],
    recommendedAction: 'revise',
    status: 'applying',
    selectedAction: 'accept-as-is',
  };
  const APPLY_PARTIAL: Partial<RecoveryIssue> = {
    reason: 'apply-partial',
    availableActions: ['retry-same-worker', 'restore-backup'],
    recommendedAction: 'retry-same-worker',
  };
  const APPLY_CONFLICT: Partial<RecoveryIssue> = {
    reason: 'apply-conflict',
    availableActions: ['retry-same-worker', 'end-run'],
    recommendedAction: 'retry-same-worker',
  };

  it.each([
    ['checkout', CHECKOUT],
    ['worktree', WORKTREE],
  ] as const)(
    'refuses words for Accept as is an older build left chosen (%s), and runs nothing',
    (_mode, workspace) => {
      const { deps, restarted } = makeDeps({
        loaded: { kind: 'loaded', state: halted(OLDER_ACCEPT, workspace) },
      });

      expect(continueRun({ ref: REF, steer: WORDS, deps })).toEqual({
        kind: 'refused',
        reason: 'takes-no-words',
        message: 'Cannot send words with Accept as is. Clear them.',
      });
      expect(restarted).toEqual([]);
    },
  );

  it('takes Accept as is an older build left chosen when nothing is typed', () => {
    const state = halted(OLDER_ACCEPT, CHECKOUT);
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    expect(continueRun({ ref: REF, steer: plainUserMessage('  '), deps }).kind).toBe('restarted');
    expect(restarted).toEqual([{ state, steer: undefined }]);
  });

  it.each([
    ['restore-backup', APPLY_PARTIAL, 'Restore backup'],
    ['retry-same-worker', APPLY_PARTIAL, 'Re-run Apply'],
    ['retry-same-worker', APPLY_CONFLICT, 'Re-run Apply'],
  ] as const)(
    'refuses words for a chosen %s on %o, and runs nothing',
    (selectedAction, issue, label) => {
      const { deps, restarted } = makeDeps({
        loaded: {
          kind: 'loaded',
          state: halted({ ...issue, status: 'applying', selectedAction }),
        },
      });

      expect(continueRun({ ref: REF, steer: WORDS, deps })).toEqual({
        kind: 'refused',
        reason: 'takes-no-words',
        message: `Cannot send words with ${label}. Clear them.`,
      });
      expect(restarted).toEqual([]);
    },
  );

  it.each([APPLY_PARTIAL, APPLY_CONFLICT])(
    'refuses words on a pending halt none of whose actions reads them (%o)',
    (issue) => {
      const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state: halted(issue) } });

      expect(continueRun({ ref: REF, steer: WORDS, deps })).toEqual({
        kind: 'refused',
        reason: 'takes-no-words',
        message: 'Cannot send words to this halt. Clear them first.',
      });
      expect(restarted).toEqual([]);
    },
  );

  it.each<[string, Partial<WorkflowState>]>([
    ['an Apply cut part way', { applying: { at: '2026-10-23T00:00:00.000Z', backupId: 'bk1' } }],
    [
      'a stop that landed on Apply',
      {
        interruptedStep: {
          step: { kind: 'apply' },
          source: 'user',
          at: '2026-10-23T00:00:00.000Z',
        },
      },
    ],
  ])('refuses words on %s with no halt: Apply reads none', (_label, extra) => {
    const state: WorkflowState = {
      ...openState(),
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: WORKTREE,
      ...extra,
    };
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    expect(continueRun({ ref: REF, steer: WORDS, deps })).toEqual({
      kind: 'refused',
      reason: 'takes-no-words',
      message: 'Cannot send words to Apply. Clear them.',
    });
    expect(restarted).toEqual([]);

    const bare = makeDeps({ loaded: { kind: 'loaded', state } });
    expect(continueRun({ ref: REF, deps: bare.deps }).kind).toBe('restarted');
    expect(bare.restarted).toEqual([{ state, steer: undefined }]);
  });

  it('opens a pending Apply halt when nothing is typed', () => {
    const state = halted(APPLY_PARTIAL);
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    expect(continueRun({ ref: REF, deps }).kind).toBe('restarted');
    expect(restarted).toEqual([{ state, steer: undefined }]);
  });

  it.each<[string, Partial<RecoveryIssue>]>([
    [
      'Skip task',
      { status: 'applying', selectedAction: 'skip-current-task', taskId: taskId('T001') },
    ],
    [
      'Retry later',
      {
        reason: 'runner-usage-limit',
        availableActions: ['retry-same-worker', 'retry-later', 'end-run'],
        status: 'applying',
        selectedAction: 'retry-later',
      },
    ],
    [
      'Change tool',
      {
        reason: 'runner-usage-limit',
        availableActions: ['retry-same-worker', 'switch-seat', 'end-run'],
        status: 'applying',
        selectedAction: 'switch-seat',
      },
    ],
    [
      'Continue',
      {
        reason: 'implementation-error',
        availableActions: ['continue', 'retry-same-worker', 'end-run'],
        status: 'applying',
        selectedAction: 'continue',
      },
    ],
    ['Fix again', { ...OLDER_ACCEPT, selectedAction: 'revise' }],
    [
      'Skip review with a note',
      {
        reason: 'review-input-too-large',
        availableActions: ['accept-as-is', 'end-run'],
        status: 'applying',
        selectedAction: 'accept-as-is',
      },
    ],
    [
      'Try again',
      { status: 'applying', selectedAction: 'retry-same-worker', taskId: taskId('T001') },
    ],
    [
      'a pending failed review',
      { ...OLDER_ACCEPT, status: 'awaiting-user', selectedAction: undefined },
    ],
    [
      'a pending halt only End run answers',
      {
        reason: 'review-input-too-large',
        availableActions: ['end-run'],
        recommendedAction: 'end-run',
      },
    ],
  ])('carries the words on as the steer for %s', (_label, issue) => {
    const state = halted(issue);
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    expect(continueRun({ ref: REF, steer: WORDS, deps }).kind).toBe('restarted');
    expect(restarted).toEqual([{ state, steer: WORDS }]);
  });
});
