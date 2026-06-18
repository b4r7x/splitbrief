import { Box, Text } from 'ink';
import { describe, expect, it, beforeEach } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { ScreenShell } from './screen-shell.js';

describe('ScreenShell', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 40, rows: 8, isSmall: true });
  });

  it('stacks multi-row footer content vertically', () => {
    const ui = renderFeature(
      <ScreenShell
        footer={
          <>
            <Box>
              <Text>footer-one</Text>
            </Box>
            <Box>
              <Text>footer-two</Text>
            </Box>
          </>
        }
      >
        <Text>body</Text>
      </ScreenShell>,
    );

    const lines = (ui.lastFrame() ?? '').split('\n');

    expect(lines).toContain('footer-one');
    expect(lines).toContain('footer-two');
    expect(lines).not.toContain('footer-onefooter-two');

    ui.unmount();
  });
});
