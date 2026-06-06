import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ReferenceCompletionMenu } from './menu.js';

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

function panelInteriorRows(frame: string): string[] {
  return frame
    .split('\n')
    .filter((line) => line.includes('│'))
    .map((line) => line.slice(line.indexOf('│') + 1, line.lastIndexOf('│')));
}

describe('ReferenceCompletionMenu', () => {
  it('truncates long paths so visible suggestions stay one line tall', () => {
    const ui = render(
      <Box width={70}>
        <ReferenceCompletionMenu filtered={LONG_FILES} selectedIndex={0} maxVisible={8} />
      </Box>,
    );

    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Tab/Enter fill');
    expect(frame).toContain('↓ more');
    const visiblePathRows = panelInteriorRows(frame).filter(
      (line) => line.includes('notes/') || line.includes('src/'),
    );
    expect(visiblePathRows).toHaveLength(8);
    expect(visiblePathRows[0]).toContain('notes/superpowers');
    ui.unmount();
  });

  it('paints opaque rows over underlying terminal content', () => {
    const ui = render(
      <Box height={12} width={90} overflow="visible">
        <Box flexDirection="column">
          {Array.from({ length: 10 }, (_, index) => (
            <Text key={index}>{'UNDERLYING TEXT '.repeat(6)}</Text>
          ))}
        </Box>
        <Box position="absolute" marginTop={1} width={80}>
          <ReferenceCompletionMenu
            filtered={LONG_FILES.slice(0, 3)}
            selectedIndex={0}
            maxVisible={3}
          />
        </Box>
      </Box>,
    );

    const rows = panelInteriorRows(ui.lastFrame() ?? '');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row).not.toContain('UNDERLYING');
    }
    ui.unmount();
  });
});
