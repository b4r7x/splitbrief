import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { taskId } from '../../../core/schemas/task.js';
import { StopMenu } from './menu.js';

function seedRunningBrief(): void {
  addEvent({
    type: 'tasks_planned',
    ts: 1_000,
    phase: 'implementing',
    total: 3,
    tasks: [
      { id: taskId('T001'), title: 'first', index: 0, file: 'src/a.ts', action: 'modify' },
      { id: taskId('T002'), title: 'second', index: 1, file: 'src/b.ts', action: 'modify' },
      { id: taskId('T003'), title: 'third', index: 2, file: 'src/c.ts', action: 'create' },
    ],
  });
  addEvent({
    type: 'task_started',
    ts: 1_100,
    phase: 'implementing',
    taskId: taskId('T002'),
    title: 'second',
    index: 1,
    total: 3,
    file: 'src/b.ts',
    action: 'modify',
  });
}

describe('StopMenu', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  });

  afterEach(() => {
    stopStore.__testReset();
  });

  it('names the brief it would finish and the one it would not start', async () => {
    seedRunningBrief();
    const ui = renderFeature(<StopMenu />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Pause after this brief');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await tick(30);
    const selected = ui.lastFrame() ?? '';
    expect(selected).toContain('finish T002');
    expect(selected).toContain('do not start T003');
    ui.unmount();
  });

  it('hides the pause row when no brief is running', async () => {
    const ui = renderFeature(<StopMenu />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Stop now');
    expect(frame).toContain('End run');
    expect(frame).not.toContain('Pause after this brief');
    ui.unmount();
  });

  it('offers the way back while a pause is pending', async () => {
    seedRunningBrief();
    stopStore.request('pause-after-brief');
    const ui = renderFeature(<StopMenu />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Keep running');
    expect(frame).not.toContain('Pause after this brief');
    ui.unmount();
  });
});
