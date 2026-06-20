import { Box, Text } from 'ink';
import { formatTokensShort } from '../../../../core/formatting.js';
import { formatToolModel } from '../../../../core/model-display.js';
import { Spinner } from '../../../../components/spinner.js';
import { useTheme, type Theme } from '../../../../components/theme.js';
import { formatDuration } from '../../../../utils/format-time.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
} from '../../../../utils/display-text.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import type {
  ActiveOperation,
  OperationRole,
  OperationStatus,
} from '../../../../stores/workflow/operations.js';

type PlannerHeartbeat = EngineEventOf<'planner_heartbeat'>;

const WARNING_PREVIEW_MAX_CELLS = 80;
const RUNNING_SEGMENT_SEPARATOR = ' · ';
const SPINNER_PREFIX_CELLS = 2;
const LEGACY_PLANNER_STATUS_PREFIX = 'planner-status:';

interface OperationStatusCardProps {
  operation: ActiveOperation;
  plannerHeartbeat?: PlannerHeartbeat | undefined;
  chrome?: boolean | undefined;
  width?: number | undefined;
}

export function OperationStatusCard({
  operation,
  plannerHeartbeat,
  chrome = false,
  width,
}: OperationStatusCardProps) {
  const t = useTheme();
  const color = roleColor(operation.role, t);
  const formattedTool = toolLabel(operation);

  if (operation.status === 'running') {
    const heartbeat = heartbeatForOperation(operation, plannerHeartbeat);
    const content = (
      <Spinner
        label={runningLabel(operation, heartbeat, width)}
        color={color}
        startTime={operation.startedAt}
      />
    );
    return chrome ? (
      <Box width="100%" overflow="hidden">
        {content}
      </Box>
    ) : (
      content
    );
  }

  return (
    <Text wrap="truncate">
      <Text color={color}>{operation.role}</Text>
      <Text color={statusColor(operation.status, t)}>
        {' '}
        {statusMarker(operation.status)} {terminalHeadline(operation)}
      </Text>
      <Text color={t.textDim}> {formatDuration(operation.durationMs)}</Text>
      {terminalSuffixes(operation).map((suffix) => (
        <Text key={suffix} color={t.textDim}>
          {' '}
          {suffix}
        </Text>
      ))}
      {formattedTool && <Text color={t.textDim}> [{formattedTool}]</Text>}
      {operation.reason && <Text color={t.textDim}> {operation.reason}</Text>}
    </Text>
  );
}

function runningLabel(
  operation: ActiveOperation,
  heartbeat: PlannerHeartbeat | undefined,
  width: number | undefined,
): string {
  const tool = toolLabel(operation);
  const maxLabelCells = width === undefined ? undefined : Math.max(1, width - SPINNER_PREFIX_CELLS);
  return fitRunningSegments(
    [
      runningBaseLabel(operation),
      ...(heartbeat && heartbeat.accumulatedTokens > 0
        ? [`${formatTokensShort(heartbeat.accumulatedTokens)} tokens`]
        : []),
      ...(heartbeat?.phaseHint ? [heartbeat.phaseHint] : []),
    ],
    tool ? `[${tool}]` : null,
    maxLabelCells,
  );
}

function heartbeatForOperation(
  operation: ActiveOperation,
  heartbeat: PlannerHeartbeat | undefined,
): PlannerHeartbeat | undefined {
  if (operation.status !== 'running') return undefined;
  if (operation.role !== 'planner') return undefined;
  if (!heartbeat) return undefined;
  if (heartbeat.callId !== undefined) {
    return heartbeat.callId === operation.callId ? heartbeat : undefined;
  }
  if (!operation.callId.startsWith(LEGACY_PLANNER_STATUS_PREFIX)) return undefined;
  if (heartbeat.phase !== operation.phase) return undefined;
  if (heartbeat.ts < operation.startedAt) return undefined;
  return heartbeat;
}

function toolLabel(operation: ActiveOperation): string {
  return formatToolModel(operation.runnerName, operation.model);
}

function runningBaseLabel(operation: ActiveOperation): string {
  return `${operation.role} ${operation.phase}`;
}

function fitRunningSegments(
  prioritySegments: readonly string[],
  lowPrioritySegment: string | null,
  maxCells: number | undefined,
): string {
  if (prioritySegments.length === 0) return '';
  if (maxCells === undefined) {
    return joinRunningSegments(
      lowPrioritySegment ? [...prioritySegments, lowPrioritySegment] : prioritySegments,
    );
  }

  const base = prioritySegments[0] ?? '';
  if (getTerminalCellWidth(base) > maxCells) return truncateTerminalDisplayText(base, maxCells);

  const fitted = [base];
  for (const segment of prioritySegments.slice(1)) {
    const candidate = joinRunningSegments([...fitted, segment]);
    if (getTerminalCellWidth(candidate) <= maxCells) {
      fitted.push(segment);
      continue;
    }

    const remaining = remainingSegmentCells(fitted, maxCells);
    if (remaining > 1) fitted.push(truncateTerminalDisplayText(segment, remaining));
    return joinRunningSegments(fitted);
  }

  if (lowPrioritySegment) {
    const candidate = joinRunningSegments([...fitted, lowPrioritySegment]);
    if (getTerminalCellWidth(candidate) <= maxCells) fitted.push(lowPrioritySegment);
  }

  return joinRunningSegments(fitted);
}

function remainingSegmentCells(fitted: readonly string[], maxCells: number): number {
  return (
    maxCells -
    getTerminalCellWidth(joinRunningSegments(fitted)) -
    getTerminalCellWidth(RUNNING_SEGMENT_SEPARATOR)
  );
}

function joinRunningSegments(segments: readonly string[]): string {
  return segments.filter((segment) => segment.length > 0).join(RUNNING_SEGMENT_SEPARATOR);
}

function terminalHeadline(operation: ActiveOperation): string {
  const status = terminalStatusLabel(operation.status);
  return status ? `${status} ${operation.phase}` : operation.phase;
}

function terminalStatusLabel(status: OperationStatus): string | null {
  switch (status) {
    case 'completed':
      return null;
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'truncated':
      return 'truncated';
    case 'aborted':
      return 'aborted';
    case 'timeout':
      return 'timeout';
    case 'refused':
      return 'refused';
    case 'unsupported_tool':
      return 'unsupported tool';
    case 'incomplete':
      return 'incomplete';
    case 'running':
      return null;
    default:
      return assertNever(status);
  }
}

function terminalSuffixes(operation: ActiveOperation): string[] {
  if (operation.status === 'running') return [];

  const suffixes: string[] = [];
  if (operation.partial) suffixes.push('partial output');

  const warnings = operation.warnings.length;
  if (warnings > 0) {
    const count = warningCountLabel(warnings);
    const preview = latestActionableWarningPreview(operation);
    suffixes.push(preview ? `${count}: ${preview}` : count);
  }

  return suffixes;
}

function warningCountLabel(count: number): string {
  return count === 1 ? '1 warning' : `${count} warnings`;
}

function latestActionableWarningPreview(operation: ActiveOperation): string | null {
  if (!isActionableTerminalStatus(operation.status)) return null;

  const latest = operation.warnings.at(-1);
  if (latest === undefined || latest.length === 0) return null;
  return truncateTerminalDisplayText(latest, WARNING_PREVIEW_MAX_CELLS);
}

function isActionableTerminalStatus(status: OperationStatus): boolean {
  switch (status) {
    case 'failed':
    case 'truncated':
    case 'aborted':
    case 'timeout':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return true;
    case 'running':
    case 'completed':
    case 'cancelled':
      return false;
    default:
      return assertNever(status);
  }
}

function roleColor(role: OperationRole, theme: Theme): string {
  switch (role) {
    case 'planner':
    case 'review':
    case 'summary':
    case 'compaction':
    case 'escalation':
      return theme.planner;
    case 'implementer':
      return theme.implementer;
    default:
      return assertNever(role);
  }
}

function statusColor(status: OperationStatus, theme: Theme): string {
  switch (status) {
    case 'completed':
      return theme.success;
    case 'cancelled':
    case 'aborted':
      return theme.warning;
    case 'failed':
    case 'truncated':
    case 'timeout':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return theme.error;
    case 'running':
      return theme.textDim;
    default:
      return assertNever(status);
  }
}

function statusMarker(status: OperationStatus): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'cancelled':
    case 'aborted':
      return '×';
    case 'failed':
    case 'truncated':
    case 'timeout':
    case 'refused':
    case 'unsupported_tool':
    case 'incomplete':
      return '!';
    case 'running':
      return '-';
    default:
      return assertNever(status);
  }
}
