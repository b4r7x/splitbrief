import { afterEach, beforeEach, describe, it, expect, onTestFinished } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { resetAllStores, setRunHalt } from '#testing/helpers/stores.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { createDraftDocument } from '../../../core/composer/document.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { taskId } from '../../../core/schemas/task.js';
import { EMPTY_BRIEFS, type RunBriefs } from '../../../core/run-view/briefs.js';
import { EMPTY_RUN_VIEW } from '../../../core/run-view/reduce.js';
import {
  activeApply,
  trackActiveApply,
} from '../../../engine/orchestrator/session-lifecycle/shutdown.js';
import {
  makeReviewFixInsertedEvents,
  makeTaskComplete,
  makeTaskStart,
} from '#testing/helpers/events/task.js';
import {
  STOP_SHEET_LEGEND,
  STOP_SHEET_PARKED_LEGEND,
  readStopMenuInput,
  readStopMenuRows,
  stopMenuFooter,
  stopMenuRows,
  type StopMenuInput,
  stopSheetFooter,
  stopSheetRows,
} from './options.js';
import { inlineMenuLayout } from '../inline-menu/layout.js';

describe('stopSheetRows', () => {
  it('keeps action spans through the existing clause wrapping', () => {
    const layout = inlineMenuLayout(
      [{ label: 'Run all', consequence: 'run commands; read output' }],
      34,
    );
    expect(layout.lines.map((line) => line.name + line.description.trimStart())).toEqual([
      'Run all',
      'run commands; read output',
    ]);
  });
  it('names the brief it would finish and the one it would not start', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
    });

    expect(rows.map((row) => row.id)).toEqual(['stop-now', 'pause-after-brief', 'end-run']);
    expect(rows[1]?.label).toBe('Pause after this brief');
    expect(rows[1]?.consequence).toBe('finish T002 including checks and review; do not start T003');
  });

  it('hides the pause row when no brief is running', () => {
    const rows = stopSheetRows({
      currentTaskId: null,
      nextTaskId: null,
      boundaryPauseRequested: false,
    });

    expect(rows.map((row) => row.id)).toEqual(['stop-now', 'end-run']);
  });

  it('offers the way back while a pause is pending', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: true,
    });

    expect(rows.map((row) => row.id)).toEqual(['stop-now', 'keep-running', 'end-run']);
    expect(rows[1]?.label).toBe('Keep running');
  });

  it('names the last brief without inventing a successor', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T005',
      nextTaskId: null,
      boundaryPauseRequested: false,
    });

    expect(rows[1]?.consequence).toBe(
      'finish T005 including checks and review; do not start another brief',
    );
  });

  it('promises checks and no review in the pause row of a REVIEW None run', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
      reviewNone: true,
    });

    expect(rows[1]?.consequence).toBe('finish T002 including checks; do not start T003');
  });

  it('promises no revert and names confirm as the shared key', () => {
    expect(STOP_SHEET_LEGEND).toBe('↑↓ select · ⏎ confirm · esc stop · tab close');
    expect(STOP_SHEET_PARKED_LEGEND).toBe('↑↓ select · ⏎ confirm · esc back · tab close');
  });

  it('names only what stays: the changes, the draft, both, or nothing', () => {
    expect(stopSheetFooter({ hasChanges: true, hasDraft: true })).toBe('Changes and draft stay.');
    expect(stopSheetFooter({ hasChanges: true, hasDraft: false })).toBe('Changes stay.');
    expect(stopSheetFooter({ hasChanges: false, hasDraft: true })).toBe('Draft stays.');
    expect(stopSheetFooter({ hasChanges: false, hasDraft: false })).toBeNull();
  });

  it('claims partial changes on Stop now only while a brief runs', () => {
    const idle = stopSheetRows({
      currentTaskId: null,
      nextTaskId: null,
      boundaryPauseRequested: false,
    });
    const building = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
      hasChanges: true,
    });

    expect(idle[0]?.consequence).toBe('stop execution; keep the run open');
    expect(building[0]?.consequence).toBe('stop execution; keep partial changes');
  });

  it('claims no partial changes on Stop now once a revert left none of the brief files', () => {
    const rows = (briefKept: number) =>
      stopSheetRows({
        currentTaskId: 'T002',
        nextTaskId: 'T003',
        boundaryPauseRequested: false,
        briefKept,
      });

    expect(rows(0)[0]?.consequence).toBe('stop execution; keep the run open');
    expect(rows(0).map((row) => row.id)).toEqual(['stop-now', 'pause-after-brief', 'end-run']);
    expect(rows(1)[0]?.consequence).toBe('stop execution; keep partial changes');
  });

  it('claims kept changes on End run only once a brief has run', () => {
    const rows = (input: { hasChanges: boolean }) =>
      stopSheetRows({
        currentTaskId: null,
        nextTaskId: null,
        boundaryPauseRequested: false,
        hasChanges: input.hasChanges,
      });

    expect(rows({ hasChanges: false }).at(-1)?.consequence).toBe('stop execution; close this run');
    expect(rows({ hasChanges: true }).at(-1)?.consequence).toBe(
      'stop execution; close this run; keep changes',
    );
  });
});

describe('stopMenuRows', () => {
  const IDLE: StopMenuInput = {
    stop: { phase: 'idle', intent: 'none', parked: null },
    route: { screen: 'home' },
    view: EMPTY_RUN_VIEW,
    applying: false,
    hasDraft: false,
  };
  const ON_T002: RunBriefs = {
    ...EMPTY_BRIEFS,
    tasks: [
      { id: 'T001', title: 'One', status: 'done' },
      { id: 'T002', title: 'Two', status: 'in_progress' },
      { id: 'T003', title: 'Three', status: 'pending' },
    ],
    currentTask: 2,
    totalTasks: 3,
  };
  const parkedOn = (kept: readonly string[]): StopMenuInput['stop'] => ({
    phase: 'parked',
    intent: 'stop-now',
    parked: { kind: 'mid-brief', taskId: 'T002', resolve: null, kept },
  });

  it('offers only Retry stop once the stop failed', () => {
    const rows = stopMenuRows({ ...IDLE, stop: { ...IDLE.stop, phase: 'failed' } });

    expect(rows.map((row) => row.id)).toEqual(['retry-stop']);
  });

  it('offers only the way back while this process applies the run, keeping the draft', () => {
    expect(stopMenuRows({ ...IDLE, applying: true, hasDraft: true })).toEqual([
      {
        id: 'leave',
        label: 'Back to sessions',
        consequence: 'return home; keep the run and draft',
      },
    ]);
  });

  it('pauses after the running brief and keeps the changes of the finished one', () => {
    const rows = stopMenuRows({
      ...IDLE,
      view: { ...EMPTY_RUN_VIEW, phase: 'implementing', briefs: ON_T002 },
    });

    expect(rows.map((row) => [row.id, row.consequence])).toEqual([
      ['stop-now', 'stop execution; keep partial changes'],
      ['pause-after-brief', 'finish T002 including checks and review; do not start T003'],
      ['end-run', 'stop execution; close this run; keep changes'],
    ]);
  });

  it('keeps only the rows the halt accepts', () => {
    const rows = stopMenuRows({
      ...IDLE,
      view: {
        ...EMPTY_RUN_VIEW,
        phase: 'implementing',
        briefs: ON_T002,
        halt: {
          issue: makeRecoveryIssue({ availableActions: ['retry-same-worker'] }),
          at: { kind: 'review', cycle: 0 },
        },
      },
    });

    expect(rows.map((row) => [row.id, row.consequence])).toEqual([
      ['stop-now', 'park the run; keep it open'],
    ]);
  });

  it('waits for the stop it carries out', () => {
    const rows = stopMenuRows({
      ...IDLE,
      stop: { phase: 'requested', intent: 'stop-now', parked: null },
    });

    expect(rows.map((row) => [row.id, row.label])).toEqual([['leave', 'Back after stop']]);
  });

  it('offers Resume and End run on a parked run, with the files and the draft it keeps', () => {
    const rows = stopMenuRows({ ...IDLE, stop: parkedOn(['src/b.ts']), hasDraft: true });

    expect(rows.map((row) => [row.id, row.consequence])).toEqual([
      ['resume', 'continue this run; keep the unsent draft'],
      ['end-run', 'close this run; keep changes'],
      ['leave', 'return home; keep the run and draft'],
    ]);
  });

  it('names in the footer what the parked run keeps', () => {
    expect(stopMenuFooter({ ...IDLE, stop: parkedOn(['src/b.ts']), hasDraft: true })).toBe(
      'Changes and draft stay.',
    );
    expect(stopMenuFooter({ ...IDLE, stop: parkedOn([]) })).toBeNull();
  });
});

describe('readStopMenuRows on a run another process holds', () => {
  afterEach(() => {
    resetAllStores();
  });

  function openHeldRun(): void {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ status: { kind: 'running' } }),
      execution: { kind: 'at-rest' },
    });
  }

  it('offers only the way back on a run another process holds, never Resume or End run', () => {
    openHeldRun();

    expect(readStopMenuRows()).toEqual([
      {
        id: 'leave',
        label: 'Back to sessions',
        consequence: 'return home; keep the run',
      },
    ]);
  });
});

describe('readStopMenuRows on a run ready to apply', () => {
  afterEach(() => {
    resetAllStores();
  });

  it.each([null, makeSummary(), makeSummary({ changedFiles: ['src/changed.ts'] })])(
    'offers End run as a discard that saves run.patch, and no Resume',
    (summary) => {
      routerStore.init({
        screen: 'workflow',
        run: makeRunRecord({ status: { kind: 'ready-to-apply', override: false }, summary }),
        execution: { kind: 'at-rest' },
      });

      const rows = readStopMenuRows();
      expect(rows.map((row) => row.id)).toEqual(['end-run', 'leave']);
      expect(rows[0]?.consequence).toBe('discard the result; save its changes in run.patch');
    },
  );

  it('offers End run without a patch when the ready run changed no files', () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        status: { kind: 'ready-to-apply', override: false },
        summary: makeSummary({ changedFiles: [] }),
      }),
      execution: { kind: 'at-rest' },
    });

    const rows = readStopMenuRows();
    expect(rows.map((row) => row.id)).toEqual(['end-run', 'leave']);
    expect(rows[0]?.consequence).toBe('discard the result; it changed no files');
    expect(rows[0]?.consequence).not.toContain('run.patch');
  });
});

describe('readStopMenuRows during an unfinished Apply', () => {
  afterEach(() => {
    resetAllStores();
  });

  const applyPartial = makeRecoveryIssue({
    reason: 'apply-partial',
    phase: 'complete',
    availableActions: ['retry-same-worker', 'restore-backup'],
  });

  it('offers no End run on a run at rest whose Apply did not finish', () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        hydration: {
          kind: 'loaded',
          state: makeWorkflowState({
            phase: 'complete',
            applying: { at: '2026-10-17T00:00:00.000Z', backupId: 'b1' },
            pendingRecovery: applyPartial,
          }),
        },
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: applyPartial } },
          resumeAt: { kind: 'review', cycle: 0 },
        },
      }),
      execution: { kind: 'at-rest' },
    });

    expect(readStopMenuRows().map((row) => row.id)).toEqual(['resume', 'leave']);
  });

  it('offers no End run at a live halt whose actions refuse it', () => {
    setRunHalt({ issue: applyPartial, at: { kind: 'review', cycle: 0 } });

    expect(readStopMenuRows().map((row) => row.id)).toEqual(['stop-now']);
  });

  it('offers neither Stop now nor End run while this process applies the run live', async () => {
    const apply = Promise.withResolvers<void>();
    void trackActiveApply(apply.promise);
    onTestFinished(async () => {
      apply.resolve();
      await activeApply();
    });

    expect(readStopMenuRows().map((row) => row.id)).toEqual(['leave']);
  });
});

describe('readStopMenuRows right after a continue', () => {
  afterEach(() => {
    resetAllStores();
  });

  it('pauses after the inserted running fix and holds back the next fix before pending plan work', () => {
    resetAllStores();
    for (const event of makeReviewFixInsertedEvents()) addEvent(event);
    expect(readStopMenuRows().find((row) => row.id === 'pause-after-brief')?.consequence).toBe(
      'finish T006 including checks and review; do not start T007',
    );
    addEvent(makeTaskComplete({ taskId: taskId('T006') }));
    addEvent(makeTaskStart({ taskId: taskId('T007'), index: 0, total: 7 }));
    expect(readStopMenuRows().find((row) => row.id === 'pause-after-brief')?.consequence).toBe(
      'finish T007 including checks and review; do not start T005',
    );
  });

  it('reads REVIEW None for the pause row from the run pass, with no config loaded', () => {
    resetAllStores();
    for (const event of makeReviewFixInsertedEvents()) addEvent(event);
    addEvent({
      type: 'workflow_config',
      ts: 1,
      phase: 'implementing',
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      reviewerSeat: 'none',
    });

    expect(readStopMenuRows().find((row) => row.id === 'pause-after-brief')?.consequence).toBe(
      'finish T006 including checks; do not start T007',
    );
  });

  // Continuing a halt resets its brief before the task loop starts it again, so for that moment no
  // brief reads in progress. The run is still on that brief, and a pause after it is still a choice.
  it('offers a pause after the brief the run is on, before the brief starts again', () => {
    const phase = 'implementing' as const;
    addEvent({
      type: 'tasks_planned',
      ts: 1,
      phase,
      tasks: [
        { id: taskId('T001'), title: 'One', index: 0, file: 'a.ts', action: 'create' },
        { id: taskId('T002'), title: 'Two', index: 1, file: 'b.ts', action: 'create' },
        { id: taskId('T003'), title: 'Three', index: 2, file: 'c.ts', action: 'create' },
      ],
      total: 3,
    });
    addEvent({
      type: 'task_started',
      ts: 2,
      phase,
      taskId: taskId('T001'),
      title: 'One',
      index: 0,
      total: 3,
      file: 'a.ts',
      action: 'create',
    });
    addEvent({
      type: 'task_completed',
      ts: 3,
      phase,
      taskId: taskId('T001'),
      title: 'One',
      method: 'local',
      retries: 0,
      duration: 1,
    });
    addEvent({
      type: 'task_started',
      ts: 4,
      phase,
      taskId: taskId('T002'),
      title: 'Two',
      index: 1,
      total: 3,
      file: 'b.ts',
      action: 'create',
    });
    addEvent({ type: 'task_reset', ts: 5, phase, taskId: taskId('T002') });

    const pause = readStopMenuRows().find((row) => row.id === 'pause-after-brief');
    expect(pause?.consequence).toBe('finish T002 including checks and review; do not start T003');
  });
});

describe('readStopMenuRows at a recovery halt', () => {
  afterEach(() => {
    resetAllStores();
  });

  beforeEach(() => {
    const phase = 'implementing' as const;
    addEvent({
      type: 'tasks_planned',
      ts: 1,
      phase,
      tasks: [
        { id: taskId('T001'), title: 'One', index: 0, file: 'a.ts', action: 'create' },
        { id: taskId('T002'), title: 'Two', index: 1, file: 'b.ts', action: 'create' },
      ],
      total: 2,
    });
    addEvent({
      type: 'task_started',
      ts: 2,
      phase,
      taskId: taskId('T001'),
      title: 'One',
      index: 0,
      total: 2,
      file: 'a.ts',
      action: 'create',
    });
    setRunHalt({
      issue: makeRecoveryIssue({ reason: 'runner-usage-limit', taskId: taskId('T001') }),
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });
  });

  it('offers Stop now and End run, and no pause after the halted brief', () => {
    expect(readStopMenuRows().map((row) => row.id)).toEqual(['stop-now', 'end-run']);
  });

  it('offers pause after the running brief once the halt notice is cleared', () => {
    setRunHalt(null);

    expect(readStopMenuRows().map((row) => row.id)).toEqual([
      'stop-now',
      'pause-after-brief',
      'end-run',
    ]);
  });
});

describe('Session options after a stop cut a brief', () => {
  afterEach(() => {
    resetAllStores();
  });

  beforeEach(() => {
    addEvent({
      type: 'tasks_planned',
      ts: 1,
      phase: 'implementing',
      tasks: [{ id: taskId('T001'), title: 'Sum', index: 0, file: 'src/sum.js', action: 'create' }],
      total: 1,
    });
    addEvent(makeTaskStart({ taskId: taskId('T001'), index: 0, total: 1 }));
  });

  it('names nothing kept when the cut brief had written nothing, as the byline says', () => {
    stopStore.park('mid-brief', 'T001', null, []);

    expect(stopMenuFooter(readStopMenuInput())).toBeNull();
    expect(readStopMenuRows().find((row) => row.id === 'end-run')?.consequence).toBe(
      'close this run',
    );
  });

  it('keeps changes when the cut brief had written files', () => {
    stopStore.park('mid-brief', 'T001', null, ['src/sum.js']);

    expect(stopMenuFooter(readStopMenuInput())).toBe('Changes stay.');
    expect(readStopMenuRows().find((row) => row.id === 'end-run')?.consequence).toBe(
      'close this run; keep changes',
    );
  });

  it('reads the kept files from the record of a stopped run at rest', () => {
    const atRest = (kept: readonly string[] = []) => {
      routerStore.init({
        screen: 'workflow',
        run: makeRunRecord({
          status: {
            kind: 'open',
            stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
            resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
          },
        }),
        execution: { kind: 'at-rest' },
      });
      runViewStore.__testReset({ stopKept: kept });
    };

    atRest();
    expect(stopMenuFooter(readStopMenuInput())).toBeNull();
    atRest(['src/sum.js']);
    expect(stopMenuFooter(readStopMenuInput())).toBe('Changes stay.');
  });
});

describe('the draft in the stop rows and footer', () => {
  afterEach(() => {
    resetAllStores();
  });

  it('promises a draft only while the composer holds one', () => {
    stopStore.park('mid-brief', 'T001', null, []);

    expect(stopMenuFooter(readStopMenuInput())).toBeNull();
    expect(readStopMenuRows().find((row) => row.id === 'leave')?.consequence).toBe(
      'return home; keep the run',
    );
    expect(readStopMenuRows().find((row) => row.id === 'resume')?.consequence).toBe(
      'continue this run',
    );

    composerLiveStore.setDraft(createDraftDocument('note'));

    expect(stopMenuFooter(readStopMenuInput())).toBe('Draft stays.');
    expect(readStopMenuRows().find((row) => row.id === 'leave')?.consequence).toBe(
      'return home; keep the run and draft',
    );
    expect(readStopMenuRows().find((row) => row.id === 'resume')?.consequence).toBe(
      'continue this run; keep the unsent draft',
    );
  });
});

describe('the stop sheet after a revert or a restore of the running brief', () => {
  afterEach(() => {
    resetAllStores();
  });

  beforeEach(() => {
    addEvent({
      type: 'tasks_planned',
      ts: 1,
      phase: 'implementing',
      tasks: [{ id: taskId('T001'), title: 'Sum', index: 0, file: 'src/sum.js', action: 'create' }],
      total: 1,
    });
    addEvent(makeTaskStart({ taskId: taskId('T001'), index: 0, total: 1 }));
    addEvent({
      type: 'implementer_generate_running',
      ts: 2,
      phase: 'implementing',
      taskId: taskId('T001'),
    });
  });

  const sheet = () => {
    const rows = readStopMenuRows();
    return {
      stopNow: rows.find((row) => row.id === 'stop-now')?.consequence,
      endRun: rows.find((row) => row.id === 'end-run')?.consequence,
      footer: stopMenuFooter(readStopMenuInput()),
    };
  };
  const KEPT = {
    stopNow: 'stop execution; keep partial changes',
    endRun: 'stop execution; close this run; keep changes',
    footer: 'Changes stay.',
  };
  const NOTHING = {
    stopNow: 'stop execution; keep the run open',
    endRun: 'stop execution; close this run',
    footer: null,
  };
  const reverted = (ts: number, briefKept: number) =>
    addEvent({
      type: 'info',
      ts,
      phase: 'implementing',
      message: 'T001 attempt reverted: 1 file',
      briefKept,
    });

  it('keeps nothing after the first attempt was put back, until the next attempt runs', () => {
    reverted(3, 0);

    expect(sheet()).toEqual(NOTHING);

    addEvent({
      type: 'implementer_generate_running',
      ts: 4,
      phase: 'implementing',
      taskId: taskId('T001'),
    });

    expect(sheet()).toEqual(KEPT);
  });

  it('keeps partial changes after a failed retry, which leaves the files of the attempt before it', () => {
    addEvent({
      type: 'task_retry',
      ts: 3,
      phase: 'implementing',
      taskId: taskId('T001'),
      attempt: 1,
      maxRetries: 2,
      error: 'K1 failed',
    });
    reverted(4, 1);

    expect(sheet()).toEqual(KEPT);
  });

  it('keeps partial changes after a resumed attempt failed on the files from before its stop', () => {
    addEvent({ type: 'workflow_resumed', ts: 3, phase: 'implementing' });
    addEvent(makeTaskStart({ ts: 4, taskId: taskId('T001'), index: 0, total: 1 }));
    reverted(5, 1);

    expect(sheet()).toEqual(KEPT);
  });

  it('keeps partial changes after a denial, which takes back only the denied files', () => {
    addEvent({
      type: 'error',
      ts: 3,
      phase: 'implementing',
      message:
        "Approval gate denied .env.local: no. SPLITBRIEF discarded this attempt's writes to .env.local.",
    });

    expect(sheet()).toEqual(KEPT);
  });

  it('keeps nothing at the halt after a denial took back every write of the brief', () => {
    addEvent({
      type: 'error',
      ts: 3,
      phase: 'implementing',
      message:
        "Task changed files blocked by approval gate: no. SPLITBRIEF discarded this attempt's writes to .env.local.",
      briefKept: 0,
    });
    setRunHalt({
      issue: makeRecoveryIssue({ reason: 'approval-denied', taskId: taskId('T001') }),
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });

    expect(readStopMenuRows().map((row) => row.id)).toEqual(['stop-now', 'end-run']);
    expect(sheet()).toEqual({ ...NOTHING, stopNow: 'park the run; keep it open' });
  });

  it('keeps nothing once a halt restored the brief to its start', () => {
    reverted(3, 1);
    addEvent({
      type: 'error',
      ts: 4,
      phase: 'implementing',
      message: 'Planner consult for T001 failed: The planner process stopped unexpectedly.',
    });
    setRunHalt({
      issue: makeRecoveryIssue({ reason: 'planner-call-failed', taskId: taskId('T001') }),
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 1 },
    });
    addEvent({
      type: 'warning',
      ts: 5,
      phase: 'implementing',
      message: 'Restored 1 change of the failing brief to its start: src/sum.js',
      briefKept: 0,
    });

    expect(readStopMenuRows().map((row) => row.id)).toEqual(['stop-now', 'end-run']);
    expect(sheet()).toEqual({ ...NOTHING, stopNow: 'park the run; keep it open' });
  });
});
