import { describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { getTerminalCellWidth } from '../display-text.js';
import { glyph, markdownLayoutGlyphs } from '../../lib/glyphs.js';
import { parseMarkdownBlocks } from './block-parser.js';
import { layoutMarkdown } from './layout.js';
import type { MarkdownLayoutLine } from './types.js';

// These expectations spell the unicode tier out literally, so the tier is pinned here rather
// than left to whether the process running the suite happens to own a TTY.
forceUnicodeGlyphs();

const GLYPHS = markdownLayoutGlyphs();
const RAIL = glyph('codeRail');
const HOOK = glyph('wrapContinuation');

function lineText(line: MarkdownLayoutLine): string {
  return line.segments.map((segment) => segment.text).join('');
}

function stripCodeRail(text: string): string {
  if (text.startsWith(`${RAIL}${HOOK}`)) return text.slice(`${RAIL}${HOOK}`.length);
  if (text.startsWith(`${RAIL} `)) return text.slice(`${RAIL} `.length);
  if (text.startsWith(RAIL)) return text.slice(RAIL.length);
  return text;
}

describe('layoutCodeBlockLines', () => {
  it('does not interpret markdown syntax inside code fences', () => {
    const layout = layoutMarkdown(
      parseMarkdownBlocks(['```', '# heading', '---', '- item', '```'].join('\n')),
      { glyphs: GLYPHS, width: 40 },
    );

    expect(layout.rows.map((row) => row.blockKind)).toEqual(['code']);
    expect(layout.rows.flatMap((row) => row.lines.map(lineText))).toEqual([
      RAIL,
      `${RAIL} # heading`,
      `${RAIL} ---`,
      `${RAIL} - item`,
      RAIL,
    ]);
  });

  it('pads a code block with a bare-rail line above and below its content', () => {
    const layout = layoutMarkdown(parseMarkdownBlocks(['```', 'const a = 1;', '```'].join('\n')), {
      width: 40,
      glyphs: GLYPHS,
    });
    const row = layout.rows[0];
    const padSegments = [{ kind: 'codeGutter', text: RAIL }];

    expect(row?.lines.map(lineText)).toEqual([RAIL, `${RAIL} const a = 1;`, RAIL]);
    expect(row?.lines.at(0)?.segments).toEqual(padSegments);
    expect(row?.lines.at(-1)?.segments).toEqual(padSegments);
    expect(row?.height).toBe(3);
    expect(layout.height).toBe(3);
  });

  it('flushes the language tag to the far edge, out of the column the code starts in', () => {
    const source = ['```ts', 'const a = 1;', '```'].join('\n');
    const row = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 40 }).rows[0];

    expect(row?.lines.map(lineText)).toEqual([
      `${RAIL}${' '.repeat(37)}ts`,
      `${RAIL} const a = 1;`,
      RAIL,
    ]);
    expect(row?.lines.at(0)?.segments).toEqual([
      { kind: 'codeGutter', text: `${RAIL}${' '.repeat(37)}` },
      { kind: 'codeLanguage', text: 'ts' },
    ]);
    expect(row?.lines.every((line) => getTerminalCellWidth(lineText(line)) <= 40)).toBe(true);
    expect(row?.lines.at(-1)?.segments).toEqual([{ kind: 'codeGutter', text: RAIL }]);
  });

  it.each(['text', 'txt', 'plain', 'plaintext', 'none', 'raw', 'output', 'TEXT'])(
    'opens a fence tagged %s on the bare rail, with no label to read as code',
    (language) => {
      const source = [`\`\`\`${language}`, 'value', '```'].join('\n');
      const row = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 40 })
        .rows[0];

      expect(row?.lines.map(lineText)).toEqual([RAIL, `${RAIL} value`, RAIL]);
      expect(row?.lines.at(0)?.segments).toEqual([{ kind: 'codeGutter', text: RAIL }]);
    },
  );

  it('marks wrapped code continuation lines in the gutter', () => {
    const source = ['```', `const value = '${'x'.repeat(40)}';`, '```'].join('\n');
    const lines = layoutMarkdown(parseMarkdownBlocks(source), {
      glyphs: GLYPHS,
      width: 24,
    }).rows.flatMap((row) => row.lines);
    const texts = lines.map(lineText);
    const body = texts.slice(1, -1);

    expect(body.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.segments[0]?.kind === 'codeGutter')).toBe(true);
    expect(body.at(0)?.startsWith(`${RAIL} `)).toBe(true);
    expect(body.slice(1).every((text) => text.startsWith(`${RAIL}${HOOK}`))).toBe(true);
    expect(texts.at(0)).toBe(RAIL);
    expect(texts.at(-1)).toBe(RAIL);
  });

  it('wraps an unhighlighted fence on words and hangs it at its own indent', () => {
    const source = [
      '```text',
      'src/engine/providers/request.ts',
      '  Add tool definitions and assistant tool-call messages.',
      '```',
    ].join('\n');

    expect(
      layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 40 }).rows[0]?.lines.map(
        lineText,
      ),
    ).toEqual([
      RAIL,
      `${RAIL} src/engine/providers/request.ts`,
      `${RAIL}   Add tool definitions and assistant`,
      `${RAIL}${HOOK}  tool-call messages.`,
      RAIL,
    ]);
  });

  it('drops the hanging indent when it would leave no room to wrap into', () => {
    const source = ['```text', `${' '.repeat(34)}${'x'.repeat(160)}`, '```'].join('\n');
    const layout = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 40 });
    const body = layout.rows[0]?.lines.map(lineText).slice(1, -1) ?? [];

    expect(layout.height).toBeLessThan(12);
    expect(body.every((text) => getTerminalCellWidth(text) <= 40)).toBe(true);
    expect(body.slice(1).every((text) => text.startsWith(`${RAIL}${HOOK}`))).toBe(true);
  });

  it('wraps a long language tag so the row height matches what it renders', () => {
    const source = ['```', 'code', '```'].join('\n').replace('```', `\`\`\`${'z'.repeat(120)}`);
    const row = layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width: 40 }).rows[0];

    expect(row?.lines.every((line) => getTerminalCellWidth(lineText(line)) <= 40)).toBe(true);
    expect(row?.height).toBe(row?.lines.length);
  });

  describe('highlighted code layout', () => {
    function fenceLayout(language: string, lines: readonly string[], width: number) {
      const source = [`\`\`\`${language}`, ...lines, '```'].join('\n');
      return layoutMarkdown(parseMarkdownBlocks(source), { glyphs: GLYPHS, width });
    }

    function fenceSegments(language: string, lines: readonly string[], width: number) {
      return fenceLayout(language, lines, width).rows.flatMap((row) =>
        row.lines.flatMap((line) => line.segments),
      );
    }

    it('renders a ts fence with at least two distinct highlight scopes', () => {
      const segments = fenceSegments('ts', ["const greeting = 'hello';"], 60);
      const scopes = new Set(
        segments.map((segment) => segment.scope).filter((scope) => scope !== undefined),
      );

      expect(scopes.size).toBeGreaterThanOrEqual(2);
      expect(
        segments
          .filter((segment) => segment.scope !== undefined)
          .every((segment) => segment.kind === 'code'),
      ).toBe(true);
    });

    it('opens a highlighted fence with its language tag, then gutters the body', () => {
      const segments = fenceSegments('ts', ["const greeting = 'hello';"], 60);

      expect(segments[0]).toEqual({ kind: 'codeGutter', text: `${RAIL}${' '.repeat(57)}` });
      expect(segments[1]).toEqual({ kind: 'codeLanguage', text: 'ts' });
      expect(segments[2]).toEqual({ kind: 'codeGutter', text: `${RAIL} ` });
    });

    it('keeps an unknown language monochrome as scope-less code text', () => {
      const segments = fenceSegments('notalanguage', ["const greeting = 'hello';"], 60);

      expect(segments.every((segment) => segment.scope === undefined)).toBe(true);
      expect(segments.some((segment) => segment.kind === 'codeText')).toBe(true);
      expect(segments.some((segment) => segment.kind === 'code')).toBe(false);
    });

    it('preserves the scope on continuation lines when a highlighted line wraps', () => {
      const literal = `'${'a'.repeat(40)}'`;
      const layout = fenceLayout('ts', [`const s = ${literal};`], 24);
      const lines = layout.rows.flatMap((row) => row.lines);

      expect(lines.length).toBeGreaterThan(1);
      const continuationScopes = lines
        .slice(1)
        .flatMap((line) => line.segments)
        .map((segment) => segment.scope);
      expect(continuationScopes).toContain('string');
    });

    // Wrapping trims the whitespace it breaks on, so the invariant is that highlighting
    // neither drops nor duplicates any non-space character, at any width.
    it.each([16, 24, 40, 60, 80])(
      'reconstructs the highlighted fence source within the width at %d',
      (width) => {
        const lines = ['const value = 42;', '', '// done'];
        const rendered = fenceLayout('ts', lines, width)
          .rows.flatMap((row) => row.lines)
          .map(lineText);
        const body = rendered.slice(1, -1).map((text) => stripCodeRail(text));
        const withoutSpace = (text: string) => text.replace(/\s/g, '');

        expect(withoutSpace(body.join(''))).toBe(withoutSpace(lines.join('')));
        expect(rendered.every((text) => getTerminalCellWidth(text) <= width)).toBe(true);
      },
    );
  });
});
