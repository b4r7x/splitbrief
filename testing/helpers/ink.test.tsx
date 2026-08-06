import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from './ansi.js';
import { flushEffects, renderFeature, type RenderViewport } from './ink.js';

const WIDE_VIEWPORT: RenderViewport = { cols: 120, rows: 40 };

const mountedHarnesses: { unmount: () => void }[] = [];

afterEach(() => {
  for (const harness of mountedHarnesses) {
    harness.unmount();
  }
  mountedHarnesses.length = 0;
});

describe('renderFeature viewport', () => {
  it('lays out at the declared viewport width', async () => {
    const ui = renderFeature(<WidthRow />, WIDE_VIEWPORT);
    mountedHarnesses.push(ui);
    await flushEffects();

    expect(lineWidth(ui.lastFrame())).toBe(WIDE_VIEWPORT.cols);
  });

  it('lays out at the 100-column default when no viewport is passed', async () => {
    const ui = renderFeature(<WidthRow />);
    mountedHarnesses.push(ui);
    await flushEffects();

    expect(lineWidth(ui.lastFrame())).toBe(100);
  });

  it('delivers bytes written to the returned stdin to a mounted input handler', async () => {
    const ui = renderFeature(<InputEcho />);
    mountedHarnesses.push(ui);
    await flushEffects();

    ui.stdin.write('a');
    await flushEffects();

    expect(ui.lastFrame()).toContain('a');
  });

  it('exposes every frame in order and writes nothing after unmount', async () => {
    const ui = renderFeature(<InputEcho />);
    mountedHarnesses.push(ui);
    await flushEffects();

    const initialFrameCount = ui.frames.length;
    expect(initialFrameCount).toBeGreaterThan(0);

    ui.stdin.write('1');
    await flushEffects();
    ui.stdin.write('2');
    await flushEffects();

    expect(ui.frames.length).toBeGreaterThan(initialFrameCount);
    expect(ui.lastFrame()).toBe(ui.frames[ui.frames.length - 1]);
    expect(ui.lastFrame()).toContain('2');

    ui.unmount();
    const frameCountAfterUnmount = ui.frames.length;
    await flushEffects();
    expect(ui.frames.length).toBe(frameCountAfterUnmount);
  });
});

function WidthRow() {
  return (
    <Box flexDirection="row">
      <Box width={80} borderStyle="round" />
      <Box width={40} flexShrink={0} borderStyle="round" />
    </Box>
  );
}

function InputEcho() {
  const [input, setInput] = useState('');
  useInput((chunk) => setInput((previous) => previous + chunk));
  return <Text>{input}</Text>;
}

function lineWidth(frame: string): number {
  return stripAnsiStyles(frame).split('\n')[0]?.length ?? 0;
}
