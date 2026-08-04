import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { adviseMode } from '../../../engine/orchestrator/planning/mode-advisor.js';
import type { AdvisorResult } from '../../../engine/orchestrator/planning/mode-advisor.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../engine/runners/prepared-execution.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { markInterruptParked } from '../../../stores/workflow/actions/interrupt.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { BRAILLE_SPINNER_FRAMES, glyph } from '../../../lib/glyphs.js';
import { InputFooter } from './input-footer.js';

import { makeRunnerCallStalled } from '#testing/helpers/events/runner-call.js';

function localExecution(
  feature: string,
  worktreeName?: string,
): { kind: 'local'; prepared: PreparedExecution } {
  const projectDir = '/tmp/splitbrief-test';
  const preparationId = 'input-footer-preparation';
  const sessionId = 'input-footer-session';
  const active = {
    version: 1 as const,
    sessionId,
    generation: '22222222-2222-4222-8222-222222222222',
  };

  return {
    kind: 'local',
    prepared: {
      purpose: 'new-workflow',
      config: parsePreparedConfig(
        makeConfig({
          planner: {
            kind: 'api',
            provider: 'anthropic',
            model: 'test-planner',
            apiBase: 'https://api.anthropic.com/v1',
            apiKey: 'test-key',
            contextLength: 32_768,
          },
        }),
      ),
      preparationId,
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [
          {
            id: 'runners',
            title: 'Runners',
            checks: [
              { id: 'runner.planner', severity: 'ok', summary: 'Planner ready' },
              {
                id: 'runner.implementer.default',
                severity: 'ok',
                summary: 'Implementer ready',
              },
            ],
          },
        ],
        metadata: {},
      },
      gates: [
        {
          kind: 'api',
          slot: { role: 'planner' },
          preparationId,
          provider: 'anthropic',
          endpointOrigin: 'https://api.anthropic.com',
        },
        {
          kind: 'api',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          provider: 'ollama',
          endpointOrigin: 'http://localhost:11434',
        },
      ],
      session: {
        kind: 'new',
        ref: { projectDir, sessionId },
        ownership: active,
        active,
      },
      runtime: {
        feature,
        ...(worktreeName !== undefined && { worktreeName }),
        allowRepoRunners: false,
        allowHooks: false,
      },
    },
  };
}

function publishAdvisory(advisory: AdvisorResult): void {
  if (advisory.kind === 'none') return;
  addEvent({
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
  });
}

describe('InputFooter', () => {
  beforeEach(() => {
    eventsStore.__testReset();
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/splitbrief-test' });
    routerStore.init({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'demo',
        sessionId: 'attached-session',
        attach: { sockPath: '/tmp/splitbrief.sock', authToken: 'test-token' },
      },
    });
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

    expect(frame).toContain('Interrupted — ⏎ retry · type to steer');
    expect(BRAILLE_SPINNER_FRAMES.some((spinnerFrame) => frame.includes(spinnerFrame))).toBe(false);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('the interrupted lead shows the interim text until the continuation prompt parks', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ status: 'interrupted', phase: 'implementing' });

    const pending = renderFeature(<InputFooter />);
    const pendingFrame = stripAnsiStyles(pending.lastFrame() ?? '');
    expect(pendingFrame).toContain('Interrupted — finishing current step…');
    expect(pendingFrame).not.toContain('⏎ retry');
    pending.unmount();

    markInterruptParked();

    const parked = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(parked.lastFrame() ?? '')).toContain(
      'Interrupted — ⏎ retry · type to steer',
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
    addEvent(
      makeRunnerCallStalled({
        ts: Date.now() - 5_000,
        silentMs: 60_000,
      }),
    );

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // The shown span includes the silence that elapsed before the warning fired:
    // 5s since the warning + the 60s warn threshold = 1:05.
    expect(frame).toContain(`${glyph('statusWarning')} Still working — silent 1:05`);

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
    routerStore.init({
      screen: 'workflow',
      execution: localExecution('demo', dirty),
    });

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
    routerStore.init({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'demo',
        sessionId: 'attached-session',
        attach: { sockPath: '/tmp/splitbrief.sock', authToken: 'test-token' },
      },
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain(glyph('cursor'));

    ui.unmount();
    terminalSizeStore.reset();
  });
});
