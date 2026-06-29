import type { RecoveryAction, RecoveryReason } from '../../core/schemas/enums.js';
import { PROMPTABLE_RECOVERY_ACTIONS } from '../../core/schemas/enums.js';
import type { RecoveryFact, RecoveryIssue } from '../../core/schemas/recovery.js';
import { recoveryFactNumber, recoveryFactString } from '../../core/schemas/recovery.js';
import { countNoun } from '../../utils/pluralize.js';
import { glyph } from '../../lib/glyphs.js';
import { assertNever } from '../../utils/type-guards.js';

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
  'planner-split-rebase': 'p',
  continue: 'c',
  'skip-current-task': 's',
  'pause-run': 'space',
  'abort-workflow': 'a',
};

export const ACTION_ALIASES: Record<RecoveryAction, string[]> = {
  'retry-same-worker': ['r', 'retry', 'retry same worker', 'retry-same-worker'],
  'route-bigger-worker': ['b', 'bigger', 'route', 'route bigger', 'route-bigger-worker'],
  'planner-split-rebase': [],
  continue: ['c', 'continue', 'cont'],
  'skip-current-task': ['s', 'skip', 'skip task', 'skip-current-task'],
  'pause-run': ['space', 'pause', 'pause run', 'pause-run'],
  'abort-workflow': ['a', 'abort', 'quit', 'q', 'abort-workflow'],
};

export interface RecoveryActionChoiceContext {
  reason?: RecoveryReason | undefined;
  facts?: Record<string, RecoveryFact> | undefined;
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
    default:
      return assertNever(action);
  }
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
    if (action === 'planner-split-rebase') {
      rows.push({
        kind: 'action',
        text: formatActionRow(ACTION_KEYS[action], `ask planner to ${rebaseVerb(context)}`),
        recommended: action === recommended,
      });
      rows.push({ kind: 'note', text: REBASE_CONTINUATION });
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

export function formatRecoveryActionLines(
  actions: RecoveryAction[],
  context: RecoveryActionChoiceContext = {},
  recommended?: RecoveryAction | undefined,
): string[] {
  return buildRecoveryActionRows(actions, context, recommended).map((row) =>
    row.kind === 'note' || !row.recommended ? row.text : `${recommendedRowPrefix()}${row.text}`,
  );
}

export function buildRecoveryPromptRows(issue: RecoveryIssue): PromptRow[] {
  const actions = getRecoveryPromptActions(issue);
  const context: RecoveryActionChoiceContext = { reason: issue.reason, facts: issue.facts };
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
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) {
    return actions.includes('pause-run') ? 'pause-run' : null;
  }
  const action =
    normalized.length === 0 ? 'pause-run' : findAliasedActionAmong(normalized, actions);
  return action ?? null;
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
  const attemptSuffix =
    issue.attempts !== undefined ? ` after ${countNoun(issue.attempts, 'attempt')}` : '';
  return `recovery needed · ${issue.message}${attemptSuffix}`;
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
