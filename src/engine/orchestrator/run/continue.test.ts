import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OwnedResumeState } from '../../../core/state/resume-hydration.js';
import { createInitialState } from '../../../core/state/machine.js';
import { composeContinuation } from '../../spec/prompts/continuation.js';
import { continueRun, type ContinueRunDeps } from './continue.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';

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
