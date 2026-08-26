import { describe, expect, it } from 'vitest';
import { SOFT_SEP } from '../../components/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { getChromeContentWidth } from './layout/chrome-rows.js';
import { buildInputFooterByline } from './input-footer-byline.js';

function fullByline(byline: { lead: string; hint: string; queued: string; rest: string }): string {
  return `${byline.lead}${byline.hint}${byline.queued}${byline.rest}`;
}

describe('buildInputFooterByline', () => {
  const marker = glyph('stageDone');
  const stageLead = `${marker} build 3/7`;

  it('renders one dim middot byline with the lead, eta and git', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: '~2m left',
      gitLabel: 'git:branch+squash',
      advisoryText: 'use --quick for trivial edits',
    });

    expect(fullByline(byline)).toBe(
      `${marker} build 3/7 · ~2m left · git:branch+squash · use --quick for trivial edits`,
    );
  });

  it('passes a live status lead through at the head of the byline', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '⠋ Researching… 2:24',
      queuedText: null,
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
    });

    expect(fullByline(byline)).toBe('⠋ Researching… 2:24 · git:none');
  });

  it('never includes the resting Ctrl+C control cluster', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: '~2m left',
      gitLabel: 'git:squash',
      advisoryText: null,
    });

    expect(fullByline(byline)).not.toContain('Ctrl+C');
  });

  it('drops advisory, then eta, then git as width tightens, then truncates the lead', () => {
    const base = {
      lead: stageLead,
      queuedText: null,
      etaText: '~2m left',
      gitLabel: 'git:squash',
      advisoryText: 'use --quick for trivial edits',
    } as const;
    const colsFor = (target: string) => getTerminalCellWidth(target);

    const noAdvisory = `${stageLead} · ~2m left · git:squash`;
    const noEta = `${stageLead} · git:squash`;
    const noGit = stageLead;

    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(noAdvisory) }))).toBe(
      noAdvisory,
    );
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(noEta) }))).toBe(noEta);
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(noGit) }))).toBe(noGit);

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
      gitLabel: 'git:none',
      advisoryText: null,
    } as const;

    expect(fullByline(buildInputFooterByline(base))).not.toContain('y copy');
    expect(fullByline(buildInputFooterByline({ ...base, copyHint: 'y copy' }))).toBe(
      `${marker} build 3/7 · git:none · y copy`,
    );
  });

  it('drops the copy hint first as width tightens: y copy → bare y → gone', () => {
    const base = {
      lead: stageLead,
      queuedText: null,
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
      copyHint: 'y copy',
    } as const;
    const colsFor = (width: number) => width;

    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(31) }))).toBe(
      `${marker} build 3/7 · git:none · y copy`,
    );
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(28) }))).toBe(
      `${marker} build 3/7 · git:none · y`,
    );
    expect(fullByline(buildInputFooterByline({ ...base, cols: colsFor(24) }))).toBe(
      `${marker} build 3/7 · git:none`,
    );
  });

  it('appends the worktree name at the tail with a subtle cursor marker', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
      worktreeLabel: 'my-feature',
    });

    expect(fullByline(byline)).toBe(
      `${marker} build 3/7 · git:none · ${glyph('cursor')} my-feature`,
    );
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
      gitLabel: 'git:none',
      advisoryText: null,
      worktreeLabel,
    });

    expect(fullByline(byline)).toBe(`${stageLead} · git:none`);
  });

  it('drops the worktree name rather than crowding the core when width is tight', () => {
    const base = {
      lead: stageLead,
      queuedText: null,
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
      worktreeLabel: 'my-feature',
    } as const;
    const core = `${marker} build 3/7 · git:none`;
    const cols = getTerminalCellWidth(core);

    expect(fullByline(buildInputFooterByline({ ...base, cols }))).toBe(core);
  });

  it('truncates the worktree name to the room that remains', () => {
    const core = `${marker} build 3/7 · git:none`;
    const worktreeLabel = 'a-very-long-worktree-branch-name';
    const width = getTerminalCellWidth(core) + getTerminalCellWidth(' · ') + 12;
    const byline = fullByline(
      buildInputFooterByline({
        cols: width,
        lead: stageLead,
        queuedText: null,
        etaText: null,
        gitLabel: 'git:none',
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
        gitLabel: 'git:branch+squash',
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
      gitLabel: 'git:none',
      advisoryText: null,
    });

    expect(byline.queued).toBe(`${SOFT_SEP}2 queued`);
    expect(fullByline(byline)).toBe(`${stageLead} · 2 queued · git:none`);
  });

  it('renders the hint as its own dim part, directly behind the lead it explains', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: '⚠ Still working — silent 5:12',
      hintText: 'tools report when done',
      queuedText: '2 queued',
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
    });

    expect(byline.hint).toBe(`${SOFT_SEP}tools report when done`);
    expect(fullByline(byline)).toBe(
      '⚠ Still working — silent 5:12 · tools report when done · 2 queued · git:none',
    );
  });

  it('omits the hint segment when no hint is passed', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
    });

    expect(byline.hint).toBe('');
    expect(fullByline(byline)).toBe(`${stageLead} · git:none`);
  });

  it('drops the hint before the queued count when width runs out', () => {
    const base = {
      lead: stageLead,
      hintText: 'tools report when done',
      queuedText: '2 queued',
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
    } as const;
    const withHint = `${stageLead} · tools report when done · 2 queued`;
    const withoutHint = `${stageLead} · 2 queued`;

    expect(fullByline(buildInputFooterByline({ ...base, cols: 120 }))).toBe(
      `${withHint} · git:none`,
    );
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
      gitLabel: 'git:none',
      advisoryText: null,
    });

    expect(byline.queued).toBe('2 queued');
    expect(fullByline(byline)).toBe('2 queued · git:none');
  });
});
