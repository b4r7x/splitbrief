import { Box, Text } from 'ink';
import { formatTokensShort } from '../../../../core/formatting.js';
import { formatToolModel } from '../../../../core/model-display.js';
import { Spinner } from '../../../../components/spinner.js';
import { useTheme, type Theme } from '../../../../components/theme.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { assertNever } from '../../../../utils/type-guards.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import type {
  ActiveOperation,
  OperationRole,
  OperationStatus,
} from '../../../../stores/workflow/operations.js';

type PlannerHeartbeat = EngineEventOf<'planner_heartbeat'>;

interface OperationStatusCardProps {
  operation: ActiveOperation;
  plannerHeartbeat?: PlannerHeartbeat | undefined;
  chrome?: boolean | undefined;
}

export function OperationStatusCard({
  operation,
  plannerHeartbeat,
  chrome = false,
}: OperationStatusCardProps) {
  const t = useTheme();
  const color = roleColor(operation.role, t);
  const formattedTool = toolLabel(operation);

  if (operation.status === 'running') {
    const heartbeat = heartbeatForOperation(operation, plannerHeartbeat);
    const content = (
      <Spinner
        label={runningLabel(operation, heartbeat)}
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
        {statusMarker(operation.status)} {operation.phase}
      </Text>
      <Text color={t.textDim}> {formatDuration(operation.durationMs)}</Text>
      {formattedTool && <Text color={t.textDim}> [{formattedTool}]</Text>}
      {operation.reason && <Text color={t.textDim}> {operation.reason}</Text>}
    </Text>
  );
}

function runningLabel(operation: ActiveOperation, heartbeat: PlannerHeartbeat | undefined): string {
  const tokenSuffix =
    heartbeat && heartbeat.accumulatedTokens > 0
      ? ` · ${formatTokensShort(heartbeat.accumulatedTokens)} tokens`
      : '';
  const hintSuffix = heartbeat?.phaseHint ? ` · ${heartbeat.phaseHint}` : '';
  return `${operation.label}${tokenSuffix}${hintSuffix}`;
}

function heartbeatForOperation(
  operation: ActiveOperation,
  heartbeat: PlannerHeartbeat | undefined,
): PlannerHeartbeat | undefined {
  if (operation.status !== 'running') return undefined;
  if (operation.role !== 'planner') return undefined;
  if (!heartbeat) return undefined;
  if (heartbeat.phase !== operation.phase) return undefined;
  if (heartbeat.ts < operation.startedAt) return undefined;
  return heartbeat;
}

function toolLabel(operation: ActiveOperation): string {
  return formatToolModel(operation.runnerName, operation.model);
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
    case 'timeout':
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
    case 'timeout':
      return '!';
    case 'running':
      return '-';
    default:
      return assertNever(status);
  }
}
