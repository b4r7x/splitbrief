import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { createDraftDocument } from '../../../core/composer/document.js';
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

describe('StopMenu changes copy', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  });

  afterEach(() => {
    stopStore.__testReset();
  });

  async function selectRow(ui: ReturnType<typeof renderFeature>, downs: number): Promise<string> {
    await flushEffects();
    for (let press = 0; press < downs; press += 1) {
      ui.stdin.write('\x1b[B');
      await tick(30);
    }
    return ui.lastFrame() ?? '';
  }

  it('claims no changes before a brief has run', async () => {
    const ui = renderFeature(<StopMenu />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Stop options');
    expect(frame).not.toContain('Stop options ·');
    expect(frame).toContain('Stop now · stop execution; keep the run open');
    const endRun = await selectRow(ui, 1);
    expect(endRun).toContain('End run · stop execution; close this run');
    expect(endRun).not.toContain('keep changes');
    ui.unmount();
  });

  it('claims the changes a running brief makes', async () => {
    seedRunningBrief();
    const ui = renderFeature(<StopMenu />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Stop options · Changes stay.');
    expect(frame).toContain('Stop now · stop execution; keep partial changes');
    expect(await selectRow(ui, 2)).toContain(
      'End run · stop execution; close this run; keep changes',
    );
    ui.unmount();
  });

  it('names the draft in the title once the composer holds one', async () => {
    const ui = renderFeature(<StopMenu />);
    await tick();

    expect(ui.lastFrame()).toContain('Stop options');
    composerLiveStore.setDraft(createDraftDocument('note'));
    await tick(30);

    expect(ui.lastFrame()).toContain('Stop options · Draft stays.');
    ui.unmount();
  });

  it('paints no blank row in the parked menu, whichever row is selected', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    seedRunningBrief();
    stopStore.request('stop-now');
    stopStore.park('mid-brief', null, null);
    const ui = renderFeature(<StopMenu />);
    await tick();
    const frames = [ui.lastFrame() ?? '', await selectRow(ui, 1), await selectRow(ui, 1)];

    for (const frame of frames) {
      const lines = frame.split('\n');
      const body = lines.slice(
        lines.findIndex((line) => line.includes('Session options')) + 1,
        lines.findIndex((line) => line.includes('↑↓ select')),
      );
      expect(body.filter((line) => line.replace(/[│|]/g, '').trim() === '')).toEqual([]);
      expect(lines.length).toBe(frames[0]?.split('\n').length);
    }
    ui.unmount();
  });

  it('offers to close a parked run that built nothing without claiming changes', async () => {
    stopStore.request('stop-now');
    stopStore.park('mid-brief', null, null);
    const ui = renderFeature(<StopMenu />);
    await tick();

    expect(ui.lastFrame()).toContain('Session options');
    expect(ui.lastFrame()).not.toContain('Session options ·');
    const endRun = await selectRow(ui, 1);
    expect(endRun).toContain('End run · close this run');
    expect(endRun).not.toContain('keep changes');
    ui.unmount();
  });
});
