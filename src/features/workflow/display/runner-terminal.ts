import { formatToolModel } from '../../../core/model-display.js';
import { formatDuration } from '../../../utils/format-time.js';
import type { WorkflowActivityItem } from '../../../stores/workflow/activity.js';
import type { ActiveOperation, OperationStatus } from '../../../stores/workflow/operations.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { assertNever } from '../../../utils/type-guards.js';
import { sanitizeWorkflowDisplayText } from './safe-text.js';

export type RunnerTerminalTone = 'info' | 'success' | 'warning' | 'error' | 'textDim';
export type RunnerOperationLineSegmentRole = 'role' | 'status' | 'dim';

type OperationMarker = '✓' | '×' | '!' | '-';
type ActivityMarker = '*' | '+' | '!' | 'x';
type TerminalOperation = Exclude<ActiveOperation, { status: 'running' }>;

export interface RunnerOperationStatusDisplay {
  label: string | null;
  marker: OperationMarker;
  tone: RunnerTerminalTone;
  showDiagnosticPreview: boolean;
}

export interface RunnerActivityDisplay {
  label: string;
  value: string | null;
  diagnosticPreview: string | null;
  marker: ActivityMarker;
  tone: RunnerTerminalTone;
  valueTone: RunnerTerminalTone;
}

export interface RunnerOperationLineSegment {
  text: string;
  role: RunnerOperationLineSegmentRole;
  tone?: RunnerTerminalTone;
}

interface RunnerActivityDisplayInput {
  stage: WorkflowActivityItem['stage'];
  kind: WorkflowActivityItem['kind'];
  label: string;
  target?: string | undefined;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
}

const DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS = 80;
const TOOL_SUFFIX_MAX_CELLS = 28;
const INTERNAL_RUNNER_INTERRUPTED_PATTERN = /\brunner_interrupted\b/g;

export function runnerOperationStatusDisplay(
  status: OperationStatus,
): RunnerOperationStatusDisplay {
  switch (status) {
    case 'completed':
      return {
        label: null,
        marker: '✓',
        tone: 'success',
        showDiagnosticPreview: false,
      };
    case 'cancelled':
      return {
        label: 'cancelled',
        marker: '×',
        tone: 'warning',
        showDiagnosticPreview: false,
      };
    case 'aborted':
      return {
        label: 'interrupted',
        marker: '×',
        tone: 'warning',
        showDiagnosticPreview: true,
      };
    case 'failed':
      return failureStatusDisplay('failed');
    case 'truncated':
      return failureStatusDisplay('truncated');
    case 'timeout':
      return failureStatusDisplay('timeout');
    case 'refused':
      return failureStatusDisplay('refused');
    case 'unsupported_tool':
      return failureStatusDisplay('unsupported tool');
    case 'incomplete':
      return failureStatusDisplay('incomplete');
    case 'running':
      return {
        label: null,
        marker: '-',
        tone: 'textDim',
        showDiagnosticPreview: false,
      };
    default:
      return assertNever(status);
  }
}

export function runnerActivityDisplay(
  item: RunnerActivityDisplayInput,
  diagnosticMaxCells = DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS,
): RunnerActivityDisplay {
  const stage = runnerActivityStageDisplay(item.stage);
  const interrupted = item.stage === 'aborted';
  return {
    label: interrupted ? 'interrupted' : activityKindLabel(item.kind),
    value: interrupted ? null : cleanRunnerDisplayText(item.target ?? item.label),
    diagnosticPreview: runnerActivityDiagnosticPreview(item, diagnosticMaxCells),
    marker: stage.marker,
    tone: stage.tone,
    valueTone: stage.valueTone,
  };
}

export function runnerActivityDiagnosticPreview(
  item: RunnerActivityDisplayInput,
  maxCells = DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS,
): string | null {
  if (!isDiagnosticActivity(item)) return null;

  const source = item.diagnosticPartial ?? item.textPartial;
  if (source === undefined) return null;

  const clean = cleanRunnerDisplayText(source);
  if (clean.length === 0) return null;

  return truncateTerminalDisplayText(clean, maxCells);
}

export function runnerTerminalOperationLine(
  operation: TerminalOperation,
  maxCells?: number,
): RunnerOperationLineSegment[] {
  const statusDisplay = runnerOperationStatusDisplay(operation.status);
  const warning = operationWarningDisplay(operation);
  const fixedSegments: RunnerOperationLineSegment[] = [
    { text: operation.role, role: 'role' },
    {
      text: ` ${statusDisplay.marker} ${terminalHeadline(operation, statusDisplay)}`,
      role: 'status',
      tone: statusDisplay.tone,
    },
    { text: ` ${formatDuration(operation.durationMs)}`, role: 'dim' },
    ...(warning ? [{ text: ` ${warning.count}`, role: 'dim' as const }] : []),
    ...(operation.partial ? [{ text: ' partial output', role: 'dim' as const }] : []),
    ...toolSuffixSegments(operation, maxCells),
  ];

  const reason = operation.reason ? ` ${cleanRunnerDisplayText(operation.reason)}` : null;
  const warningPreview = warning?.preview ? `: ${warning.preview}` : null;

  if (maxCells === undefined) {
    return insertFlexibleSegments(fixedSegments, reason, warningPreview);
  }

  const optionalBudget = Math.max(0, maxCells - segmentCells(fixedSegments));
  const { fittedReason, fittedWarningPreview } = fitFlexibleTerminalSegments({
    reason,
    warningPreview,
    maxCells: optionalBudget,
  });

  return insertFlexibleSegments(fixedSegments, fittedReason, fittedWarningPreview);
}

export function cleanRunnerDisplayText(text: string): string {
  return sanitizeWorkflowDisplayText(text)
    .replace(INTERNAL_RUNNER_INTERRUPTED_PATTERN, 'interrupted')
    .replace(/\s+/g, ' ')
    .trim();
}

function insertFlexibleSegments(
  fixedSegments: RunnerOperationLineSegment[],
  reason: string | null,
  warningPreview: string | null,
): RunnerOperationLineSegment[] {
  const role = fixedSegments[0];
  const status = fixedSegments[1];
  const duration = fixedSegments[2];
  if (role === undefined || status === undefined || duration === undefined) return fixedSegments;

  const segments: RunnerOperationLineSegment[] = [role, status, duration];
  if (reason) segments.push({ text: reason, role: 'dim' });
  const tail = fixedSegments.slice(3);
  if (tail.length === 0) return segments;

  const [firstTail, ...restTail] = tail;
  if (firstTail === undefined) return segments;
  segments.push(firstTail);
  if (warningPreview && firstTail.text.includes('warning')) {
    segments.push({ text: warningPreview, role: 'dim' });
  }
  segments.push(...restTail);
  return segments;
}

function fitFlexibleTerminalSegments(input: {
  reason: string | null;
  warningPreview: string | null;
  maxCells: number;
}): { fittedReason: string | null; fittedWarningPreview: string | null } {
  const reasonCells = input.reason ? getTerminalCellWidth(input.reason) : 0;
  const warningCells = input.warningPreview ? getTerminalCellWidth(input.warningPreview) : 0;
  if (reasonCells + warningCells <= input.maxCells) {
    return {
      fittedReason: input.reason,
      fittedWarningPreview: input.warningPreview,
    };
  }

  if (input.maxCells <= 0) return { fittedReason: null, fittedWarningPreview: null };

  if (input.reason && input.warningPreview) {
    const warningBudget = Math.min(warningCells, input.maxCells);
    const reasonBudget = input.maxCells - warningBudget;
    return {
      fittedReason: fitOptionalTerminalSegment(input.reason, reasonBudget),
      fittedWarningPreview: fitOptionalTerminalSegment(input.warningPreview, warningBudget),
    };
  }

  return {
    fittedReason: input.reason ? fitOptionalTerminalSegment(input.reason, input.maxCells) : null,
    fittedWarningPreview: input.warningPreview
      ? fitOptionalTerminalSegment(input.warningPreview, input.maxCells)
      : null,
  };
}

function fitOptionalTerminalSegment(segment: string, maxCells: number): string | null {
  if (maxCells <= 1) return null;
  return truncateTerminalDisplayText(segment, maxCells);
}

function segmentCells(segments: readonly RunnerOperationLineSegment[]): number {
  return segments.reduce((cells, segment) => cells + getTerminalCellWidth(segment.text), 0);
}

function toolSuffixSegments(
  operation: TerminalOperation,
  maxCells: number | undefined,
): RunnerOperationLineSegment[] {
  const model = operation.model === 'default' ? undefined : operation.model;
  const tool = cleanRunnerDisplayText(formatToolModel(operation.runnerName, model));
  if (tool.length === 0) return [];

  const toolCells =
    maxCells === undefined ? undefined : Math.min(TOOL_SUFFIX_MAX_CELLS, Math.max(1, maxCells - 2));
  const fittedTool = toolCells === undefined ? tool : truncateTerminalDisplayText(tool, toolCells);
  return [{ text: ` [${fittedTool}]`, role: 'dim' }];
}

function terminalHeadline(
  operation: TerminalOperation,
  statusDisplay: RunnerOperationStatusDisplay,
): string {
  return statusDisplay.label ? `${statusDisplay.label} ${operation.phase}` : operation.phase;
}

function operationWarningDisplay(
  operation: TerminalOperation,
): { count: string; preview: string | null } | null {
  const warnings = operation.warnings.length;
  if (warnings === 0) return null;

  return {
    count: warningCountLabel(warnings),
    preview: latestActionableWarningPreview(operation),
  };
}

function warningCountLabel(count: number): string {
  return count === 1 ? '1 warning' : `${count} warnings`;
}

function latestActionableWarningPreview(operation: TerminalOperation): string | null {
  if (!runnerOperationStatusDisplay(operation.status).showDiagnosticPreview) return null;

  const latest = operation.warnings.at(-1);
  if (latest === undefined || latest.length === 0) return null;
  return truncateTerminalDisplayText(
    cleanRunnerDisplayText(latest),
    DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS,
  );
}

function failureStatusDisplay(label: string): RunnerOperationStatusDisplay {
  return {
    label,
    marker: '!',
    tone: 'error',
    showDiagnosticPreview: true,
  };
}

function runnerActivityStageDisplay(stage: WorkflowActivityItem['stage']): {
  marker: ActivityMarker;
  tone: RunnerTerminalTone;
  valueTone: RunnerTerminalTone;
} {
  switch (stage) {
    case 'started':
    case 'updated':
      return { marker: '*', tone: 'info', valueTone: 'textDim' };
    case 'completed':
      return { marker: '+', tone: 'success', valueTone: 'textDim' };
    case 'warning':
    case 'aborted':
      return { marker: '!', tone: 'warning', valueTone: 'warning' };
    case 'failed':
    case 'timeout':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return { marker: 'x', tone: 'error', valueTone: 'error' };
    default:
      return assertNever(stage);
  }
}

function activityKindLabel(kind: WorkflowActivityItem['kind']): string {
  switch (kind) {
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    case 'command':
      return 'run';
    case 'read':
      return 'read';
    case 'write':
    case 'edit':
      return 'edit';
    case 'search':
    case 'glob':
      return 'search';
    case 'web':
    case 'mcp':
      return 'call';
    case 'tool':
    case 'file':
    case 'text':
    case 'task':
    case 'plan':
    case 'session':
    case 'artifact':
    case 'unknown':
      return kind;
    default:
      return assertNever(kind);
  }
}

function isDiagnosticActivity(item: RunnerActivityDisplayInput): boolean {
  if (item.kind === 'warning' || item.kind === 'error') return true;

  switch (item.stage) {
    case 'warning':
    case 'aborted':
    case 'failed':
    case 'timeout':
    case 'truncated':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return true;
    case 'started':
    case 'updated':
    case 'completed':
      return false;
    default:
      return assertNever(item.stage);
  }
}
