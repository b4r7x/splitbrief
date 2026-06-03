import { useState } from 'react';
import { Box, Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { MultilineInput } from './multiline-input.js';

const CTRL_R = '\x12';
const CTRL_U = '\x15';

function Harness() {
  const [value, setValue] = useState('');
  return (
    <Box flexDirection="column">
      <Text>value:{value}</Text>
      <MultilineInput value={value} onChange={setValue} showCursor={false} rows={1} />
    </Box>
  );
}

describe('MultilineInput modifier chords', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it('swallows unhandled Ctrl+R without inserting text', async () => {
    const ui = renderFeature(<Harness />);
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write('r');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:r');

    ui.stdin.write(CTRL_U);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:');
    expect(ui.lastFrame() ?? '').not.toContain('value:r');

    ui.stdin.write(CTRL_R);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:');
    expect(ui.lastFrame() ?? '').not.toContain('value:r');
  });
});
