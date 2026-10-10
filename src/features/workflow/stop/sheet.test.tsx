import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import {
  clearAllHandlers,
  consumeBoundaryPause,
  createAbortHandlerScope,
  setCancelHandler,
} from '../handlers.js';
import { StopSheet } from './sheet.js';
import { stopSheetRows } from './options.js';

const ARROW_DOWN = '\u001B[B';

const RUNNING_BRIEF = {
  currentTaskId: 'T002',
  nextTaskId: 'T003',
  boundaryPauseRequested: false,
};

function renderSheet(rows = stopSheetRows(RUNNING_BRIEF)) {
  overlayStore.open('stop-sheet');
  return renderFeature(<StopSheet rows={rows} />);
}

describe('StopSheet', () => {
  beforeEach(() => {
    resetAllStores();
    clearAllHandlers();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('prints every row, the no-revert promise and the shared navigation keys', async () => {
    const ui = renderSheet();
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Stop options');
    expect(frame).toContain('Stop now');
    expect(frame).toContain('Pause after this brief');
    expect(frame).toContain('End run');
    expect(frame).toContain('Changes and draft stay.');
    expect(frame).toContain('↑↓ select · ⏎ confirm · esc stop · tab close');
    ui.unmount();
  });

  it('names esc back to sessions while the parked rows include the way home', async () => {
    const ui = renderSheet([
      {
        id: 'resume',
        label: 'Resume',
        consequence: 'continue this run; keep the unsent draft',
      },
      {
        id: 'leave',
        label: 'Back to sessions',
        consequence: 'return home; keep the run and draft',
      },
    ]);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('↑↓ select · ⏎ confirm · esc back · tab close');
    expect(frame).not.toContain('esc stop');
    ui.unmount();
  });

  it('drops whole legend keys instead of wrapping them on a narrow terminal', async () => {
    terminalSizeStore.__testReset({ cols: 48, rows: 24, isSmall: true });
    const ui = renderSheet();
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('↑↓ select · ⏎ confirm · esc stop');
    expect(frame).not.toContain('tab close');
    ui.unmount();
  });

  it('keeps the title on one row and the legend clear of consequences at 22 columns', async () => {
    terminalSizeStore.__testReset({ cols: 22, rows: 45, isSmall: true });
    const ui = renderSheet(stopSheetRows({ ...RUNNING_BRIEF, hasChanges: true }));
    await tick();
    const lines = (ui.lastFrame() ?? '')
      .split('\n')
      .map((line) => line.replace(/[│|]/g, '').trim());
    expect(lines.find((line) => line.includes('Stop options'))).toBe('Stop options');
    const legendIndex = lines.findIndex((line) => line.includes('↑↓ select'));
    expect(lines[legendIndex]).toBe('↑↓ select');
    expect(lines[legendIndex - 1]).toBe('keep changes');
    ui.unmount();
  });

  it('wraps the consequence rather than truncating it, and still fits the shortest terminal', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const ui = renderSheet();
    await tick();
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await tick(30);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('start T003');
    expect(frame).not.toContain('\u2026');
    expect(frame.split('\n').length).toBeLessThanOrEqual(10);
    ui.unmount();
  });

  it('paints no blank row above the legend and keeps one height, whichever row is selected', async () => {
    const rows = stopSheetRows({ ...RUNNING_BRIEF, hasChanges: true });
    for (const cols of [80, 60]) {
      terminalSizeStore.__testReset({ cols, rows: 24, isSmall: true });
      const ui = renderSheet(rows);
      await tick();
      const frames = [ui.lastFrame() ?? ''];
      for (let press = 1; press < rows.length; press += 1) {
        await flushEffects();
        ui.stdin.write(ARROW_DOWN);
        await tick(30);
        frames.push(ui.lastFrame() ?? '');
      }

      for (const frame of frames) {
        const lines = frame.split('\n');
        const body = lines.slice(
          lines.findIndex((line) => line.includes('Stop options')) + 1,
          lines.findIndex((line) => line.includes('↑↓ select')),
        );
        expect(body.filter((line) => line.replace(/[│|]/g, '').trim() === '')).toEqual([]);
        expect(lines.length).toBe(frames[0]?.split('\n').length);
      }
      ui.unmount();
    }
  });

  it('stops the run on the first row', async () => {
    const abort = vi.fn();
    createAbortHandlerScope()(abort);
    const ui = renderSheet();
    await tick();

    ui.stdin.write('\r');
    await tick();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('stop-now');
    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('asks for a boundary pause on the second row', async () => {
    const ui = renderSheet();
    await tick();

    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await tick(30);
    ui.stdin.write('\r');
    await tick();

    expect(stopStore.get().intent).toBe('pause-after-brief');
    expect(consumeBoundaryPause()).toBe(true);
    ui.unmount();
  });

  it('ends the run on the last row', async () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);
    const ui = renderSheet();
    await tick();

    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await tick(30);
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await tick(30);
    ui.stdin.write('\r');
    await tick();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('end-run');
    ui.unmount();
  });

  it('holds the cursor on its row when the running brief drops the pause row', async () => {
    const abort = vi.fn();
    createAbortHandlerScope()(abort);
    const cancel = vi.fn();
    setCancelHandler(cancel);
    const ui = renderSheet();
    await tick();

    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await tick(30);

    ui.rerender(
      <StopSheet
        rows={stopSheetRows({
          currentTaskId: null,
          nextTaskId: null,
          boundaryPauseRequested: false,
        })}
      />,
    );
    await tick();

    ui.stdin.write('\r');
    await tick();

    expect(cancel).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('stop-now');
    ui.unmount();
  });

  it('takes no letter keys', async () => {
    const abort = vi.fn();
    createAbortHandlerScope()(abort);
    const ui = renderSheet();
    await tick();

    ui.stdin.write('s');
    await tick();
    ui.stdin.write('b');
    await tick();

    expect(abort).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');
    expect(overlayStore.get().active).toBe('stop-sheet');
    ui.unmount();
  });

  it('tab closes the menu with no effect on the run', async () => {
    const abort = vi.fn();
    createAbortHandlerScope()(abort);
    const ui = renderSheet();
    await tick();

    ui.stdin.write('\t');
    await tick();

    expect(overlayStore.get().active).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');
    ui.unmount();
  });
});
