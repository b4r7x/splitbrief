import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { ReferenceCompletionMenu } from './menu.js';
import { glyph } from '../../../../lib/glyphs.js';

const LONG_FILES = [
  'notes/superpowers/specs/2026-04-30-approval-allowed-paths/spec.md',
  'notes/superpowers/specs/2026-05-01-session-continuity/agent-briefs/03-numeric-aliases.md',
  'src/cli/sessions/aliases.test.ts',
  'src/cli/sessions/aliases.ts',
  'notes/superpowers/specs/09-at-file-autocomplete/README.md',
  'notes/superpowers/specs/09-at-file-autocomplete/agent-briefs/01-at-file-hook-and-ui.md',
  'notes/superpowers/specs/09-at-file-autocomplete/decisions.md',
  'notes/superpowers/specs/09-at-file-autocomplete/execute-prompt.md',
  'docs/extra.md',
];

describe('ReferenceCompletionMenu', () => {
  afterEach(() => {
    terminalSizeStore.reset();
  });

  it('truncates long paths so visible suggestions stay one line tall', () => {
    const ui = render(
      <Box width={70}>
        <ReferenceCompletionMenu filtered={LONG_FILES} selectedIndex={0} maxVisible={8} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('tab/⏎ fill');
    expect(frame).toContain(glyph('scrollThumb'));
    const visiblePathRows = frame
      .split('\n')
      .filter((line) => line.includes('notes/') || line.includes('src/'));
    expect(visiblePathRows.length).toBeLessThanOrEqual(8);
    expect(visiblePathRows.some((line) => line.includes('notes/superpowers'))).toBe(true);
    ui.unmount();
  });

  it('drops footer tokens to the abbreviated form below the narrow width gate', () => {
    terminalSizeStore.__testReset({ cols: 40 });
    const ui = render(
      <Box width={40}>
        <ReferenceCompletionMenu
          filtered={LONG_FILES.slice(0, 3)}
          selectedIndex={0}
          maxVisible={3}
        />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('↑↓ · ⏎ · esc');
    expect(frame).not.toContain('select');
    expect(frame).not.toContain('tab/⏎ fill');
    ui.unmount();
  });
});
