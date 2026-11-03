import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { ThemeText as Text } from '../components/theme.js';
import { useSharedClock } from './use-shared-clock.js';

const NOW = 1_700_000_000_000;

function ClockHarness({ name, active }: { name: string; active: (now: number) => boolean }) {
  const now = useSharedClock({ active });
  return <Text>{`${name}:[${now}]`}</Text>;
}

function readClock(output: string | undefined, name: string): number | undefined {
  const match = new RegExp(`${name}:\\[(\\d+)\\]`).exec(output ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

describe('useSharedClock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('feeds every active surface the same sample on each tick', async () => {
    const ui = renderFeature(
      <Box flexDirection="column">
        <ClockHarness name="header" active={() => true} />
        <ClockHarness name="sidebar" active={() => true} />
      </Box>,
    );
    await flushEffects();

    vi.advanceTimersByTime(3_000);
    await flushEffects();
    expect(readClock(ui.lastFrame(), 'header')).toBe(NOW + 3_000);
    expect(readClock(ui.lastFrame(), 'sidebar')).toBe(NOW + 3_000);

    ui.unmount();
  });

  it('moves a surface already on the clock to the sample a joining surface takes', async () => {
    const first = renderFeature(<ClockHarness name="header" active={() => true} />);
    await flushEffects();
    expect(readClock(first.lastFrame(), 'header')).toBe(NOW);

    vi.setSystemTime(NOW + 400);
    const second = renderFeature(<ClockHarness name="sidebar" active={() => true} />);
    await flushEffects();
    expect(readClock(first.lastFrame(), 'header')).toBe(NOW + 400);
    expect(readClock(second.lastFrame(), 'sidebar')).toBe(NOW + 400);

    first.unmount();
    second.unmount();
  });

  it('keeps an inactive surface on its last sample and starts no interval for it', async () => {
    const ui = renderFeature(<ClockHarness name="header" active={() => false} />);
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(3_000);
    await flushEffects();
    expect(readClock(ui.lastFrame(), 'header')).toBe(NOW);

    ui.unmount();
  });

  it('keeps a surface on the clock until a tick fails its rule, through a re-render past the limit', async () => {
    const beforeLimit = (now: number) => now < NOW + 2_500;
    const ui = renderFeature(<ClockHarness name="header" active={beforeLimit} />);
    await flushEffects();
    vi.advanceTimersByTime(2_000);
    await flushEffects();

    // A re-render that is not a tick lands past the limit; the sample it reads is still before it.
    vi.setSystemTime(NOW + 2_600);
    ui.rerender(<ClockHarness name="banner" active={beforeLimit} />);
    await flushEffects();
    expect(readClock(ui.lastFrame(), 'banner')).toBe(NOW + 2_000);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    await flushEffects();
    const left = readClock(ui.lastFrame(), 'banner') ?? 0;
    expect(left).toBeGreaterThanOrEqual(NOW + 2_500);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(3_000);
    await flushEffects();
    expect(readClock(ui.lastFrame(), 'banner')).toBe(left);

    ui.unmount();
  });

  it('stops the interval when the last surface leaves the clock', async () => {
    const ui = renderFeature(<ClockHarness name="header" active={() => true} />);
    await flushEffects();
    expect(vi.getTimerCount()).toBe(1);

    ui.unmount();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
  });
});
