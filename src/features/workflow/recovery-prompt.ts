import { RECOVERY_ACTIONS, type RecoveryAction } from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { isSeatLevelRetry } from '../../engine/orchestrator/recovery/actions.js';
import { recoveryFactString } from '../../core/schemas/recovery/facts.js';
import { glyph } from '../../lib/glyphs.js';
import { SOFT_SEP } from '../../core/separators.js';
import { formatResetAt, stripRecoveryResetClause } from '../../core/recovery/reset-clock.js';
import {
  formatRecoveryHeadline,
  formatRecoveryHeadlineSpans,
} from '../../core/recovery/headline.js';
import {
  recoveryActionLabel,
  recoveryActionParts,
  type RecoveryActionChoiceContext,
} from '../../core/recovery/action-label.js';
import { leavesWordsUnread } from '../../core/recovery/typed-words.js';
import { formatTruncatedList } from '../../core/formatting.js';
import {
  ELLIPSIS,
  elidePathMiddle,
  getTerminalCellWidth,
  oneLineDisplayText,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { wrapHard } from '../../utils/wrap.js';
import {
  readRecoveryContext,
  recoveryContextCauseWords,
  recoveryContextSeatLabel,
} from './usage-details-model.js';

import { haltOf, recoveryHaltLabel } from '../../core/recovery/halt.js';
import { stateTone } from '../../core/theme/state-tone.js';
import type { ConversationRowSegment } from './conversation-rows/types.js';
import { separatedSpans } from './conversation-rows/row-format/text.js';

const ACTION_ORDER = RECOVERY_ACTIONS;

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

const ACTION_KEYS: Record<RecoveryAction, string> = {
  'retry-same-worker': 'r',
  'restore-backup': 'u',
  'switch-seat': 'w',
  'retry-later': 'l',
  revise: 'v',
  'accept-as-is': 'k',
  continue: 'c',
  'decide-for-me': 'd',
  'skip-current-task': 's',
  'end-run': 'a',
};

/**
 * The one key an action answers to on the picker row. The driver reads the same letter typed in
 * the composer as words, unless it is the key of the halt's correction action.
 */
export function recoveryActionKey(action: RecoveryAction): string {
  return ACTION_KEYS[action];
}

export const ACTION_ALIASES: Record<RecoveryAction, string[]> = {
  'retry-same-worker': ['r', 'retry', 'retry same worker', 'retry-same-worker'],
  'restore-backup': ['u'],
  'switch-seat': ['w'],
  'retry-later': ['l'],
  revise: ['v', 'revise', 'comment'],
  'accept-as-is': ['k'],
  continue: ['c'],
  'decide-for-me': ['d'],
  'skip-current-task': ['s'],
  'end-run': ['a'],
};

export function getRecoveryPromptActions(issue: RecoveryIssue): RecoveryAction[] {
  const allowed = new Set(issue.availableActions);
  return ACTION_ORDER.filter((action) => allowed.has(action));
}

/**
 * The action typed words take on this halt: a retry carries them as the steer, and a halt that
 * offers no retry sends them with its revise. A halt that offers neither takes no words, and so
 * does an Apply halt: Re-run Apply reads none.
 */
export function correctionActionFor(issue: RecoveryIssue): RecoveryAction | undefined {
  const offered: readonly RecoveryAction[] = ['retry-same-worker', 'revise'];
  return offered.find(
    (action) => issue.availableActions.includes(action) && !leavesWordsUnread(issue.reason, action),
  );
}

/** The composer placeholder on an open halt names what the focused side takes. */
export function recoveryComposerHint(issue: RecoveryIssue, menuFocused: boolean): string {
  const correction = correctionActionFor(issue) !== undefined;
  if (menuFocused)
    return correction
      ? 'Choose an action above, or tab to type a correction…'
      : 'Choose an action above…';
  return correction ? 'Type a correction, or tab to choose an action…' : 'Tab to choose an action…';
}

/** An empty ⏎ in the composer runs no action: words or a row do. */
export const RECOVERY_EMPTY_ENTER_NOTICE = 'Nothing to send. Tab to choose an action.';

const REVIEW_FAILED_REVISE_CONSEQUENCE = 'runs another fix cycle with your note';

function applyRecoveryConsequence(
  action: RecoveryAction,
  reason: RecoveryActionChoiceContext['reason'],
): string | undefined {
  if (reason !== 'apply-conflict' && reason !== 'apply-partial') return undefined;
  if (action === 'restore-backup' && reason === 'apply-partial')
    return 'puts back the files Apply replaced and removes the ones it created';
  if (action !== 'retry-same-worker') return undefined;
  return reason === 'apply-conflict'
    ? 'after you resolve the files in the workspace'
    : 'writes the files still missing';
}

function recoveryMenuContext(issue: RecoveryIssue): RecoveryActionChoiceContext {
  return {
    reason: issue.reason,
    switchSeat: issue.switchSeat,
    seat: issue.seat,
    resetAt: issue.resetAt,
    haltedTool: recoveryFactString(issue.facts, 'tool'),
  };
}

/** The words of an action's menu row without its consequence, as a byline names the choice. */
export function recoveryMenuActionLabel(action: RecoveryAction, issue: RecoveryIssue): string {
  return recoveryActionLabel(action, recoveryMenuContext(issue));
}

/**
 * A menu row's words. A swap says what it runs again, as the applier decides it
 * (`isSeatLevelRetry`): the step the halted seat was on, else the brief the halt
 * names, from its first attempt. So does a retry after a PLAN or REVIEW halt on
 * a brief: "Try again" alone reads as retrying the call that stopped, but it
 * restarts the brief. On a short panel the facts above the rows are what drops.
 */
export function recoveryMenuParts(
  action: RecoveryAction,
  issue: RecoveryIssue,
  briefFinished: boolean,
): ConversationRowSegment[] {
  const label = recoveryActionParts(action, recoveryMenuContext(issue)).map(
    (part): ConversationRowSegment => ({
      text: part.text,
      tone: part.seat === undefined ? 'text' : CREW_SEAT_ROLES[part.seat],
    }),
  );
  const consequence =
    action === 'end-run' && briefFinished
      ? 'closes this run, keeps its changes'
      : recoveryMenuConsequence(action, issue);
  return consequence === undefined
    ? label
    : [...label, { text: SOFT_SEP, tone: 'textDim' }, { text: consequence, tone: 'textDim' }];
}

function recoveryMenuConsequence(action: RecoveryAction, issue: RecoveryIssue): string | undefined {
  if (action === 'retry-same-worker' || action === 'restore-backup') {
    const apply = applyRecoveryConsequence(action, issue.reason);
    if (apply !== undefined) return apply;
  }
  if (action === 'revise')
    return issue.reason === 'review-failed' ? REVIEW_FAILED_REVISE_CONSEQUENCE : undefined;
  const seatLevel = isSeatLevelRetry(issue);
  const says =
    action === 'switch-seat' ||
    (action === 'retry-same-worker' &&
      !seatLevel &&
      (issue.seat === 'plan' || issue.seat === 'review'));
  if (!says) return undefined;
  if (!seatLevel) return 'restarts this brief';
  return issue.phase === 'final-review' ? 'runs the review again' : 'runs this step again';
}

export function formatMiddotList(values: string[], max: number): string {
  return formatTruncatedList(values, max);
}

/**
 * The issue and its facts at the panel's text width; the menu under them holds the actions.
 * `askedRows` puts the asked row before the task and its files, on at most that many rows, for a
 * panel too short to reach it.
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
  const facts =
    askedRows === undefined
      ? [...subject, ...details]
      : [
          ...asked.map((detail) => fitAskedDetail(detail, room, askedRows)),
          ...subject,
          ...details.filter((detail) => !isAskedDetail(detail)),
        ];

  const parts = formatRecoveryHeaderParts(issue);
  const rows: PromptRow[] = [
    { kind: 'headline', tone: 'attention', text: parts.map((part) => part.text).join(''), parts },
  ];
  if (facts.length > 0) {
    rows.push({ kind: 'blank' }, { kind: 'facts', items: facts, grid: false });
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

export function recommendedRecoveryAction(issue: RecoveryIssue): RecoveryAction | undefined {
  return resolveRecommendedAction(issue, getRecoveryPromptActions(issue));
}

export function parseRecoveryActionAnswer(
  input: string,
  issue: RecoveryIssue,
): RecoveryAction | null {
  const normalized = input.trim().toLowerCase();
  return findAliasedActionAmong(normalized, getRecoveryPromptActions(issue)) ?? null;
}

function findAliasedActionAmong(
  value: string,
  candidates: readonly RecoveryAction[],
): RecoveryAction | undefined {
  for (const action of candidates) {
    if (ACTION_ALIASES[action].includes(value)) return action;
  }
  return undefined;
}

function resolveRecommendedAction(
  issue: RecoveryIssue,
  actions: RecoveryAction[],
): RecoveryAction | undefined {
  if (actions.includes(issue.recommendedAction)) return issue.recommendedAction;
  return actions[0];
}

function formatRecoveryHeaderParts(issue: RecoveryIssue): ConversationRowSegment[] {
  return [
    { text: recoveryHaltLabel(haltOf(issue.reason)), tone: stateTone('attention') },
    { text: SOFT_SEP, tone: 'textDim' },
    ...recoveryCauseParts(issue),
  ];
}

function recoveryCauseParts(issue: RecoveryIssue): ConversationRowSegment[] {
  const context = readRecoveryContext(issue);
  if (context !== null)
    return [
      { text: 'Nothing was sent to ', tone: 'text' },
      { text: recoveryContextSeatLabel(context), tone: CREW_SEAT_ROLES[context.seat] },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: recoveryContextCauseWords(context), tone: 'text' },
    ];
  if (
    (issue.reason === 'runner-usage-limit' || issue.reason === 'runner-unauthenticated') &&
    recoveryFactString(issue.facts, 'tool') !== undefined
  ) {
    return separatedSpans(formatRecoveryHeadline(issue), 'text');
  }
  // The engine's sentence carries the evidence for the headless sinks; here the evidence is the
  // first fact row, so the header names the halt and nothing is said twice. A checkout halt's
  // rows do not repeat its changes, so its header names them.
  if (
    issue.reason === 'implementer-recipe-invalid' ||
    recoveryFactString(issue.facts, 'refusal') !== undefined ||
    issue.reason === 'implementer-left-isolation' ||
    issue.reason === 'checkout-changed' ||
    issue.reason === 'apply-conflict' ||
    issue.reason === 'apply-partial' ||
    issue.reason === 'review-input-too-large' ||
    issue.reason === 'required-checks-unrunnable' ||
    issue.reason === 'plan-questions-exhausted' ||
    issue.reason === 'plan-checks-failed' ||
    issue.reason === 'runner-timeout-repeated'
  ) {
    return recoveryHeadlineParts(issue);
  }
  // A retry-exhausted halt reads the transcript's own sentence, so a halt saved
  // under older words names its cause the way the transcript and the byline do.
  const cause = issue.reason === 'retry-exhausted' ? formatRecoveryHeadline(issue) : issue.message;
  return separatedSpans(cause, 'text');
}

export function recoveryHeadlineParts(issue: RecoveryIssue): ConversationRowSegment[] {
  return formatRecoveryHeadlineSpans(issue).flatMap((part) =>
    part.seat === undefined
      ? separatedSpans(part.text, 'text')
      : [{ text: part.text, tone: CREW_SEAT_ROLES[part.seat] }],
  );
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

/**
 * The widest halt a builder writes is retry-exhausted: the last error, the attempts, the bigger
 * worker on offer, what the implementer said, what the planner answered, and the planner's
 * verdict. The budget covers all six, so the two voices are never the rows that fall off.
 * Apply conflicts and partial Apply keep every file detail and the workspace or backup path.
 */
const MAX_DETAIL_LINES = 6;

/** The line the halt asks the user to read: the planner's question, or why it cannot be done. */
export function isAskedDetail(detail: string): boolean {
  return detail.startsWith('Question: ') || detail.startsWith('Planner said: ');
}

function formatDetailLines(issue: RecoveryIssue): string[] {
  const dropQuotedReset = formatResetAt(issue.resetAt) !== undefined;
  const details =
    issue.reason === 'apply-conflict' || issue.reason === 'apply-partial'
      ? issue.details
      : issue.details
          .filter((detail) => !detail.startsWith('Worker profile:'))
          .slice(0, MAX_DETAIL_LINES);
  return details
    .map(formatDetailLine)
    .map((detail) => (dropQuotedReset ? stripRecoveryResetClause(detail) : detail));
}

function formatDetailLine(detail: string): string {
  if (detail.startsWith('Validation: ')) return `Last check ${detail.slice('Validation: '.length)}`;
  if (detail.startsWith('Validation ')) return `Last check ${detail.slice('Validation '.length)}`;
  if (detail.startsWith('Spent ')) return `Spent ${detail.slice('Spent '.length)}`;
  return detail;
}
