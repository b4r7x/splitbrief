import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import chalk from 'chalk';
import { defaultTheme } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { openRunBylineParts } from '../closed/byline.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { preparationStore } from '../../../stores/navigation/preparation.js';
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
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { BRAILLE_SPINNER_FRAMES, glyph, spinnerFrames } from '../../../lib/glyphs.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { InputFooter } from './input-footer.js';

import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallStarted,
  makeRunnerCallStalled,
} from '#testing/helpers/events/runner-call.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTaskComplete } from '#testing/helpers/events/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { markWaitEnded, markWaitStarted } from '../../../stores/workflow/actions/wait.js';
import { loadEvents } from '../../../stores/workflow/actions/load.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { markWorkflowPaused } from '../../../stores/workflow/actions/pause.js';
import { markWorkflowResumed } from '../../../stores/workflow/actions/resume.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeMessage } from '#testing/helpers/queue.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const originalColorLevel = chalk.level;

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
    chalk.level = originalColorLevel;
    preparationStore.reset();
    recoveryNoticeStore.clear();
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

    const ui = renderFeature(
      <InputFooter byline={[{ text: 'Stopped at T002 — stopped by you', tone: 'warning' }]} />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // A live byline opens with its pip on the mark column; this one has none, so it keeps an empty
    // mark slot and puts its words on the text column instead of a letter where the pip would be.
    expect(frame.indexOf('Stopped at T002')).toBe(MARK_SLOT_CELLS);

    ui.unmount();
  });

  it('paints a preparation check spinner accent and its words and command dim', () => {
    chalk.level = 3;
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    preparationStore.submit({
      origin: 'continue',
      stage: 'Checking tools',
      prepare: async () => ({ kind: 'aborted' }),
      onPrepared: () => {},
    });
    const ui = renderFeature(<InputFooter />);
    const frame = ui.lastFrame() ?? '';
    expect(stripAnsiStyles(frame)).toBe(`${spinnerFrames()[0]} Checking tools · esc cancel`);
    expect(frame).toContain(
      paint(defaultTheme.accent, `${spinnerFrames()[0]} `).replace('\u001b[39m', ''),
    );
    expect(frame).toContain(paint(defaultTheme.textDim, 'Checking tools · esc cancel'));
    ui.unmount();
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
    expect(parkedFrame).toContain('Stopped at T002');
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

  it('quotes no estimate of the time left while briefs build', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
    tasksStore.__testReset({
      currentTask: 3,
      totalTasks: 4,
      tasks: [
        { id: 'T001', title: 'T1', status: 'done' as const },
        { id: 'T002', title: 'T2', status: 'done' as const },
        { id: 'T003', title: 'T3', status: 'in_progress' as const },
        { id: 'T004', title: 'T4', status: 'pending' as const },
      ],
    });
    addEvent(makeTaskComplete({ taskId: taskId('T001'), duration: 120_000 }));
    addEvent(makeTaskComplete({ taskId: taskId('T002'), duration: 120_000 }));

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

    expect(frame).toContain('Stopped at T002 · Partial changes kept');
    // The keys live on the legend row above, so the byline carries the state alone.
    expect(frame).not.toContain('⏎ resume');
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
    expect(pendingFrame).not.toContain('Stopped at');
    pending.unmount();

    stopStore.park('mid-brief', 'T002', null);

    const parked = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(parked.lastFrame() ?? '')).toContain('Stopped at T002');
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
    // 5s since the warning + the 60s warn threshold = 1:05.
    expect(frame).toContain('No output for 1:05');
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
    expect(besideBlockFrame).toContain('Implementing…');
    expect(besideBlockFrame).not.toContain('⚠');
    expect(besideBlockFrame).not.toContain('No output');
    besideBlock.unmount();

    // The same stalled call states its silence once the block is not on screen, so the silence
    // above is the block's doing and not a footer that never had one to show.
    const bare = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(bare.lastFrame() ?? '')).toContain('No output for 1:05');
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
      'No output for 1:05 · tools report when done',
    );

    ui.unmount();
    terminalSizeStore.reset();
  });

  // The stream reported this tool as it opened: the build block states the silence and names the
  // tool, so the byline beside it shows the normal live status, with no warning and no hint.
  it('leaves an open tool through a silence to the block beside it', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'implementing',
      startedAt: Date.now() - 120_000,
    });
    addEvent(
      makeRunnerCallStarted({ ts: Date.now() - 90_000, callId: 'call-1', runnerName: 'opencode' }),
    );
    addEvent(
      makeRunnerCallActivity({ ts: Date.now() - 80_000, runnerName: 'opencode', stage: 'updated' }),
    );
    addEvent(
      makeRunnerCallStalled({ ts: Date.now() - 5_000, silentMs: 60_000, runnerName: 'opencode' }),
    );

    const ui = renderFeature(<InputFooter buildBlockShown />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Implementing…');
    expect(frame).not.toContain('⚠');
    expect(frame).not.toContain('No output');
    expect(frame).not.toContain('tools report when done');

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

    expect(frame).toContain('No output for 1:05');
    expect(frame).not.toContain('tools report when done');

    ui.unmount();
    terminalSizeStore.reset();
  });

  it.each([120, 80, 60])(
    'keeps the first-delivery count beside a reopened run byline at %s columns',
    (cols) => {
      terminalSizeStore.__testReset({ cols, rows: 24, isSmall: false });
      const state = makeWorkflowState({
        phase: 'implementing',
        interruptedStep: {
          step: { kind: 'brief', taskId: taskId('T003'), attempt: 0 },
          source: 'user',
          at: '2026-10-11T00:00:00.000Z',
          cut: 'mid-step',
        },
        messageQueue: [
          {
            ...makeMessage(),
            id: 'reviewed',
            deliveredTo: { reviewer: '2026-10-11T00:00:00.000Z' },
          },
          { ...makeMessage(), id: 'pending' },
        ],
      });
      routerStore.init({
        screen: 'workflow',
        run: makeRunRecord({
          status: deriveRunStatus({ state, liveness: 'not-alive' }),
          hydration: { kind: 'loaded', state },
        }),
        execution: { kind: 'at-rest' },
      });
      hydrateFromState(state);
      tasksStore.__testReset({
        currentTask: 1,
        totalTasks: 1,
        tasks: [{ id: 'T003', title: 'Running brief', status: 'in_progress' }],
      });
      const ui = renderFeature(
        <InputFooter
          byline={[
            { text: 'Stopped at T003', tone: 'warning' },
            { text: ' · type a correction or ⏎ to continue', tone: 'textDim' },
          ]}
        />,
        { cols, rows: 24 },
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('Stopped at T003');
      expect(frame).toContain('1 queued');
      expect(frame.match(/1 queued/gu)).toHaveLength(1);
      expect(frame).not.toContain('2 queued');
      if (cols === 120) expect(frame).toContain('1 queued for BUILD on T003');
      ui.unmount();
    },
  );

  it.each([120, 80, 60])(
    'hides the queue on an ended BUILD byline at %s columns without clearing it',
    (cols) => {
      terminalSizeStore.__testReset({ cols, rows: 24, isSmall: false });
      const state = makeWorkflowState({
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001', status: 'in_progress' })],
        closed: { as: 'ended', at: '2026-10-11T00:00:00.000Z' },
        messageQueue: [makeMessage('Keep the validation API')],
      });
      routerStore.init({
        screen: 'workflow',
        run: makeRunRecord({
          status: deriveRunStatus({ state, liveness: 'not-alive' }),
          hydration: { kind: 'loaded', state },
        }),
        execution: { kind: 'at-rest' },
      });
      hydrateFromState(state);

      const ui = renderFeature(
        <InputFooter
          byline={[
            { text: 'Ended', tone: 'warning' },
            { text: ' · ', tone: 'textDim' },
            { text: 'Build', tone: 'implementer' },
            { text: ' 0/1', tone: 'textDim' },
          ]}
        />,
        { cols, rows: 24 },
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame.trim()).toBe('Ended · Build 0/1');
      expect(lifecycleStore.get().queueDepth).toBe(1);
      ui.unmount();
    },
  );

  it('hides the queue while the run waits for Apply', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const state = makeWorkflowState({
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'worktree',
        path: '/tmp/reviewed-workspace',
        base: { snapshotId: 'reviewed-base', head: null },
      },
      messageQueue: [makeMessage('Keep the validation API')],
    });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        status: deriveRunStatus({ state, liveness: 'not-alive' }),
        hydration: { kind: 'loaded', state },
      }),
      execution: { kind: 'at-rest' },
    });
    hydrateFromState(state);

    const ui = renderFeature(<InputFooter byline={[{ text: 'Ready to apply', tone: 'accent' }]} />);
    expect(stripAnsiStyles(ui.lastFrame() ?? '').trim()).toBe('Ready to apply');
    expect(lifecycleStore.get().queueDepth).toBe(1);
    ui.unmount();
  });

  it('queued count renders as an info byline segment that survives narrow widths', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({ phase: 'implementing', status: 'complete', queueDepth: 2 });

    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    const wide = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(wide.lastFrame() ?? '')).toContain('2 queued');
    expect(wide.lastFrame()).toContain(
      paint(defaultTheme.info, ' · 2 queued').replace('\u001b[39m', ''),
    );
    wide.unmount();

    terminalSizeStore.__testReset({ cols: 24, rows: 24, isSmall: false });
    const narrow = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(narrow.lastFrame() ?? '')).toContain('2 queued');
    expect(stripAnsiStyles(narrow.lastFrame() ?? '')).not.toContain('for BUILD');
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

  it('keeps the short queued count beside a long check at 60 columns', () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', queueDepth: 1 });
    tasksStore.__testReset({
      currentTask: 1,
      totalTasks: 1,
      tasks: [{ id: 'T003', title: 'Running brief', status: 'in_progress' }],
    });
    operationsStore.__testReset({
      suiteStage: {
        id: 'V1',
        command: 'npm run test:integration',
        moment: 'brief',
        stageStartedTs: Date.now() - 62_000,
      },
    });
    const ui = renderFeature(<InputFooter />, { cols: 60, rows: 18 });
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Fix check V1 · npm run test:integration 1:02 · 1 queued');
    expect(frame).not.toContain('for BUILD');
    expect(getTerminalCellWidth(frame)).toBeLessThanOrEqual(58);
    ui.unmount();
    terminalSizeStore.reset();
  });

  it('keeps the queued byline until the attached BUILD call delivers the message', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', queueDepth: 1 });
    tasksStore.__testReset({
      currentTask: 1,
      totalTasks: 1,
      tasks: [{ id: 'T003', title: 'Running brief', status: 'in_progress' }],
    });
    addEvent({
      type: 'steerable_call',
      ts: 1,
      phase: 'implementing',
      seat: 'build',
      taskId: 'T003',
    });
    const ui = renderFeature(<InputFooter />);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('1 queued for BUILD on T003');
    addEvent({
      type: 'queue_drained',
      ts: 2,
      phase: 'implementing',
      seat: 'build',
      taskId: 'T003',
      count: 1,
      via: 'mid-call',
    });
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('queued for BUILD');
    ui.unmount();
  });

  it('names the brief the queue waits for while a brief is building', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', queueDepth: 1 });
    tasksStore.__testReset({
      currentTask: 1,
      totalTasks: 2,
      tasks: [
        { id: 'T003', title: 'T3', status: 'in_progress' as const },
        { id: 'T004', title: 'T4', status: 'pending' as const },
      ],
    });

    const ui = renderFeature(<InputFooter />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('1 queued for BUILD on T003');
    ui.unmount();
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
  it('paints a failed stop with error and its cause with text', () => {
    chalk.level = 3;
    stopStore.request('stop-now');
    stopStore.fail('Disk full');
    const ui = renderFeature(<InputFooter width={120} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.error, `${glyph('statusPending')} Stop failed`).replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, ' · ').replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(paint(defaultTheme.text, 'Disk full'));
    ui.unmount();
  });

  it('paints waiting with warning', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({ status: 'running', phase: 'planning' });
    const ui = renderFeature(<InputFooter width={120} waiting />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.warning, `${glyph('statusPending')} Waiting for your answer`).replace(
        '\u001b[39m',
        '',
      ),
    );
    ui.unmount();
  });

  it('paints the live review spinner accent, its seat reviewer and its clock dim', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({
      status: 'running',
      phase: 'final-review',
      startedAt: Date.now() - 42_000,
      phaseFirstSeenTs: { 'final-review': Date.now() - 42_000 },
    });
    const ui = renderFeature(<InputFooter width={120} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.accent, `${spinnerFrames()[0]} `).replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.reviewer, 'Review').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, ' · reviewing changes 0:42'));
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.textDim, ' · reviewing changes 0:42').replace('\u001b[39m', ''),
    );
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Review · reviewing changes 0:42');
    ui.unmount();
  });

  it.each([
    ['paused', 'warning', 'Stopped at the plan', 'type a correction or ⏎ to continue'],
    ['failed', 'error', 'Stopped by an error · Disk full', '⏎ to retry the step'],
  ] as const)('paints the at-rest %s reason and dim action', (kind, tone, reason, action) => {
    chalk.level = 3;
    const byline = openRunBylineParts({
      status: {
        kind: 'open',
        stop: {
          kind: 'stopped',
          on: kind === 'paused' ? { kind, at: 'mid-step' } : { kind, message: 'Disk full' },
        },
        resumeAt: { kind: 'planner', call: 'plan' },
      },
      continuable: true,
      width: 120,
    });
    const ui = renderFeature(<InputFooter width={120} byline={byline} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme[tone], kind === 'failed' ? 'Stopped by an error' : reason).replace(
        '\u001b[39m',
        '',
      ),
    );
    if (kind === 'failed') {
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.textDim, ' · ').replace('\u001b[39m', ''),
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.text, 'Disk full').replace('\u001b[39m', ''),
      );
    }
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.textDim, ` · ${action}`).replace('\u001b[39m', ''),
    );
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${reason} · ${action}`);
    ui.unmount();
  });
  it('paints the stopping clock with textDim without changing its separators', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });
    stopStore.__testReset({
      intent: 'stop-now',
      phase: 'terminating',
      requestedAt: Date.now() - 42_000,
    });
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = ui.lastFrame();
    expect(frame).toContain(paint(defaultTheme.textDim, ' · Waiting for processes to exit · 0:42'));
    expect(stripAnsiStyles(frame)).toContain(
      'Stopping the run · Waiting for processes to exit · 0:42',
    );
    ui.unmount();
  });

  it('carries state, stage and fraction tones in the waiting byline', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({ status: 'running', phase: 'final-review' });
    tasksStore.__testReset({
      totalTasks: 5,
      tasks: [
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'done' },
      ],
    });
    const ui = renderFeature(<InputFooter width={120} waiting />);
    expect(stripAnsiStyles(ui.lastFrame())).toContain('Waiting for your answer · Review 2/5');
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.warning, `${glyph('statusPending')} Waiting for your answer`).replace(
        '\u001b[39m',
        '',
      ),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.reviewer, 'Review').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, ' · ').replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, ' 2/5').replace('\u001b[39m', ''));
    ui.unmount();
  });

  // A continued run sits paused until its engine starts again: reaping, restoring and re-entering
  // take seconds, and the byline says what is happening rather than asking for a resume.
  it.each([
    { phase: 'implementing', brief: 'T002', expected: 'Resuming T002' },
    { phase: 'final-review', brief: null, expected: 'Resuming the review' },
    { phase: 'planning', brief: null, expected: 'Resuming the plan' },
  ] as const)('says $expected while a continued run starts again', ({ phase, brief, expected }) => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ status: 'paused', phase });
    if (brief !== null) {
      tasksStore.__testReset({
        currentTask: 2,
        totalTasks: 2,
        tasks: [
          { id: 'T001', title: 'One', status: 'done' },
          { id: brief, title: 'Two', status: 'in_progress' },
        ],
      });
    }
    const ui = renderFeature(<InputFooter width={120} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(`${spinnerFrames()[0]} ${expected}`);
    expect(frame).not.toContain('Paused');
    expect(frame).not.toContain('/resume');
    ui.unmount();
    terminalSizeStore.reset();
  });

  it('paints a running reviewer check mark accent and only its seat words reviewer', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({ status: 'running', phase: 'final-review' });
    operationsStore.__testReset({
      suiteStage: {
        id: 'V1',
        moment: 'pre-review',
        command: 'npm test',
        stageStartedTs: Date.now() - 42_000,
      },
    });
    const ui = renderFeature(<InputFooter width={120} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.accent, `${spinnerFrames()[0]} `).replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.reviewer, 'Review').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.reviewer, 'Reviewer').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, ' check V1 · npm test 0:42'));
    ui.unmount();
  });

  it('paints a recovery stop with warning', () => {
    chalk.level = 3;
    recoveryNoticeStore.open({ seat: 'build', resetAt: null, issue: makeRecoveryIssue() });
    const ui = renderFeature(<InputFooter width={120} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.warning, `${glyph('statusFailed')} Run stopped`),
    );
    ui.unmount();
  });
});
