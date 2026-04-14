import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const SMALL_SCREEN_THRESHOLD = 120;

describe('terminalSizeStore', () => {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, writable: true });
  });

  it('uses process.stdout.columns and rows', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 200, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 50, writable: true });

    const { terminalSizeStore } = await import('./terminal-size.js');

    const state = terminalSizeStore.get();
    expect(state.cols).toBe(200);
    expect(state.rows).toBe(50);
  });

  it('falls back to 80x24 when columns/rows undefined', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: undefined, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: undefined, writable: true });

    const { terminalSizeStore } = await import('./terminal-size.js');

    const state = terminalSizeStore.get();
    expect(state.cols).toBe(80);
    expect(state.rows).toBe(24);
  });

  it('isSmall is true when cols < threshold', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: SMALL_SCREEN_THRESHOLD - 1, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, writable: true });

    const { terminalSizeStore } = await import('./terminal-size.js');

    expect(terminalSizeStore.get().isSmall).toBe(true);
  });

  it('isSmall is false when cols >= threshold', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: SMALL_SCREEN_THRESHOLD, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, writable: true });

    const { terminalSizeStore } = await import('./terminal-size.js');

    expect(terminalSizeStore.get().isSmall).toBe(false);
  });

  it('exposes use, get, reset methods', async () => {
    const { terminalSizeStore } = await import('./terminal-size.js');

    expect(typeof terminalSizeStore.use).toBe('function');
    expect(typeof terminalSizeStore.get).toBe('function');
    expect(typeof terminalSizeStore.reset).toBe('function');
  });

  it('clamps computed panel widths to a positive value on narrow terminals', async () => {
    const { getClampedTerminalWidth, getResponsivePanelWidth } = await import('./terminal-size.js');

    expect(getClampedTerminalWidth(3, 80)).toBe(1);
    expect(getResponsivePanelWidth(3, true)).toBe(1);
    expect(getResponsivePanelWidth(90, true)).toBe(76);
  });
});
