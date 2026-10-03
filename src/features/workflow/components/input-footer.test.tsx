import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import {
  operationsStore,
  type RunningOperation,
} from '../../../stores/workflow/operations/state.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { focusStore } from '../../../stores/ui/focus.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { BRAILLE_SPINNER_FRAMES, glyph } from '../../../lib/glyphs.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { InputFooter } from './input-footer.js';

import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRunnerCallStalled } from '#testing/helpers/events/runner-call.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { markWaitEnded, markWaitStarted } from '../../../stores/workflow/actions/wait.js';
import { loadEvents } from '../../../stores/workflow/actions/load.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { markWorkflowPaused } from '../../../stores/workflow/actions/pause.js';
import { markWorkflowResumed } from '../../../stores/workflow/actions/resume.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';

function runningOn(runnerName: string): RunningOperation {
  return {
    callId: `call-${runnerName}`,
    role: 'implementer',
    phase: 'implementing',
    label: runnerName,
    runnerName,
    startedAt: 0,
    status: 'running',
    endedAt: null,
    durationMs: null,
    partial: false,
    reason: null,
    usage: null,
    warnings: [],
  };
}

describe('InputFooter', () => {
  beforeEach(() => {
    eventsStore.__testReset();
    configStore.__testReset({ config: makeConfig(), projectDir: '/tmp/splitbrief-test' });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord(),
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: '/tmp/splitbrief-test',
          sessionId: 'input-footer-session',
          feature: 'demo',
          config: makeConfig(),
          gates: () => [],
        }),
      },
    });
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
    operationsStore.__testReset();
  });

  afterEach(() => {
    eventsStore.__testReset();
    configStore.__testReset();
    routerStore.init({ screen: 'home' });
    stopStore.__testReset();
    conversationScrollStore.__testReset();
    lifecycleStore.__testReset();
    tasksStore.__testReset();
    tokensStore.__testReset();
    operationsStore.__testReset();
  });

  it('renders flush, leaving the gutter to the footer that wraps it', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });

    const ui = renderFeature(<InputFooter byline="Paused at T002 — stopped by you" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // A live byline opens with its pip on the mark column; this one has none, so it keeps an empty
    // mark slot and puts its words on the text column instead of a letter where the pip would be.
    expect(frame.indexOf('Paused at T002')).toBe(MARK_SLOT_CELLS);

    ui.unmount();
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

  it('shows neutral API waiting beside the input until the first response, and honors cancellation', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });
    const operation = runningOn('lm-studio');
    operationsStore.__testReset({
      active: {
        ...operation,
        apiRuntimeStatus: {
          phase: 'waiting-first-response',
          loadState: 'not-loaded',
          observedAt: 1000,
        },
      },
    });
    const waiting = renderFeature(<InputFooter />);
    expect(waiting.lastFrame()).toContain('Waiting for response');
    expect(waiting.lastFrame()).not.toMatch(/loading|not-loaded|unloaded/i);
    waiting.unmount();

    operationsStore.__testReset({
      active: {
        ...operation,
        apiRuntimeStatus: { phase: 'streaming', loadState: 'not-loaded', observedAt: 1000 },
      },
    });
    const streaming = renderFeature(<InputFooter />);
    expect(streaming.lastFrame()).toContain('Implementing');
    expect(streaming.lastFrame()).not.toContain('Waiting for response');
    streaming.unmount();

    lifecycleStore.__testReset({
      status: 'cancelled',
      phase: 'implementing',
      reason: 'user_cancelled',
    });
    const cancelled = renderFeature(<InputFooter />);
    expect(cancelled.lastFrame()).toContain('Stopped by you');
    expect(cancelled.lastFrame()).not.toMatch(/Waiting for response|unloaded/);
    cancelled.unmount();
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
    expect(frame).not.toContain(`${glyph('stageDone')} Plan`);

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

  it('says one verb for the planning session and names an old chain briefs call', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'planning',
      startedAt: Date.now() - 90_000,
      phaseFirstSeenTs: { planning: Date.now() - 30_000 },
    });

    addEvent(makePlannerStatus({ phase: 'planning', call: 'plan', ts: Date.now() }));
    const plan = renderFeature(<InputFooter />);
    // The session's one verb runs on the Plan stage's clock, which opens with the run.
    expect(stripAnsiStyles(plan.lastFrame() ?? '')).toMatch(/Planning… 1:\d\d/);
    expect(plan.lastFrame() ?? '').not.toContain('briefs');
    plan.unmount();

    addEvent(makePlannerStatus({ phase: 'planning', call: 'tasks', ts: Date.now() }));
    const tasks = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(tasks.lastFrame() ?? '')).toMatch(/Compiling briefs… 0:\d\d/);
    tasks.unmount();

    terminalSizeStore.reset();
  });

  it('keeps the time spent waiting on the user out of the live elapsed', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const now = Date.now();
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'researching',
      startedAt: now - 300_000,
    });
    markWaitStarted(now - 200_000);
    markWaitEnded(now - 80_000);

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // Five minutes on the clock, two of them waiting for an answer: the stage worked for three.
    expect(frame).toMatch(/Researching… 3:0\d/);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('counts a resumed run from its resume, not from a stage an earlier process opened', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const now = Date.now();
    const hours = (n: number) => now - n * 3_600_000;
    // The plan stage opened eight hours ago, then the run sat parked until this process resumed it.
    loadEvents([
      { type: 'workflow_started', ts: hours(9), phase: 'researching', feature: 'demo' },
      makePlannerStatus({ phase: 'planning', call: 'plan', ts: hours(8) }),
    ]);
    hydrateFromState(
      makeWorkflowState({ phase: 'planning', startedAt: new Date(hours(9)).toISOString() }),
    );
    addEvent({ type: 'workflow_resumed', ts: now - 35 * 60_000, phase: 'planning' });
    addEvent(makePlannerStatus({ phase: 'planning', call: 'tasks', ts: now - 30 * 60_000 }));

    const ui = renderFeature(<InputFooter />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(/Compiling briefs… 35:0\d/);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('starts the stage clock again when a run parked in this process resumes', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const now = Date.now();
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'implementing',
      startedAt: now - 3_600_000,
      phaseFirstSeenTs: { implementing: now - 3_000_000 },
    });
    markWaitStarted(now - 2_900_000);
    markWaitEnded(now - 2_800_000);
    markWorkflowPaused();
    markWorkflowResumed(now - 45_000);

    const ui = renderFeature(<InputFooter />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(/Implementing… 0:4\d/);

    ui.unmount();
    terminalSizeStore.reset();
  });

  // The plan stage holds two planner calls and the verb names the one running, so the clock counts
  // that call: not the plan call before it, and not the waits that call spent on the user.
  it.each([
    {
      flow: 'straight after the plan call',
      between: (ago: (minutes: number) => number) => {
        markWaitStarted(ago(8));
        markWaitEnded(ago(6));
      },
    },
    {
      flow: 'after the plan gate',
      between: (ago: (minutes: number) => number) => {
        addEvent(makePlannerStatus({ phase: 'reviewing-plan', ts: ago(6) }));
        markWaitStarted(ago(6));
        markWaitEnded(ago(3));
      },
    },
  ])('counts the tasks call from its own start $flow', ({ between }) => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const now = Date.now();
    const ago = (minutes: number) => now - minutes * 60_000;
    addEvent({ type: 'workflow_started', ts: ago(20), phase: 'researching', feature: 'demo' });
    addEvent(makePlannerStatus({ phase: 'researching', call: 'research', ts: ago(20) }));
    addEvent(makePlannerStatus({ phase: 'specifying', call: 'spec', ts: ago(17) }));
    addEvent(makePlannerStatus({ phase: 'planning', call: 'plan', ts: ago(13) }));
    between(ago);
    addEvent(makePlannerStatus({ phase: 'planning', call: 'tasks', ts: ago(2) }));

    const ui = renderFeature(<InputFooter />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(/Compiling briefs… 2:0\d/);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('starts the clock again when one planner call follows another, never at the first', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const now = Date.now();
    const ago = (minutes: number) => now - minutes * 60_000;
    // The research call opens once the repo map is built: that wait is research too, so the first
    // call of a run keeps the clock the run's start opened.
    addEvent({ type: 'workflow_started', ts: ago(10), phase: 'researching', feature: 'demo' });
    addEvent(makePlannerStatus({ phase: 'researching', call: 'research', ts: ago(10) + 6_000 }));
    const research = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(research.lastFrame() ?? '')).toMatch(/Researching… 10:0\d/);
    research.unmount();

    addEvent(makePlannerStatus({ phase: 'specifying', call: 'spec', ts: ago(3) }));
    const spec = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(spec.lastFrame() ?? '')).toMatch(/Specifying… 3:0\d/);
    spec.unmount();

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
    expect(frame).not.toContain(`${glyph('stageDone')} Plan`);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('falls back to the ● stage lead when the workflow is not running', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'researching', status: 'complete' });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('stageDone')} Plan`);
    expect(frame).not.toContain('Researching…');

    ui.unmount();
    terminalSizeStore.reset();
  });

  // SPLITBRIEF no longer stages, commits or tags a checkpoint, so the byline has no strategy to
  // report and nothing to call `git:none`. What survives is the progress the run made and the way
  // it parked.
  it('names no retired git automation while running or at rest, and keeps progress and pause', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    tasksStore.__testReset({
      currentTask: 2,
      totalTasks: 3,
      tasks: [
        { id: 'T001', title: 'T1', status: 'done' as const },
        { id: 'T002', title: 'T2', status: 'in_progress' as const },
        { id: 'T003', title: 'T3', status: 'pending' as const },
      ],
    });

    lifecycleStore.__testReset({ status: 'running', phase: 'implementing', startedAt: Date.now() });
    const running = renderFeature(<InputFooter />);
    const runningFrame = stripAnsiStyles(running.lastFrame() ?? '');
    expect(runningFrame).toMatch(/Implementing…/);
    running.unmount();

    lifecycleStore.__testReset({ status: 'complete', phase: 'implementing' });
    const atRest = renderFeature(<InputFooter />);
    const atRestFrame = stripAnsiStyles(atRest.lastFrame() ?? '');
    expect(atRestFrame).toContain('1/3');
    atRest.unmount();

    lifecycleStore.__testReset({ status: 'paused', phase: 'implementing' });
    stopStore.request('stop-now');
    stopStore.park('mid-brief', 'T002', null);
    const parked = renderFeature(<InputFooter />);
    const parkedFrame = stripAnsiStyles(parked.lastFrame() ?? '');
    expect(parkedFrame).toContain('Paused at T002');
    parked.unmount();

    for (const frame of [runningFrame, atRestFrame, parkedFrame]) {
      expect(frame).not.toContain('git:');
      expect(frame).not.toContain('checkpoint');
      expect(frame).not.toContain('per-task');
    }

    terminalSizeStore.reset();
  });

  // The branch a run creates is announced by name in the transcript, where the name is real. The
  // byline does not mirror the setting beside the worktree marker, where a reader would take the
  // worktree's name for the branch's.
  it('mirrors no git setting on the byline when createBranch is on', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    configStore.__testReset({
      config: makeConfig({ workflow: { git: { createBranch: true } } }),
      projectDir: '/tmp/splitbrief-test',
    });
    lifecycleStore.__testReset({ phase: 'researching', status: 'complete' });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('stageDone')} Plan`);
    expect(frame).not.toContain('git:');
    expect(frame).not.toContain('branch');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('renders the active rail stage and task fraction in the byline when not running', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'complete' });
    tasksStore.__testReset({
      currentTask: 3,
      totalTasks: 7,
      tasks: [
        { id: 'T001', title: 'T1', status: 'done' as const },
        { id: 'T002', title: 'T2', status: 'done' as const },
        { id: 'T003', title: 'T3', status: 'done' as const },
      ],
    });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Build 3/7');
    expect(frame).not.toContain('Ctrl+C');

    ui.unmount();
  });

  it('quotes the build block estimate and drops it when a seat swap retires it', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
    tasksStore.__testReset({
      currentTask: 3,
      totalTasks: 4,
      taskCompletionTimes: [120_000, 120_000],
      tasks: [
        { id: 'T001', title: 'T1', status: 'done' as const },
        { id: 'T002', title: 'T2', status: 'done' as const },
        { id: 'T003', title: 'T3', status: 'in_progress' as const },
        { id: 'T004', title: 'T4', status: 'pending' as const },
      ],
    });

    const quoted = renderFeature(<InputFooter />);
    const quotedFrame = stripAnsiStyles(quoted.lastFrame() ?? '');

    // Two briefs left at two minutes each, worded the way the block above words it — one
    // estimate on the screen, not two dialects of it.
    expect(quotedFrame).toContain('ETA ~4m');
    expect(quotedFrame).not.toContain('remaining');
    quoted.unmount();

    operationsStore.__testReset({ active: runningOn('codex'), last: runningOn('claude-code') });

    const retired = renderFeature(<InputFooter />);

    // The block retires an estimate the new seat never earned; the byline stops quoting it too.
    expect(stripAnsiStyles(retired.lastFrame() ?? '')).not.toContain('ETA');
    retired.unmount();

    terminalSizeStore.reset();
  });

  it('quotes no estimate during the final review, where no brief is left to build', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'final-review', status: 'running' });
    tasksStore.__testReset({
      currentTask: 2,
      totalTasks: 2,
      taskCompletionTimes: [120_000, 120_000],
      tasks: [
        { id: 'T001', title: 'T1', status: 'done' as const },
        { id: 'T002', title: 'T2', status: 'done' as const },
      ],
    });

    const ui = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('ETA');
    ui.unmount();

    terminalSizeStore.reset();
  });

  it('a user-cancelled run leads with the cancelled glyph, never the stage-done pip', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', cancelled: true });
    tasksStore.__testReset({
      currentTask: 1,
      totalTasks: 1,
      tasks: [{ id: 'T001', title: 'T1', status: 'done' as const }],
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('statusCancelled')} Stopped by you · Build 1/1`);
    expect(frame).not.toContain(`${glyph('stageDone')} Build`);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('a run that stopped for any other reason leads with the failed glyph and word', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'cancelled',
      reason: 'workflow_cancelled',
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('statusFailed')} Build failed`);
    expect(frame).not.toContain('Cancelled');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('shows no mode advice a run publishes or replays', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    addEvent({
      type: 'mode_advice',
      ts: Date.now(),
      phase: 'planning',
      kind: 'downgrade',
      risk: 'normal',
      currentMode: 'standard',
      suggestedMode: 'quick',
      confidence: 0.8,
      factors: ['short single-file edit'],
      missing: [],
    });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('advisor');
    expect(frame).not.toContain('likely quick');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('does not duplicate cost information already shown in the cost status line', () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 24, isSmall: true });
    lifecycleStore.__testReset({ phase: 'implementing', cancelled: true });
    tasksStore.__testReset({
      currentTask: 1,
      totalTasks: 4,
      tasks: [{ id: 'T001', title: 'T1', status: 'done' as const }],
    });
    tokensStore.__testReset({
      localCount: 1,
      escalatedCount: 0,
      tokenUsage: makeUsage({
        plannerInput: 1000,
        plannerOutput: 500,
        implementerInput: 2000,
        implementerOutput: 1000,
      }),
    });

    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('1/4');
    expect(frame).not.toContain('Local rate');
    expect(frame).not.toContain('Spent:');
    expect(frame).not.toContain('Saved:');

    ui.unmount();
  });

  it('a parked brief replaces the spinner with the resume keys', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ status: 'paused', phase: 'implementing' });
    stopStore.request('stop-now');
    stopStore.park('mid-brief', 'T002', null);

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Paused at T002 · Partial changes kept');
    // The keys live on the legend row above, so the byline carries the state alone.
    expect(frame).not.toContain('/resume');
    expect(BRAILLE_SPINNER_FRAMES.some((spinnerFrame) => frame.includes(spinnerFrame))).toBe(false);

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('the stopping lead reports the wait until the brief parks', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });
    stopStore.request('stop-now');
    stopStore.markTerminating();

    const pending = renderFeature(<InputFooter />);
    const pendingFrame = stripAnsiStyles(pending.lastFrame() ?? '');
    expect(pendingFrame).toContain('Waiting for processes to exit');
    expect(pendingFrame).not.toContain('Paused at');
    pending.unmount();

    stopStore.park('mid-brief', 'T002', null);

    const parked = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(parked.lastFrame() ?? '')).toContain('Paused at T002');
    parked.unmount();
    terminalSizeStore.reset();
  });

  it('a stalled call with no build block on screen states its silence on the byline', () => {
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
    // 5s since the warning + the 60s warn threshold = 1m 5s.
    expect(frame).toContain('Still working — silent 1m 5s');
    expect(frame).not.toContain('tools report when done');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('a stalled call beside the build block leaves the silence to the block', () => {
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

    const besideBlock = renderFeature(<InputFooter buildBlockShown />);
    const besideBlockFrame = stripAnsiStyles(besideBlock.lastFrame() ?? '');
    expect(besideBlockFrame).toContain('Still working');
    expect(besideBlockFrame).not.toContain('silent');
    besideBlock.unmount();

    // The same stalled call states its silence once the block is not on screen, so the silence
    // above is the block's doing and not a footer that never had one to show.
    const bare = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(bare.lastFrame() ?? '')).toContain('silent');
    bare.unmount();

    terminalSizeStore.reset();
  });

  it('a silent runner that only reports finished tools earns a hint beside the warning', () => {
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
        runnerName: 'opencode',
      }),
    );

    const ui = renderFeature(<InputFooter />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      'Still working — silent 1m 5s · tools report when done',
    );

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('a runner that streams tool use live gets the warning without the hint', () => {
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
        runnerName: 'claude-code',
      }),
    );

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Still working — silent 1m 5s');
    expect(frame).not.toContain('tools report when done');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it('queued count renders as an info byline segment that survives narrow widths', () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'complete', queueDepth: 2 });

    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const wide = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(wide.lastFrame() ?? '')).toContain('2 queued');
    wide.unmount();

    terminalSizeStore.__testReset({ cols: 24, rows: 24, isSmall: false });
    const narrow = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(narrow.lastFrame() ?? '')).toContain('2 queued');
    narrow.unmount();

    // The frame costs the two gutter cells, so a 19-column terminal cannot seat the queued
    // segment too; the ladder drops it and the lead stands alone rather than clipping.
    terminalSizeStore.__testReset({ cols: 19, rows: 24, isSmall: false });
    const cramped = renderFeature(<InputFooter />);
    const crampedFrame = stripAnsiStyles(cramped.lastFrame() ?? '');
    expect(crampedFrame).toContain('Build');
    expect(crampedFrame).not.toContain('2 queued');
    cramped.unmount();

    terminalSizeStore.reset();
  });

  it('byline stage labels are Title Case', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', status: 'complete' });

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
    // OSC-52 clipboard write + CSI erase wrapped around the visible name. A resumed
    // workflow's worktree name is untrusted, so none of these bytes may reach the terminal.
    const dirty = `${esc}]52;c;YWJj${bel}clean-tree${esc}[2K`;
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord(),
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: '/tmp/splitbrief-test',
          sessionId: 'input-footer-session',
          feature: 'demo',
          config: makeConfig(),
          gates: () => [],
          worktreeName: dirty,
        }),
      },
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
      run: makeRunRecord(),
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: '/tmp/splitbrief-test',
          sessionId: 'no-worktree-session',
          feature: 'demo',
          config: makeConfig(),
          gates: () => [],
        }),
      },
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain(glyph('cursor'));

    ui.unmount();
    terminalSizeStore.reset();
  });
});
