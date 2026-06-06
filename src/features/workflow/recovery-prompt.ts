import type { RecoveryAction, RecoveryReason } from '../../core/schemas/enums.js';
import type { RecoveryFact, RecoveryIssue } from '../../core/schemas/recovery.js';
import { recoveryFactNumber, recoveryFactString } from '../../core/schemas/recovery.js';
import { formatTruncatedList } from '../../core/formatting.js';
import { pluralize } from '../../utils/pluralize.js';
import { assertNever } from '../../utils/type-guards.js';

const ACTION_ORDER: RecoveryAction[] = [
  'retry-same-worker',
  'route-bigger-worker',
  'continue',
  'skip-current-task',
  'pause-run',
  'abort-workflow',
];

const ACTION_KEYS: Record<RecoveryAction, string> = {
  'retry-same-worker': 'r',
  'route-bigger-worker': 'b',
  'planner-split-rebase': 'p',
  continue: 'c',
  'skip-current-task': 's',
  'pause-run': 'space',
  'abort-workflow': 'a',
};

const ACTION_ALIASES: Record<RecoveryAction, string[]> = {
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

export function formatRecoveryActionText(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  switch (action) {
    case 'retry-same-worker':
      return 'retry same worker';
    case 'route-bigger-worker': {
      const profile = recoveryFactString(context.facts, 'routeBiggerProfile');
      return profile ? `route to bigger worker: ${profile}` : 'route to bigger worker';
    }
    case 'planner-split-rebase': {
      const verb =
        context.reason === 'user-edit-conflict' || context.reason === 'approval-promotion-conflict'
          ? 'rebase on your edits'
          : 'split/rebase';
      return `ask planner to ${verb} (approve/edit/reject proposal)`;
    }
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

export function formatRecoveryActionChoice(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  return `[${ACTION_KEYS[action]}] ${formatRecoveryActionText(action, context)}`;
}

export function formatRecoveryPrompt(issue: RecoveryIssue): string {
  const actions = getRecoveryPromptActions(issue);
  const recommended = recommendedAction(issue, actions);
  const context: RecoveryActionChoiceContext = { reason: issue.reason, facts: issue.facts };
  const lines = [
    formatRecoveryHeader(issue),
    ...formatSubjectLines(issue),
    ...formatDetailLines(issue),
    ...formatWorkerLines(issue),
    `Recommended: ${formatRecoveryActionText(recommended, context)}`,
    '',
    ...actions.map((action) => formatRecoveryActionChoice(action, context)),
  ];

  return lines
    .filter((line, index) => line.length > 0 || lines[index - 1] !== '')
    .join('\n')
    .trimEnd();
}

export function parseRecoveryActionAnswer(input: string, issue: RecoveryIssue): RecoveryAction {
  const actions = getRecoveryPromptActions(issue);
  const normalized = input.trim().toLowerCase();
  const action =
    input.length > 0 && input.trim().length === 0 ? 'pause-run' : findAliasedAction(normalized);

  if (action && actions.includes(action)) return action;
  return fallbackAction(issue, actions);
}

function findAliasedAction(value: string): RecoveryAction | undefined {
  for (const action of ACTION_ORDER) {
    if (ACTION_ALIASES[action].includes(value)) return action;
  }
  return undefined;
}

function fallbackAction(issue: RecoveryIssue, actions: RecoveryAction[]): RecoveryAction {
  if (actions.includes('pause-run')) return 'pause-run';
  const recommended = recommendedAction(issue, actions);
  return actions.includes(recommended) ? recommended : (actions[0] ?? 'pause-run');
}

function recommendedAction(issue: RecoveryIssue, actions: RecoveryAction[]): RecoveryAction {
  if (actions.includes(issue.recommendedAction)) return issue.recommendedAction;
  if (actions.includes('pause-run')) return 'pause-run';
  return actions[0] ?? issue.recommendedAction;
}

function formatRecoveryHeader(issue: RecoveryIssue): string {
  const attemptSuffix =
    issue.attempts !== undefined
      ? ` after ${issue.attempts} ${pluralize(issue.attempts, 'attempt')}`
      : '';
  return `Recovery needed: ${issue.message}${attemptSuffix}`;
}

function formatSubjectLines(issue: RecoveryIssue): string[] {
  const lines: string[] = [];
  if (issue.taskId && issue.taskTitle) lines.push(`Task: ${issue.taskId} - ${issue.taskTitle}`);
  if (issue.files.length > 0) lines.push(`Files: ${formatTruncatedList(issue.files, 3)}`);
  const affected = issue.affectedTaskIds.filter((taskId) => taskId !== issue.taskId);
  if (affected.length > 0) lines.push(`Affected tasks: ${formatTruncatedList(affected, 3)}`);
  return lines;
}

function formatDetailLines(issue: RecoveryIssue): string[] {
  return issue.details
    .filter((detail) => !detail.startsWith('Worker profile:'))
    .slice(0, 4)
    .map(formatDetailLine);
}

function formatDetailLine(detail: string): string {
  if (detail.startsWith('Validation: '))
    return `Last check: ${detail.slice('Validation: '.length)}`;
  if (detail.startsWith('Validation ')) return `Last check: ${detail.slice('Validation '.length)}`;
  if (detail.startsWith('Spent ')) return `Spent: ${detail.slice('Spent '.length)}`;
  return detail;
}

function formatWorkerLines(issue: RecoveryIssue): string[] {
  const worker = issue.selectedImplementerProfile;
  if (!worker) return [];
  const contextLength = recoveryFactNumber(issue.facts, 'contextLength');
  return [
    contextLength === undefined
      ? `Worker: ${worker}`
      : `Worker: ${worker} (${contextLength} context)`,
  ];
}
