import { Box } from 'ink';
import { expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { ControlledMultilineInput } from './controlled-multiline-input.js';
import chalk from 'chalk';
import { defaultTheme } from '../theme.js';
import { paint } from '../../core/theme/paint.js';

it('paints the placeholder with the secondary text token', async () => {
  const originalLevel = chalk.level;
  chalk.level = 3;
  const ui = renderFeature(
    <ControlledMultilineInput value="" placeholder="Type a comment" focus={false} rows={1} />,
  );
  try {
    await flushEffects();
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, 'Type a comment'));
  } finally {
    ui.unmount();
    chalk.level = originalLevel;
  }
});

it('remeasures a same-length history value so the cursor row stays visible', async () => {
  const ui = renderFeature(
    <Box width={4}>
      <ControlledMultilineInput
        value="abcd"
        cursorIndex={4}
        rows={1}
        maxRows={1}
        measureColumns={4}
      />
    </Box>,
  );
  await flushEffects();

  ui.rerender(
    <Box width={4}>
      <ControlledMultilineInput
        value="ab界界"
        cursorIndex={4}
        rows={1}
        maxRows={1}
        measureColumns={4}
      />
    </Box>,
  );
  await flushEffects();

  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  expect(frame).toContain('界');
  expect(frame).not.toContain('ab');
  ui.unmount();
});
