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

/** Where a stopped run settles: at rest on its re-read record, parked with no brief named. */
function leadAfterStopAt(resumeAt: StepRef): string {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
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

  it('names the brief the record says the stop cut', () => {
    expect(leadAfterStopAt({ kind: 'brief', taskId: taskId('T004'), attempt: 1 })).toBe(
      'Stopped at T004 · Partial changes kept',
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
});
