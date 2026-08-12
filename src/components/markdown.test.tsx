import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { glyph } from '../lib/glyphs.js';
import { getTerminalCellWidth } from '../utils/display-text.js';
import { renderMarkdownRows, type RenderMarkdownRowsOptions } from './markdown.js';
import { getTheme } from './theme.js';

// ink-testing-library's stdout mock resolves chalk color level 0 unless FORCE_COLOR is set before
// ink (and its chalk dependency) first load, so every color assertion below would silently no-op
// without this. Restored in afterAll so it never leaks into other test files.
const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

// The rail, bullet, and table-column expectations below name the unicode glyphs literally, so
// the tier is pinned here rather than following whether the suite runs against a TTY.
forceUnicodeGlyphs();

const RAIL = glyph('codeRail');
const HOOK = glyph('wrapContinuation');

function colorOpen(color: string): string {
  const ui = render(<Text color={color}>x</Text>);
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  const prefix = frame.slice(0, frame.indexOf('x'));
  if (!prefix) throw new Error(`no color prefix rendered for ${color}`);
  return prefix;
}

function expectFrameUsesThemeColor(raw: string, color: string): void {
  const prefix = colorOpen(color);
  expect(prefix.length).toBeGreaterThan(0);
  expect(raw).toContain(prefix);
}

async function renderMarkdown(
  options: RenderMarkdownRowsOptions,
): Promise<{ raw: string; stripped: string; unmount: () => void }> {
  const rows = renderMarkdownRows(options);
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
  const raw = ui.lastFrame() ?? '';
  return { raw, stripped: stripAnsiStyles(raw), unmount: ui.unmount };
}

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
  it('renders headings, lists, fences, and inline tokens, and hides the document header', async () => {
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

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain('title: Markdown Core');
    expect(frame).not.toContain('owner: docs');
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

  it('opens a mid-document heading with one blank line', async () => {
    const source = 'intro line\n\n## Section';
    const rows = renderMarkdownRows({ source, width: 32, theme: getTheme() });
    const { stripped, unmount } = await renderMarkdown({ source, width: 32, theme: getTheme() });

    expect(rows.map((row) => row.lines ?? 1).reduce((sum, lines) => sum + lines, 0)).toBe(3);
    expect(stripped.split('\n')).toEqual(['intro line', '', 'Section']);
    unmount();
  });

  it('does not render terminal controls, OSC payloads, or secret-looking markdown text', async () => {
    const { stripped, unmount } = await renderMarkdown({
      source: [
        '# Safe\u001b[31m heading\u001b[0m',
        'visible \u001b]52;c;clipboard\u0007done\u0007 \u009b2Ktail',
        '# Token Review',
        'Use TOKEN=abcdefghijklmnopqrstuvwxyz1234567890abcdef',
        '```sh',
        'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"',
        '```',
      ].join('\n'),
      width: 80,
      theme: getTheme(),
    });

    expect(stripped).toContain('Safe heading');
    expect(stripped).toContain('visible done tail');
    expect(stripped).not.toContain('clipboard');
    expect(stripped).not.toContain('\u001b');
    expect(stripped).not.toContain('\u009b');
    expect(stripped).not.toContain('\u0007');
    expect(stripped).toContain('Token Review');
    expect(stripped).toContain('TOKEN=REDACTED');
    expect(stripped).toContain('Authorization: Bearer ***REDACTED***');
    expect(stripped).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890abcdef');
    expect(stripped).not.toContain('abcdefghijklmnopqrstuvwxyz');
    unmount();
  });
});

describe('inline links (REQ-002, REQ-010)', () => {
  const originalForceHyperlink = process.env['FORCE_HYPERLINK'];

  beforeEach(() => {
    process.env['FORCE_HYPERLINK'] = '0';
  });

  afterEach(() => {
    if (originalForceHyperlink === undefined) delete process.env['FORCE_HYPERLINK'];
    else process.env['FORCE_HYPERLINK'] = originalForceHyperlink;
  });

  it('renders a styled label without the raw link syntax or target', async () => {
    const theme = getTheme();
    const { raw, stripped, unmount } = await renderMarkdown({
      source: '[Read the docs](https://example.com/docs)',
      width: 60,
      theme,
    });

    expect(stripped).toContain('Read the docs');
    expect(stripped).not.toContain('](');
    expect(stripped).not.toContain('https://example.com/docs');
    expectFrameUsesThemeColor(raw, theme.markdown.link);
    expect(raw).toContain('\x1b[4m');
    unmount();
  });

  it('keeps a non-URL link target out of the visible frame', async () => {
    const { stripped, unmount } = await renderMarkdown({
      source: '[README](docs/readme.md)',
      width: 60,
      theme: getTheme(),
    });

    expect(stripped).toContain('README');
    expect(stripped).not.toContain('docs/readme.md');
    unmount();
  });
});

describe('GFM pipe tables (REQ-003)', () => {
  it('renders a well-formed table with aligned columns and a distinguished header', async () => {
    const theme = getTheme();
    const source = ['| Name | Age |', '| --- | --- |', '| Alice | 30 |', '| Bob | 40 |'].join('\n');
    const { raw, stripped, unmount } = await renderMarkdown({ source, width: 40, theme });

    expect(stripped).toContain('Name');
    expect(stripped).toContain('Age');
    expect(stripped).toContain('Alice');
    expect(stripped).toContain('Bob');
    expect(stripped).not.toContain('|');
    expectFrameUsesThemeColor(raw, theme.markdown.heading);

    const tableLines = stripped.split('\n').filter((line) => line.includes('│'));
    expect(tableLines.length).toBeGreaterThan(1);
    const separatorColumns = tableLines.map((line) => line.indexOf('│'));
    expect(new Set(separatorColumns).size).toBe(1);
    unmount();
  });

  it('degrades a table wider than the available width without exceeding it', async () => {
    const width = 20;
    const source = [
      '| VeryLongHeaderColumnNameHere | Short |',
      '| --- | --- |',
      '| an overflowing body cell value | y |',
    ].join('\n');
    const { stripped, unmount } = await renderMarkdown({ source, width, theme: getTheme() });

    const lines = stripped.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(stripped).not.toContain('|');
    unmount();
  });
});

describe('headings depth 4-6 (REQ-004)', () => {
  it.each([
    { depth: 4, marker: '####' },
    { depth: 5, marker: '#####' },
    { depth: 6, marker: '######' },
  ])('renders a depth-$depth heading without a literal marker prefix', async ({ marker }) => {
    const { stripped, unmount } = await renderMarkdown({
      source: `${marker} Section Title`,
      width: 40,
      theme: getTheme(),
    });

    expect(stripped).toContain('Section Title');
    expect(stripped).not.toContain('#');
    unmount();
  });
});

describe('strikethrough (REQ-005)', () => {
  it('renders strikethrough text without the tilde delimiters', async () => {
    const { stripped, unmount } = await renderMarkdown({
      source: '~~deprecated~~',
      width: 40,
      theme: getTheme(),
    });

    expect(stripped).toContain('deprecated');
    expect(stripped).not.toContain('~~');
    unmount();
  });
});

describe('heading rank ladder (REQ-006)', () => {
  it.each([
    'terminal' as const,
    'mono' as const,
  ])('resolves the top ranks from theme.markdown.heading and the deep ranks from textDim (%s)', async (preset) => {
    const theme = getTheme(preset);
    const top = await renderMarkdown({ source: '## T', width: 40, theme });
    const deep = await renderMarkdown({ source: '##### T', width: 40, theme });

    expectFrameUsesThemeColor(top.raw, theme.markdown.heading);
    expectFrameUsesThemeColor(deep.raw, theme.textDim);
    top.unmount();
    deep.unmount();
  });

  // The review overlay renders through this module and the transcript through
  // markdown-rows; a rank that reads the same as its neighbour flattens the outline in both.
  it.each([
    'terminal' as const,
    'mono' as const,
  ])('gives each of the six ranks its own rendered form (%s)', async (preset) => {
    const theme = getTheme(preset);
    const forms: string[] = [];
    for (const depth of [1, 2, 3, 4, 5, 6]) {
      const { raw, unmount } = await renderMarkdown({
        source: `${'#'.repeat(depth)} Rank`,
        width: 40,
        theme,
      });
      forms.push(raw);
      unmount();
    }

    expect(new Set(forms).size).toBe(6);
  });
});

describe('fenced code highlighting (REQ-007)', () => {
  it('renders a ts fence with at least two distinct syntax colors', async () => {
    const theme = getTheme('mono');
    const source = ['```ts', "const x = 'y';", '```'].join('\n');
    const { raw, unmount } = await renderMarkdown({ source, width: 40, theme });

    expectFrameUsesThemeColor(raw, theme.syntax.keyword);
    expectFrameUsesThemeColor(raw, theme.syntax.string);
    unmount();
  });

  it('renders an unknown-tag fence in the monochrome code style with no syntax color', async () => {
    const theme = getTheme('mono');
    const source = ['```zzz', "const x = 'y';", '```'].join('\n');
    const { raw, stripped, unmount } = await renderMarkdown({ source, width: 40, theme });

    for (const scopeColor of Object.values(theme.syntax)) {
      expect(raw).not.toContain(colorOpen(scopeColor));
    }
    expect(stripped).toContain("const x = 'y';");
    unmount();
  });
});

describe('code block framing', () => {
  const codeSource = ['intro prose', '', '```zzz', "const x = 'y';", '```'].join('\n');

  function backgroundOpen(color: string): string {
    const ui = render(
      <Box backgroundColor={color}>
        <Text>x</Text>
      </Box>,
    );
    const frame = ui.lastFrame() ?? '';
    ui.unmount();
    const prefix = frame.slice(0, frame.indexOf('x'));
    if (!prefix) throw new Error(`no background prefix rendered for ${color}`);
    return prefix;
  }

  it('draws the gutter on code lines and leaves prose unprefixed', async () => {
    const { stripped, unmount } = await renderMarkdown({
      source: codeSource,
      width: 40,
      theme: getTheme(),
    });
    const lines = stripped.split('\n').map((line) => line.trimEnd());

    expect(lines).toContain('intro prose');
    expect(lines).toContain(`${RAIL} const x = 'y';`);
    unmount();
  });

  it('marks wrapped code lines with the continuation gutter', async () => {
    const source = ['```zzz', `const value = '${'x'.repeat(60)}';`, '```'].join('\n');
    const { stripped, unmount } = await renderMarkdown({ source, width: 30, theme: getTheme() });
    const lines = stripped
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    const codeLines = lines.slice(1, -1);

    expect(codeLines.length).toBeGreaterThan(1);
    expect(codeLines.at(0)?.startsWith(`${RAIL} `)).toBe(true);
    expect(codeLines.slice(1).every((line) => line.startsWith(`${RAIL}${HOOK}`))).toBe(true);
    expect(lines.at(0)).toBe(`${RAIL}${' '.repeat(26)}zzz`);
    expect(lines.at(-1)).toBe(RAIL);
    unmount();
  });

  it('pads the block with a bare rail above and below while prose stays flush', async () => {
    const { stripped, unmount } = await renderMarkdown({
      source: codeSource,
      width: 40,
      theme: getTheme(),
    });
    const lines = stripped.split('\n').map((line) => line.trimEnd());

    expect(lines).toEqual([
      'intro prose',
      `${RAIL}${' '.repeat(36)}zzz`,
      `${RAIL} const x = 'y';`,
      RAIL,
    ]);
    unmount();
  });

  it('paints the code background when the theme defines one', async () => {
    const theme = getTheme('mono');
    const codeBg = theme.markdown.codeBg;
    if (codeBg === undefined) throw new Error('the mono theme must define markdown.codeBg');
    const { raw, unmount } = await renderMarkdown({ source: codeSource, width: 40, theme });

    expect(raw).toContain(backgroundOpen(codeBg));
    unmount();
  });

  it('paints the code background across the full layout width, not just the text', async () => {
    const theme = getTheme('mono');
    const width = 40;
    const { stripped, unmount } = await renderMarkdown({
      source: ['```zzz', 'x', '```'].join('\n'),
      width,
      theme,
    });
    const codeLines = stripped.split('\n').filter((line) => line.includes(RAIL));

    expect(codeLines.length).toBeGreaterThan(0);
    expect(codeLines.map(getTerminalCellWidth)).toEqual(codeLines.map(() => width));
    unmount();
  });

  it('paints the code background in the terminal preset too', async () => {
    const theme = getTheme();
    const codeBg = theme.markdown.codeBg;
    if (codeBg === undefined) throw new Error('the terminal theme must define markdown.codeBg');
    const { raw, stripped, unmount } = await renderMarkdown({
      source: codeSource,
      width: 40,
      theme,
    });

    expect(stripped).toContain("const x = 'y';");
    expect(raw).toContain(backgroundOpen(codeBg));
    unmount();
  });
});

describe('OSC 8 hyperlink environment (REQ-012, REQ-013)', () => {
  const originalForceHyperlink = process.env['FORCE_HYPERLINK'];
  const originalTermProgram = process.env['TERM_PROGRAM'];

  afterEach(() => {
    if (originalForceHyperlink === undefined) delete process.env['FORCE_HYPERLINK'];
    else process.env['FORCE_HYPERLINK'] = originalForceHyperlink;
    if (originalTermProgram === undefined) delete process.env['TERM_PROGRAM'];
    else process.env['TERM_PROGRAM'] = originalTermProgram;
  });

  it('wraps a file-path link label in an OSC 8 file:// sequence when forced on', async () => {
    process.env['FORCE_HYPERLINK'] = '1';
    const { raw, unmount } = await renderMarkdown({
      source: '[src/app/root.tsx:14](src/app/root.tsx:14)',
      width: 60,
      theme: getTheme(),
      projectDir: '/repo',
    });

    expect(raw).toContain('\x1b]8;;file://');
    unmount();
  });

  it('falls back to themed styled text with zero OSC 8 bytes when forced off', async () => {
    process.env['FORCE_HYPERLINK'] = '0';
    const { raw, stripped, unmount } = await renderMarkdown({
      source: '[src/app/root.tsx:14](src/app/root.tsx:14)',
      width: 60,
      theme: getTheme(),
      projectDir: '/repo',
    });

    expect(raw).not.toContain('\x1b]8');
    expect(stripped).toContain('src/app/root.tsx:14');
    unmount();
  });

  it('falls back to plain labels under Apple Terminal with no forcing env set', async () => {
    delete process.env['FORCE_HYPERLINK'];
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    const { raw, unmount } = await renderMarkdown({
      source: '[src/app/root.tsx:14](src/app/root.tsx:14)',
      width: 60,
      theme: getTheme(),
      projectDir: '/repo',
    });

    expect(raw).not.toContain('\x1b]8');
    unmount();
  });
});

describe('HTML comments render invisibly (REQ-016)', () => {
  it.each([
    { name: 'a generic comment', source: '<!-- note -->' },
    {
      name: 'a Q-marker comment',
      source: '<!-- Q:{"id":"q1","type":"choice","text":"?","options":["a","b"],"default":0} -->',
    },
  ])('produces no visible text for $name', async ({ source }) => {
    const { stripped, unmount } = await renderMarkdown({ source, width: 40, theme: getTheme() });

    expect(stripped.trim()).toBe('');
    unmount();
  });
});
