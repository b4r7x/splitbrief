import { formatTruncatedList } from '../../../core/formatting.js';
import { isAskedDetail } from '../../../core/recovery/causes.js';
import { formatResetAt, stripRecoveryResetClause } from '../../../core/recovery/reset-clock.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { glyph } from '../../../lib/glyphs.js';
import { oneLineDisplayText } from '../../../utils/display-text/sanitize.js';
import {
  truncateTerminalDisplayText,
  ELLIPSIS,
  elidePathMiddle,
} from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrapHard } from '../../../utils/display-text/wrap.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { formatRecoveryHeaderParts } from './headline.js';

/** The indent every fact row of a prompt panel starts with. */
export const FACT_INDENT = '  ';
const FILES_LABEL = 'Files ';

export function passHeadlinePrefix(): string {
  return `${glyph('check')} `;
}

export const FAILED_REVIEW_MARKER = ' failed review · ';

export type PromptRow =
  | {
      kind: 'headline';
      tone: 'pass' | 'failed' | 'text';
      text: string;
      detail?: string;
      parts?: readonly ConversationRowSegment[];
    }
  | {
      kind: 'headline';
      tone: 'attention';
      text: string;
      detail?: string;
      parts: readonly ConversationRowSegment[];
    }
  | { kind: 'message'; text: string }
  | { kind: 'blank' }
  | { kind: 'facts'; items: string[]; grid: boolean };

export function formatMiddotList(values: string[], max: number): string {
  return formatTruncatedList(values, max);
}

/**
 * The issue and its facts at the panel's text width; the menu under them holds the actions.
 * `askedRows` puts the asked row before the task and its files, on at most that many rows, for a
 * panel too short to reach it. A cut asked row with no fact after it takes the blank row under the
 * headline as one more row of its own. When a fact follows it, the blank row stays, and the panel's
 * clip drops that row first.
 */
export function recoveryPromptSummaryRows(
  issue: RecoveryIssue,
  width: number,
  askedRows?: number,
): PromptRow[] {
  const subject = formatSubjectLines(issue, width);
  const details = formatDetailLines(issue);
  const room = width - getTerminalCellWidth(FACT_INDENT);
  const asked = details.filter(isAskedDetail);
  const after = details.filter((detail) => !isAskedDetail(detail));
  const spendsBlank =
    askedRows !== undefined &&
    askedRows > 0 &&
    subject.length === 0 &&
    after.length === 0 &&
    asked.some((detail) => fitAskedDetail(detail, room, askedRows) !== oneLineDisplayText(detail));
  const askedBudget = askedRows !== undefined && spendsBlank ? askedRows + 1 : askedRows;
  const facts =
    askedBudget === undefined
      ? [...subject, ...details]
      : [...asked.map((detail) => fitAskedDetail(detail, room, askedBudget)), ...subject, ...after];

  const parts = formatRecoveryHeaderParts(issue);
  const rows: PromptRow[] = [
    { kind: 'headline', tone: 'attention', text: parts.map((part) => part.text).join(''), parts },
  ];
  if (facts.length > 0) {
    if (!spendsBlank) rows.push({ kind: 'blank' });
    rows.push({ kind: 'facts', items: facts, grid: false });
  }
  return rows;
}

/**
 * The asked row as it wraps at `room`, on at most `rows` rows. A value can lose its exemption from
 * the mask when it is cut, and grow the row. So the row is the longest cut that the mask leaves as
 * it is, the whole text first; a shorter cut ends on `…`.
 */
function fitAskedDetail(detail: string, room: number, rows: number): string {
  const text = oneLineDisplayText(detail);
  let cells = room * rows;
  while (cells > 1) {
    const fitted = truncateTerminalDisplayText(text, cells);
    if (oneLineDisplayText(fitted) === fitted && wrapHard(fitted, room).split('\n').length <= rows)
      return fitted;
    cells = getTerminalCellWidth(fitted) - 1;
  }
  return ELLIPSIS;
}

function promptRowToLines(row: PromptRow): string[] {
  switch (row.kind) {
    case 'blank':
      return [''];
    case 'headline':
      if (row.tone === 'pass') return [`${passHeadlinePrefix()}${row.text}`];
      if (row.tone === 'failed') {
        return [
          row.detail !== undefined ? `${row.text}${FAILED_REVIEW_MARKER}${row.detail}` : row.text,
        ];
      }
      return [row.text];
    case 'message':
      return [row.text];
    case 'facts':
      return [...row.items];
  }
}

export function promptRowsToString(
  rows: readonly PromptRow[],
  mask: (row: string) => string = (row) => row,
): string {
  const lines = rows.flatMap(promptRowToLines).map(mask);
  return lines
    .filter((line, index) => line.length > 0 || lines[index - 1] !== '')
    .join('\n')
    .trimEnd();
}

/** The question-mode key of the halt; it has no panel width, so its Files row names every file. */
export function formatRecoveryPrompt(issue: RecoveryIssue): string {
  return promptRowsToString(recoveryPromptSummaryRows(issue, Number.POSITIVE_INFINITY));
}

function formatSubjectLines(issue: RecoveryIssue, width: number): string[] {
  const lines: string[] = [];
  if (issue.reason === 'review-input-too-large') lines.push(issue.message);
  if (issue.taskId && issue.taskTitle) lines.push(`Task ${issue.taskId} · ${issue.taskTitle}`);
  if (issue.files.length > 0) {
    const room = width - getTerminalCellWidth(FACT_INDENT) - getTerminalCellWidth(FILES_LABEL);
    lines.push(`${FILES_LABEL}${fitFileList(issue.files, room)}`);
  }
  const affected = issue.affectedTaskIds.filter((taskId) => taskId !== issue.taskId);
  if (affected.length > 0) lines.push(`Affected ${formatMiddotList(affected, 3)}`);
  return lines;
}

/**
 * The Files row is one row: the whole names that fit, then `+N more` as one unit. A first name
 * that does not fit beside its count is shortened the way the brief rows shorten a path. Each name
 * is measured once, so a halt with thousands of files fits its row in one pass on every render.
 */
function fitFileList(files: string[], room: number): string {
  const separator = getTerminalCellWidth(SOFT_SEP);
  const widths = files.map((file) => getTerminalCellWidth(file));
  let visible = widths.reduce((sum, width) => sum + width, separator * (files.length - 1));
  for (const [index, width] of [...widths.entries()].reverse()) {
    const hidden = files.length - index - 1;
    const tail = hidden > 0 ? separator + getTerminalCellWidth(`+${hidden} more`) : 0;
    if (visible + tail <= room) return formatTruncatedList(files, index + 1);
    visible -= width + separator;
  }
  const tail = files.length > 1 ? `${SOFT_SEP}+${files.length - 1} more` : '';
  return `${elidePathMiddle(files[0] ?? '', room - getTerminalCellWidth(tail))}${tail}`;
}

function formatDetailLines(issue: RecoveryIssue): string[] {
  const dropQuotedReset = formatResetAt(issue.resetAt) !== undefined;
  return issue.details
    .filter((detail) => !detail.startsWith('Worker profile:'))
    .map(formatDetailLine)
    .map((detail) => (dropQuotedReset ? stripRecoveryResetClause(detail) : detail));
}

function formatDetailLine(detail: string): string {
  if (detail.startsWith('Validation: ')) return `Last check ${detail.slice('Validation: '.length)}`;
  if (detail.startsWith('Validation ')) return `Last check ${detail.slice('Validation '.length)}`;
  if (detail.startsWith('Spent ')) return `Spent ${detail.slice('Spent '.length)}`;
  return detail;
}
