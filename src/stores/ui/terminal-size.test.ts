import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

  it('subscribeToResize updates store on resize and cleans up listener', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 100, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 30, writable: true });

    const { terminalSizeStore } = await import('./terminal-size.js');
    const unsubscribe = terminalSizeStore.subscribeToResize();

    Object.defineProperty(process.stdout, 'columns', { value: 150, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 50, writable: true });
    process.stdout.emit('resize');

    const after = terminalSizeStore.get();
    expect(after.cols).toBe(150);
    expect(after.rows).toBe(50);
    expect(after.isSmall).toBe(false);

    unsubscribe();

    Object.defineProperty(process.stdout, 'columns', { value: 80, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, writable: true });
    process.stdout.emit('resize');

    expect(terminalSizeStore.get().cols).toBe(150);
  });
});
