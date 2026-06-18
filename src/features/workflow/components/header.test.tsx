import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { addEvent } from '../../../stores/workflow/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { getHeaderLayout, Header } from './header.js';

const STARTED_AT = new Date(0).toISOString();

beforeEach(() => {
  routerStore.reset();
  terminalSizeStore.reset();
  lifecycleStore.reset();
});

afterEach(() => {
  vi.useRealTimers();
  routerStore.reset();
  terminalSizeStore.reset();
  lifecycleStore.reset();
});

describe('Header — worktree indicator', () => {
  it('keeps the pipeline and timer as a right-aligned group on wide terminals', () => {
    const layout = getHeaderLayout(100, false);

    expect(layout.showPipeline).toBe(true);
    expect(layout.featureWidth + layout.rightWidth).toBeLessThanOrEqual(layout.contentWidth);
  });

  it('caps title width on wide terminals instead of stretching into the status area', () => {
    expect(getHeaderLayout(180, false).featureWidth).toBe(72);
  });

  it('hides the pipeline before it can collide with the title on narrow terminals', () => {
    const layout = getHeaderLayout(42, true);

    expect(layout.showPipeline).toBe(false);
    expect(layout.rightWidth).toBe(10);
  });

  it('keeps only a small reserved gap between truncated title and pipeline', () => {
    const layout = getHeaderLayout(80, false);

    expect(layout.showPipeline).toBe(true);
    expect(layout.contentWidth - layout.featureWidth - layout.rightWidth).toBe(1);
  });

  it('renders feature name without bracket prefix when worktreeName is absent', async () => {
    routerStore.init({ screen: 'workflow', feature: 'add login form' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('add login form');
    expect(frame).not.toContain('[');
    instance.unmount();
  });

  it('renders [my-feature] prefix before feature name when worktreeName is present', async () => {
    routerStore.init({ screen: 'workflow', feature: 'implement X', worktreeName: 'my-feature' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('[my-feature]');
    expect(frame).toContain('implement X');
    instance.unmount();
  });

  it('truncates feature name when combined label exceeds featureWidth, preserving prefix', async () => {
    terminalSizeStore.__testReset({ cols: 40, rows: 24, isSmall: true });

    const longFeature = 'a'.repeat(60);
    routerStore.init({ screen: 'workflow', feature: longFeature, worktreeName: 'wt' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('[wt]');
    expect(frame).not.toContain(longFeature);
    instance.unmount();
  });

  it('omits worktree label when no worktree name is set', async () => {
    routerStore.init({ screen: 'workflow', feature: 'fix bug', worktreeName: undefined });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('fix bug');
    expect(frame).not.toContain('[');
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

    expect(firstFrame).toContain('00:00:05');
    expect(instance.lastFrame() ?? '').toContain('00:00:05');
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

    expect(frame).toContain('01:00:05');
    expect(frame).not.toContain('00:00:05');
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

    expect(frame).toContain('00:01:00');
    expect(frame).not.toContain('00:00:01');
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

    expect(firstFrame).toContain('00:00:12');
    expect(instance.lastFrame() ?? '').toContain('00:00:12');
    instance.unmount();
  });
});
