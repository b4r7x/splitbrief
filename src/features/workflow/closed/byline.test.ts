import type { RunStatus } from '../../../core/sessions/run/status.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIDE, endedInBuild, makeView } from '#testing/helpers/factories/summary-view.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { bylineParts, legendText, runClosedLabel } from './byline.js';
import { openRunBylineParts } from './open-byline.js';
import { NOW, bylineText, joinedByline, openRunByline } from '#testing/helpers/byline.js';

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

  it('drops ctrl+k commands while the app shortcuts are off', () => {
    expect(legendText({ overflow: false, width: WIDE, canOpenCommands: false })).toBe(
      'esc home · /sessions · /help',
    );
    expect(
      legendText({ overflow: false, width: WIDE, canGoHome: false, canOpenCommands: false }),
    ).toBe('/sessions · /help');
    expect(
      legendText({ overflow: true, width: WIDE, canGoHome: false, canOpenCommands: false }),
    ).toBe('shift+↑↓ scroll · /sessions · /help');
  });
});

it('shows an Ended receipt and fits the undo conflict warning to the row', () => {
  const undone = makeView({ applyUndo: { conflicts: ['src/a.ts'] } });
  const ended = endedInBuild();
  const endedWithPatch = {
    ...ended,
    files: { ...ended.files, patch: '.splitbrief/sessions/run/run.patch' },
  };
  expect(bylineParts(endedWithPatch, WIDE)[0]).toEqual({ text: 'Ended', tone: 'warning' });
  const full = 'Apply undone · your later edits were kept';
  expect(joinedByline(bylineParts(undone, WIDE))).toBe(full);
  for (const width of [5, 11, 12, 13, 14, 15, 16, 20]) {
    const parts = bylineParts(undone, width);
    expect(joinedByline(parts)).toBe(full.slice(0, width - 1) + '…');
    expect(parts[0]?.tone).toBe('warning');
  }
});

it('keeps the separator inside a failed reason dim', () => {
  const parts = openRunBylineParts({
    wait: null,
    planCard: false,
    failure: 'Disk full',
    status: {
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'failed' } },
      resumeAt: { kind: 'planner', call: 'plan' },
    },
    continuable: true,
    now: NOW,
    width: WIDE,
  });
  expect(parts).toEqual([
    { text: 'Stopped by an error', tone: 'error' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Disk full', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: '⏎ to retry the step', tone: 'textDim' },
  ]);
});

it('keeps the review seat in an at-rest halt title', () => {
  const issue = makeRecoveryIssue({ reason: 'planner-call-failed', seat: 'review' });
  const parts = openRunBylineParts({
    wait: null,
    planCard: false,
    failure: null,
    status: {
      kind: 'open',
      stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue } },
      resumeAt: { kind: 'review', cycle: 0 },
    },
    continuable: true,
    now: NOW,
    width: WIDE,
  });
  expect(joinedByline(parts)).toBe('Seat down · Reviewer call failed · ⏎ to decide');
  expect(parts).toEqual([
    { text: 'Seat down', tone: 'warning' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Reviewer', tone: 'reviewer' },
    { text: ' call failed', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: '⏎ to decide', tone: 'textDim' },
  ]);
});

it('names the chosen Continue of a failed review under REVIEW None', () => {
  const status: RunStatus = {
    kind: 'open',
    stop: {
      kind: 'waiting-for-you',
      on: {
        kind: 'halt',
        issue: makeRecoveryIssue({
          reason: 'review-failed',
          status: 'applying',
          selectedAction: 'revise',
        }),
      },
    },
    resumeAt: { kind: 'apply' },
    reviewNone: true,
  };
  const line = openRunByline({
    wait: null,
    planCard: false,
    failure: null,
    status,
    continuable: true,
    width: 80,
    now: NOW,
  });
  expect(line).toContain('⏎ to continue');
  expect(line).not.toContain('review again');
});

it('keeps the chosen Review again of a failed review with a review seat', () => {
  const status: RunStatus = {
    kind: 'open',
    stop: {
      kind: 'waiting-for-you',
      on: {
        kind: 'halt',
        issue: makeRecoveryIssue({
          reason: 'review-failed',
          status: 'applying',
          selectedAction: 'revise',
        }),
      },
    },
    resumeAt: { kind: 'apply' },
  };
  expect(
    openRunByline({
      wait: null,
      planCard: false,
      failure: null,
      status,
      continuable: true,
      width: 80,
      now: NOW,
    }),
  ).toContain('⏎ to review again');
});

describe('runClosedLabel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says when the run closed with its date, on the day it closed too', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const closedToday = new Date(2026, 9, 10, 9, 5, 0, 0).getTime();
    const closedEarlier = new Date(2026, 9, 8, 21, 14, 0, 0).getTime();
    expect(runClosedLabel(closedToday)).toBe('Run closed · Oct 10, 09:05');
    expect(runClosedLabel(closedEarlier)).toBe('Run closed · Oct 8, 21:14');
  });

  it('says only that the run closed when its record kept no time', () => {
    expect(runClosedLabel(null)).toBe('Run closed');
  });
});

it('leaves the undo receipt in the summary when no conflicts need attention', () => {
  expect(bylineText(makeView({ applyUndo: { conflicts: [] } }), WIDE)).toBe('');
});
