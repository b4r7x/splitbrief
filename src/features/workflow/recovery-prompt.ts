import type { RecoveryAction, RecoveryReason } from '../../core/schemas/enums.js';
import {
  PROMPTABLE_RECOVERY_ACTIONS,
  UserEditConflictKindSchema,
} from '../../core/schemas/enums.js';
import type {
  RecoveryFact,
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
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import {
  recoveryFactBoolean,
  recoveryFactNumber,
  recoveryFactString,
} from '../../core/schemas/recovery/facts.js';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { countNoun } from '../../utils/pluralize.js';
import { glyph } from '../../lib/glyphs.js';
import { formatResetNote } from '../../core/recovery/reset-clock.js';
import { userEditConflictRelation } from '../../core/recovery/user-edit-conflict-words.js';
import { formatRecoveryHeadline } from '../../core/recovery/headline.js';
import { formatContextLength, formatTruncatedList } from '../../core/formatting.js';
import {
  readRecoveryContext,
  recoveryContextCauseWords,
  recoveryContextSeatLabel,
} from './usage-details-model.js';

const ACTION_ORDER = PROMPTABLE_RECOVERY_ACTIONS;

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
  | { kind: 'headline'; tone: 'pass' | 'failed' | 'attention'; text: string; detail?: string }
  | { kind: 'message'; text: string }
  | { kind: 'blank' }
  | { kind: 'facts'; items: string[]; grid: boolean }
  | { kind: 'action'; text: string; recommended: boolean }
  | { kind: 'note'; text: string };

type ActionRow = Extract<PromptRow, { kind: 'action' } | { kind: 'note' }>;

const REBASE_CONTINUATION = '(approve / edit / reject the proposal)';

// `revise` and `revise-spec` share a key: no reason offers both, and the answer
// is matched only against the actions the issue itself carries.
const ACTION_KEYS: Record<RecoveryAction, string> = {
  'retry-same-worker': 'r',
  'route-bigger-worker': 'b',
  'switch-seat': 'w',
  'planner-split-rebase': 'p',
  revise: 'v',
  'revise-spec': 'v',
  continue: 'c',
  'skip-current-task': 's',
  'pause-run': 'space',
  'end-run': 'a',
};

/** The one key an action answers to, on the picker row and as a typed letter. */
export function recoveryActionKey(action: RecoveryAction): string {
  return ACTION_KEYS[action];
}

export const ACTION_ALIASES: Record<RecoveryAction, string[]> = {
  'retry-same-worker': ['r', 'retry', 'retry same worker', 'retry-same-worker'],
  'route-bigger-worker': ['b', 'bigger', 'route', 'route bigger', 'route-bigger-worker'],
  'switch-seat': ['w', 'switch', 'switch seat', 'switch-seat'],
  'planner-split-rebase': [],
  revise: ['v', 'revise', 'comment'],
  'revise-spec': ['v', 'revise', 'revise spec', 'revise-spec'],
  continue: ['c', 'continue', 'cont'],
  'skip-current-task': ['s', 'skip', 'skip task', 'skip-current-task'],
  'pause-run': ['space', 'pause', 'pause run', 'pause-run'],
  'end-run': ['a', 'end', 'end run', 'end-run', 'abort', 'quit', 'q'],
};

/** The numbered form of the seat key, as the prompt prints it for a second and third offer. */
const SWITCH_SEAT_ROW_KEY = new RegExp(`^${ACTION_KEYS['switch-seat']}([1-9][0-9]?)$`);

export interface RecoveryActionChoiceContext {
  reason?: RecoveryReason | undefined;
  facts?: Record<string, RecoveryFact> | undefined;
  switchSeat?: SwitchSeatOffer | undefined;
  /** The seat the halt stopped, where no offer names it — a recovery event carries only this. */
  seat?: CrewSeatId | undefined;
  /** The seat a retry re-issues when the halt names no brief; absent when it replays one. */
  seatRetry?: CrewSeatId | undefined;
}

export function getRecoveryPromptActions(issue: RecoveryIssue): RecoveryAction[] {
  const allowed = new Set(issue.availableActions);
  return ACTION_ORDER.filter((action) => allowed.has(action));
}

function formatRecoveryActionText(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  switch (action) {
    case 'retry-same-worker':
      return context.seatRetry === undefined
        ? 'retry same worker'
        : `retry ${CREW_SEAT_LABELS[context.seatRetry]}`;
    case 'route-bigger-worker': {
      const profile = recoveryFactString(context.facts, 'routeBiggerProfile');
      return profile ? `route to bigger worker · ${profile}` : 'route to bigger worker';
    }
    case 'switch-seat':
      return 'switch the seat to another tool';
    case 'planner-split-rebase':
      return `ask planner to ${rebaseVerb(context)}`;
    case 'revise':
      return context.reason === 'review-failed'
        ? 'revise · send the findings back with a correction'
        : 'revise · send the planner a correction';
    case 'revise-spec':
      return 'revise the spec · send it back with a note';
    case 'continue':
      return 'continue';
    case 'skip-current-task':
      return 'skip task';
    case 'pause-run':
      return 'pause · no new brief starts, changes kept';
    case 'end-run':
      return 'end run · closes this run, changes kept';
  }
}

/** The words shown by the interactive picker; machine action names stay in the action channel. */
export function recoveryActionLabel(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  switch (action) {
    case 'retry-same-worker':
      return context.seatRetry === undefined
        ? 'Try again'
        : `Try again with ${CREW_SEAT_LABELS[context.seatRetry]}`;
    case 'route-bigger-worker': {
      const profile = recoveryFactString(context.facts, 'routeBiggerProfile');
      return profile === undefined ? 'Use a bigger worker' : `Use a bigger worker · ${profile}`;
    }
    case 'switch-seat': {
      // The seat is the one that halted; a label that cannot name it names no seat at all.
      const seat = context.switchSeat?.seat ?? context.seat;
      return seat === undefined ? 'Change tool' : `Change ${CREW_SEAT_LABELS[seat]} tool`;
    }
    case 'planner-split-rebase':
      return `Ask planner to ${rebaseVerb(context)}`;
    case 'revise':
      return 'Send a correction';
    case 'revise-spec':
      return 'Revise the spec';
    case 'continue':
      return 'Continue';
    case 'skip-current-task':
      return 'Skip task';
    case 'pause-run':
      return 'Pause run';
    case 'end-run':
      return 'End run';
  }
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

function switchSeatRowText(seat: CrewSeatId, candidate: SeatSwapCandidate): string {
  const displayName =
    candidate.model === undefined
      ? undefined
      : resolveModelDisplayName({
          providerId: candidate.tool,
          model: candidate.model,
          role: CREW_SEAT_ROLES[seat],
          cache: modelCacheStore,
        });
  return `switch ${CREW_SEAT_LABELS[seat]} to ${formatSeatCandidateIdentity(candidate, displayName)} · restarts this brief there, edits kept`;
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
      switchSeatRowText(offer.seat, candidate),
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

function rebaseVerb(context: RecoveryActionChoiceContext): string {
  return context.reason === 'user-edit-conflict' || context.reason === 'approval-promotion-conflict'
    ? 'rebase on your edits'
    : 'split/rebase';
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
  context: RecoveryActionChoiceContext = {},
  recommended?: RecoveryAction | undefined,
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
    if (action === 'planner-split-rebase') {
      rows.push({ kind: 'note', text: REBASE_CONTINUATION });
    }
  }
  return rows;
}

export function formatRecoveryActionLines(
  actions: RecoveryAction[],
  context: RecoveryActionChoiceContext = {},
  recommended?: RecoveryAction | undefined,
): string[] {
  return buildRecoveryActionRows(actions, context, recommended).map((row) =>
    row.kind === 'note' || !row.recommended ? row.text : `${recommendedRowPrefix()}${row.text}`,
  );
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
    facts: issue.facts,
    switchSeat: issue.switchSeat,
    seat: issue.seat,
    seatRetry: seatLevelRetrySeat(issue),
  };
  const recommended = resolveRecommendedAction(issue, actions);
  const facts = [
    ...formatSubjectLines(issue),
    ...formatDetailLines(issue),
    ...formatWorkerLines(issue),
  ];

  const rows: PromptRow[] = [
    { kind: 'headline', tone: 'attention', text: formatRecoveryHeader(issue) },
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

export function promptRowsToString(rows: PromptRow[]): string {
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
export function formatRecoveryPromptSummary(issue: RecoveryIssue): string {
  const rows = buildRecoveryPromptRows(issue).filter(
    (row): row is Exclude<PromptRow, { kind: 'action' } | { kind: 'note' }> =>
      row.kind !== 'action' && row.kind !== 'note',
  );
  return promptRowsToString(rows);
}

export function recommendedRecoveryAction(issue: RecoveryIssue): RecoveryAction | undefined {
  return resolveRecommendedAction(issue, getRecoveryPromptActions(issue));
}

export function parseRecoveryActionAnswer(
  input: string,
  issue: RecoveryIssue,
): RecoveryAction | null {
  const actions = getRecoveryPromptActions(issue);
  if (input.length === 0) return resolveRecommendedAction(issue, actions) ?? null;
  // The pause key is the space bar, so whitespace alone is that key press, not an empty answer.
  const trimmed = input.trim();
  const normalized = trimmed.length === 0 ? 'space' : trimmed.toLowerCase();
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
  if (actions.includes('pause-run')) return 'pause-run';
  return actions[0];
}

function formatRecoveryHeader(issue: RecoveryIssue): string {
  const context = formatApiContextHeadline(issue);
  if (context !== undefined) return context;
  const usageLimit = formatUsageLimitHeadline(issue);
  if (usageLimit !== undefined) return usageLimit;
  // The engine's sentence carries the evidence for the headless sinks; here the evidence is the
  // first fact row, so the header names the halt and nothing is said twice.
  if (issue.reason === 'implementer-left-isolation' || issue.reason === 'checkout-changed') {
    return `Recovery needed · ${formatRecoveryHeadline(issue)}`;
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
  return `Recovery needed · ${cause}${attemptSuffix}`;
}

/** The clock the seat comes back on, in the words the header uses — the panel's only spelling of it. */
function resetNote(issue: RecoveryIssue): string | undefined {
  if (issue.resetAt === undefined) return undefined;
  const resetAt = Date.parse(issue.resetAt);
  return Number.isFinite(resetAt) ? formatResetNote(resetAt) : undefined;
}

/**
 * A packet the seat was never given states two things: that no call was made, and why. The seat is
 * named in the word the crew uses for it, so the row is not read as a review that found nothing or
 * a brief that needs repairing. Every figure the refusal compared stays in `/usage`; the message
 * the boundary wrote repeats the missing sections the details already carry, so the panel states
 * the cause once and lets the detail row hold the list.
 */
function formatApiContextHeadline(issue: RecoveryIssue): string | undefined {
  const context = readRecoveryContext(issue);
  if (context === null) return undefined;
  return `Nothing was sent to ${recoveryContextSeatLabel(context)} · ${recoveryContextCauseWords(context)}`;
}

/**
 * A quota halt states three things and no more: that recovery is needed, the tool
 * that ran out, and the clock it comes back on — the same words the header uses,
 * so one instant is never spelled two ways on one screen. The engine's own
 * sentence keeps the advice for the headless sinks; here the action rows are the
 * advice, and the tool's verbatim diagnostic stays in the facts as a quote.
 */
function formatUsageLimitHeadline(issue: RecoveryIssue): string | undefined {
  if (issue.reason !== 'runner-usage-limit') return undefined;
  const tool = recoveryFactString(issue.facts, 'tool');
  if (tool === undefined) return undefined;
  const reset = resetNote(issue);
  return `Usage limit on ${tool}${reset === undefined ? '' : ` · ${reset}`}`;
}

function formatSubjectLines(issue: RecoveryIssue): string[] {
  const lines: string[] = [];
  if (issue.taskId && issue.taskTitle) lines.push(`Task ${issue.taskId} · ${issue.taskTitle}`);
  if (issue.files.length > 0) lines.push(`Files ${formatMiddotList(issue.files, 3)}`);
  const affected = issue.affectedTaskIds.filter((taskId) => taskId !== issue.taskId);
  if (affected.length > 0) lines.push(`Affected ${formatMiddotList(affected, 3)}`);
  return lines;
}

// One instant, one spelling: whichever surface carries the reset clock, the others drop the clause
// rather than restating it in their own words.
const RESET_CLAUSE = /\s*·\s*resets\b[^·]*$/iu;

export function stripRecoveryResetClause(text: string): string {
  return text.replace(RESET_CLAUSE, '');
}

/**
 * The widest halt a builder writes is retry-exhausted: the last error, the attempts, the bigger
 * worker on offer, what the implementer said, what the planner answered, and the planner's
 * verdict. The budget covers all six, so the two voices are never the rows that fall off.
 */
const MAX_DETAIL_LINES = 6;

function formatDetailLines(issue: RecoveryIssue): string[] {
  const dropQuotedReset = resetNote(issue) !== undefined;
  return issue.details
    .filter((detail) => !detail.startsWith('Worker profile:'))
    .slice(0, MAX_DETAIL_LINES)
    .map((detail) => formatDetailLine(detail, issue))
    .map((detail) => (dropQuotedReset ? stripRecoveryResetClause(detail) : detail));
}

function formatDetailLine(detail: string, issue: RecoveryIssue): string {
  if (detail.startsWith('Validation: ')) return `Last check ${detail.slice('Validation: '.length)}`;
  if (detail.startsWith('Validation ')) return `Last check ${detail.slice('Validation '.length)}`;
  if (detail.startsWith('Spent ')) return `Spent ${detail.slice('Spent '.length)}`;
  if (isConflictRecovery(issue)) {
    const conflictSummary = formatConflictSummary(detail, issue);
    if (conflictSummary !== undefined) return conflictSummary;
    const continuation = formatConflictContinuation(detail, issue);
    if (continuation !== undefined) return continuation;
    const fileConflict = formatFileConflictDetail(detail, issue);
    if (fileConflict !== undefined) return fileConflict;
  }
  return detail;
}

function isConflictRecovery(issue: RecoveryIssue): boolean {
  return issue.reason === 'user-edit-conflict' || issue.reason === 'approval-promotion-conflict';
}

function formatConflictSummary(detail: string, issue: RecoveryIssue): string | undefined {
  const prefix = 'Conflict kind: ';
  if (!detail.startsWith(prefix)) return undefined;
  const value = detail.slice(prefix.length);
  const parsed = UserEditConflictKindSchema.safeParse(value);
  const factKind = issue.facts?.conflictKind;
  if (!parsed.success || (factKind !== undefined && factKind !== value)) return undefined;
  return `Edit relation: ${userEditConflictRelation({
    kind: parsed.data,
    affectedTaskIds: issue.affectedTaskIds,
    currentTaskId: issue.taskId,
  })}`;
}

function formatConflictContinuation(detail: string, issue: RecoveryIssue): string | undefined {
  const safeToContinue = recoveryFactBoolean(issue.facts, 'safeToContinue');
  if (safeToContinue === undefined) return undefined;
  const expected = `Safe to continue: ${safeToContinue ? 'yes' : 'no'}`;
  if (detail !== expected) return undefined;
  return safeToContinue ? 'Continuing is safe' : 'Continuing is not safe';
}

function formatFileConflictDetail(detail: string, issue: RecoveryIssue): string | undefined {
  for (const file of issue.files) {
    const prefix = `${file}: `;
    if (!detail.startsWith(prefix)) continue;
    const description = detail.slice(prefix.length);
    for (const kind of UserEditConflictKindSchema.options) {
      if (description === kind) {
        return `${file}: ${userEditConflictRelation({
          kind,
          affectedTaskIds: issue.affectedTaskIds,
          currentTaskId: issue.taskId,
        })}`;
      }
      const affectedPrefix = `${kind} affects `;
      if (!description.startsWith(affectedPrefix)) continue;
      const affectedTaskIds = description.slice(affectedPrefix.length).split(', ');
      if (
        affectedTaskIds.length === 0 ||
        affectedTaskIds.some((id) => !TaskIdSchema.safeParse(id).success)
      ) {
        return undefined;
      }
      return `${file}: ${userEditConflictRelation({
        kind,
        affectedTaskIds,
        currentTaskId: issue.taskId,
      })}`;
    }
  }
  return undefined;
}

function formatWorkerLines(issue: RecoveryIssue): string[] {
  const worker = issue.selectedImplementerProfile;
  if (!worker) return [];
  const contextLength = recoveryFactNumber(issue.facts, 'contextLength');
  const formattedLength = formatContextLength(contextLength) || contextLength;
  return [
    contextLength === undefined
      ? `Worker ${worker}`
      : `Worker ${worker} · ${formattedLength} context`,
  ];
}
