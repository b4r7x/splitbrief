import type { PreparationProblem } from '../../components/preparation-problem.js';
import { readinessCheckLines } from '../../core/readiness/format.js';
import { readinessCheckRemediation } from '../../core/readiness/json.js';
import type { ReadinessCheck } from '../../core/readiness/types.js';
import { glyph } from '../../lib/glyphs.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text/sanitize.js';
import { splitTerminalGraphemes, getTerminalCellWidth } from '../../utils/display-text/width.js';

const INDENT = '  ';
export type LineTone = 'cause' | 'text' | 'dim';

type PanelLine =
  | Readonly<{ kind: 'text'; key: string; text: string; tone: LineTone }>
  | Readonly<{ kind: 'rule'; key: string; label: string }>;

function hardSplit(word: string, budget: number): string[] {
  const parts: string[] = [];
  let line = '';
  let width = 0;
  for (const grapheme of splitTerminalGraphemes(word)) {
    const cells = getTerminalCellWidth(grapheme);
    if (width > 0 && width + cells > budget) {
      parts.push(line);
      line = '';
      width = 0;
    }
    line += grapheme;
    width += cells;
  }
  if (line !== '') parts.push(line);
  return parts;
}

/** A command in backticks is one word, so a fix never breaks a command that fits a row. */
const WORD = /`[^`\r\n]*`\S*|\S+/g;

/**
 * Prose is wrapped here rather than by Ink so every row the scroller counts is exactly one line:
 * a diagnostic that wraps to four rows must cost four, or the fix under it scrolls out of reach.
 */
function wrapText(text: string, budget: number): string[] {
  const width = Math.max(1, budget);
  const lines: string[] = [];
  let line = '';
  const words = (text.match(WORD) ?? []).flatMap((word) =>
    getTerminalCellWidth(word) > width ? word.split(/\s+/).filter((part) => part !== '') : [word],
  );
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (getTerminalCellWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line !== '') lines.push(line);
    const parts = hardSplit(word, width);
    for (const part of parts.slice(0, -1)) lines.push(part);
    line = parts[parts.length - 1] ?? '';
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/**
 * A marked line hangs: the arrow marks the statement once and every row it wraps to lines up under
 * its text, so three wrapped rows read as one instruction instead of three.
 */
function paragraph(input: {
  key: string;
  text: string;
  tone: LineTone;
  budget: number;
  indent?: string;
  marker?: string;
}): PanelLine[] {
  const indent = input.indent ?? '';
  const marker = input.marker === undefined ? '' : `${input.marker} `;
  const hang = `${indent}${' '.repeat(getTerminalCellWidth(marker))}`;
  return wrapText(input.text, input.budget - getTerminalCellWidth(hang)).map((text, index) => ({
    kind: 'text' as const,
    key: `${input.key}:${index}`,
    text: index === 0 ? `${indent}${marker}${text}` : `${hang}${text}`,
    tone: input.tone,
  }));
}

function blank(key: string): PanelLine {
  return { kind: 'text', key, text: '', tone: 'dim' };
}

function checkLines(check: ReadinessCheck, index: number, budget: number): PanelLine[] {
  return readinessCheckLines({ ...check, remediation: readinessCheckRemediation(check) }).flatMap(
    (text, line) =>
      paragraph({
        key: `${check.id}:${index}:${line}`,
        text: sanitizeTerminalDisplayText(text),
        tone: line === 0 ? 'text' : 'dim',
        budget,
        indent: line === 0 ? '' : INDENT,
      }),
  );
}

/** Every entry gets its own air: two checks with no row between them read as one paragraph. */
function spaced(key: string, groups: readonly PanelLine[][]): PanelLine[] {
  return groups.flatMap((group, index) =>
    index === 0 ? group : [blank(`${key}:gap:${index}`), ...group],
  );
}

function section(label: string, lines: PanelLine[]): PanelLine[] {
  if (lines.length === 0) return [];
  return [blank(`${label}:gap`), { kind: 'rule', key: `${label}:rule`, label }, ...lines];
}

export function panelLines(model: PreparationProblem, budget: number): PanelLine[] {
  const lead = [
    ...paragraph({ key: 'cause', text: model.cause, tone: 'cause', budget }),
    ...(model.reason ? paragraph({ key: 'reason', text: model.reason, tone: 'text', budget }) : []),
    ...(model.action
      ? paragraph({
          key: 'action',
          text: model.action,
          tone: 'text',
          budget,
          marker: glyph('connectorHandoff'),
        })
      : []),
  ];
  return [
    ...lead,
    ...model.details.flatMap((text, index) =>
      paragraph({
        key: `lead-detail:${index}`,
        text: sanitizeTerminalDisplayText(text),
        tone: 'dim',
        budget,
        indent: INDENT,
      }),
    ),
    ...(model.diagnostic
      ? section(
          'File error',
          paragraph({ key: 'diagnostic', text: model.diagnostic, tone: 'dim', budget }),
        )
      : []),
    ...section(
      'Blockers',
      spaced(
        'blockers',
        model.blockers.map((check, index) => checkLines(check, index, budget)),
      ),
    ),
    ...section(
      'Warnings',
      spaced(
        'warnings',
        model.warnings.map((check, index) => checkLines(check, index, budget)),
      ),
    ),
  ];
}
