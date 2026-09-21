import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { ReadinessReport } from '../core/readiness/types.js';
import { createInitialState } from '../core/state/machine.js';
import { loadOwnerWorkflowState } from '../core/state/resume-hydration.js';
import type { PrepareExecutionInput } from '../engine/runners/prepare-execution/prepare-execution.js';
import type { PreparationOutcome } from '../engine/runners/prepared-execution.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { configStore } from '../stores/project/config.js';
import { preparationStore } from '../stores/navigation/preparation.js';
import { routerStore } from '../stores/navigation/router.js';
import { continueRunInPlace, type SessionSelectDeps } from '../stores/navigation/session-select.js';
import type { WorkflowScreenDeps } from '../features/workflow/hooks/workflow-screen/use-model.js';
import { Router } from './router.js';
import { HomeScreen, type HomeScreenDeps } from './screens/home.js';

const ENTER = '\r';
const ESC = '\u001b';
const HOME_HINT = '/help · /crew · /settings · /skills · ctrl+k commands';
const CHECKING = 'Checking tools';
const FULLSCREEN_PANEL_TITLE = 'Preparing your tools';
const DRAFT = 'add a parser';
const TYPED_AFTER_SUBMIT = ' and tests';
const PASTE_CHIP = '[paste #1 +5 lines]';
const PASTED_LINES = '\none\ntwo\nthree\nfour';
/** Two keystrokes either side of the settle: side by side means the caret never moved. */
const BEFORE_MARK = '@';
const AFTER_MARK = '^';

let projectDir = '';

function readyReport(): ReadinessReport {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir: '/project',
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready.' },
    sections: [],
    metadata: {},
  };
}

function blockedReport(): ReadinessReport {
  return {
    ...readyReport(),
    status: 'blocked',
    counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
    nextAction: { kind: 'exit', label: 'Exit', reason: 'Fix the configured runner.' },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: [
          {
            id: 'runners.preparation.planner',
            severity: 'blocker',
            summary: 'The configured runner could not be admitted.',
            fix: 'Open settings and review the runner.',
          },
        ],
      },
    ],
  };
}

const RESUME_STATE = {
  ...createInitialState('Continue the interrupted run'),
  phase: 'implementing' as const,
};

/** The run the resume tests open at rest and then continue in place. */
const AT_REST_RUN = makeRunRecord({
  ref: { projectDir: '/tmp/preparation-composer', sessionId: '2026-09-16-resume' },
  feature: RESUME_STATE.feature,
  hydration: { kind: 'loaded', state: RESUME_STATE },
  status: {
    kind: 'open',
    stop: { kind: 'interrupted' },
    resumeAt: { kind: 'planner', call: 'tasks' },
  },
});

function homeDeps(
  prepare: (input: PrepareExecutionInput) => Promise<PreparationOutcome>,
): HomeScreenDeps {
  return {
    prepareExecution: prepare,
    sessionSelect: {
      loadResumeState: loadOwnerWorkflowState,
      prepareResume: async () => ({ kind: 'aborted' }),
      hydrateRun: async () => {},
    },
  };
}

function renderHome(prepare: (input: PrepareExecutionInput) => Promise<PreparationOutcome>) {
  const { cols, rows } = terminalSizeStore.get();
  return renderFeature(
    <HomeScreen commands={[]} onRuntimeCommand={() => {}} deps={homeDeps(prepare)} />,
    { cols, rows },
  );
}

function WorkflowRoute({ deps }: { deps: WorkflowScreenDeps }) {
  const overlayActive = overlayStore.use((state) => state.active);
  return (
    <Router
      screen="workflow"
      overlayActive={overlayActive}
      commands={[]}
      onRuntime={() => {}}
      copyTarget={async () => 'empty'}
      workflowDeps={deps}
    />
  );
}

function frameRows(ui: ReturnType<typeof renderFeature>): string[] {
  return stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
}

function rowWith(ui: ReturnType<typeof renderFeature>, text: string): number {
  return frameRows(ui).findIndex((row) => row.includes(text));
}

/** Keeps typing and pastes into the composer that is still live behind a running check. */
async function typeAndPasteAfterSubmit(ui: ReturnType<typeof renderFeature>): Promise<void> {
  ui.stdin.write(TYPED_AFTER_SUBMIT);
  await vi.waitFor(() => expect(ui.lastFrame()).toContain(`${DRAFT}${TYPED_AFTER_SUBMIT}`));
  ui.stdin.write(PASTED_LINES);
  await vi.waitFor(() => expect(ui.lastFrame()).toContain(PASTE_CHIP));
  await flushEffects();
}

beforeEach(() => {
  forceUnicodeGlyphs();
  resetAllStores();
  projectDir = createTempDir('preparation-composer');
  configStore.__testReset({ config: makeConfig(), projectDir });
  terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
});

afterEach(() => {
  resetAllStores();
  cleanupTempDir(projectDir);
  projectDir = '';
});

describe('a check running beside the composer', () => {
  it.each(['resolve', 'reject', 'cancel'] as const)(
    'keeps the exact draft and the composer where it was when the check ends in %s',
    async (ending) => {
      const pending = Promise.withResolvers<PreparationOutcome>();
      const ui = renderHome(() => pending.promise);
      await flushEffects();
      const idleRows = frameRows(ui);
      const hintRow = idleRows.findIndex((row) => row.includes(HOME_HINT));
      expect(hintRow).toBeGreaterThan(0);

      ui.stdin.write(DRAFT);
      await vi.waitFor(() => expect(ui.lastFrame()).toContain(DRAFT));
      ui.stdin.write(ENTER);
      await vi.waitFor(() => expect(preparationStore.get().kind).toBe('checking'));
      await flushEffects();
      // The status takes the hint's own row: nothing is inserted, so nothing moves.
      expect(frameRows(ui)[hintRow]).toContain(CHECKING);
      expect(frameRows(ui).length).toBe(idleRows.length);
      expect(ui.lastFrame()).not.toContain(FULLSCREEN_PANEL_TITLE);

      // Typing and pasting are the composer's; neither touches the attempt they ran beside.
      await typeAndPasteAfterSubmit(ui);
      ui.stdin.write(BEFORE_MARK);
      let busyRows: string[] = [];
      await vi.waitFor(() => {
        busyRows = frameRows(ui);
        expect(busyRows.find((row) => row.includes(DRAFT)) ?? '').toContain(BEFORE_MARK);
      });
      expect(preparationStore.get().kind).toBe('checking');
      const statusRow = busyRows.findIndex((row) => row.includes(CHECKING));
      const composerRow = busyRows.findIndex((row) =>
        row.includes(`${DRAFT}${TYPED_AFTER_SUBMIT}`),
      );
      const chipRow = busyRows.findIndex((row) => row.includes(PASTE_CHIP));

      if (ending === 'cancel') {
        ui.stdin.write(ESC);
      } else if (ending === 'resolve') {
        pending.resolve({ kind: 'blocked', report: blockedReport() });
      } else {
        pending.reject(new Error('The runner check did not complete.'));
      }
      await vi.waitFor(() => expect(preparationStore.get().kind).not.toBe('checking'));
      await flushEffects();

      // A result that needs an answer takes the page; it never takes the draft under it.
      if (ending !== 'cancel') {
        expect(ui.lastFrame()).toContain('r retry');
        ui.stdin.write(ESC);
        await vi.waitFor(() => expect(ui.lastFrame()).not.toContain('r retry'));
      }

      const settled = frameRows(ui);
      expect(settled.length).toBe(busyRows.length);
      expect(settled[composerRow]).toBe(busyRows[composerRow]);
      expect(settled[chipRow]).toBe(busyRows[chipRow]);
      // The row the status borrowed goes back to being the hint row, in place.
      expect(settled[statusRow]).toContain(HOME_HINT);
      expect(settled.flatMap((row, index) => (row === busyRows[index] ? [] : [index]))).toEqual([
        statusRow,
      ]);

      // The caret did not move either: the next keystroke lands right after the last one.
      ui.stdin.write(AFTER_MARK);
      await vi.waitFor(() => expect(ui.lastFrame()).toContain(`${BEFORE_MARK}${AFTER_MARK}`));
      expect(rowWith(ui, `${BEFORE_MARK}${AFTER_MARK}`)).toBe(composerRow);

      if (ending === 'cancel') pending.resolve({ kind: 'aborted' });
      ui.unmount();
    },
  );

  it('names a check this screen did not submit without offering a key it cannot spend', async () => {
    const older = Promise.withResolvers<PreparationOutcome>();
    const ui = renderHome(async () => ({ kind: 'aborted' }));
    await flushEffects();

    // What the CLI submits before the mount is the same wait, and Home is the screen it lands on.
    const launch = preparationStore.submit({
      origin: 'start',
      stage: CHECKING,
      prepare: () => older.promise,
      onPrepared: () => {
        throw new Error('the superseded attempt must not hand off');
      },
    });
    await flushEffects();
    const statusRow = rowWith(ui, CHECKING);
    expect(statusRow).toBeGreaterThan(0);
    expect(frameRows(ui)[statusRow]).not.toContain('esc cancel');
    expect(ui.lastFrame()).not.toContain(FULLSCREEN_PANEL_TITLE);

    // Escape spends nothing that is not this screen's, so the older check keeps running.
    ui.stdin.write(ESC);
    await tick(20);
    expect(preparationStore.get()).toMatchObject({ kind: 'checking', attempt: launch.attempt });

    older.resolve({ kind: 'aborted' });
    await launch.promise;
    ui.unmount();
  });

  it('a stale completion from the older check cannot take the newer run off the screen', async () => {
    const older = Promise.withResolvers<PreparationOutcome>();
    const newer = Promise.withResolvers<PreparationOutcome>();
    const ui = renderHome(() => newer.promise);
    await flushEffects();

    const launch = preparationStore.submit({
      origin: 'start',
      stage: CHECKING,
      prepare: () => older.promise,
      onPrepared: () => {
        throw new Error('the superseded attempt must not hand off');
      },
    });
    await flushEffects();

    ui.stdin.write('start from home');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('start from home'));
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      const state = preparationStore.get();
      expect(state.kind === 'checking' && state.attempt > launch.attempt).toBe(true);
    });
    const current = preparationStore.get();

    older.reject(new Error('the older check failed after it was superseded'));
    await launch.promise;
    await flushEffects();

    // The failure of an attempt nobody is waiting on changes nothing: no panel, no route change,
    // and the newer check is still the one the row is naming.
    expect(preparationStore.get()).toBe(current);
    expect(ui.lastFrame()).not.toContain('Tool preparation');
    expect(routerStore.get()).toEqual({ screen: 'home' });
    expect(frameRows(ui)[rowWith(ui, CHECKING)]).toContain('esc cancel');

    newer.resolve({ kind: 'aborted' });
    ui.unmount();
  });
});

describe('a resume checking its tools', () => {
  const workflowDeps: WorkflowScreenDeps = {
    runWorkflow: async () => {
      throw new Error('a run at rest must not start a workflow');
    },
  };

  function continueDeps(prepareResume: SessionSelectDeps['prepareResume']): SessionSelectDeps {
    return {
      loadResumeState: () => ({ kind: 'loaded', state: RESUME_STATE }),
      prepareResume,
      hydrateRun: async () => {},
    };
  }

  it('keeps the selected run on screen and states the check beside its composer', async () => {
    routerStore.init({ screen: 'workflow', run: AT_REST_RUN, execution: { kind: 'at-rest' } });
    const exactRoute = routerStore.get();
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const ui = renderFeature(<WorkflowRoute deps={workflowDeps} />, { cols: 100, rows: 30 });
    await tick(20);
    const atRestRows = frameRows(ui);

    const selection = continueRunInPlace({
      record: AT_REST_RUN,
      state: RESUME_STATE,
      deps: continueDeps((_input, attemptSignal) => {
        signal = attemptSignal;
        return pending.promise;
      }),
    });
    await vi.waitFor(() => expect(preparationStore.get().kind).toBe('checking'));
    await tick(20);

    const checkingRows = frameRows(ui);
    expect(ui.lastFrame()).not.toContain(FULLSCREEN_PANEL_TITLE);
    // The run is exactly where it was. Two rows move, and only because Escape changed hands: the
    // byline it already had now names the check, and the legend stops offering esc for going home.
    const statusRow = checkingRows.findIndex((row) => row.includes(CHECKING));
    const legendRow = atRestRows.findIndex((row) => row.includes('esc home'));
    expect(checkingRows[statusRow]).toContain('esc cancel');
    expect(checkingRows[legendRow]).not.toContain('esc');
    expect(checkingRows[legendRow]).toContain('ctrl+k commands');
    expect(
      checkingRows.flatMap((row, index) => (row === atRestRows[index] ? [] : [index])),
    ).toEqual([legendRow, statusRow].sort((left, right) => left - right));

    // The composer beside the status still takes a correction.
    ui.stdin.write('and keep the parser');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('and keep the parser'));
    expect(routerStore.get()).toBe(exactRoute);

    ui.stdin.write(ESC);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await tick(20);
    expect(preparationStore.get()).toEqual({ kind: 'idle' });
    expect(routerStore.get()).toBe(exactRoute);
    expect(ui.lastFrame()).toContain('and keep the parser');
    expect(frameRows(ui).length).toBe(atRestRows.length);

    pending.resolve({ kind: 'aborted' });
    await selection;
    ui.unmount();
  });

  it('gives the page to a blocked resume and gives the run back when it is dismissed', async () => {
    routerStore.init({ screen: 'workflow', run: AT_REST_RUN, execution: { kind: 'at-rest' } });
    const exactRoute = routerStore.get();
    const ui = renderFeature(<WorkflowRoute deps={workflowDeps} />, { cols: 100, rows: 30 });
    await tick(20);
    const atRestFrame = ui.lastFrame();

    await continueRunInPlace({
      record: AT_REST_RUN,
      state: RESUME_STATE,
      deps: continueDeps(async () => ({ kind: 'blocked', report: blockedReport() })),
    });
    await tick(20);

    expect(ui.lastFrame()).toContain('The configured runner could not be admitted.');
    expect(ui.lastFrame()).toContain('r retry · esc back · s settings');
    expect(ui.lastFrame()).not.toContain(AT_REST_RUN.feature);

    // The composer the panel covers takes nothing while it is covered: the panel's keys mean one
    // thing each, and no stray keystroke is waiting in the draft when the run comes back.
    ui.stdin.write('zqx');
    await tick(20);
    expect(ui.lastFrame()).not.toContain('zqx');

    ui.stdin.write(ESC);
    await vi.waitFor(() => expect(preparationStore.get().kind).toBe('idle'));
    await tick(20);
    expect(routerStore.get()).toBe(exactRoute);
    expect(ui.lastFrame()).toBe(atRestFrame);
    ui.unmount();
  });
});
