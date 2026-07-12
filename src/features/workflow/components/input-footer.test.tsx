import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { adviseMode } from '../../../engine/orchestrator/planning/mode-advisor.js';
import type { AdvisorResult } from '../../../engine/orchestrator/planning/mode-advisor.js';
import { _eventsInternal, eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { _lifecycleInternal, lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { markInterruptParked } from '../../../stores/workflow/actions.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { BRAILLE_SPINNER_FRAMES, glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { buildInputFooterByline, InputFooter } from './input-footer.js';

function publishAdvisory(advisory: AdvisorResult): void {
  if (advisory.kind === 'none') return;
  _eventsInternal.set((prev) => ({
    events: [
      ...prev.events,
      {
        type: 'mode_advice',
        ts: Date.now(),
        phase: 'planning',
        kind: advisory.kind,
        risk: advisory.risk,
        currentMode: advisory.currentMode,
        suggestedMode: advisory.suggestedMode,
        confidence: advisory.confidence,
        factors: advisory.factors,
        missing: advisory.missing,
      },
    ],
  }));
}

function fullByline(byline: { lead: string; queued: string; rest: string }): string {
  return `${byline.lead}${byline.queued}${byline.rest}`;
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

  it('uses a width-1 live marker so the truncation budget stays reliable', () => {
    expect(getTerminalCellWidth(marker)).toBe(1);
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
    // content width is the full cols; size cols so exactly the target variant fits.
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
    // content width is the full cols (getChromeContentWidth); size cols so each variant just fits.
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

  it('omits the worktree marker when no worktree name is set', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      lead: stageLead,
      queuedText: null,
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
    });

    expect(fullByline(byline)).not.toContain(glyph('cursor'));
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
    // Exactly enough for the core leaves no room for the ` · ▸ …` tail, so the worktree drops.
    const cols = getTerminalCellWidth(core);

    expect(fullByline(buildInputFooterByline({ ...base, cols }))).toBe(core);
  });

  it('truncates the worktree name to the room that remains', () => {
    const core = `${marker} build 3/7 · git:none`;
    const worktreeLabel = 'a-very-long-worktree-branch-name';
    // Leave 12 content cells past the core+separator: enough for a truncated tail, not the whole name.
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

describe('InputFooter', () => {
  beforeEach(() => {
    eventsStore.__testReset();
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/diptych-test' });
    routerStore.init({ screen: 'workflow', feature: 'demo' });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
  });

  afterEach(() => {
    eventsStore.__testReset();
    configStore.__testReset();
    routerStore.init({ screen: 'home' });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
  });

  it('renders the y copy affordance only while a focused row resolves a copy value', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    reviewStore.setReviewFile('specs/001/tasks.md');
    reviewStore.setBriefSources(['raw brief markdown']);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(1);

    const idle = renderFeature(<InputFooter />);
    expect(idle.lastFrame() ?? '').not.toContain('y copy');
    idle.unmount();

    focusStore.set('brief', 0);
    const focused = renderFeature(<InputFooter />);
    expect(focused.lastFrame() ?? '').toContain('y copy');
    focused.unmount();

    focusStore.clear();
    reviewStore.clearReview();
    terminalSizeStore.reset();
  });

  it('hides the y copy affordance when sources exist but no brief row is rendered', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    reviewStore.setReviewFile('specs/001/tasks.md');
    reviewStore.setBriefSources(['raw brief markdown']);
    reviewStore.setRenderedLineCount(1);
    reviewStore.setVisibleBriefCount(0);
    focusStore.set('brief', 0);

    const focused = renderFeature(<InputFooter />);
    expect(focused.lastFrame() ?? '').not.toContain('y copy');
    focused.unmount();

    focusStore.clear();
    reviewStore.clearReview();
    terminalSizeStore.reset();
  });

  it('hides the y copy affordance when the focused row resolves no value', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    reviewStore.clearReview();

    // Region 'brief' maps to the brief target; with no compiled briefs there is nothing to copy, so
    // the affordance must stay hidden rather than promise an empty yank.
    focusStore.set('brief', 0);
    const focused = renderFeature(<InputFooter />);
    expect(focused.lastFrame() ?? '').not.toContain('y copy');
    focused.unmount();

    focusStore.clear();
    terminalSizeStore.reset();
  });

  it('leads with the animated live status instead of the stage marker while running', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'researching',
      startedAt: Date.now() - 144_000,
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toMatch(/Researching… \d+:\d\d/);
    expect(frame).not.toContain(`${glyph('stageDone')} Spec`);
    expect(frame).toContain('git:none');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('derives the elapsed live-status time from lifecycle.phaseFirstSeenTs, not the events store', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'implementing',
      startedAt: Date.now() - 300_000,
      phaseFirstSeenTs: { implementing: Date.now() - 30_000 },
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toMatch(/Implementing… 0:\d\d/);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('keeps the live lead below the Form-B rail width', () => {
    terminalSizeStore.__testReset({ cols: 24, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'specifying',
      startedAt: Date.now() - 1_000,
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toMatch(/Specifying… \d+:\d\d/);
    expect(frame).not.toContain(`${glyph('stageDone')} Spec`);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('falls back to the ● stage lead when the workflow is not running', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'researching', cancelled: true });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('stageDone')} Spec · git:none`);
    expect(frame).not.toContain('Researching…');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('renders the active rail stage and task fraction in the byline when not running', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', cancelled: true });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Build 3/7');
    expect(frame).not.toContain('Ctrl+C');

    ui.unmount();
  });

  it('renders downgrade advisory text when advisory state is set', () => {
    const advisory = adviseMode('fix typo in footer', 'standard');
    publishAdvisory(advisory);

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('advisor:');
    expect(frame).toContain('instant');

    ui.unmount();
  });

  it('omits advisory text when the advisor has no displayable warning', () => {
    const advisory = adviseMode('add auth with JWT refresh tokens', 'speckit');
    publishAdvisory(advisory);

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('advisor:');

    ui.unmount();
  });

  it('does not duplicate cost information already shown in the cost status line', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 24, isSmall: true });
    lifecycleStore.__testReset({ phase: 'implementing', cancelled: true });
    tasksStore.__testReset({ currentTask: 1, totalTasks: 4 });
    tokensStore.__testReset({
      localCount: 1,
      escalatedCount: 0,
      tokenUsage: {
        plannerInput: 1000,
        plannerOutput: 500,
        implementerInput: 2000,
        implementerOutput: 1000,
        escalationInput: 0,
        escalationOutput: 0,
      },
    });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('1/4');
    expect(frame).not.toContain('Local rate');
    expect(frame).not.toContain('Spent:');
    expect(frame).not.toContain('Saved:');

    ui.unmount();
  });

  it('shows the queue notice in the resting footer byline', () => {
    terminalSizeStore.__testReset({ cols: 140, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', queueDepth: 2 });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('2 queued');

    ui.unmount();
  });

  it('interrupted byline replaces the spinner with a static interrupted lead', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ status: 'interrupted', phase: 'implementing' });
    markInterruptParked();

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('interrupted — Enter retry · type to steer');
    expect(BRAILLE_SPINNER_FRAMES.some((spinnerFrame) => frame.includes(spinnerFrame))).toBe(false);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('the interrupted lead shows the interim text until the continuation prompt parks', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ status: 'interrupted', phase: 'implementing' });

    const pending = renderFeature(<InputFooter />);
    const pendingFrame = stripAnsiStyles(pending.lastFrame() ?? '');
    expect(pendingFrame).toContain('interrupted — finishing current step…');
    expect(pendingFrame).not.toContain('Enter retry');
    pending.unmount();

    markInterruptParked();

    const parked = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(parked.lastFrame() ?? '')).toContain(
      'interrupted — Enter retry · type to steer',
    );
    parked.unmount();
    terminalSizeStore.reset();
  });

  it('a stalled running call shows the still-working silence warning', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'implementing',
      startedAt: Date.now() - 120_000,
    });
    _lifecycleInternal.set((state) => ({
      ...state,
      stall: { since: Date.now() - 5_000, silentMs: 60_000 },
    }));

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // The shown span includes the silence that elapsed before the warning fired:
    // 5s since the warning + the 60s warn threshold = 1:05.
    expect(frame).toContain(`${glyph('statusWarning')} still working — silent 1:05`);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('queued count renders as an info byline segment that survives narrow widths', () => {
    lifecycleStore.__testReset({ phase: 'implementing', cancelled: true, queueDepth: 2 });

    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const wide = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(wide.lastFrame() ?? '')).toContain('2 queued');
    wide.unmount();

    terminalSizeStore.__testReset({ cols: 20, rows: 24, isSmall: false });
    const narrow = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(narrow.lastFrame() ?? '')).toContain('2 queued');
    narrow.unmount();

    terminalSizeStore.reset();
  });

  it('byline stage labels are Title Case', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', cancelled: true });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain(`${glyph('stageDone')} Plan`);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('renders the sanitized worktree name and strips injected control sequences', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    // OSC-52 clipboard write + CSI erase wrapped around the visible name. A resumed/attached
    // workflow's worktree name is untrusted, so none of these bytes may reach the terminal.
    const dirty = `${esc}]52;c;YWJj${bel}clean-tree${esc}[2K`;
    routerStore.init({ screen: 'workflow', feature: 'demo', worktreeName: dirty });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('cursor')} clean-tree`);
    expect(frame).not.toContain(esc);
    expect(frame).not.toContain('52;c');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('omits the worktree marker when the workflow route has no worktree name', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    routerStore.init({ screen: 'workflow', feature: 'demo' });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain(glyph('cursor'));

    ui.unmount();
    terminalSizeStore.reset();
  });
});
