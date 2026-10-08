import { describe, expect, it } from 'vitest';
import { SOFT_SEP } from '../../core/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { getChromeContentWidth } from './layout/chrome-rows.js';
import { buildInputFooterByline, stageFractionText } from './input-footer-byline.js';
import { stopByline } from './stop/copy.js';

function fullByline(byline: { lead: string; hint: string; queued: string; rest: string }): string {
  return `${byline.lead}${byline.hint}${byline.queued}${byline.rest}`;
}

// The byline builds against the width inside the gutter, so a line of W cells needs W + 2 terminal
// columns: one gutter cell on each side.
function colsForLine(target: string): number {
  return getTerminalCellWidth(target) + (120 - getChromeContentWidth(120));
}

describe('buildInputFooterByline', () => {
  const marker = glyph('stageDone');
  const stageLead = `${marker} build 3/7`;

  it('passes a live status lead through at the head of the byline', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '⠋ Researching… 2:24',
      queuedText: null,
    });

    expect(fullByline(byline)).toBe('⠋ Researching… 2:24');
  });

  it('cuts a long reviewer check command, never its label or its clock', () => {
    const lead =
      '⠋ Reviewer check V1 · npx vitest run src/features/workflow/display/build-progress.test.ts';
    for (const cols of [60, 80]) {
      const line = fullByline(
        buildInputFooterByline({ cols, lead, leadClock: '0:42', queuedText: '2 queued' }),
      );

      expect(line.startsWith('⠋ Reviewer check V1 · npx vitest')).toBe(true);
      expect(line.endsWith('… 0:42')).toBe(true);
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(getChromeContentWidth(cols));
    }
  });

  it('keeps the clock after the lead when the whole line fits', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '⠋ Reviewer check V1 · npm test',
      leadClock: '0:42',
      queuedText: null,
    });

    expect(fullByline(byline)).toBe('⠋ Reviewer check V1 · npm test 0:42');
  });

  it('never includes the resting Ctrl+C control cluster', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
    });

    expect(fullByline(byline)).not.toContain('Ctrl+C');
  });

  it('appends the worktree name at the tail with a subtle cursor marker', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      worktreeLabel: 'my-feature',
    });

    expect(fullByline(byline)).toBe(`${marker} build 3/7 · ${glyph('cursor')} my-feature`);
  });

  it.each([
    { label: 'empty', worktreeLabel: '' },
    { label: 'unset', worktreeLabel: null },
  ])('omits the worktree marker when the worktree name is $label', ({ worktreeLabel }) => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      worktreeLabel,
    });

    expect(fullByline(byline)).toBe(stageLead);
  });

  it('drops the worktree name rather than crowding the core when width is tight', () => {
    const base = {
      lead: stageLead,
      queuedText: null,
      worktreeLabel: 'my-feature',
    } as const;
    const core = `${marker} build 3/7`;

    expect(fullByline(buildInputFooterByline({ ...base, cols: colsForLine(core) }))).toBe(core);
  });

  it('truncates the worktree name to the room that remains', () => {
    const core = `${marker} build 3/7`;
    const worktreeLabel = 'a-very-long-worktree-branch-name';
    const width = getTerminalCellWidth(core) + getTerminalCellWidth(' · ') + 12;
    const byline = fullByline(
      buildInputFooterByline({
        cols: width,
        lead: stageLead,
        queuedText: null,
        worktreeLabel,
      }),
    );

    expect(byline.startsWith(`${core} · ${glyph('cursor')}`)).toBe(true);
    expect(byline).not.toContain(worktreeLabel);
    expect(getTerminalCellWidth(byline)).toBeLessThanOrEqual(getChromeContentWidth(width));
  });

  it('stays within the width inside the gutter', () => {
    const cols = 64;
    const byline = fullByline(
      buildInputFooterByline({
        cols,
        lead: stageLead,
        queuedText: null,
      }),
    );

    expect(getTerminalCellWidth(byline)).toBeLessThanOrEqual(getChromeContentWidth(cols));
  });

  it('renders the queued segment as its own tone-carrying part, separate from the lead', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: '2 queued',
    });

    expect(byline.queued).toBe(`${SOFT_SEP}2 queued`);
    expect(fullByline(byline)).toBe(`${stageLead} · 2 queued`);
  });

  it('renders the hint as its own dim part, directly behind the lead it explains', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '⚠ Still working — silent 5m 12s',
      hintText: 'tools report when done',
      queuedText: '2 queued',
    });

    expect(byline.hint).toBe(`${SOFT_SEP}tools report when done`);
    expect(fullByline(byline)).toBe(
      '⚠ Still working — silent 5m 12s · tools report when done · 2 queued',
    );
  });

  it('omits the hint segment when no hint is passed', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
    });

    expect(byline.hint).toBe('');
    expect(fullByline(byline)).toBe(stageLead);
  });

  it('drops the hint before the queued count when width runs out', () => {
    const base = {
      lead: stageLead,
      hintText: 'tools report when done',
      queuedText: '2 queued',
    } as const;
    const withHint = `${stageLead} · tools report when done · 2 queued`;
    const withoutHint = `${stageLead} · 2 queued`;

    expect(fullByline(buildInputFooterByline({ ...base, cols: 120 }))).toBe(withHint);
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsForLine(withHint) }))).toBe(
      withHint,
    );
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsForLine(withoutHint) }))).toBe(
      withoutHint,
    );
  });

  it('the queued segment carries no leading separator when the lead is empty', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '',
      queuedText: '2 queued',
    });

    expect(byline.queued).toBe('2 queued');
    expect(fullByline(byline)).toBe('2 queued');
  });
});

describe('stageFractionText', () => {
  it('fraction equals passed, not the index of the running brief', () => {
    expect(stageFractionText({ passed: 2, total: 5 })).toBe('2/5');
  });

  it('is empty before the plan announces a total', () => {
    expect(stageFractionText({ passed: 0, total: 0 })).toBe('');
  });
});

describe('the stop byline through the footer', () => {
  function stopLine(overrides: Parameters<typeof stopByline>[0]): string {
    const stopped = stopByline(overrides);
    if (stopped === null) throw new Error('expected a stop byline');
    return fullByline(
      buildInputFooterByline({
        cols: 120,
        lead: stopped.lead,
        leadClock: stopped.clock,
        hintText: stopped.hint,
        queuedText: null,
      }),
    );
  }

  const running: Parameters<typeof stopByline>[0] = {
    intent: 'stop-now',
    phase: 'terminating',
    parked: null,
    currentTaskId: 'T002',
    nextTaskId: 'T003',
    passed: 1,
    total: 5,
    elapsedMs: 4_000,
    questionPending: false,
    suite: null,
  };

  it('names the wait while processes are asked to exit', () => {
    expect(stopLine(running)).toContain('Stopping T002 · Waiting for processes to exit · 0:04');
    expect(stopLine(running)).toContain('esc back after stop · ctrl+c quit after stop');
  });

  it('says it is forcing once the grace is spent', () => {
    expect(stopLine({ ...running, phase: 'forcing' })).toContain(
      'Stopping T002 · Forcing remaining processes to exit',
    );
  });

  it('names the run, not the brief, while the run is ending', () => {
    expect(stopLine({ ...running, intent: 'end-run' })).toContain(
      'Ending run · Waiting for processes to exit · 0:04',
    );
  });

  it('keeps the clock of the reviewer check a pause waits on when its command is long', () => {
    const stopped = stopByline({
      ...running,
      intent: 'pause-after-brief',
      phase: 'requested',
      suite: {
        id: 'V1',
        moment: 'pre-review',
        command: 'npx vitest run src/features/workflow/display/build-progress.test.ts',
        elapsedMs: 42_000,
      },
    });
    if (stopped === null) throw new Error('expected a stop byline');
    const line = fullByline(
      buildInputFooterByline({
        cols: 60,
        lead: stopped.lead,
        leadClock: stopped.clock,
        hintText: stopped.hint,
        queuedText: null,
      }),
    );

    expect(line.startsWith('Reviewer check V1 · npx vitest')).toBe(true);
    expect(line.endsWith('… 0:42')).toBe(true);
  });

  it('says the session is being saved on the way out', () => {
    expect(stopLine({ ...running, intent: 'quit' })).toContain(
      'Quitting · Stopping processes and saving session',
    );
  });
});
