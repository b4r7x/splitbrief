import { describe, expect, it } from 'vitest';
import { WIDE, endedInBuild, makeView } from '#testing/helpers/factories/summary-view.js';
import type { SummaryView } from './view-model.js';
import { taskId } from '../../../core/schemas/task.js';
import { bylineText, legendText, openRunByline, stepWord } from './byline.js';

describe('bylineText', () => {
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
      scope: { kind: 'checked', passed: false, score: 0.6, errors: 1, warnings: 1 },
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
      scope: { kind: 'checked', passed: false, score: 0.6, errors: 1, warnings: 1 },
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

  it('names the brief a paused run is holding, then the key that moves it', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'paused', at: 'mid-step' },
          resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
        },
      }),
    ).toBe('Paused at T003 · type a correction or ⏎ to continue');
  });

  it('names the gate a waiting run is parked at', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'waiting', gate: 'spec' },
          resumeAt: { kind: 'gate', gate: 'spec' },
        },
      }),
    ).toBe('Waiting at the spec gate · ⏎ to reopen it');
  });

  it('quotes the halt headline rather than the raw reason', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: {
            kind: 'halted',
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
              availableActions: ['switch-seat', 'end-run'],
              recommendedAction: 'switch-seat',
              createdAt: '2026-09-14T00:00:00.000Z',
            },
          },
          resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 1 },
        },
      }),
    ).toBe('Halted · Signed out of codex · ⏎ to decide');
  });

  it('quotes the error a failed run recorded', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'failed', message: 'Planning failed.' },
          resumeAt: { kind: 'planner', call: 'spec' },
        },
      }),
    ).toBe('Stopped by an error · Planning failed. · ⏎ to retry the step');
  });

  it('names the step an interrupted run picks up at', () => {
    expect(
      openRunByline({
        ...OPEN,
        status: {
          kind: 'open',
          stop: { kind: 'interrupted' },
          resumeAt: { kind: 'planner', call: 'tasks' },
        },
      }),
    ).toBe('Interrupted · ⏎ to continue from the tasks step');
  });

  it('says why a run nothing can pick up cannot be continued', () => {
    expect(
      openRunByline({
        continuable: false,
        width: WIDE,
        status: {
          kind: 'open',
          stop: { kind: 'failed', message: 'Session has no saved state to read.' },
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

  it('sheds the reason before the action when the line will not fit', () => {
    const status = {
      kind: 'open',
      stop: { kind: 'paused', at: 'mid-step' },
      resumeAt: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
    } as const;
    expect(openRunByline({ continuable: true, status, width: 30 })).toBe(
      'Type a correction or ⏎ to con…',
    );
  });
});

describe('stepWord', () => {
  it.each([
    [{ kind: 'planner', call: 'spec' } as const, 'the spec step'],
    [{ kind: 'gate', gate: 'briefs' } as const, 'the briefs gate'],
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
