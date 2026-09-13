import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
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
const ESC = '\u001B';

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

  it('prints every row, the no-revert promise and the three navigation keys', async () => {
    const ui = renderSheet();
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Stop options');
    expect(frame).toContain('Stop now');
    expect(frame).toContain('Pause after this brief');
    expect(frame).toContain('End run');
    expect(frame).toContain('No option reverts files. Your draft is preserved.');
    expect(frame).toContain('↑↓ · ⏎ · esc');
    ui.unmount();
  });

  it('wraps the consequence rather than truncating it, and still fits the shortest terminal', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const ui = renderSheet();
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('start T003');
    expect(frame).not.toContain('\u2026');
    expect(frame.split('\n')).toHaveLength(18);
    ui.unmount();
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

    ui.stdin.write(ARROW_DOWN);
    await tick();
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

    ui.stdin.write(ARROW_DOWN);
    await tick();
    ui.stdin.write(ARROW_DOWN);
    await tick();
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

    ui.stdin.write(ARROW_DOWN);
    await tick();

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

  it('esc closes the sheet with no effect on the run', async () => {
    const abort = vi.fn();
    createAbortHandlerScope()(abort);
    const ui = renderSheet();
    await tick();

    ui.stdin.write(ESC);
    await tick();

    expect(overlayStore.get().active).toBe('none');
    expect(abort).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');
    ui.unmount();
  });
});
