import { Box, Text } from 'ink';
import { formatTokensShort } from '../../../../core/formatting.js';
import { formatToolModel } from '../../../../core/model-display.js';
import { Spinner } from '../../../../components/spinner.js';
import { useTheme, type Theme } from '../../../../components/theme.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
} from '../../../../utils/display-text.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import type { ActiveOperation, OperationRole } from '../../../../stores/workflow/operations.js';
import {
  cleanRunnerDisplayText,
  runnerTerminalOperationLine,
  type RunnerOperationLineSegmentRole,
  type RunnerTerminalTone,
} from '../../display/runner-terminal.js';

type PlannerHeartbeat = EngineEventOf<'planner_heartbeat'>;

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
      {runnerTerminalOperationLine(operation, width).map((segment, index) => (
        <Text
          key={`${segment.role}-${index}`}
          color={operationSegmentColor(segment.role, segment.tone, operation.role, t)}
        >
          {segment.text}
        </Text>
      ))}
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
  return cleanRunnerDisplayText(formatToolModel(operation.runnerName, operation.model));
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

function operationSegmentColor(
  role: RunnerOperationLineSegmentRole,
  tone: RunnerTerminalTone | undefined,
  operationRole: OperationRole,
  theme: Theme,
): string {
  switch (role) {
    case 'role':
      return roleColor(operationRole, theme);
    case 'status':
      return runnerToneColor(tone ?? 'textDim', theme);
    case 'dim':
      return theme.textDim;
    default:
      return assertNever(role);
  }
}

function runnerToneColor(tone: RunnerTerminalTone, theme: Theme): string {
  switch (tone) {
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'error':
      return theme.error;
    case 'info':
      return theme.info;
    case 'textDim':
      return theme.textDim;
    default:
      return assertNever(tone);
  }
}
