import type { RecoveryAction, RecoveryReason } from '../../core/schemas/enums.js';
import { PROMPTABLE_RECOVERY_ACTIONS } from '../../core/schemas/enums.js';
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
import { recoveryFactNumber, recoveryFactString } from '../../core/schemas/recovery/facts.js';
import { countNoun } from '../../utils/pluralize.js';
import { glyph } from '../../lib/glyphs.js';
import { formatSeatResetNote } from './seat-reset.js';

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

const ACTION_KEYS: Record<RecoveryAction, string> = {
  'retry-same-worker': 'r',
  'route-bigger-worker': 'b',
  'switch-seat': 'w',
  'planner-split-rebase': 'p',
  continue: 'c',
  'skip-current-task': 's',
  'pause-run': 'space',
  'abort-workflow': 'a',
};

export const ACTION_ALIASES: Record<RecoveryAction, string[]> = {
  'retry-same-worker': ['r', 'retry', 'retry same worker', 'retry-same-worker'],
  'route-bigger-worker': ['b', 'bigger', 'route', 'route bigger', 'route-bigger-worker'],
  'switch-seat': ['w', 'switch', 'switch seat', 'switch-seat'],
  'planner-split-rebase': [],
  continue: ['c', 'continue', 'cont'],
  'skip-current-task': ['s', 'skip', 'skip task', 'skip-current-task'],
  'pause-run': ['space', 'pause', 'pause run', 'pause-run'],
  'abort-workflow': ['a', 'abort', 'quit', 'q', 'abort-workflow'],
};

/** The numbered form of the seat key, as the prompt prints it for a second and third offer. */
const SWITCH_SEAT_ROW_KEY = new RegExp(`^${ACTION_KEYS['switch-seat']}([1-9][0-9]?)$`);

export interface RecoveryActionChoiceContext {
  reason?: RecoveryReason | undefined;
  facts?: Record<string, RecoveryFact> | undefined;
  switchSeat?: SwitchSeatOffer | undefined;
}

export function getRecoveryPromptActions(issue: RecoveryIssue): RecoveryAction[] {
  const allowed = new Set(issue.availableActions);
  if (issue.reason === 'budget-exceeded') allowed.delete('continue');
  return ACTION_ORDER.filter((action) => allowed.has(action));
}

function formatRecoveryActionText(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  switch (action) {
    case 'retry-same-worker':
      return 'retry same worker';
    case 'route-bigger-worker': {
      const profile = recoveryFactString(context.facts, 'routeBiggerProfile');
      return profile ? `route to bigger worker · ${profile}` : 'route to bigger worker';
    }
    case 'switch-seat':
      return 'switch the seat to another tool';
    case 'planner-split-rebase':
      return `ask planner to ${rebaseVerb(context)}`;
    case 'continue':
      return 'continue';
    case 'skip-current-task':
      return 'skip task';
    case 'pause-run':
      return 'pause';
    case 'abort-workflow':
      return 'abort';
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
  return `switch ${CREW_SEAT_LABELS[seat]} to ${formatSeatCandidateIdentity(candidate)}`;
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
  const offered = offeredSeatSwapCandidates(offer);
  const match = SWITCH_SEAT_ROW_KEY.exec(input.trim().toLowerCase());
  if (match?.[1] === undefined) return offered[0];
  return offered[Number.parseInt(match[1], 10) - 1];
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
  const visible = values.slice(0, max).join(' · ');
  const hidden = values.length - max;
  return hidden > 0 ? `${visible} · ${hidden} more` : visible;
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

function buildRecoveryPromptRows(issue: RecoveryIssue): PromptRow[] {
  const actions = getRecoveryPromptActions(issue);
  const context: RecoveryActionChoiceContext = {
    reason: issue.reason,
    facts: issue.facts,
    switchSeat: issue.switchSeat,
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
  const offered = offeredSeatSwapCandidates(issue.switchSeat);
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
  const usageLimit = formatUsageLimitHeadline(issue);
  if (usageLimit !== undefined) return usageLimit;
  // "T003 validation failed" takes "after 3 attempts"; a message that already
  // ends a sentence would read it as part of that sentence ("or abort after 2
  // attempts"), so it keeps its full stop and the attempt count stays in the
  // facts, where the issue's own `Attempts: n/m` detail already carries it.
  const attemptSuffix =
    issue.attempts !== undefined && !issue.message.endsWith('.')
      ? ` after ${countNoun(issue.attempts, 'attempt')}`
      : '';
  return `recovery needed · ${issue.message}${attemptSuffix}`;
}

/** The clock the seat comes back on, in the words the header uses — the panel's only spelling of it. */
function resetNote(issue: RecoveryIssue): string | undefined {
  if (issue.resetAt === undefined) return undefined;
  const resetAt = Date.parse(issue.resetAt);
  return Number.isFinite(resetAt) ? formatSeatResetNote(resetAt) : undefined;
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
  return `recovery needed · ${tool} hit its limit${reset === undefined ? '' : ` · ${reset}`}`;
}

function formatSubjectLines(issue: RecoveryIssue): string[] {
  const lines: string[] = [];
  if (issue.taskId && issue.taskTitle) lines.push(`task ${issue.taskId} · ${issue.taskTitle}`);
  if (issue.files.length > 0) lines.push(`files ${formatMiddotList(issue.files, 3)}`);
  const affected = issue.affectedTaskIds.filter((taskId) => taskId !== issue.taskId);
  if (affected.length > 0) lines.push(`affected ${formatMiddotList(affected, 3)}`);
  return lines;
}

function formatDetailLines(issue: RecoveryIssue): string[] {
  return issue.details
    .filter((detail) => !detail.startsWith('Worker profile:'))
    .slice(0, 4)
    .map(formatDetailLine);
}

function formatDetailLine(detail: string): string {
  if (detail.startsWith('Validation: ')) return `last check ${detail.slice('Validation: '.length)}`;
  if (detail.startsWith('Validation ')) return `last check ${detail.slice('Validation '.length)}`;
  if (detail.startsWith('Spent ')) return `spent ${detail.slice('Spent '.length)}`;
  return detail;
}

function formatWorkerLines(issue: RecoveryIssue): string[] {
  const worker = issue.selectedImplementerProfile;
  if (!worker) return [];
  const contextLength = recoveryFactNumber(issue.facts, 'contextLength');
  return [
    contextLength === undefined
      ? `worker ${worker}`
      : `worker ${worker} · ${contextLength} context`,
  ];
}
