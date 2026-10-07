import type { RunStatus } from '../../../core/sessions/run-status.js';
import { describe, expect, it } from 'vitest';
import { WIDE, endedInBuild, makeView } from '#testing/helpers/factories/summary-view.js';
import type { SummaryView } from './view-model.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { taskId } from '../../../core/schemas/task.js';
import { bylineText, legendText, openRunByline, stepWord } from './byline.js';

describe('bylineText', () => {
  it('offers the undo on an applied run', () => {
    expect(bylineText(makeView({ outcome: { kind: 'applied' } }), WIDE)).toBe(
      'Undo the Apply with /run reject confirm',
    );
  });

  it('says how to bring the changes of a discarded run back', () => {
    const view = makeView({
      outcome: { kind: 'discarded' },
      files: {
        ...makeView().files,
        patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
      },
    });
    expect(bylineText(view, WIDE)).toBe('Bring the changes back with git apply on the Patch file');
  });

  it('names the Patch row instead of a path a narrow line would cut', () => {
    const view = makeView({
      outcome: { kind: 'discarded' },
      files: {
        ...makeView().files,
        patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
      },
    });
    expect(bylineText(view, 56)).toBe('Bring the changes back with git apply on the Patch file');
  });

  it('offers no git apply for a discarded run that saved no changes', () => {
    expect(bylineText(makeView({ outcome: { kind: 'discarded' } }), WIDE)).toBe('esc home');
  });

  it('says how to bring the changes of an ended workspace run back', () => {
    const view = endedInBuild();
    expect(
      bylineText(
        {
          ...view,
          files: {
            ...view.files,
            patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
          },
        },
        WIDE,
      ),
    ).toBe('Bring the changes back with git apply on the Patch file');
  });

  it('offers both choices on a ready run', () => {
    expect(bylineText(makeView(), WIDE)).toBe(
      'Keep it with /run accept, or revert it with /run reject confirm',
    );
  });

  it('points at the blocking findings first', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      review: {
        kind: 'written',
        verdict: 'fail',
        counts: { critical: 2, warning: 1, note: 0 },
        markdownPath: 'review-packet.md',
        driftPassed: false,
        evidence: { validated: 3, total: 3 },
        missingArtifacts: 0,
      },
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 1 },
    });
    expect(bylineText(view, WIDE)).toBe(
      'Read the 2 blocking findings in the packet, or revert it with /run reject confirm',
    );
  });

  it('points at the scope deviations when nothing is blocking', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      review: {
        ...makeView().review,
        counts: { critical: 0, warning: 1, note: 0 },
      } as SummaryView['review'],
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 1 },
    });
    expect(bylineText(view, WIDE)).toBe(
      'Check the 2 scope deviations in the packet, or revert it with /run reject confirm',
    );
  });

  it('points at the failed briefs when the review and the scope are clean', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      briefs: {
        total: 3,
        passed: 2,
        local: 2,
        escalated: 0,
        failed: 1,
        skipped: 0,
        rows: [],
        earlierRows: [],
      },
    });
    expect(bylineText(view, WIDE)).toBe(
      'Fix the failed brief, or revert it with /run reject confirm',
    );
    const two = makeView({
      outcome: { kind: 'needs-attention' },
      briefs: {
        total: 3,
        passed: 1,
        local: 1,
        escalated: 0,
        failed: 2,
        skipped: 0,
        rows: [],
        earlierRows: [],
      },
    });
    expect(bylineText(two, WIDE)).toBe(
      'Fix the 2 failed briefs, or revert it with /run reject confirm',
    );
  });

  it('offers the same two choices when a run needing attention points at nothing specific', () => {
    const view = makeView({ outcome: { kind: 'needs-attention' }, review: { kind: 'not-run' } });
    expect(bylineText(view, WIDE)).toBe(
      'Keep it with /run accept, or revert it with /run reject confirm',
    );
  });

  it('sends an ended run home, because there is nothing left to accept', () => {
    expect(bylineText(endedInBuild(), WIDE)).toBe('esc home');
  });

  it('reports a decided checkpoint instead of offering one', () => {
    expect(bylineText(makeView({ checkpoint: 'accepted' }), WIDE)).toBe(
      'Accepted · nothing left to do',
    );
    expect(bylineText(makeView({ checkpoint: 'rejected' }), WIDE)).toBe(
      'Rejected · its files were restored',
    );
  });

  it('drops the alternative before it cuts a word', () => {
    expect(bylineText(makeView(), 40)).toBe('Keep it with /run accept');
  });

  it('truncates only when even the first choice will not fit', () => {
    expect(bylineText(makeView(), 10)).toHaveLength(10);
  });
});

describe('openRunByline', () => {
  const OPEN = { continuable: true, width: WIDE } as const;

  it('points a run ready to apply at its result menu', () => {
    expect(
      openRunByline({
        continuable: false,
        width: WIDE,
        status: { kind: 'ready-to-apply', override: false },
      }),
    ).toBe('Ready to apply · pick Apply, Show diff or Discard');
  });

  it('says an override is applied as is', () => {
    expect(
      openRunByline({
        continuable: false,
        width: WIDE,
        status: { kind: 'ready-to-apply', override: true },
      }),
    ).toBe('Ready to apply as is · pick Apply as is, Show diff or Discard');
  });

  it('names the brief a paused run is holding, then the key that moves it', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
          resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
        },
      }),
    ).toBe('Stopped at T003 · type a correction or ⏎ to continue');
  });

  it('reopens the plan card a run with a typed plan is parked at', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate: 'plan', reopens: true } },
          resumeAt: { kind: 'gate', gate: 'plan' },
        },
      }),
    ).toBe('Waiting at the plan · ⏎ to reopen it');
  });

  it.each(['spec', 'plan', 'briefs'] as const)(
    'continues an old run parked at its %s gate as the plan stage, without reopening it',
    (gate) => {
      expect(
        openRunByline({
          ...OPEN,
          status: {
            kind: 'open',
            stop: { kind: 'waiting-for-you', on: { kind: 'gate', gate, reopens: false } },
            resumeAt: { kind: 'gate', gate },
          },
        }),
      ).toBe('Waiting at the plan · ⏎ to continue');
    },
  );

  it('names a seat-down halt and quotes its headline rather than the raw reason', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: {
            kind: 'waiting-for-you',
            on: {
              kind: 'halt',
              issue: {
                id: 'h1',
                reason: 'runner-unauthenticated',
                phase: 'implementing',
                status: 'awaiting-user',
                files: [],
                affectedTaskIds: [],
                message: 'Signed out',
                details: [],
                facts: { tool: 'codex' },
                availableActions: ['retry-same-worker', 'end-run'],
                recommendedAction: 'retry-same-worker',
                createdAt: '2026-09-14T00:00:00.000Z',
              },
            },
          },
          resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
        },
      }),
    ).toBe('Seat down · Signed out of codex · ⏎ to decide');
  });

  it('names a halt only the operator can decide as needing you', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: makeRecoveryIssue() } },
          resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 3 },
        },
      }),
    ).toBe('Needs you · T001 failed · ⏎ to decide');
  });

  it('asks for the answer a run waiting on a question needs', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'question' } },
          resumeAt: { kind: 'planner', call: 'plan' },
        },
      }),
    ).toBe('Waiting for your answer · type a reply or ⏎ to continue');
  });

  it('quotes the error a failed run recorded', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'failed', message: 'Planning failed.' } },
          resumeAt: { kind: 'planner', call: 'spec' },
        },
      }),
    ).toBe('Stopped by an error · Planning failed. · ⏎ to retry the step');
  });

  it('names the tool a run waits on and the clock its reset lands', () => {
    const resetAt = new Date(new Date().setHours(17, 0, 0, 0)).toISOString();
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: {
            kind: 'stopped',
            on: { kind: 'seat-wait', seat: 'review', tool: 'codex', resetAt },
          },
          resumeAt: { kind: 'review', cycle: 0 },
        },
      }),
    ).toBe('Waiting for codex · resets 17:00');
  });

  it('names the step an interrupted run picks up at', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'planner', call: 'tasks' },
        },
      }),
    ).toBe('Stopped at the plan · ⏎ to continue');
  });

  it('says why a run nothing can pick up cannot be continued', () => {
    expect(
      openRunByline({
        continuable: false,
        width: WIDE,
        status: {
          kind: 'open',
          stop: {
            kind: 'stopped',
            on: { kind: 'failed', message: 'Session has no saved state to read.' },
          },
          resumeAt: { kind: 'planner', call: 'research' },
        },
      }),
    ).toBe('Saved state unreadable · start it again from home');
  });

  it('says a run another process is driving is not this screen to move', () => {
    expect(openRunByline({ ...OPEN, status: { kind: 'running' } })).toBe(
      'Running in another process',
    );
  });

  it('keeps the halt name when a narrow line cannot hold its cause', () => {
    const status: RunStatus = {
      kind: 'open',
      stop: {
        kind: 'waiting-for-you',
        on: {
          kind: 'halt',
          issue: {
            id: 'h1',
            reason: 'implementer-left-isolation',
            phase: 'implementing',
            status: 'awaiting-user',
            files: [],
            affectedTaskIds: [],
            message: 'T002 left the isolation directory',
            details: [],
            availableActions: ['retry-same-worker', 'end-run'],
            recommendedAction: 'retry-same-worker',
            createdAt: '2026-09-14T00:00:00.000Z',
          },
        },
      },
      resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
    };
    expect(openRunByline({ continuable: true, status, width: 40 })).toBe('Seat down · ⏎ to decide');
  });

  it('sheds the reason before the action when the line will not fit', () => {
    const status = {
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
      resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
    } as const;
    expect(openRunByline({ continuable: true, status, width: 30 })).toBe(
      'Type a correction or ⏎ to con…',
    );
  });
});

describe('stepWord', () => {
  it.each([
    [{ kind: 'planner', call: 'spec' } as const, 'the plan'],
    [{ kind: 'planner', call: 'plan' } as const, 'the plan'],
    [{ kind: 'gate', gate: 'briefs' } as const, 'the plan'],
    [{ kind: 'brief', taskId: taskId('T007'), attempt: 0 } as const, 'T007'],
    [{ kind: 'review', cycle: 1 } as const, 'the review'],
  ])('names %o as %s', (step, word) => {
    expect(stepWord(step)).toBe(word);
  });
});

describe('legendText', () => {
  it('names the keys the screen answers to', () => {
    expect(legendText({ overflow: false, width: WIDE })).toBe(
      'esc home · ctrl+k commands · /sessions · /help',
    );
  });

  it('adds the scroll key next to esc only when the body overflows', () => {
    expect(legendText({ overflow: true, width: WIDE })).toBe(
      'esc home · shift+↑↓ scroll · ctrl+k commands · /sessions · /help',
    );
  });

  it('drops whole keys rather than half-naming one', () => {
    const fitted = legendText({ overflow: false, width: 30 });
    expect(fitted).toBe('esc home · ctrl+k commands');
    expect(fitted).not.toContain('…');
  });
});
