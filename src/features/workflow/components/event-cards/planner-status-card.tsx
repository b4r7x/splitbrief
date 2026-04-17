import { Text } from 'ink';
import type { TuiEvent } from '../../types.js';
import { useTheme } from '../../../../components/theme.js';
import { Spinner } from '../../../../components/spinner.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { formatToolModel } from '../../../../core/model-display.js';
import { phaseRole } from '../../../../core/phases.js';

type PlannerStatusEvent = Extract<TuiEvent, { type: 'planner-status' }>;

export function PlannerStatusCard({ event }: { event: PlannerStatusEvent }) {
  const t = useTheme();
  const role = phaseRole(event.phase);
  const color = role === 'implementer' ? t.implementer : t.planner;
  const toolLabel = formatToolModel(event.tool, event.model);

  if (event.status === 'running') {
    const suffix = toolLabel ? ` (${toolLabel})` : '';
    return (
      <Spinner
        label={`${role}  ${event.phase}${suffix}...`}
        color={color}
        startTime={event.ts}
      />
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
