import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
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

function panelLines(frame: string): string[] {
  return frame
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
}

describe('ReferenceCompletionMenu', () => {
  it('renders a bordered panel and marks the selected suggestion with a cursor', () => {
    const ui = render(
      <Box width={70}>
        <ReferenceCompletionMenu filtered={LONG_FILES} selectedIndex={0} maxVisible={8} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';
    // borderStyleFor('round') -> Ink classic border (`+-|`) under the ascii tier in tests.
    expect(frame).toContain('|');
    expect(frame).toContain(glyph('cursor'));
    expect(frame).not.toContain('▌');
    ui.unmount();
  });

  it('truncates long paths so visible suggestions stay one line tall', () => {
    const ui = render(
      <Box width={70}>
        <ReferenceCompletionMenu filtered={LONG_FILES} selectedIndex={0} maxVisible={8} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('tab/⏎ fill');
    // The bare "↓ more" line is replaced by the in-frame scrollbar thumb in the right gutter.
    expect(frame).toContain(glyph('scrollThumb'));
    const visiblePathRows = panelLines(frame).filter(
      (line) => line.includes('notes/') || line.includes('src/'),
    );
    expect(visiblePathRows.length).toBeLessThanOrEqual(8);
    expect(visiblePathRows.some((line) => line.includes('notes/superpowers'))).toBe(true);
    ui.unmount();
  });

  it('occludes underlying transcript text when overlaid absolutely', () => {
    terminalSizeStore.__testReset({ cols: 80 });
    const underlying = 'UNDERLYING'.repeat(6);
    const ui = render(
      <Box height={12} width={60} overflow="visible">
        <Box flexDirection="column">
          {Array.from({ length: 10 }, (_, index) => (
            <Text key={index}>{underlying}</Text>
          ))}
        </Box>
        <Box position="absolute" marginTop={1} width={60}>
          <ReferenceCompletionMenu
            filtered={LONG_FILES.slice(0, 3)}
            selectedIndex={0}
            maxVisible={3}
          />
        </Box>
      </Box>,
    );

    const lines = (ui.lastFrame() ?? '').split('\n');
    const footerIndex = lines.findIndex((line) => line.includes('select'));
    expect(footerIndex).toBeGreaterThan(0);
    // 3 suggestion rows + hairline + footer: every panel line hides the transcript
    for (const line of lines.slice(footerIndex - 4, footerIndex + 1)) {
      expect(line.slice(0, 60)).not.toContain('UNDERLYING');
    }
    ui.unmount();
  });

  it('keeps narrow panels to a single suggestion row plus the footer', () => {
    const ui = render(
      <Box width={24}>
        <ReferenceCompletionMenu
          filtered={LONG_FILES.slice(0, 1)}
          selectedIndex={0}
          maxVisible={1}
        />
      </Box>,
    );

    const lines = panelLines(ui.lastFrame() ?? '');
    expect(lines.some((line) => line.includes('spec.md'))).toBe(true);
    expect(lines.some((line) => line.includes('select'))).toBe(true);
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
    terminalSizeStore.__testReset({ cols: 80 });
  });
});
