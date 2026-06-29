import type {
  TaskReviewCommand,
  TaskReviewRequest,
  TaskReviewResponse,
} from '../../engine/events/workflow-events.js';
import {
  formatActionRow,
  formatMiddotList,
  type PromptRow,
  promptRowsToString,
} from './recovery-prompt.js';

const COMMAND_LABELS: Record<TaskReviewCommand, string> = {
  continue: 'continue',
  'redo-task': 'redo task',
  'edit-notes': 'notes <text>',
  'revise-plan': 'revise-plan <notes>',
  abort: 'abort',
};

const COMMAND_KEYS: Record<Exclude<TaskReviewCommand, 'edit-notes'>, string> = {
  continue: 'c',
  'redo-task': 'r',
  'revise-plan': 'p',
  abort: 'a',
};

const COMMAND_ALIASES: Record<string, TaskReviewResponse['action']> = {
  c: 'continue',
  continue: 'continue',
  cont: 'continue',
  r: 'redo-task',
  redo: 'redo-task',
  'redo-task': 'redo-task',
  p: 'revise-plan',
  plan: 'revise-plan',
  revise: 'revise-plan',
  'revise-plan': 'revise-plan',
  a: 'abort',
  abort: 'abort',
  q: 'abort',
  quit: 'abort',
};

export function buildTaskReviewPromptRows(request: TaskReviewRequest): PromptRow[] {
  const passed = request.validation.passed === true;
  const headline: PromptRow = passed
    ? {
        kind: 'headline',
        tone: 'pass',
        text: `${request.taskId} ready for review · ${request.taskTitle}`,
      }
    : { kind: 'headline', tone: 'failed', text: `${request.taskId}`, detail: request.taskTitle };
  const facts = [
    `status ${request.status}`,
    `files ${formatList(request.filesTouched)}`,
    `checks ${request.validation.summary}`,
    ...formatCostLines(request),
    ...formatEvidenceLines(request),
    ...formatRoutingLines(request),
    ...formatRecoveryLines(request),
  ];

  const rows: PromptRow[] = [
    headline,
    { kind: 'blank' },
    { kind: 'facts', items: facts, grid: passed },
  ];
  const actionRows = buildTaskReviewCommandRows(request.availableCommands);
  if (actionRows.length > 0) rows.push({ kind: 'blank' }, ...actionRows);
  return rows;
}

export function formatTaskReviewPrompt(request: TaskReviewRequest): string {
  return promptRowsToString(buildTaskReviewPromptRows(request));
}

export function parseTaskReviewAnswer(
  input: string,
  availableCommands?: readonly TaskReviewCommand[] | undefined,
): TaskReviewResponse | null {
  const trimmed = input.trim();
  if (!trimmed) return taskReviewResponseAllowed({ action: 'continue' }, availableCommands);

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('notes ') || lower.startsWith('note ') || lower.startsWith('edit ')) {
    return taskReviewResponseAllowed(
      { action: 'continue', notes: trimmed.slice(trimmed.indexOf(' ') + 1).trim() },
      availableCommands,
    );
  }
  if (
    lower.startsWith('revise-plan ') ||
    lower.startsWith('revise ') ||
    lower.startsWith('plan ')
  ) {
    return taskReviewResponseAllowed(
      { action: 'revise-plan', notes: trimmed.slice(trimmed.indexOf(' ') + 1).trim() },
      availableCommands,
    );
  }

  const action = COMMAND_ALIASES[lower];
  return action ? taskReviewResponseAllowed({ action }, availableCommands) : null;
}

export function taskReviewResponseAllowed(
  response: TaskReviewResponse,
  availableCommands?: readonly TaskReviewCommand[] | undefined,
): TaskReviewResponse | null {
  if (availableCommands === undefined) return response;
  const available = new Set<TaskReviewCommand>(availableCommands);
  if (response.notes !== undefined && response.action === 'continue') {
    return available.has('edit-notes') ? response : null;
  }
  return available.has(response.action) ? response : null;
}

function formatEvidenceLines(request: TaskReviewRequest): string[] {
  const lines = [`evidence ${request.evidence.summary}`];
  if (request.evidence.path) lines.push(`evidence path ${request.evidence.path}`);
  return lines;
}

function formatCostLines(request: TaskReviewRequest): string[] {
  const taskTokens = request.cost.taskTokens;
  const tokenText = taskTokens
    ? `${taskTokens.implementerTokens} implementer, ${taskTokens.escalationTokens} escalation`
    : `${request.cost.tokenUsage.implementerInput + request.cost.tokenUsage.implementerOutput} implementer total`;
  const worker = [request.cost.tool, request.cost.model, request.cost.implementerProfile]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' / ');
  return [`cost ${tokenText}${worker ? ` · ${worker}` : ''}`];
}

function formatRoutingLines(request: TaskReviewRequest): string[] {
  const routing = request.routing;
  if (!routing) return [];
  const context =
    routing.contextLength === undefined
      ? `${routing.estimatedTokens} tokens`
      : `${routing.estimatedTokens}/${routing.contextLength} tokens`;
  return [`route ${routing.fit} ${context} · ${routing.reason}`];
}

function formatRecoveryLines(request: TaskReviewRequest): string[] {
  if (!request.recovery) return [];
  return [
    `recovery ${request.recovery.reason} · ${request.recovery.message}`,
    `recovery actions ${request.recovery.availableActions.join(' · ')}`,
  ];
}

function formatList(values: string[], max = 4): string {
  if (values.length === 0) return 'none';
  return formatMiddotList(values, max);
}

function buildTaskReviewCommandRows(commands: readonly TaskReviewCommand[]): PromptRow[] {
  const rows: PromptRow[] = [];
  for (const command of commands) {
    if (command === 'edit-notes') {
      rows.push({ kind: 'note', text: 'type notes <text> to continue with notes' });
      continue;
    }
    rows.push({
      kind: 'action' as const,
      text: formatActionRow(COMMAND_KEYS[command], COMMAND_LABELS[command]),
      recommended: command === 'continue',
    });
  }
  return rows;
}
