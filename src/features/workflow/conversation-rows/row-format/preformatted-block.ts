import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { glyph } from '../../../../lib/glyphs.js';
import { wrapWidthFor } from '../row-markers.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowKind,
  ConversationRowSegment,
  ConversationRowTone,
} from '../types.js';
import { segmentedRow } from './rows.js';
import { sanitizeRowDisplayText, wrappedRowTexts } from './text.js';

// Formatter diffs, compiler tables and test frames carry meaning in their columns, so a source
// line must stay a row: cut at the right edge rather than reflowed. 30 lines shows a full biome
// format hunk (~24 lines) whole while staying under a normal transcript viewport, so the block
// never evicts the run around it; the session log keeps the untruncated text.
const MAX_PREFORMATTED_LINES = 30;

const TRAILING_WHITESPACE = /\s+$/;
const LABEL_META_GAP = '  ';
const FOOTER_GAP = ' · ';

// Tools end a banner with a run of rule characters padded to their own terminal width, so the run
// almost never matches ours. Truncating it would stamp an ellipsis — a promise that content was
// cut — onto pure decoration, so a trailing rule is re-laid to the block width instead.
const TRAILING_RULE = /([─━═⎯⎼‾])\1{3,}\s*$/;
const MIN_RULE_CELLS = 3;

// Diff markers survive a line-number gutter and a vertical rule, which is how formatters print
// them: `17    │ - ····[`. Anchored so a bare `-` in prose cannot match.
const DIFF_MARKER = /^[\s\d]*(?:[│|]\s*)?([+-])[\s]/;

export interface PreformattedBlockInput {
  keyPrefix: string;
  label: string;
  meta?: string | undefined;
  text: string;
  width: number;
  tone: ConversationRowTone;
  maxLines?: number | undefined;
  moreHint?: string | undefined;
}

export function preformattedOutputBlock(
  input: PreformattedBlockInput,
): ConversationRowBlock | null {
  const captured = preformattedLines(input.text);
  if (captured.length === 0) return null;

  const lines = withoutToolEpilogue(captured);
  const bodyWidth = wrapWidthFor('callout-body', input.width);
  const maxLines = Math.max(1, input.maxLines ?? MAX_PREFORMATTED_LINES);
  const body = bodyTextLines(lines, bodyWidth, maxLines);
  const hidden = body.hidden + (captured.length - lines.length);

  // The rail is structure, not severity. Painting thirty rows of it in the block's tone put a
  // full-height column of one colour down the tallest thing in the transcript — and at sixteen
  // colours, where `error` and `removed` are both plain red, the rail, the label and every removed
  // line collapsed into a single red field. Severity stays on the label and on the signed rows.
  const rows: ConversationRow[] = [
    ruledRow(
      `${input.keyPrefix}-top`,
      headerSegments(input.label, input.meta, input.tone, bodyWidth),
      'callout-top',
      'border',
    ),
    ...body.lines.map((line, index) =>
      ruledRow(`${input.keyPrefix}-line-${index}`, line.segments, 'callout-body', 'border'),
    ),
  ];

  const footer = sourceFooterSegments({
    hidden,
    unit: 'line',
    width: bodyWidth,
    ...(input.moreHint === undefined ? {} : { pointer: { text: input.moreHint, tone: 'textDim' } }),
  });
  if (footer !== null) {
    rows.push(
      ruledRow(`${input.keyPrefix}-pad`, [{ text: '' }], 'callout-body', 'border'),
      ruledRow(`${input.keyPrefix}-more`, footer, 'callout-body', 'border'),
    );
  }

  return {
    key: input.keyPrefix,
    rowCount: rows.length,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      rows.slice(Math.max(0, windowStart), Math.max(0, windowEnd)),
  };
}

// Preformatted is not unabridged. A tool signs off with a ruled banner and the paragraph attached
// to it — biome's `check ━━━ / × Some errors were emitted`, vitest's `⎯⎯[1/1]⎯` and its counts —
// and that sign-off says only what the validate summary row already said, in the rows nearest the
// composer, identically on every failure. The first banner is the diagnostic's own heading, so a
// capture whose only banner opens it keeps everything.
function withoutToolEpilogue(lines: string[]): string[] {
  let banner = -1;
  for (let index = lines.length - 1; index > 0; index--) {
    if (isRuledBanner(lines[index] ?? '')) {
      banner = index;
      break;
    }
  }
  if (banner < 0) return lines;

  let cut = banner;
  while (cut > 0 && (lines[cut - 1] ?? '') !== '') cut -= 1;
  if (cut === 0) return lines;
  while (cut > 0 && (lines[cut - 1] ?? '') === '') cut -= 1;
  return lines.slice(0, cut);
}

export interface SourceFooterInput {
  hidden: number;
  unit: string;
  pointer?: ConversationRowSegment | undefined;
  fitPointer?: ((text: string, width: number) => string) | undefined;
  width: number;
}

// One closing row for every block that shows part of something larger: a marker that can never be
// mistaken for content, what was left out and in what unit, and the one thing to act on. The count
// is dropped when nothing was left out, but the row and its marker stay — a bare path appearing
// only sometimes is what made a missing line invisible.
export function sourceFooterSegments(input: SourceFooterInput): ConversationRowSegment[] | null {
  const width = Math.max(1, input.width);
  const marker = footerMarker(width);
  const count = input.hidden > 0 ? `+ ${countNoun(input.hidden, `more ${input.unit}`)}` : '';
  if (count === '' && input.pointer === undefined) return null;

  const segments: ConversationRowSegment[] =
    marker.length === 0 ? [] : [{ text: marker, tone: 'border' }];
  let used = getTerminalCellWidth(marker);
  if (count !== '') {
    const countWidth = width - used;
    if (countWidth > 0) {
      const fittedCount = truncateTerminalDisplayText(count, countWidth);
      segments.push({ text: fittedCount, tone: 'textDim' });
      used += getTerminalCellWidth(fittedCount);
    }
  }
  if (input.pointer === undefined) return segments;

  const gap = count === '' ? '' : FOOTER_GAP;
  const gapWidth = getTerminalCellWidth(gap);
  const pointerWidth = width - used - gapWidth;
  if (pointerWidth <= 0) return segments;

  if (gap !== '') segments.push({ text: gap, tone: 'textDim' });
  // Fitted from the middle by default: a command says what kind of thing it is at its head and
  // which one it is at its tail, and cutting the right edge takes exactly the half that identifies
  // it. A caller whose pointer has its own structure supplies its own fit.
  const fitPointer = input.fitPointer ?? truncateTerminalDisplayTextMiddle;
  segments.push({
    ...input.pointer,
    text: truncateTerminalDisplayText(fitPointer(input.pointer.text, pointerWidth), pointerWidth),
  });
  return segments;
}

function footerMarker(width: number): string {
  const full = `${glyph('treeLast')} `;
  if (getTerminalCellWidth(full) < width) return full;

  const compact = glyph('treeLast');
  return getTerminalCellWidth(compact) < width ? compact : '';
}

interface PreformattedBodyLine {
  segments: ConversationRowSegment[];
}

interface PreformattedBody {
  lines: PreformattedBodyLine[];
  hidden: number;
}

// Only the rows that will be shown are fitted. Fitting walks a line grapheme by grapheme, so
// measuring the whole capture to render thirty rows of it made a ten-thousand-line validate error
// cost seconds of the first paint; the cut is decided by line count, which splitting already knew.
//
// Columns are a relationship between lines, so a lone line has none to protect. Wrapping it keeps
// the whole message — a single long tsc error would otherwise lose most of itself to the cut — and
// each continuation is marked and indented so a wrapped sentence cannot read as a second error.
function bodyTextLines(lines: string[], width: number, maxLines: number): PreformattedBody {
  if (lines.length === 1) {
    const continuation = continuationPrefix(width);
    const continuationWidth = getTerminalCellWidth(continuation);
    const wrapped = wrappedRowTexts(lines[0] ?? '', Math.max(1, width - continuationWidth));
    return {
      lines: wrapped.slice(0, maxLines).map((text, index) => ({
        segments:
          index === 0
            ? [{ text, tone: 'textDim' as const }]
            : [
                { text: continuation, tone: 'border' as const },
                { text, tone: 'textDim' as const },
              ],
      })),
      hidden: Math.max(0, wrapped.length - maxLines),
    };
  }

  // A blank left at the cut would sit directly above the footer's own pad row, and two blank rows
  // inside a rail read as a fault rather than as spacing.
  const visible = lines.slice(0, maxLines);
  while (visible.at(-1) === '') visible.pop();
  return {
    lines: visible.map((line) => ({
      segments: [{ text: fitLine(line, width), tone: lineTone(line) }],
    })),
    hidden: Math.max(0, lines.length - visible.length),
  };
}

function continuationPrefix(width: number): string {
  const full = `  ${glyph('wrapContinuation')} `;
  if (getTerminalCellWidth(full) < width) return full;

  const compact = glyph('wrapContinuation');
  return getTerminalCellWidth(compact) < width ? compact : '';
}

// A rule with a title in front of it heads the section below it; a rule on its own is a divider and
// stays as quiet as the lines it separates.
function isRuledBanner(line: string): boolean {
  const rule = TRAILING_RULE.exec(line);
  return rule !== null && line.slice(0, rule.index).trim().length > 0;
}

function fitLine(line: string, width: number): string {
  const rule = TRAILING_RULE.exec(line);
  if (rule === null) return truncateTerminalDisplayText(line, width);

  const ruleChar = rule[1] ?? '';
  const head = line.slice(0, rule.index).replace(TRAILING_WHITESPACE, '');
  if (head.length > 0 && width < MIN_RULE_CELLS + 2) {
    return truncateTerminalDisplayText(head, width);
  }
  if (head.length === 0 && width < MIN_RULE_CELLS) return '';

  const fittedHead = truncateTerminalDisplayText(head, Math.max(0, width - MIN_RULE_CELLS - 1));
  const gap = fittedHead.length === 0 ? '' : ' ';
  const ruleCells = width - getTerminalCellWidth(fittedHead) - getTerminalCellWidth(gap);
  return `${fittedHead}${gap}${ruleChar.repeat(Math.max(MIN_RULE_CELLS, ruleCells))}`;
}

// Three tiers instead of one flat wash, decided by the row itself: the banner a tool rules off with
// ━ heads the section below it and reads brightest, a signed line carries its sign's polarity, and
// everything else is context. Nothing is looked up in a neighbour — a marker the reader cannot see
// cannot change what the rows they can see mean, and reading the whole capture to color thirty rows
// of it is the cost this block exists to avoid.
//
// Polarity, not severity: a removed line inside an error block took the error hue while `error`,
// `dimError` and the rail all resolved to plain red, and the four collapsed into one field.
function lineTone(line: string): ConversationRowTone {
  if (isRuledBanner(line)) return 'text';
  const marker = DIFF_MARKER.exec(line)?.[1];
  if (marker === '+') return 'diffAdded';
  if (marker === '-') return 'diffRemoved';
  return 'diffContext';
}

// Two blank rows inside a rail read as a rendering fault rather than as spacing, and tools emit
// them freely, so a run of them collapses to the one that does the separating.
function preformattedLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of sanitizeRowDisplayText(text).split('\n')) {
    const line = raw.replace(TRAILING_WHITESPACE, '');
    if (line === '' && lines.at(-1) === '') continue;
    lines.push(line);
  }
  if (lines.at(0) === '') lines.shift();
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function headerSegments(
  label: string,
  meta: string | undefined,
  tone: ConversationRowTone,
  width: number,
): ConversationRowSegment[] {
  const fittedLabel = truncateTerminalDisplayText(label, width);
  if (meta === undefined || meta.length === 0) return [{ text: fittedLabel, tone, bold: true }];

  // The meta ends in the command that produced the block, and a command ends in the file it ran
  // against — the part that says which failure this is. Fitting from the middle keeps it.
  const metaWidth =
    width - getTerminalCellWidth(fittedLabel) - getTerminalCellWidth(LABEL_META_GAP);
  const fittedMeta = metaWidth > 0 ? truncateTerminalDisplayTextMiddle(meta, metaWidth) : '';
  if (fittedMeta.length === 0) return [{ text: fittedLabel, tone, bold: true }];

  return [
    { text: fittedLabel, tone, bold: true },
    { text: LABEL_META_GAP },
    { text: fittedMeta, tone: 'textDim' },
  ];
}

function ruledRow(
  key: string,
  segments: ConversationRowSegment[],
  kind: ConversationRowKind,
  tone: ConversationRowTone,
): ConversationRow {
  return { ...segmentedRow(key, segments, kind), markerTone: tone };
}
