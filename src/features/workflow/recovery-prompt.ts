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
import { isAskedDetail } from '../../core/recovery/causes.js';
import {
  recoveryActionLabel,
  recoveryActionParts,
  type RecoveryActionChoiceContext,
} from '../../core/recovery/action-label.js';
import { leavesWordsUnread } from '../../core/recovery/typed-words.js';
import { formatTruncatedList } from '../../core/formatting.js';
import { elidePathMiddle, truncateTerminalDisplayText } from '../../utils/display-text/truncate.js';
import { ELLIPSIS } from '../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';
import { oneLineDisplayText } from '../../utils/display-text/sanitize.js';
import { wrapHard } from '../../utils/display-text/wrap.js';
import {
  readRecoveryContext,
  recoveryContextCauseWords,
  recoveryContextSeatLabel,
} from './usage-details-model.js';

import { haltOf, recoveryHaltLabel } from '../../core/recovery/halt.js';
import { decidedRecovery } from '../../core/recovery/decide.js';
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
 * does a halt that picks up at a step that reads no words (`stepReadsNone`).
 */
export function correctionActionFor(
  issue: RecoveryIssue,
  stepReadsNone: boolean,
): RecoveryAction | undefined {
  const offered: readonly RecoveryAction[] = ['retry-same-worker', 'revise'];
  return offered.find(
    (action) =>
      issue.availableActions.includes(action) &&
      !leavesWordsUnread(issue.reason, action, stepReadsNone),
  );
}

/** The refusal of typed words on a halt with no correction action. */
export const NO_CORRECTION_MESSAGE = 'This halt takes no typed correction. Choose an action.';

/** The composer placeholder on an open halt names what the focused side takes. */
export function recoveryComposerHint(
  issue: RecoveryIssue,
  menuFocused: boolean,
  stepReadsNone: boolean,
): string {
  const correction = correctionActionFor(issue, stepReadsNone) !== undefined;
  if (menuFocused)
    return correction
      ? 'Choose an action above, or tab to type a correction…'
      : 'Choose an action above…';
  return correction ? 'Type a correction, or tab to choose an action…' : 'Tab to choose an action…';
}

/** An empty ⏎ in the composer runs no action: words or a row do. */
export const RECOVERY_EMPTY_ENTER_NOTICE = 'Nothing to send. Tab to choose an action.';

const REVIEW_FAILED_REVISE_CONSEQUENCE = 'sends your note to the reviewer';

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

function recoveryMenuContext(
  issue: RecoveryIssue,
  reviewNone: boolean,
): RecoveryActionChoiceContext {
  return {
    reviewNone,
    reason: issue.reason,
    switchSeat: issue.switchSeat,
    seat: issue.seat,
    resetAt: issue.resetAt,
    haltedTool: recoveryFactString(issue.facts, 'tool'),
  };
}

/** The words of an action's menu row without its consequence, as a byline names the choice. */
export function recoveryMenuActionLabel(
  action: RecoveryAction,
  issue: RecoveryIssue,
  reviewNone: boolean,
): string {
  return recoveryActionLabel(action, recoveryMenuContext(issue, reviewNone));
}

/**
 * A menu row's words. A swap says what it runs again, as the applier decides it
 * (`isSeatLevelRetry`): the step the halted seat was on, else the brief the halt
 * names. So does a retry after a PLAN or REVIEW halt on a brief: "Try again"
 * alone reads as retrying the call that stopped. A *Seat down* halt on BUILD or
 * PLAN parks its brief (`raiseBriefHalt`), so that brief continues on the files
 * it kept; after any other halt the brief starts again. On a short panel the
 * facts above the rows are what drops.
 */
export function recoveryMenuParts(
  action: RecoveryAction,
  issue: RecoveryIssue,
  briefFinished: boolean,
  reviewNone: boolean,
): ConversationRowSegment[] {
  const label = recoveryActionParts(action, recoveryMenuContext(issue, reviewNone)).map(
    (part): ConversationRowSegment => ({
      text: part.text,
      tone: part.seat === undefined ? 'text' : CREW_SEAT_ROLES[part.seat],
    }),
  );
  const consequence =
    action === 'end-run' && briefFinished
      ? 'closes this run, keeps its changes'
      : recoveryMenuConsequence(action, issue, reviewNone);
  return consequence === undefined
    ? label
    : [...label, { text: SOFT_SEP, tone: 'textDim' }, { text: consequence, tone: 'textDim' }];
}

const DECIDED_STEP_CONSEQUENCE: Partial<Record<RecoveryAction, string>> = {
  'skip-current-task': 'skips this brief',
  'end-run': 'closes this run',
  'retry-same-worker': 'lets the implementer decide',
  revise: 'lets the next review decide',
};

function recoveryMenuConsequence(
  action: RecoveryAction,
  issue: RecoveryIssue,
  reviewNone: boolean,
): string | undefined {
  if (action === 'accept-as-is')
    return issue.reason === 'review-input-too-large'
      ? 'accepts the result'
      : 'records the blockers';
  if (action === 'decide-for-me') {
    const decided = decidedRecovery(issue);
    return decided === undefined ? undefined : DECIDED_STEP_CONSEQUENCE[decided.action];
  }
  if (action === 'retry-same-worker' || action === 'restore-backup') {
    const apply = applyRecoveryConsequence(action, issue.reason);
    if (apply !== undefined) return apply;
  }
  if (action === 'revise')
    return issue.reason === 'review-failed' && !reviewNone
      ? REVIEW_FAILED_REVISE_CONSEQUENCE
      : undefined;
  const seatLevel = isSeatLevelRetry(issue);
  const says =
    action === 'switch-seat' ||
    (action === 'retry-same-worker' &&
      !seatLevel &&
      (issue.seat === 'plan' || issue.seat === 'review'));
  if (!says) return undefined;
  if (!seatLevel)
    return haltOf(issue.reason) === 'seat-down' && issue.seat !== 'review'
      ? 'continues this brief'
      : 'restarts this brief';
  return issue.phase === 'final-review' ? 'runs the review again' : 'runs this step again';
}

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
    issue.facts?.reviewSeatNoImages === true ||
    issue.reason === 'implementer-left-isolation' ||
    issue.reason === 'checkout-changed' ||
    issue.reason === 'apply-conflict' ||
    issue.reason === 'apply-partial' ||
    issue.reason === 'review-input-too-large' ||
    issue.reason === 'required-checks-unrunnable' ||
    issue.reason === 'plan-questions-exhausted' ||
    issue.reason === 'plan-checks-failed' ||
    issue.reason === 'runner-timeout-repeated' ||
    issue.reason === 'runner-check-failed'
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
