import { RECOVERY_ACTIONS, type RecoveryAction } from '../../core/schemas/enums.js';
import type {
  RecoveryIssue,
  SeatSwapCandidate,
  SwitchSeatOffer,
} from '../../core/schemas/recovery/schemas.js';
import {
  CREW_SEAT_LABELS,
  formatSeatCandidateIdentity,
  type CrewSeatId,
} from '../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { resolveModelDisplayName } from '../../engine/providers/model/display-names.js';
import { isSeatLevelRetry } from '../../engine/orchestrator/recovery/actions.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { recoveryFactString } from '../../core/schemas/recovery/facts.js';
import { countNoun } from '../../utils/pluralize.js';
import { glyph } from '../../lib/glyphs.js';
import { SOFT_SEP } from '../../core/separators.js';
import { formatResetAt, stripRecoveryResetClause } from '../../core/recovery/reset-clock.js';
import {
  formatRecoveryHeadline,
  formatRecoveryHeadlineSpans,
} from '../../core/recovery/headline.js';
import {
  keepsHaltedTool,
  recoveryActionLabel,
  recoveryActionParts,
  type RecoveryActionChoiceContext,
} from '../../core/recovery/action-label.js';
import { formatTruncatedList } from '../../core/formatting.js';
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

const BOUND_REASONS: ReadonlySet<RecoveryIssue['reason']> = new Set([
  'consult-bound-spent',
  'planner-calls-spent',
]);

export function recommendedRowPrefix(): string {
  return `${glyph('liveBar')} `;
}

export function passHeadlinePrefix(): string {
  return `${glyph('check')} `;
}

export const FAILED_REVIEW_MARKER = ' failed review · ';

const ACTION_ROW_PATTERN = /^\[.+?\]/;

export function formatActionRow(key: string, text: string): string {
  return `[${key}]  ${text}`;
}

export function isActionRowLine(line: string): boolean {
  const prefix = recommendedRowPrefix();
  const body = line.startsWith(prefix) ? line.slice(prefix.length) : line;
  return ACTION_ROW_PATTERN.test(body);
}

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
  | { kind: 'facts'; items: string[]; grid: boolean }
  | { kind: 'action'; text: string; recommended: boolean }
  | { kind: 'note'; text: string };

type ActionRow = Extract<PromptRow, { kind: 'action' } | { kind: 'note' }>;

const ACTION_KEYS: Record<RecoveryAction, string> = {
  'retry-same-worker': 'r',
  'restore-backup': 'u',
  'switch-seat': 'w',
  'retry-later': 'l',
  revise: 'v',
  'accept-as-is': 'k',
  continue: 'c',
  'skip-current-task': 's',
  'end-run': 'a',
};

/** The one key an action answers to, on the picker row and as a typed letter. */
export function recoveryActionKey(action: RecoveryAction): string {
  return ACTION_KEYS[action];
}

export const ACTION_ALIASES: Record<RecoveryAction, string[]> = {
  'retry-same-worker': ['r', 'retry', 'retry same worker', 'retry-same-worker'],
  'restore-backup': ['u', 'restore', 'restore backup', 'restore-backup'],
  'switch-seat': ['w', 'switch', 'switch seat', 'switch-seat'],
  'retry-later': ['l', 'later', 'retry later', 'wait', 'retry-later'],
  revise: ['v', 'revise', 'comment'],
  'accept-as-is': ['k', 'accept', 'accept as is', 'accept-as-is'],
  continue: ['c', 'continue', 'cont'],
  'skip-current-task': ['s', 'skip', 'skip task', 'skip-current-task'],
  'end-run': ['a', 'end', 'end run', 'end-run', 'abort', 'quit', 'q'],
};

/** The numbered form of the seat key, as the prompt prints it for a second and third offer. */
const SWITCH_SEAT_ROW_KEY = new RegExp(`^${ACTION_KEYS['switch-seat']}([1-9][0-9]?)$`);

export function getRecoveryPromptActions(issue: RecoveryIssue): RecoveryAction[] {
  const allowed = new Set(issue.availableActions);
  return ACTION_ORDER.filter((action) => allowed.has(action));
}

/**
 * The action typed words take on this halt: a retry carries them as the steer, and a halt that
 * offers no retry sends them with its revise. A halt that offers neither takes no words.
 */
export function correctionActionFor(issue: RecoveryIssue): RecoveryAction | undefined {
  const offered: readonly RecoveryAction[] = [
    'retry-same-worker',
    'revise',
    // A spent bound continues by a grant, and the grant records the note and steers the replay.
    ...(BOUND_REASONS.has(issue.reason) ? (['continue'] as const) : []),
  ];
  return offered.find((action) => issue.availableActions.includes(action));
}

/** The composer placeholder on an open halt names what the focused side takes. */
export function recoveryComposerHint(
  issue: RecoveryIssue,
  menuFocused: boolean,
  stopMenuOpen: boolean,
): string {
  if (stopMenuOpen) return 'Choose an action above…';
  const correction = correctionActionFor(issue) !== undefined;
  if (menuFocused)
    return correction
      ? 'Choose an action above, or tab to type a correction…'
      : 'Choose an action above…';
  return correction ? 'Type a correction, or tab to choose an action…' : 'Tab to choose an action…';
}

function formatRecoveryActionText(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  const applyConsequence = applyRecoveryConsequence(action, context.reason);
  if (applyConsequence !== undefined) {
    const label = recoveryActionLabel(action, context);
    return `${label.charAt(0).toLowerCase()}${label.slice(1)}${SOFT_SEP}${applyConsequence}`;
  }
  switch (action) {
    case 'retry-same-worker':
      return context.seatRetry === undefined
        ? 'retry same worker'
        : `retry ${CREW_SEAT_LABELS[context.seatRetry]}`;
    case 'restore-backup':
      return 'restore backup';
    case 'switch-seat':
      return 'switch the seat to another tool';
    case 'retry-later': {
      const label = recoveryActionLabel('retry-later', context);
      return label.charAt(0).toLowerCase() + label.slice(1);
    }
    case 'revise':
      return context.reason === 'review-failed'
        ? 'fix again · add a note, grant one more fix cycle'
        : 'revise · send the planner a correction';
    case 'accept-as-is':
      return context.reason === 'review-input-too-large'
        ? 'skip review · ready to apply unreviewed; your note is recorded and Apply asks once'
        : 'accept as is · ready to apply with the open findings; Apply lists them and asks once';
    case 'continue':
      return 'continue';
    case 'skip-current-task':
      return 'skip task';
    case 'end-run':
      return 'end run · closes this run, changes kept';
  }
}

function applyRecoveryConsequence(
  action: RecoveryAction,
  reason: RecoveryActionChoiceContext['reason'],
): string | undefined {
  if (reason !== 'apply-conflict' && reason !== 'apply-partial') return undefined;
  if (action === 'end-run') return 'closes this run, the checkout keeps what it has now';
  if (action === 'restore-backup' && reason === 'apply-partial')
    return 'puts back the files Apply replaced and removes the ones it created';
  if (action !== 'retry-same-worker') return undefined;
  return reason === 'apply-conflict'
    ? 'after you resolve the files in the workspace'
    : 'writes the files still missing';
}

/** How many of a seat's detected tools the halt offers; a longer list is a settings question. */
export const OFFERED_SEAT_SWAP_CANDIDATES = 3;

export function offeredSeatSwapCandidates(
  offer: SwitchSeatOffer | undefined,
): readonly SeatSwapCandidate[] {
  return offer === undefined ? [] : offer.candidates.slice(0, OFFERED_SEAT_SWAP_CANDIDATES);
}

/** One offered tool needs no number; several are numbered from the seat's own key. */
function switchSeatRowKey(index: number, offered: number): string {
  const key = ACTION_KEYS['switch-seat'];
  return offered === 1 ? key : `${key}${index + 1}`;
}

/**
 * A menu row's words. A swap says what it runs again, as the applier decides it
 * (`isSeatLevelRetry`): the step the halted seat was on, else the brief the halt
 * names, from its first attempt. So does a retry after a PLAN or REVIEW halt on
 * a brief: "Try again" alone reads as retrying the call that stopped, but it
 * restarts the brief. On a short panel the facts above the rows are what drops.
 */
export function recoveryMenuLabel(action: RecoveryAction, issue: RecoveryIssue): string {
  return recoveryMenuParts(action, issue)
    .map((part) => part.text)
    .join('');
}

export function recoveryMenuParts(
  action: RecoveryAction,
  issue: RecoveryIssue,
): ConversationRowSegment[] {
  const label = recoveryActionParts(action, {
    reason: issue.reason,
    switchSeat: issue.switchSeat,
    seat: issue.seat,
    resetAt: issue.resetAt,
    haltedTool: recoveryFactString(issue.facts, 'tool'),
  }).map(
    (part): ConversationRowSegment => ({
      text: part.text,
      tone: part.seat === undefined ? 'text' : CREW_SEAT_ROLES[part.seat],
    }),
  );
  const consequence = recoveryMenuConsequence(action, issue);
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
    return issue.reason === 'review-failed' ? 'add a note, grant one more fix cycle' : undefined;
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

/** A switch-seat row; the halted tool offered without a model reads as the menu's model pick. */
function switchSeatRowText(
  seat: CrewSeatId,
  candidate: SeatSwapCandidate,
  haltedTool: string | undefined,
): string {
  if (keepsHaltedTool(candidate, haltedTool)) {
    const label = recoveryActionLabel('switch-seat', {
      switchSeat: { seat, candidates: [candidate] },
      haltedTool,
    });
    return label.charAt(0).toLowerCase() + label.slice(1);
  }
  const displayName =
    candidate.model === undefined
      ? undefined
      : resolveModelDisplayName({
          providerId: candidate.tool,
          model: candidate.model,
          role: CREW_SEAT_ROLES[seat],
          cache: modelCacheStore,
        });
  return `switch ${CREW_SEAT_LABELS[seat]} to ${formatSeatCandidateIdentity(candidate, displayName)}`;
}

/**
 * The tools a quota-blocked seat is offered get one row each, because a row is
 * what the operator presses: a comma-separated list behind a single key names
 * several destinations and says nothing about which one it takes. Tools past
 * the offer are counted in a note, never dropped silently.
 */
function switchSeatRows(context: RecoveryActionChoiceContext, recommended: boolean): ActionRow[] {
  const offer = context.switchSeat;
  const offered = offeredSeatSwapCandidates(offer);
  if (offer === undefined || offered.length === 0) {
    return [
      { kind: 'action', text: formatRecoveryActionChoice('switch-seat', context), recommended },
    ];
  }
  const rows: ActionRow[] = offered.map((candidate, index) => ({
    kind: 'action',
    text: formatActionRow(
      switchSeatRowKey(index, offered.length),
      switchSeatRowText(offer.seat, candidate, context.haltedTool),
    ),
    recommended: recommended && index === 0,
  }));
  const hidden = offer.candidates.length - offered.length;
  if (hidden > 0) {
    rows.push({ kind: 'note', text: `(${countNoun(hidden, 'more ready tool')} detected)` });
  }
  return rows;
}

/**
 * Which offered tool an answer names: the bare seat key takes the first row,
 * `w2` the second, and a number past the offer takes nothing so an unknown key
 * is refused instead of silently swapping to a tool the operator never read.
 */
export function switchSeatCandidateForAnswer(
  input: string,
  offer: SwitchSeatOffer | undefined,
): SeatSwapCandidate | undefined {
  const candidates = offer?.candidates ?? [];
  const match = SWITCH_SEAT_ROW_KEY.exec(input.trim().toLowerCase());
  if (match?.[1] === undefined) return candidates[0];
  return candidates[Number.parseInt(match[1], 10) - 1];
}

function formatRecoveryActionChoice(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  return formatActionRow(ACTION_KEYS[action], formatRecoveryActionText(action, context));
}

export function formatMiddotList(values: string[], max: number): string {
  return formatTruncatedList(values, max);
}

function buildRecoveryActionRows(
  actions: RecoveryAction[],
  context: RecoveryActionChoiceContext,
  recommended: RecoveryAction | undefined,
): ActionRow[] {
  const rows: ActionRow[] = [];
  for (const action of actions) {
    if (action === 'switch-seat') {
      rows.push(...switchSeatRows(context, action === recommended));
      continue;
    }
    rows.push({
      kind: 'action',
      text: formatRecoveryActionChoice(action, context),
      recommended: action === recommended,
    });
  }
  return rows;
}

/**
 * A halt that names no brief is about the seat, not a task: PLAN and REVIEW have nothing to reset,
 * so their retry re-issues the same step once the seat is corrected. Mirrors `isSeatLevelRetry`
 * (`src/engine/orchestrator/recovery/actions.ts`), which decides what the retry actually does;
 * both are keyed on the same two facts, so a row never offers a replay the applier will not run.
 */
function seatLevelRetrySeat(issue: RecoveryIssue): CrewSeatId | undefined {
  if (issue.taskId !== undefined) return undefined;
  if (issue.seat !== 'plan' && issue.seat !== 'review') return undefined;
  const contextCode = recoveryFactString(issue.facts, 'apiContextCode');
  const reviewFailure = recoveryFactString(issue.facts, 'reviewFailureKind');
  return contextCode === 'insufficient-context' || reviewFailure === 'call-failed'
    ? issue.seat
    : undefined;
}

function buildRecoveryPromptRows(issue: RecoveryIssue): PromptRow[] {
  const actions = getRecoveryPromptActions(issue);
  const context: RecoveryActionChoiceContext = {
    reason: issue.reason,
    switchSeat: issue.switchSeat,
    seat: issue.seat,
    seatRetry: seatLevelRetrySeat(issue),
    resetAt: issue.resetAt,
    haltedTool: recoveryFactString(issue.facts, 'tool'),
  };
  const recommended = resolveRecommendedAction(issue, actions);
  const facts = [...formatSubjectLines(issue), ...formatDetailLines(issue)];

  const parts = formatRecoveryHeaderParts(issue);
  const rows: PromptRow[] = [
    { kind: 'headline', tone: 'attention', text: parts.map((part) => part.text).join(''), parts },
  ];
  if (facts.length > 0) {
    rows.push({ kind: 'blank' }, { kind: 'facts', items: facts, grid: false });
  }
  const actionRows = buildRecoveryActionRows(actions, context, recommended);
  if (actionRows.length > 0) {
    rows.push({ kind: 'blank' }, ...actionRows);
  }
  return rows;
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
    case 'action':
      return [row.recommended ? `${recommendedRowPrefix()}${row.text}` : row.text];
    case 'note':
      return [row.text];
  }
}

export function promptRowsToString(rows: readonly PromptRow[]): string {
  const lines = rows.flatMap(promptRowToLines);
  return lines
    .filter((line, index) => line.length > 0 || lines[index - 1] !== '')
    .join('\n')
    .trimEnd();
}

export function formatRecoveryPrompt(issue: RecoveryIssue): string {
  return promptRowsToString(buildRecoveryPromptRows(issue));
}

/** The issue and its facts for the picker; action rows are rendered as real selectable rows. */
export function recoveryPromptSummaryRows(issue: RecoveryIssue): PromptRow[] {
  const rows = buildRecoveryPromptRows(issue).filter(
    (row): row is Exclude<PromptRow, { kind: 'action' } | { kind: 'note' }> =>
      row.kind !== 'action' && row.kind !== 'note',
  );
  while (rows.at(-1)?.kind === 'blank') rows.pop();
  return rows;
}

export function recommendedRecoveryAction(issue: RecoveryIssue): RecoveryAction | undefined {
  return resolveRecommendedAction(issue, getRecoveryPromptActions(issue));
}

export function parseRecoveryActionAnswer(
  input: string,
  issue: RecoveryIssue,
): RecoveryAction | null {
  const actions = getRecoveryPromptActions(issue);
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return resolveRecommendedAction(issue, actions) ?? null;
  if (SWITCH_SEAT_ROW_KEY.test(normalized)) {
    return numberedSwitchSeatAction(normalized, issue, actions);
  }
  return findAliasedActionAmong(normalized, actions) ?? null;
}

/**
 * A numbered seat key is only a key while the prompt printed it: one offered
 * tool is keyed bare, so `w2` there is a typo, not a choice.
 */
function numberedSwitchSeatAction(
  value: string,
  issue: RecoveryIssue,
  actions: readonly RecoveryAction[],
): RecoveryAction | null {
  if (!actions.includes('switch-seat')) return null;
  const offered = issue.switchSeat?.candidates ?? [];
  if (offered.length < 2) return null;
  return switchSeatCandidateForAnswer(value, issue.switchSeat) === undefined ? null : 'switch-seat';
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
    issue.reason === 'plan-checks-failed'
  ) {
    return recoveryHeadlineParts(issue);
  }
  // "T003 validation failed" takes "after 3 attempts"; a cause that already
  // ends a sentence would read it as part of that sentence ("or abort after 2
  // attempts"), so it keeps its full stop and the attempt count stays in the
  // facts, where the issue's own `Attempts: n/m` detail already carries it.
  // A retry-exhausted halt reads the transcript's own sentence, so a halt saved
  // under older words names its cause the way the transcript and the byline do.
  const cause = issue.reason === 'retry-exhausted' ? formatRecoveryHeadline(issue) : issue.message;
  const attemptSuffix =
    issue.attempts !== undefined && issue.attempts > 0 && !cause.endsWith('.')
      ? ` after ${countNoun(issue.attempts, 'attempt')}`
      : '';
  return separatedSpans(`${cause}${attemptSuffix}`, 'text');
}

export function recoveryHeadlineParts(issue: RecoveryIssue): ConversationRowSegment[] {
  return formatRecoveryHeadlineSpans(issue).flatMap((part) =>
    part.seat === undefined
      ? separatedSpans(part.text, 'text')
      : [{ text: part.text, tone: CREW_SEAT_ROLES[part.seat] }],
  );
}

function formatSubjectLines(issue: RecoveryIssue): string[] {
  const lines: string[] = [];
  if (issue.reason === 'review-input-too-large') lines.push(issue.message);
  if (issue.taskId && issue.taskTitle) lines.push(`Task ${issue.taskId} · ${issue.taskTitle}`);
  if (issue.files.length > 0) lines.push(`Files ${formatMiddotList(issue.files, 3)}`);
  const affected = issue.affectedTaskIds.filter((taskId) => taskId !== issue.taskId);
  if (affected.length > 0) lines.push(`Affected ${formatMiddotList(affected, 3)}`);
  return lines;
}

/**
 * The widest halt a builder writes is retry-exhausted: the last error, the attempts, the bigger
 * worker on offer, what the implementer said, what the planner answered, and the planner's
 * verdict. The budget covers all six, so the two voices are never the rows that fall off.
 * Apply conflicts and partial Apply keep every file detail and the workspace or backup path.
 */
const MAX_DETAIL_LINES = 6;

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
