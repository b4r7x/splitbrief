import type {
  TaskReviewCommand,
  TaskReviewRequest,
  TaskReviewResponse,
} from '../../engine/events/workflow-events.js';
import { formatTruncatedList } from '../../core/formatting.js';

const COMMAND_LABELS: Record<TaskReviewCommand, string> = {
  continue: 'continue',
  'redo-task': 'redo',
  'edit-notes': 'notes <text>',
  'revise-plan': 'revise-plan <notes>',
  abort: 'abort',
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

export function formatTaskReviewPrompt(request: TaskReviewRequest): string {
  const lines = [
    `Task review: ${request.taskId} - ${request.taskTitle}`,
    `Status: ${request.status}`,
    `Files: ${formatList(request.filesTouched)}`,
    `Validation: ${request.validation.summary}`,
    ...formatEvidenceLines(request),
    ...formatCostLines(request),
    ...formatRoutingLines(request),
    ...formatRecoveryLines(request),
    '',
    `Commands: ${formatTaskReviewCommands(request.availableCommands)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function parseTaskReviewAnswer(input: string): TaskReviewResponse | null {
  const trimmed = input.trim();
  if (!trimmed) return { action: 'continue' };

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('notes ') || lower.startsWith('note ') || lower.startsWith('edit ')) {
    return { action: 'continue', notes: trimmed.slice(trimmed.indexOf(' ') + 1).trim() };
  }
  if (
    lower.startsWith('revise-plan ') ||
    lower.startsWith('revise ') ||
    lower.startsWith('plan ')
  ) {
    return { action: 'revise-plan', notes: trimmed.slice(trimmed.indexOf(' ') + 1).trim() };
  }

  const action = COMMAND_ALIASES[lower];
  return action ? { action } : null;
}

function formatEvidenceLines(request: TaskReviewRequest): string[] {
  const lines = [`Evidence: ${request.evidence.summary}`];
  if (request.evidence.path) lines.push(`Evidence path: ${request.evidence.path}`);
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
  return [`Cost/routing: ${tokenText}${worker ? ` (${worker})` : ''}`];
}

function formatRoutingLines(request: TaskReviewRequest): string[] {
  const routing = request.routing;
  if (!routing) return [];
  const context =
    routing.contextLength === undefined
      ? `${routing.estimatedTokens} tokens`
      : `${routing.estimatedTokens}/${routing.contextLength} tokens`;
  return [`Route: ${routing.fit} ${context} - ${routing.reason}`];
}

function formatRecoveryLines(request: TaskReviewRequest): string[] {
  if (!request.recovery) return [];
  return [
    `Recovery: ${request.recovery.reason} - ${request.recovery.message}`,
    `Recovery actions: ${request.recovery.availableActions.join(', ')}`,
  ];
}

function formatList(values: string[], max = 4): string {
  if (values.length === 0) return 'none';
  return formatTruncatedList(values, max);
}

function formatTaskReviewCommands(commands: readonly TaskReviewCommand[]): string {
  return commands.map((command) => COMMAND_LABELS[command]).join(', ');
}
