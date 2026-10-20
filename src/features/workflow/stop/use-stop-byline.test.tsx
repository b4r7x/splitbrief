import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import { taskId } from '../../../core/schemas/task.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { requestBoundaryPause, requestSeatChangeAtBoundary } from '../handlers.js';
import { useStopByline } from './use-stop-byline.js';

function Lead() {
  return (
    <Text>
      {useStopByline()
        ?.parts.map((part) => part.text)
        .join('') ?? 'none'}
    </Text>
  );
}

function LeadAndHint() {
  const byline = useStopByline();
  return (
    <Text>
      {byline === null
        ? 'none'
        : `${byline.parts.map((part) => part.text).join('')}|${byline.hint}`}
    </Text>
  );
}

/** Where a stopped run settles: at rest on its re-read record, parked with no brief named. */
function leadAfterStopAt(resumeAt: StepRef, kept: readonly string[] = []): string {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({
      status: {
        kind: 'open',
        stop: {
          kind: 'stopped',
          on: { kind: 'paused', at: 'mid-step', ...(kept.length > 0 && { kept }) },
        },
        resumeAt,
      },
    }),
    execution: { kind: 'at-rest' },
  });
  stopStore.request('stop-now');
  stopStore.park('mid-brief', null, null);
  const ui = renderFeature(<Lead />);
  const lead = ui.lastFrame().trim();
  ui.unmount();
  return lead;
}

describe('useStopByline', () => {
  beforeEach(resetAllStores);
  afterEach(resetAllStores);

  it('names the gate a stop settled at from the run record, with no changes to keep', () => {
    expect(leadAfterStopAt({ kind: 'gate', gate: 'plan' })).toBe('Stopped at the plan');
  });

  it('names the brief the record says the stop cut, and the changes it kept', () => {
    expect(
      leadAfterStopAt({ kind: 'brief', taskId: taskId('T004'), attempt: 1 }, ['src/a.ts']),
    ).toBe('Stopped at T004 · Partial changes kept');
  });

  it('claims no kept changes for a cut brief the record says changed nothing', () => {
    expect(leadAfterStopAt({ kind: 'brief', taskId: taskId('T004'), attempt: 1 })).toBe(
      'Stopped at T004',
    );
  });

  it('says nothing once End run closed the run: the closed run speaks for itself', () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        status: { kind: 'closed', as: 'ended' },
        hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'reviewing-plan' }) },
        summary: makeSummary(),
      }),
      execution: { kind: 'at-rest' },
    });
    stopStore.request('end-run');
    stopStore.end();
    const ui = renderFeature(<Lead />);

    expect(ui.lastFrame().trim()).toBe('none');
    ui.unmount();
  });

  it('names the brief the pause outlived once the running brief has finished', () => {
    lifecycleStore.__testReset({ phase: 'implementing' });
    tasksStore.__testReset({
      tasks: [
        { id: 'T001', title: 'first', status: 'done' },
        { id: 'T002', title: 'second', status: 'done' },
        { id: 'T003', title: 'third', status: 'done' },
      ],
      currentTask: 3,
      totalTasks: 3,
    });
    stopStore.request('pause-after-brief');
    const ui = renderFeature(<Lead />);

    expect(ui.lastFrame().trim()).toBe('Finishing T003');
    ui.unmount();
  });

  it('a seat saved while the plan is made keeps the run status and names when it changes', () => {
    lifecycleStore.__testReset({ status: 'running', phase: 'planning' });
    requestSeatChangeAtBoundary();
    const ui = renderFeature(<LeadAndHint />);

    expect(ui.lastFrame().trim()).toBe('|Seat changes after the next brief');
    ui.unmount();
  });

  it('a seat saved under a running brief names that brief and claims no finish', () => {
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });
    tasksStore.__testReset({
      tasks: [
        { id: 'T001', title: 'first', status: 'in_progress' },
        { id: 'T002', title: 'second', status: 'pending' },
      ],
      currentTask: 1,
      totalTasks: 2,
    });
    requestSeatChangeAtBoundary();
    const ui = renderFeature(<LeadAndHint />);

    expect(ui.lastFrame().trim()).toBe('|Seat changes after T001');
    ui.unmount();
  });

  it('a seat saved in the final review names a fix brief or the next run, with no brief left', () => {
    lifecycleStore.__testReset({ status: 'running', phase: 'final-review' });
    tasksStore.__testReset({
      tasks: [{ id: 'T001', title: 'first', status: 'done' }],
      currentTask: 1,
      totalTasks: 1,
    });
    requestSeatChangeAtBoundary();
    const ui = renderFeature(<LeadAndHint />);

    expect(ui.lastFrame().trim()).toBe('|Seat changes after a fix brief or at the next run');
    ui.unmount();
  });

  it('the operator pause keeps its own words beside a seat change', () => {
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });
    tasksStore.__testReset({
      tasks: [{ id: 'T001', title: 'first', status: 'in_progress' }],
      currentTask: 1,
      totalTasks: 1,
    });
    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    const ui = renderFeature(<LeadAndHint />);

    expect(ui.lastFrame().trim()).toBe('Finishing T001|Pause requested; no next brief will start');
    ui.unmount();
  });
});
