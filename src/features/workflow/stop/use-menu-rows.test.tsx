import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDraftDocument } from '../../../core/composer/document.js';
import { taskId } from '../../../core/schemas/task.js';
import {
  activeApply,
  trackActiveApply,
} from '../../../engine/orchestrator/session-lifecycle/shutdown.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { useStopMenuRows } from './use-menu-rows.js';

function Rows() {
  const { rows, footer } = useStopMenuRows();
  return <Text>{`${rows.map((row) => row.id).join(' ')} | ${footer ?? 'no footer'}`}</Text>;
}

function startSecondBrief(): void {
  addEvent({
    type: 'tasks_planned',
    ts: 1_000,
    phase: 'implementing',
    total: 2,
    tasks: [
      { id: taskId('T001'), title: 'first', index: 0, file: 'src/a.ts', action: 'modify' },
      { id: taskId('T002'), title: 'second', index: 1, file: 'src/b.ts', action: 'modify' },
    ],
  });
  addEvent({
    type: 'task_started',
    ts: 1_100,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'first',
    index: 0,
    total: 2,
    file: 'src/a.ts',
    action: 'modify',
  });
}

async function mount() {
  const ui = renderFeature(<Rows />);
  await flushEffects();
  return ui;
}

describe('useStopMenuRows', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('repaints the rows when a pause is requested', async () => {
    startSecondBrief();
    const ui = await mount();
    expect(ui.lastFrame()).toBe('stop-now pause-after-brief end-run | Changes stay.');

    stopStore.request('pause-after-brief');
    await flushEffects();

    expect(ui.lastFrame()).toBe('stop-now keep-running end-run | Changes stay.');
    ui.unmount();
  });

  it('repaints the rows when a brief starts', async () => {
    const ui = await mount();
    expect(ui.lastFrame()).toBe('stop-now end-run | no footer');

    startSecondBrief();
    await flushEffects();

    expect(ui.lastFrame()).toBe('stop-now pause-after-brief end-run | Changes stay.');
    ui.unmount();
  });

  it('repaints the rows when the screen shows a run another process holds', async () => {
    const ui = await mount();

    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ status: { kind: 'running' } }),
      execution: { kind: 'at-rest' },
    });
    await flushEffects();

    expect(ui.lastFrame()).toBe('leave | no footer');
    ui.unmount();
  });

  it('repaints the rows when this process starts to apply the run', async () => {
    const ui = await mount();
    const apply = Promise.withResolvers<void>();
    onTestFinished(async () => {
      apply.resolve();
      await activeApply();
    });

    void trackActiveApply(apply.promise);
    await flushEffects();

    expect(ui.lastFrame()).toBe('leave | no footer');
    ui.unmount();
  });

  it('repaints the footer when the composer takes a draft', async () => {
    const ui = await mount();

    composerLiveStore.setDraft(createDraftDocument('note'));
    await flushEffects();

    expect(ui.lastFrame()).toBe('stop-now end-run | Draft stays.');
    ui.unmount();
  });
});
