import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { adviseMode } from '../../../engine/orchestrator/planning/mode-advisor.js';
import type { AdvisorResult } from '../../../engine/orchestrator/planning/mode-advisor.js';
import { _eventsInternal, eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { glyph } from '../../../lib/glyphs.js';
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

describe('buildInputFooterByline', () => {
  const marker = glyph('stageDone');

  it('renders one dim middot byline with the live marker, stage, fraction, eta and git', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      stageText: 'build',
      fractionText: '3/7',
      etaText: '~2m left',
      gitLabel: 'git:branch+squash',
      advisoryText: 'use --quick for trivial edits',
    });

    expect(byline).toBe(
      `${marker} build 3/7 · ~2m left · git:branch+squash · use --quick for trivial edits`,
    );
  });

  it('uses a width-1 live marker so the truncation budget stays reliable', () => {
    expect(getTerminalCellWidth(marker)).toBe(1);
  });

  it('never includes the resting Ctrl+C control cluster', () => {
    const byline = buildInputFooterByline({
      cols: 120,
      stageText: 'build',
      fractionText: '3/7',
      etaText: '~2m left',
      gitLabel: 'git:squash',
      advisoryText: null,
    });

    expect(byline).not.toContain('Ctrl+C');
  });

  it('drops advisory, then eta, then git, then the stage word as width tightens', () => {
    const base = {
      stageText: 'build',
      fractionText: '3/7',
      etaText: '~2m left',
      gitLabel: 'git:squash',
      advisoryText: 'use --quick for trivial edits',
    } as const;
    // content width is cols - 2; size cols so exactly the target variant fits.
    const colsFor = (target: string) => getTerminalCellWidth(target) + 2;

    const noAdvisory = `${marker} build 3/7 · ~2m left · git:squash`;
    const noEta = `${marker} build 3/7 · git:squash`;
    const noGit = `${marker} build 3/7`;
    const floor = `${marker} 3/7`;

    expect(buildInputFooterByline({ ...base, cols: colsFor(noAdvisory) })).toBe(noAdvisory);
    expect(buildInputFooterByline({ ...base, cols: colsFor(noEta) })).toBe(noEta);
    expect(buildInputFooterByline({ ...base, cols: colsFor(noGit) })).toBe(noGit);
    expect(buildInputFooterByline({ ...base, cols: colsFor(floor) })).toBe(floor);
  });

  it('includes the y copy token only when a focus exists, reserved at the tail', () => {
    const base = {
      cols: 120,
      stageText: 'build',
      fractionText: '3/7',
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
    } as const;

    expect(buildInputFooterByline(base)).not.toContain('y copy');
    expect(buildInputFooterByline({ ...base, copyHint: 'y copy' })).toBe(
      `${marker} build 3/7 · git:none · y copy`,
    );
  });

  it('drops the copy hint first as width tightens: y copy → bare y → gone', () => {
    const base = {
      stageText: 'build',
      fractionText: '3/7',
      etaText: null,
      gitLabel: 'git:none',
      advisoryText: null,
      copyHint: 'y copy',
    } as const;
    // content width is cols - 2 (getChromeContentWidth); size cols so each variant just fits.
    const colsFor = (width: number) => width + 2;

    expect(buildInputFooterByline({ ...base, cols: colsFor(31) })).toBe(
      `${marker} build 3/7 · git:none · y copy`,
    );
    expect(buildInputFooterByline({ ...base, cols: colsFor(28) })).toBe(
      `${marker} build 3/7 · git:none · y`,
    );
    expect(buildInputFooterByline({ ...base, cols: colsFor(24) })).toBe(
      `${marker} build 3/7 · git:none`,
    );
  });

  it('stays within the chrome content width', () => {
    const cols = 64;
    const byline = buildInputFooterByline({
      cols,
      stageText: 'build',
      fractionText: '3/7',
      etaText: '~2m left',
      gitLabel: 'git:branch+squash',
      advisoryText: 'use --quick for trivial edits',
    });

    expect(getTerminalCellWidth(byline)).toBeLessThanOrEqual(getChromeContentWidth(cols));
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

  it('renders the active rail stage and task fraction in the byline', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing' });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('build 3/7');
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
    lifecycleStore.__testReset({ phase: 'implementing' });
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

  it('keeps the queue notice out of the resting footer byline', () => {
    terminalSizeStore.__testReset({ cols: 140, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', queueDepth: 2 });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('queued');

    ui.unmount();
  });
});
