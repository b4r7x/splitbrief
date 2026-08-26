import { getTerminalCellWidth } from '../display-text.js';
import { highlightMarkdownCode, type MarkdownHighlightSpan } from './highlight.js';
import { measureSegments, wrapSegments } from './layout-segments.js';
import type {
  MarkdownCodeBlock,
  MarkdownLayoutGlyphs,
  MarkdownLayoutLine,
  MarkdownLayoutSegment,
} from './types.js';

const MIN_HANGING_CODE_CELLS = 8;
// Info strings that name no language. They label the fence with nothing the reader does not
// already see, so the block opens on the bare rail instead.
const UNINFORMATIVE_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  'text',
  'txt',
  'plain',
  'plaintext',
  'none',
  'raw',
  'output',
]);

export function layoutCodeBlockLines(input: {
  block: MarkdownCodeBlock;
  width: number;
  glyphs: MarkdownLayoutGlyphs;
}): MarkdownLayoutLine[] {
  const { block, width, glyphs } = input;
  const spans = highlightMarkdownCode({ lines: block.lines, language: block.language });
  const highlighted = spans !== null && hasHighlightScope(spans) ? spans : undefined;
  const lines =
    highlighted === undefined
      ? plainCodeLines(block.lines, width, glyphs)
      : highlightedCodeLines(highlighted, width, glyphs);
  return [...codeOpenLines(block.language, width, glyphs), ...lines, codeCloseLine(glyphs)];
}

// A fence whose highlighter produced no scoped span carries no syntax meaning, so it
// wraps on words and hangs continuations at its own indent instead of breaking mid-token.
function plainCodeLines(
  sourceLines: readonly string[],
  width: number,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutLine[] {
  const lines = sourceLines.length > 0 ? sourceLines : [''];
  return lines.flatMap((line) => {
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    // Past this point the hanging indent leaves too little room to wrap into, and every
    // continuation would hold a cell or two, so the line falls back to the hard split.
    if (
      measureSegments(codeWrapPrefix(glyphs)) +
        getTerminalCellWidth(indent) +
        MIN_HANGING_CODE_CELLS >
      width
    ) {
      return wrapSegments({
        segments: [{ kind: 'codeText', text: line }],
        firstPrefix: codeGutterPrefix(glyphs),
        continuationPrefix: codeWrapPrefix(glyphs),
        width,
        mode: 'hard',
      });
    }
    const hang: MarkdownLayoutSegment[] =
      indent.length > 0 ? [{ kind: 'codeText', text: indent }] : [];
    return wrapSegments({
      segments: [{ kind: 'codeText', text: line.slice(indent.length) }],
      firstPrefix: [...codeGutterPrefix(glyphs), ...hang],
      continuationPrefix: [...codeWrapPrefix(glyphs), ...hang],
      width,
      mode: 'word',
    });
  });
}

function highlightedCodeLines(
  spanLines: readonly (readonly MarkdownHighlightSpan[])[],
  width: number,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutLine[] {
  const lines = spanLines.length > 0 ? spanLines : [[]];
  return lines.flatMap((spans) =>
    wrapSegments({
      segments: spans.map(highlightSpanToSegment),
      firstPrefix: codeGutterPrefix(glyphs),
      continuationPrefix: codeWrapPrefix(glyphs),
      width,
      mode: 'hard',
    }),
  );
}

function hasHighlightScope(spanLines: readonly (readonly MarkdownHighlightSpan[])[]): boolean {
  return spanLines.some((spans) => spans.some((span) => span.scope !== undefined));
}

function highlightSpanToSegment(span: MarkdownHighlightSpan): MarkdownLayoutSegment {
  if (span.scope === undefined) {
    return { kind: 'codeText', text: span.text };
  }
  return { kind: 'code', text: span.text, scope: span.scope };
}

function codeGutterPrefix(glyphs: MarkdownLayoutGlyphs): MarkdownLayoutSegment[] {
  return [{ kind: 'codeGutter', text: `${glyphs.codeRail} ` }];
}

function codeWrapPrefix(glyphs: MarkdownLayoutGlyphs): MarkdownLayoutSegment[] {
  return [{ kind: 'codeGutter', text: `${glyphs.codeRail}${glyphs.wrapContinuation}` }];
}

// The tag sits flush with the block's right edge so it never occupies the column the code
// starts in, and it wraps like any other content when it cannot: an unwrapped row would
// report height 1 for something the terminal breaks across several lines, and the
// virtualized window measures rows by that height.
function codeOpenLines(
  language: string | undefined,
  width: number,
  glyphs: MarkdownLayoutGlyphs,
): MarkdownLayoutLine[] {
  const label = codeLanguageLabel(language);
  if (label === undefined) return [codeCloseLine(glyphs)];

  const railWidth = getTerminalCellWidth(glyphs.codeRail);
  const pad = width - railWidth - getTerminalCellWidth(label);
  if (pad < 1) {
    return wrapSegments({
      segments: [{ kind: 'codeLanguage', text: label }],
      firstPrefix: codeGutterPrefix(glyphs),
      continuationPrefix: codeGutterPrefix(glyphs),
      width,
      mode: 'hard',
    });
  }

  return [
    {
      segments: [
        { kind: 'codeGutter', text: `${glyphs.codeRail}${' '.repeat(pad)}` },
        { kind: 'codeLanguage', text: label },
      ],
    },
  ];
}

function codeLanguageLabel(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  const label = language.trim();
  if (label.length === 0) return undefined;
  return UNINFORMATIVE_CODE_LANGUAGES.has(label.toLowerCase()) ? undefined : label;
}

function codeCloseLine(glyphs: MarkdownLayoutGlyphs): MarkdownLayoutLine {
  return { segments: [{ kind: 'codeGutter', text: glyphs.codeRail }] };
}
