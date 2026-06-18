import { describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { Box } from 'ink';
import { renderMarkdownRows } from './markdown.js';
import { getTheme } from './theme.js';

const markdownSample = [
  '---',
  'title: Markdown Core',
  'owner: docs',
  '---',
  '# Markdown Core',
  '- parse `**literal**` then **bold**',
  '  - keep src/utils/markdown/block-parser.ts visible',
  '```md',
  '# not a heading',
  '---',
  '- not a list',
  '```',
].join('\n');

describe('Markdown', () => {
  it('renders headings, lists, fences, frontmatter, and inline tokens', async () => {
    const rows = renderMarkdownRows({
      source: markdownSample,
      width: 32,
      theme: getTheme(),
    });
    const ui = renderFeature(
      <Box flexDirection="column">
        {rows.map((row) => (
          <Box key={row.key} flexDirection="column">
            {row.node}
          </Box>
        ))}
      </Box>,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('title: Markdown Core');
    expect(frame).toContain('owner: docs');
    expect(frame).toContain('Markdown Core');
    expect(frame).toContain('• parse **literal** then bold');
    expect(frame).toContain('src/utils/markdown/block-par');
    expect(frame).toContain('**literal**');
    expect(frame).toContain('# not a heading');
    expect(frame).toContain('- not a list');

    ui.unmount();
  });

  it('exposes renderable rows with true line counts', () => {
    const rows = renderMarkdownRows({
      source: markdownSample,
      width: 32,
      theme: getTheme(),
    });

    expect(rows.some((row) => (row.lines ?? 1) > 1)).toBe(true);
    expect(
      rows.map((row) => row.lines ?? 1).reduce((sum, lines) => sum + lines, 0),
    ).toBeGreaterThan(rows.length);
  });

  it('does not render terminal controls or OSC payloads from markdown text', async () => {
    const rows = renderMarkdownRows({
      source: [
        '# Safe\u001b[31m heading\u001b[0m',
        'visible \u001b]52;c;clipboard\u0007done\u0007 \u009b2Ktail',
      ].join('\n'),
      width: 48,
      theme: getTheme(),
    });
    const ui = renderFeature(
      <Box flexDirection="column">
        {rows.map((row) => (
          <Box key={row.key} flexDirection="column">
            {row.node}
          </Box>
        ))}
      </Box>,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Safe heading');
    expect(frame).toContain('visible done tail');
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');
    expect(frame).not.toContain('\u009b');
    expect(frame).not.toContain('\u0007');

    ui.unmount();
  });
});
