import { formatToolModel } from '../../../core/model-display.js';
import { formatDuration } from '../../../utils/format-time.js';
import type {
  ActiveOperation,
  OperationStatus,
  OperationWarningGroup,
} from '../../../stores/workflow/operations.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
} from '../../../utils/display-text.js';
import { assertNever } from '../../../utils/type-guards.js';
import { glyph } from '../../../lib/glyphs.js';

export type RunnerTerminalTone = 'info' | 'success' | 'warning' | 'error' | 'textDim';
export type RunnerOperationLineSegmentRole = 'role' | 'status' | 'dim';

type OperationMarker = string;
type TerminalOperation = Exclude<ActiveOperation, { status: 'running' }>;

export interface RunnerOperationStatusDisplay {
  label: string | null;
  marker: OperationMarker;
  tone: RunnerTerminalTone;
  showDiagnosticPreview: boolean;
}

export interface RunnerOperationLineSegment {
  text: string;
  role: RunnerOperationLineSegmentRole;
  tone?: RunnerTerminalTone;
  bold?: boolean;
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
        marker: glyph('check'),
        tone: 'success',
        showDiagnosticPreview: false,
      };
    case 'cancelled':
      return {
        label: 'cancelled',
        marker: glyph('statusCancelled'),
        tone: 'warning',
        showDiagnosticPreview: false,
      };
    case 'aborted':
      return {
        label: 'interrupted',
        marker: glyph('statusCancelled'),
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

export function runnerTerminalOperationLine(
  operation: TerminalOperation,
  maxCells?: number,
): RunnerOperationLineSegment[] {
  const statusDisplay = runnerOperationStatusDisplay(operation.status);
  const warning = operationWarningDisplay(operation);
  const statusLabel = statusDisplay.label;
  const fixedSegments: RunnerOperationLineSegment[] = [
    { text: operation.role, role: 'role' },
    {
      text: ` ${statusDisplay.marker}${statusLabel ? ` ${statusLabel}` : ''}`,
      role: 'status',
      tone: statusDisplay.tone,
    },
    { text: ` ${operation.phase}`, role: 'role', bold: true },
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
  return sanitizeTerminalDisplayText(text)
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
  const phase = fixedSegments[2];
  const duration = fixedSegments[3];
  if (role === undefined || status === undefined || phase === undefined || duration === undefined)
    return fixedSegments;

  const segments: RunnerOperationLineSegment[] = [role, status, phase, duration];
  if (reason) segments.push({ text: reason, role: 'dim' });
  const tail = fixedSegments.slice(4);
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

function operationWarningDisplay(
  operation: TerminalOperation,
): { count: string; preview: string | null } | null {
  const warnings = operationWarningCount(operation.warnings);
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
  if (latest === undefined || latest.latestMessage.length === 0) return null;
  return truncateTerminalDisplayText(
    cleanRunnerDisplayText(latest.latestMessage),
    DEFAULT_DIAGNOSTIC_PREVIEW_MAX_CELLS,
  );
}

function operationWarningCount(warnings: readonly OperationWarningGroup[]): number {
  return warnings.reduce((count, warning) => count + warning.count, 0);
}

function failureStatusDisplay(label: string): RunnerOperationStatusDisplay {
  return {
    label,
    marker: '!',
    tone: 'error',
    showDiagnosticPreview: true,
  };
}
