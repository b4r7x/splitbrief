import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { markInterruptRequested } from '../../../stores/workflow/actions/interrupt.js';
import { markInterruptResumed } from '../../../stores/workflow/actions/resume.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { glyph } from '../../../lib/glyphs.js';
import { PLANNER_INHERITANCE } from '../../../core/crew/identity.js';
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
    const layout = getHeaderLayout({ cols: 100, railCells: 40 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.railWidth).toBeLessThanOrEqual(layout.contentWidth);
  });

  it('shrinks the rail cell to leave room for the seat + elapsed tail', () => {
    const withTail = getHeaderLayout({ cols: 160, railCells: 40, seatCells: 44 });
    const withoutTail = getHeaderLayout({ cols: 160, railCells: 40 });

    expect(withTail.railWidth).toBeLessThan(withoutTail.railWidth);
  });

  it('keeps the elapsed clock at narrow widths where the status word would still fit', () => {
    const layout = getHeaderLayout({ cols: 40, railCells: 20 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.railWidth).toBeGreaterThan(0);
  });

  it('keeps the rail alone at the narrowest widths, dropping the elapsed tail', () => {
    const layout = getHeaderLayout({ cols: 22, railCells: 18 });

    expect(layout.showElapsed).toBe(false);
    expect(layout.railWidth).toBeGreaterThan(0);
  });

  it('omits the seat line when no seat width is supplied', () => {
    expect(getHeaderLayout({ cols: 120, railCells: 40 }).showSeats).toBe(false);
  });

  it('shows the seat line when the terminal is wide', () => {
    expect(getHeaderLayout({ cols: 160, railCells: 40, seatCells: 44 }).showSeats).toBe(true);
  });

  it('omits the seat line entirely when a wide rail leaves no room', () => {
    expect(getHeaderLayout({ cols: 60, railCells: 50, seatCells: 44 }).showSeats).toBe(false);
  });
});

describe('Header — seat line', () => {
  const ESC = String.fromCharCode(27);
  const hostileSequence = `${ESC}[2J`;

  async function seatFrame(cols: number, config = makeConfig()): Promise<string> {
    resetStores();
    terminalSizeStore.__testReset({ cols, rows: 24, isSmall: cols < 120 });
    configStore.__testReset({ projectDir: '/tmp/p', config });
    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');
    instance.unmount();
    return frame;
  }

  it('names all three seats in one collapsed line without a chevron', async () => {
    const frame = await seatFrame(160);

    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    expect(frame).toContain('REVIEW');
    expect(frame).toContain('Qwen 2.5 Coder 7B');
    expect(frame.slice(frame.indexOf('PLAN'))).not.toContain(glyph('connectorSame'));
  });

  it('gives up one seat name to the tight bar instead of hiding all three', async () => {
    const frame = await seatFrame(110);

    expect(frame).toContain('PLAN');
    expect(frame).toContain('Qwen 2.5 Coder 7B');
  });

  it('says the review seat borrows the planner when no reviewer is configured', async () => {
    const frame = await seatFrame(160);

    expect(frame).toContain(PLANNER_INHERITANCE.mark);
  });

  it('names the reviewer seat with its own runner when a reviewer is configured', async () => {
    const frame = await seatFrame(
      200,
      makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } }),
    );

    expect(frame).toContain('REVIEW');
    expect(frame).toContain('Codex');
    expect(frame).not.toContain(PLANNER_INHERITANCE.mark);
  });

  it('sanitizes hostile model ids in the visible seat line', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/p',
      config: makeConfig({ implementer: { model: `qwen${hostileSequence}-coder` } }),
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const rawFrame = instance.lastFrame() ?? '';

    expect(stripAnsiStyles(rawFrame)).toContain('Qwen Coder');
    expect(rawFrame).not.toContain(hostileSequence);
    instance.unmount();
  });

  it('drops the seat line but keeps the elapsed clock when the rail crowds the bar', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('BUILD');
    expect(frame).toContain('0:05');
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

  it('freezes the elapsed clock while interrupted and resumes on resume', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'running',
      startedAt: 0,
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    expect(instance.lastFrame() ?? '').toContain('0:05');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(instance.lastFrame() ?? '').toContain('0:10');

    act(() => {
      markInterruptRequested();
    });
    expect(instance.lastFrame() ?? '').toContain('0:10');

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(instance.lastFrame() ?? '').toContain('0:10');

    act(() => {
      markInterruptResumed();
    });
    expect(instance.lastFrame() ?? '').toContain('0:30');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(instance.lastFrame() ?? '').toContain('0:32');
    instance.unmount();
  });
});
