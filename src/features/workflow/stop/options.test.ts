import { afterEach, beforeEach, describe, it, expect, onTestFinished } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { taskId } from '../../../core/schemas/task.js';
import {
  activeApply,
  trackActiveApply,
} from '../../../engine/orchestrator/session-lifecycle/shutdown.js';
import {
  makeReviewFixInsertedEvents,
  makeTaskComplete,
  makeTaskStart,
} from '#testing/helpers/events/task.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import {
  STOP_SHEET_FOOTER,
  STOP_SHEET_LEGEND,
  STOP_SHEET_PARKED_LEGEND,
  readStopMenuRows,
  readStopSheetFooter,
  stopMenuLayout,
  stopSheetFooter,
  stopSheetRows,
} from './options.js';

describe('stopSheetRows', () => {
  it('keeps action spans through the existing clause wrapping', () => {
    const layout = stopMenuLayout(
      [{ label: 'Run all', consequence: 'run commands; read output' }],
      34,
    );
    expect(layout.options[0]?.parts).toEqual([
      [
        { text: 'Run all', tone: 'text' },
        { text: ' · ', tone: 'textDim' },
        { text: 'run commands;', tone: 'textDim' },
      ],
      [
        { text: '  ', tone: 'textDim' },
        { text: 'read output', tone: 'textDim' },
      ],
    ]);
    expect(layout.options[0]?.lines).toEqual(['Run all · run commands;', '  read output']);
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

  it('promises no revert and names confirm as the shared key', () => {
    expect(STOP_SHEET_FOOTER).toBe('Changes and draft stay.');
    expect(STOP_SHEET_LEGEND).toBe('↑↓ select · ⏎ confirm · esc stop · tab close');
    expect(STOP_SHEET_PARKED_LEGEND).toBe('↑↓ select · ⏎ confirm · esc back · tab close');
  });

  it('promises only the draft before a brief has run', () => {
    expect(stopSheetFooter({ hasChanges: false })).toBe('Draft stays.');
    expect(stopSheetFooter({ hasChanges: true })).toBe(STOP_SHEET_FOOTER);
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

describe('stopMenuLayout', () => {
  it('takes the composer width at every terminal width, so the two stacked boxes share both edges', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
    });

    for (const cols of [60, 120, 220]) {
      expect(stopMenuLayout(rows, cols).width).toBe(getChromeContentWidth(cols));
    }
  });

  const building = stopSheetRows({
    currentTaskId: 'T002',
    nextTaskId: 'T003',
    boundaryPauseRequested: false,
    hasChanges: true,
  });

  it('states every consequence, so the sheet is as tall as its rows whichever is selected', () => {
    expect(stopMenuLayout(building, 120).bodyRows).toBe(3);
    expect(stopMenuLayout(building, 80).bodyRows).toBe(4);
    expect(stopMenuLayout(building, 60).bodyRows).toBe(5);
  });

  it('breaks a wrapped row between clauses and hangs the rest under its label', () => {
    expect(stopMenuLayout(building, 80).options[1]?.lines).toEqual([
      'Pause after this brief · finish T002 including checks and review;',
      '  do not start T003',
    ]);
    expect(stopMenuLayout(building, 60).options[2]?.lines).toEqual([
      'End run · stop execution; close this run;',
      '  keep changes',
    ]);
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
        consequence: 'return home; keep the run and draft',
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
    recoveryNoticeStore.open({
      seat: 'build',
      ranOn: null,
      resetAt: null,
      issue: applyPartial,
      at: { kind: 'review', cycle: 0 },
    });

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
    recoveryNoticeStore.open({
      seat: 'build',
      ranOn: null,
      resetAt: null,
      issue: makeRecoveryIssue({ reason: 'runner-usage-limit', taskId: taskId('T001') }),
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });
  });

  it('offers Stop now and End run, and no pause after the halted brief', () => {
    expect(readStopMenuRows().map((row) => row.id)).toEqual(['stop-now', 'end-run']);
  });

  it('offers pause after the running brief once the halt notice is cleared', () => {
    recoveryNoticeStore.clear();

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

  it('keeps only the draft when the cut brief had written nothing, as the byline says', () => {
    stopStore.park('mid-brief', 'T001', null, []);

    expect(readStopSheetFooter()).toBe('Draft stays.');
    expect(readStopMenuRows().find((row) => row.id === 'end-run')?.consequence).toBe(
      'close this run',
    );
  });

  it('keeps changes when the cut brief had written files', () => {
    stopStore.park('mid-brief', 'T001', null, ['src/sum.js']);

    expect(readStopSheetFooter()).toBe(STOP_SHEET_FOOTER);
    expect(readStopMenuRows().find((row) => row.id === 'end-run')?.consequence).toBe(
      'close this run; keep changes',
    );
  });

  it('reads the kept files from the record of a stopped run at rest', () => {
    const atRest = (kept?: readonly string[]) =>
      routerStore.init({
        screen: 'workflow',
        run: makeRunRecord({
          status: {
            kind: 'open',
            stop: {
              kind: 'stopped',
              on: { kind: 'paused', at: 'mid-step', ...(kept !== undefined && { kept }) },
            },
            resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
          },
        }),
        execution: { kind: 'at-rest' },
      });

    atRest();
    expect(readStopSheetFooter()).toBe('Draft stays.');
    atRest(['src/sum.js']);
    expect(readStopSheetFooter()).toBe(STOP_SHEET_FOOTER);
  });
});
