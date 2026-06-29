import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { addEvent } from '../../../stores/workflow/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { configStore } from '../../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { glyph } from '../../../lib/glyphs.js';
import { getHeaderLayout, Header } from './header.js';

const STARTED_AT = new Date(0).toISOString();

beforeEach(() => {
  routerStore.reset();
  terminalSizeStore.reset();
  lifecycleStore.reset();
  configStore.__testReset();
});

afterEach(() => {
  vi.useRealTimers();
  routerStore.reset();
  terminalSizeStore.reset();
  lifecycleStore.reset();
  configStore.__testReset();
});

describe('Header — layout', () => {
  it('shows the elapsed tail when there is ample width', () => {
    const layout = getHeaderLayout({ cols: 100, isSmall: false, featureCells: 8 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.featureWidth).toBeLessThanOrEqual(layout.contentWidth);
  });

  it('caps title width on wide terminals instead of stretching into the status area', () => {
    expect(getHeaderLayout({ cols: 180, isSmall: false, featureCells: 200 }).featureWidth).toBe(72);
  });

  it('keeps the elapsed clock at narrow widths where the unrendered status word would not fit', () => {
    const layout = getHeaderLayout({ cols: 26, isSmall: true, featureCells: 8 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.featureWidth).toBeGreaterThanOrEqual(8);
  });

  it('keeps the feature alone at the narrowest widths, dropping the elapsed tail', () => {
    const layout = getHeaderLayout({ cols: 18, isSmall: true, featureCells: 8 });

    expect(layout.showElapsed).toBe(false);
    expect(layout.featureWidth).toBeGreaterThanOrEqual(8);
  });

  it('omits the runner summary by default when no runner widths are supplied', () => {
    expect(getHeaderLayout({ cols: 120, isSmall: false, featureCells: 8 }).runnerVariant).toBe(
      'none',
    );
  });

  it('shows the full role-labeled runner summary when the terminal is wide', () => {
    expect(
      getHeaderLayout({
        cols: 160,
        isSmall: false,
        featureCells: 4,
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
        featureCells: 4,
        runnerFullCells: 44,
        runnerCompactCells: 31,
      }).runnerVariant,
    ).toBe('compact');
  });

  it('omits the runner summary entirely when a long feature leaves no room', () => {
    expect(
      getHeaderLayout({
        cols: 60,
        isSmall: true,
        featureCells: 40,
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
    routerStore.init({ screen: 'workflow', feature: 'task' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('planner');
    expect(frame).toContain('claude-code');
    expect(frame).toContain('impl');
    expect(frame).toContain('Qwen 2.5 Coder 7B');
    expect(frame).toContain(glyph('connectorSame'));
    instance.unmount();
  });

  it('drops the role words but keeps the model names on a small terminal', async () => {
    terminalSizeStore.__testReset({ cols: 110, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    routerStore.init({ screen: 'workflow', feature: 'task' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('claude-code');
    expect(frame).toContain('Qwen 2.5 Coder 7B');
    expect(frame).toContain(glyph('connectorSame'));
    expect(frame).not.toContain('planner');
    instance.unmount();
  });

  it('omits the runner models but keeps the elapsed clock when space is tight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    routerStore.init({
      screen: 'workflow',
      feature: 'a fairly long feature title to crowd the bar',
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('claude-code');
    expect(frame).not.toContain('Qwen');
    expect(frame).toContain('0:05');
    instance.unmount();
  });
});

describe('Header — worktree byline', () => {
  it('renders the feature name without any bracket badge when no worktree is set', async () => {
    routerStore.init({ screen: 'workflow', feature: 'add login form' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('add login form');
    expect(frame).not.toContain('[');
    instance.unmount();
  });

  it('demotes the worktree to a dim middot byline tail, not a colored bracket badge', async () => {
    routerStore.init({ screen: 'workflow', feature: 'implement X', worktreeName: 'my-feature' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('· my-feature');
    expect(frame).toContain('implement X');
    expect(frame).not.toContain('[my-feature]');
    instance.unmount();
  });

  it('drops the dim status word now that the rail carries the phase, keeping the feature', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });
    routerStore.init({ screen: 'workflow', feature: 'fix bug' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('fix bug');
    expect(frame).not.toContain('planning');
    instance.unmount();
  });

  it('leaves the cancelled status word to the rail rather than repeating it in the header', async () => {
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
    routerStore.init({ screen: 'workflow', feature: 'fix bug' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('fix bug');
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

  it('strips OSC-52/CSI control bytes from a resumed workflow feature name', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    const payload = 'ZWNobyBwd25lZA==';
    const malicious = `before\u001b]52;c;${payload}\u0007\u001b[2Jafter`;
    routerStore.init({ screen: 'workflow', feature: malicious });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const rawFrame = instance.lastFrame() ?? '';

    expect(rawFrame).not.toContain(payload);
    expect(rawFrame).not.toContain('\u001b]52');
    expect(rawFrame).not.toContain('\u001b[2J');
    expect(stripAnsiStyles(rawFrame)).toContain('beforeafter');
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
