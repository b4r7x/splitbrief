import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { addEvent } from '../../../stores/workflow/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { glyph } from '../../../lib/glyphs.js';
import { getHeaderLayout, Header } from './header.js';

const STARTED_AT = new Date(0).toISOString();

function resetStores(): void {
  terminalSizeStore.reset();
  lifecycleStore.reset();
  tasksStore.__testReset();
  tokensStore.__testReset();
  eventsStore.__testReset();
  configStore.__testReset();
}

beforeEach(resetStores);

afterEach(() => {
  vi.useRealTimers();
  resetStores();
});

describe('Header — layout', () => {
  it('shows the elapsed tail when there is ample width', () => {
    const layout = getHeaderLayout({ cols: 100, isSmall: false, railCells: 40 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.railWidth).toBeLessThanOrEqual(layout.contentWidth);
  });

  it('shrinks the rail cell to leave room for the runner + elapsed tail', () => {
    const withTail = getHeaderLayout({
      cols: 160,
      isSmall: false,
      railCells: 40,
      runnerFullCells: 44,
      runnerCompactCells: 31,
    });
    const withoutTail = getHeaderLayout({ cols: 160, isSmall: false, railCells: 40 });

    expect(withTail.railWidth).toBeLessThan(withoutTail.railWidth);
  });

  it('keeps the elapsed clock at narrow widths where the status word would still fit', () => {
    const layout = getHeaderLayout({ cols: 40, isSmall: true, railCells: 20 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.railWidth).toBeGreaterThan(0);
  });

  it('keeps the rail alone at the narrowest widths, dropping the elapsed tail', () => {
    const layout = getHeaderLayout({ cols: 22, isSmall: true, railCells: 18 });

    expect(layout.showElapsed).toBe(false);
    expect(layout.railWidth).toBeGreaterThan(0);
  });

  it('omits the runner summary by default when no runner widths are supplied', () => {
    expect(getHeaderLayout({ cols: 120, isSmall: false, railCells: 40 }).runnerVariant).toBe(
      'none',
    );
  });

  it('shows the full role-labeled runner summary when the terminal is wide', () => {
    expect(
      getHeaderLayout({
        cols: 160,
        isSmall: false,
        railCells: 40,
        runnerFullCells: 44,
        runnerCompactCells: 31,
      }).runnerVariant,
    ).toBe('full');
  });

  it('drops to the compact runner summary on small terminals even when full would fit', () => {
    expect(
      getHeaderLayout({
        cols: 110,
        isSmall: true,
        railCells: 40,
        runnerFullCells: 44,
        runnerCompactCells: 31,
      }).runnerVariant,
    ).toBe('compact');
  });

  it('omits the runner summary entirely when a wide rail leaves no room', () => {
    expect(
      getHeaderLayout({
        cols: 60,
        isSmall: true,
        railCells: 50,
        runnerFullCells: 44,
        runnerCompactCells: 31,
      }).runnerVariant,
    ).toBe('none');
  });
});

describe('Header — runner summary', () => {
  it('labels both roles and names both models when the terminal is wide', async () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('Planner');
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('Implementer');
    expect(frame).toContain('Qwen 2.5 Coder 7B');
    expect(frame).toContain(glyph('connectorSame'));
    instance.unmount();
  });

  it('drops the role words but keeps the model names on a small terminal', async () => {
    terminalSizeStore.__testReset({ cols: 110, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('Claude Code');
    expect(frame).toContain('Qwen 2.5 Coder 7B');
    expect(frame).toContain(glyph('connectorSame'));
    expect(frame).not.toContain('Planner');
    instance.unmount();
  });

  it('omits the runner models but keeps the elapsed clock when the rail crowds the bar', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('Claude Code');
    expect(frame).not.toContain('Qwen');
    expect(frame).toContain('0:05');
    instance.unmount();
  });

  it('keeps the compact runner and elapsed clock when Form C is selected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    terminalSizeStore.__testReset({ cols: 35, rows: 24, isSmall: true });
    configStore.__testReset({
      projectDir: '/tmp/p',
      config: makeConfig({
        planner: { kind: 'shell', command: 'planner', model: 'aa' },
        implementer: { model: 'bb' },
      }),
    });

    const instance = render(<Header startedAt={STARTED_AT} railForm="C" />);
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('task 3/7');
    expect(frame).toContain('Aa');
    expect(frame).toContain('Bb');
    expect(frame).toContain(glyph('connectorSame'));
    expect(frame).toContain('0:05');
    expect(frame).not.toContain('Planner');
    instance.unmount();
  });
});

describe('Header — rail and elapsed', () => {
  it('renders the phase rail in place of any task title', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    // The rail's stage labels are present; the verbose phase verb never reaches the header.
    expect(frame).toContain('Plan');
    expect(frame).toContain('Build');
    expect(frame).not.toContain('planning');
    instance.unmount();
  });

  it('does not repeat the cancelled status word that the rail already owns', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'researching',
      status: 'cancelled',
      cancelled: true,
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
      reason: 'user_cancelled',
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('cancelled');
    instance.unmount();
  });

  it('freezes elapsed time when lifecycle is cancelled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    lifecycleStore.__testReset({
      phase: 'researching',
      status: 'cancelled',
      cancelled: true,
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
      reason: 'user_cancelled',
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const firstFrame = instance.lastFrame() ?? '';

    vi.advanceTimersByTime(30_000);

    expect(firstFrame).toContain('0:05');
    expect(instance.lastFrame() ?? '').toContain('0:05');
    instance.unmount();
  });

  it('renders elapsed time from the lifecycle start when resuming an older workflow', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_605_000);
    lifecycleStore.__testReset({
      phase: 'planning',
      status: 'running',
      startedAt: 0,
    });

    const instance = render(<Header startedAt={new Date(3_600_000).toISOString()} />);
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('1:00:05');
    instance.unmount();
  });

  it('renders elapsed time from replayed lifecycle start when attached to an older workflow', () => {
    vi.useFakeTimers();
    vi.setSystemTime(61_000);
    addEvent({
      type: 'workflow_started',
      ts: 1_000,
      phase: 'planning',
      feature: 'attached workflow',
    });

    const instance = render(<Header startedAt={new Date(60_000).toISOString()} />);
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('1:00');
    expect(frame).not.toContain('0:01');
    instance.unmount();
  });

  it('freezes elapsed time when lifecycle is complete', () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    lifecycleStore.__testReset({
      phase: 'complete',
      status: 'complete',
      startedAt: 0,
      endedAt: 12_000,
      durationMs: 12_000,
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const firstFrame = instance.lastFrame() ?? '';

    vi.advanceTimersByTime(30_000);

    expect(firstFrame).toContain('0:12');
    expect(instance.lastFrame() ?? '').toContain('0:12');
    instance.unmount();
  });
});
