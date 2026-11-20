import { addEvent } from '../stores/workflow/actions/event.js';
import { conversationScrollStore } from '../stores/workflow/conversation-scroll.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { TieredApprovalResponse } from '../core/approval/types.js';
import type { ReadinessReport } from '../core/readiness/types.js';
import { createInitialState } from '../core/state/machine.js';
import { loadOwnerWorkflowState } from '../core/state/resume-hydration.js';
import type { PrepareExecutionInput } from '../engine/runners/prepare-execution/prepare.js';
import type { PreparationOutcome } from '../engine/runners/prepare-execution/prepared.js';
import { closeApprovalPrompt, openApprovalPrompt } from '../stores/prompts/approval.js';
import { composerLiveStore } from '../stores/ui/composer-live.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { draftDocumentText, inputHistoryStore } from '../stores/ui/input-history.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../lib/terminal/typeahead-grace.js';
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
const PASTE_CHIP = '[Pasted #1 +5 lines]';
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
            fix: 'Check the runner executable.',
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
  ref: {
    projectDir: join(process.env.XDG_STATE_HOME ?? tmpdir(), 'preparation-composer'),
    sessionId: '2026-09-16-resume',
  },
  feature: RESUME_STATE.feature,
  hydration: { kind: 'loaded', state: RESUME_STATE },
  status: {
    kind: 'open',
    stop: { kind: 'stopped', on: { kind: 'interrupted' } },
    resumeAt: { kind: 'planner', call: 'tasks' },
  },
});

function homeDeps(
  prepare: (input: PrepareExecutionInput) => Promise<PreparationOutcome>,
): HomeScreenDeps {
  return {
    prepareExecution: prepare,
    sessionSelect: {
      applying: () => false,
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
      await flushEffects();
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

      // The result stays beside the draft until dismissed.
      if (ending !== 'cancel') {
        expect(ui.lastFrame()).toContain('⏎ try again');
        ui.stdin.write(ESC);
        await vi.waitFor(() => expect(ui.lastFrame()).not.toContain('⏎ try again'));
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
    await flushEffects();
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
      applying: () => false,
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
    // The run is exactly where it was. Two rows move, and only because Escape and ctrl+k changed
    // hands: the byline it already had now names the check, and the legend stops offering esc for
    // going home or ctrl+k for the command palette. keys.test.tsx:973-975 pins that ctrl+k opens
    // nothing while sessionPreparationActive is true, so the old assertion that the check keeps
    // ctrl+k in the legend pinned the defect instead.
    const statusRow = checkingRows.findIndex((row) => row.includes(CHECKING));
    const legendRow = atRestRows.findIndex((row) => row.includes('esc home'));
    expect(atRestRows[legendRow]).toContain('esc home · ctrl+k commands');
    expect(checkingRows[statusRow]).toContain('esc cancel');
    expect(checkingRows[legendRow]).not.toContain('esc');
    expect(checkingRows[legendRow]).not.toContain('ctrl+k');
    expect(checkingRows[legendRow]).toContain('/sessions · /help');
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
    expect(frameRows(ui)[legendRow]).toContain('esc home · ctrl+k commands');

    pending.resolve({ kind: 'aborted' });
    await selection;
    ui.unmount();
  });

  it('keeps the transcript scroll and draft active while Continue is blocked', async () => {
    routerStore.init({ screen: 'workflow', run: AT_REST_RUN, execution: { kind: 'at-rest' } });
    addEvent({ type: 'user_message', phase: 'planning', ts: 123, text: AT_REST_RUN.feature });
    const exactRoute = routerStore.get();
    const ui = renderFeature(<WorkflowRoute deps={workflowDeps} />, { cols: 100, rows: 30 });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain(AT_REST_RUN.feature));
    for (let index = 0; index < 32; index++) {
      addEvent({
        type: 'user_message',
        phase: 'planning',
        ts: 124 + index,
        text: `Draft ${index}`,
      });
    }
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Draft 31'));
    const prepareResume = vi.fn(
      async (): Promise<PreparationOutcome> => ({
        kind: 'blocked',
        report: blockedReport(),
      }),
    );

    await continueRunInPlace({
      record: AT_REST_RUN,
      state: RESUME_STATE,
      deps: continueDeps(prepareResume),
    });
    await vi.waitFor(() =>
      expect(ui.lastFrame()).toContain('The configured runner could not be admitted.'),
    );
    expect.soft(ui.lastFrame()).toContain('⏎ try again · ctrl+d details');
    expect.soft(ui.lastFrame()).toContain('Draft 31');

    ui.stdin.write('\x1b[5~');
    await vi.waitFor(() => expect(conversationScrollStore.get().scrollOffset).toBeGreaterThan(0));

    ui.stdin.write('rs');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('› rs'));
    expect.soft(prepareResume).toHaveBeenCalledTimes(1);
    ui.stdin.write(ENTER);
    await vi.waitFor(() => expect(prepareResume).toHaveBeenCalledTimes(2));
    expect(ui.lastFrame()).toContain('› rs');

    ui.stdin.write(ESC);
    await vi.waitFor(() => expect(preparationStore.get().kind).toBe('idle'));
    expect(routerStore.get()).toBe(exactRoute);
    ui.unmount();
  });
});

describe('a runner trust gate on the continuation page', () => {
  const WORDS = 'keep the parser';

  afterEach(() => {
    vi.restoreAllMocks();
    closeApprovalPrompt();
  });

  // The words wait in the run's composer under the page. The clock stops at the open and then
  // moves past the grace, so the next key is one the user typed with the gate on the page.
  async function openGateOverWords() {
    // The run lives in this test's own project, so no draft that another test saved comes back.
    const run = makeRunRecord({ ...AT_REST_RUN, ref: { ...AT_REST_RUN.ref, projectDir } });
    routerStore.init({ screen: 'workflow', run, execution: { kind: 'at-rest' } });
    const gateOpens = Promise.withResolvers<void>();
    const answers: TieredApprovalResponse[] = [];
    const sessionSelect: SessionSelectDeps = {
      applying: () => false,
      loadResumeState: () => ({ kind: 'loaded', state: RESUME_STATE }),
      hydrateRun: async () => {},
      cancelPendingApproval: closeApprovalPrompt,
      prepareResume: async () => {
        await gateOpens.promise;
        answers.push(
          await openApprovalPrompt({
            tier: 'confirm',
            actionClass: 'runner_trust',
            actionDescription: 'Executable: "tools/review-bot"',
            phase: 'implementing',
          }),
        );
        return { kind: 'aborted' };
      },
    };
    const deps: WorkflowScreenDeps = {
      runWorkflow: async () => {
        throw new Error('a run at rest must not start a workflow');
      },
      sessionSelect,
    };
    const ui = renderFeature(<WorkflowRoute deps={deps} />, { cols: 100, rows: 30 });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('esc home'));
    const selection = continueRunInPlace({
      record: run,
      state: RESUME_STATE,
      deps: sessionSelect,
    });
    await vi.waitFor(() => expect(preparationStore.get().kind).toBe('checking'));
    ui.stdin.write(WORDS);
    await vi.waitFor(() => expect(composerLiveStore.get().text).toBe(WORDS));
    const openedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(openedAt);
    gateOpens.resolve();
    await vi.waitFor(() => expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Deny'));
    clock.mockReturnValue(openedAt + PROMPT_TYPEAHEAD_GRACE_MS + 30);
    await flushEffects();
    return { ui, selection, answers };
  }

  it('denies on x and leaves the words in the composer as they were', async () => {
    const { ui, selection, answers } = await openGateOverWords();
    ui.stdin.write('x');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    await selection;
    await flushEffects();
    expect({
      answers: answers.map((answer) => answer.decision),
      text: composerLiveStore.get().text,
    }).toEqual({ answers: ['deny'], text: WORDS });
    ui.unmount();
  });

  it('confirms on ⏎, sends none of the words and shows no feedback', async () => {
    const { ui, selection, answers } = await openGateOverWords();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    await selection;
    await flushEffects();
    expect({
      answers: answers.map((answer) => answer.decision),
      text: composerLiveStore.get().text,
      sent: inputHistoryStore.get().entries.map(draftDocumentText),
      feedback: feedbackStore.get(),
    }).toEqual({
      answers: ['confirm'],
      text: WORDS,
      sent: [],
      feedback: { message: null, severity: 'info' },
    });
    ui.unmount();
  });
});
