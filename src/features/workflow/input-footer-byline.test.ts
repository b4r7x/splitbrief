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

describe('buildInputFooterByline', () => {
  const marker = glyph('stageDone');
  const stageLead = `${marker} build 3/7`;

  it('renders one dim middot byline with the lead, eta and advisory', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: '~2m left',
      advisoryText: 'use --quick for trivial edits',
    });

    expect(fullByline(byline)).toBe(
      `${marker} build 3/7 · ~2m left · use --quick for trivial edits`,
    );
  });

  it('passes a live status lead through at the head of the byline', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '⠋ Researching… 2:24',
      queuedText: null,
      etaText: null,
      advisoryText: null,
    });

    expect(fullByline(byline)).toBe('⠋ Researching… 2:24');
  });

  it('never includes the resting Ctrl+C control cluster', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: '~2m left',
      advisoryText: null,
    });

    expect(fullByline(byline)).not.toContain('Ctrl+C');
  });

  it('drops advisory, then eta as width tightens, then truncates the lead', () => {
    const base = {
      lead: stageLead,
      queuedText: null,
      etaText: '~2m left',
      advisoryText: 'use --quick for trivial edits',
    } as const;
    const colsFor = (target: string) => getTerminalCellWidth(target);

    const noAdvisory = `${stageLead} · ~2m left`;
    const noEta = stageLead;

    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(noAdvisory) }))).toBe(
      noAdvisory,
    );
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(noEta) }))).toBe(noEta);

    const crampedWidth = colsFor(stageLead) - 2;
    const cramped = fullByline(buildInputFooterByline({ ...base, cols: crampedWidth }));
    expect(getTerminalCellWidth(cramped)).toBeLessThanOrEqual(crampedWidth);
  });

  it('includes the y copy token only when a focus exists, reserved at the tail', () => {
    const base = {
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: null,
      advisoryText: null,
    } as const;

    expect(fullByline(buildInputFooterByline(base))).not.toContain('y copy');
    expect(fullByline(buildInputFooterByline({ ...base, copyHint: 'y copy' }))).toBe(
      `${marker} build 3/7 · y copy`,
    );
  });

  it('drops the copy hint first as width tightens: y copy → bare y → gone', () => {
    const base = {
      lead: stageLead,
      queuedText: null,
      etaText: null,
      advisoryText: null,
      copyHint: 'y copy',
    } as const;
    const colsFor = (width: number) => width;

    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(31) }))).toBe(
      `${marker} build 3/7 · y copy`,
    );
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(19) }))).toBe(
      `${marker} build 3/7 · y`,
    );
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(14) }))).toBe(
      `${marker} build 3/7`,
    );
  });

  it('appends the worktree name at the tail with a subtle cursor marker', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: null,
      advisoryText: null,
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
      etaText: null,
      advisoryText: null,
      worktreeLabel,
    });

    expect(fullByline(byline)).toBe(stageLead);
  });

  it('drops the worktree name rather than crowding the core when width is tight', () => {
    const base = {
      lead: stageLead,
      queuedText: null,
      etaText: null,
      advisoryText: null,
      worktreeLabel: 'my-feature',
    } as const;
    const core = `${marker} build 3/7`;
    const cols = getTerminalCellWidth(core);

    expect(fullByline(buildInputFooterByline({ ...base, cols }))).toBe(core);
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
        etaText: null,
        advisoryText: null,
        worktreeLabel,
      }),
    );

    expect(byline.startsWith(`${core} · ${glyph('cursor')}`)).toBe(true);
    expect(byline).not.toContain(worktreeLabel);
    expect(getTerminalCellWidth(byline)).toBeLessThanOrEqual(getChromeContentWidth(width));
  });

  it('stays within the chrome content width', () => {
    const cols = 64;
    const byline = fullByline(
      buildInputFooterByline({
        cols,
        lead: stageLead,
        queuedText: null,
        etaText: '~2m left',
        advisoryText: 'use --quick for trivial edits',
      }),
    );

    expect(getTerminalCellWidth(byline)).toBeLessThanOrEqual(getChromeContentWidth(cols));
  });

  it('renders the queued segment as its own tone-carrying part, separate from the lead', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: '2 queued',
      etaText: null,
      advisoryText: null,
    });

    expect(byline.queued).toBe(`${SOFT_SEP}2 queued`);
    expect(fullByline(byline)).toBe(`${stageLead} · 2 queued`);
  });

  it('renders the hint as its own dim part, directly behind the lead it explains', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '⚠ Still working — silent 5:12',
      hintText: 'tools report when done',
      queuedText: '2 queued',
      etaText: null,
      advisoryText: null,
    });

    expect(byline.hint).toBe(`${SOFT_SEP}tools report when done`);
    expect(fullByline(byline)).toBe(
      '⚠ Still working — silent 5:12 · tools report when done · 2 queued',
    );
  });

  it('omits the hint segment when no hint is passed', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: null,
      advisoryText: null,
    });

    expect(byline.hint).toBe('');
    expect(fullByline(byline)).toBe(stageLead);
  });

  it('drops the hint before the queued count when width runs out', () => {
    const base = {
      lead: stageLead,
      hintText: 'tools report when done',
      queuedText: '2 queued',
      etaText: null,
      advisoryText: null,
    } as const;
    const withHint = `${stageLead} · tools report when done · 2 queued`;
    const withoutHint = `${stageLead} · 2 queued`;

    expect(fullByline(buildInputFooterByline({ ...base, cols: 120 }))).toBe(withHint);
    expect(
      fullByline(buildInputFooterByline({ ...base, cols: getTerminalCellWidth(withHint) })),
    ).toBe(withHint);
    expect(
      fullByline(buildInputFooterByline({ ...base, cols: getTerminalCellWidth(withoutHint) })),
    ).toBe(withoutHint);
  });

  it('the queued segment carries no leading separator when the lead is empty', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '',
      queuedText: '2 queued',
      etaText: null,
      advisoryText: null,
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
        hintText: stopped.hint,
        queuedText: null,
        etaText: null,
        advisoryText: null,
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
    sheetOpen: false,
    questionPending: false,
  };

  it('names the wait while processes are asked to exit', () => {
    expect(stopLine(running)).toContain(
      'Stopping T002 · Waiting for processes to exit · elapsed 0:04 · No new work will start',
    );
  });

  it('says it is forcing once the grace is spent', () => {
    expect(stopLine({ ...running, phase: 'forcing' })).toContain(
      'Stopping T002 · Forcing remaining processes to exit',
    );
  });

  it('names the run, not the brief, while the run is ending', () => {
    expect(stopLine({ ...running, intent: 'end-run' })).toContain(
      'Ending run · Waiting for processes to exit · elapsed 0:04',
    );
  });

  it('says the session is being saved on the way out', () => {
    expect(stopLine({ ...running, intent: 'quit' })).toContain(
      'Quitting · Stopping processes and saving session',
    );
  });
});
