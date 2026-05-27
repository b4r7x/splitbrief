import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';
import { Spinner } from '../../../../components/spinner.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { formatToolModel } from '../../../../core/model-display.js';
import { phaseRole } from '../../../../core/phases.js';
import { eventsStore } from '../../../../stores/workflow/events.js';
import { createLatestEventByTypeSelector } from '../latest-event-selector.js';

type PlannerStatusEvent = Extract<EngineEvent, { type: 'planner_status' }>;

const selectLatestHeartbeat = createLatestEventByTypeSelector('planner_heartbeat');

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k tokens`;
  }
  return `${tokens} tokens`;
}

export function PlannerStatusCard({ event }: { event: PlannerStatusEvent }) {
  const t = useTheme();
  const latestHeartbeat = eventsStore.use(selectLatestHeartbeat);
  const role = phaseRole(event.phase);
  const color = role === 'implementer' ? t.implementer : t.planner;
  const toolLabel = formatToolModel(event.tool, event.model);

  if (event.status === 'running') {
    const suffix = toolLabel ? ` (${toolLabel})` : '';
    const heartbeatSuffix = latestHeartbeat && latestHeartbeat.accumulatedTokens > 0
      ? ` · ${formatTokenCount(latestHeartbeat.accumulatedTokens)}`
      : '';
    const hintSuffix = latestHeartbeat?.phaseHint
      ? ` · ${latestHeartbeat.phaseHint}`
      : '';

    return (
      <Box flexDirection="column">
        <Spinner
          label={`${role} ${event.phase}${suffix}...`}
          color={color}
          startTime={event.ts}
        />
        {(heartbeatSuffix || hintSuffix) && (
          <Text color={t.textDim}>  {heartbeatSuffix}{hintSuffix}</Text>
        )}
      </Box>
    );
  }

  const dur = event.duration ? ` ${formatDuration(event.duration)}` : '';
  return (
    <Text>
      <Text color={color}>{role}</Text>
      <Text color={t.success}> ✓ {event.phase}</Text>
      <Text color={t.textDim}>{dur}</Text>
      {toolLabel && <Text color={t.textDim}> [{toolLabel}]</Text>}
      {event.summary && <Text color={t.textDim}> {event.summary}</Text>}
    </Text>
  );
}