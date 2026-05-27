import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';
import { getProviderDisplayName } from '../../../../core/providers/catalog.js';

type WorkflowConfigEvent = Extract<EngineEvent, { type: 'workflow_config' }>;
export type WorkflowConfigDensity = 'full' | 'labels' | 'tools';
type WorkflowConfigSegmentRole = 'mode' | 'dim' | 'planner' | 'implementer';
type WorkflowConfigSegment = { text: string; role: WorkflowConfigSegmentRole };

function getWorkflowConfigSegments(event: WorkflowConfigEvent, density: WorkflowConfigDensity): WorkflowConfigSegment[] {
  const planner = getProviderDisplayName(event.plannerTool);
  const implementer = getProviderDisplayName(event.implementerTool);

  if (density === 'tools') {
    return [
      { text: event.mode, role: 'mode' },
      { text: ' · ', role: 'dim' },
      { text: planner, role: 'planner' },
      { text: ' → ', role: 'dim' },
      { text: implementer, role: 'implementer' },
    ];
  }

  return [
    { text: event.mode, role: 'mode' },
    { text: ' · ', role: 'dim' },
    { text: 'Planner: ', role: 'dim' },
    { text: planner, role: 'planner' },
    ...(density === 'full' && event.plannerModel ? [{ text: ` (${event.plannerModel})`, role: 'dim' as const }] : []),
    { text: ' · ', role: 'dim' },
    { text: 'Implementer: ', role: 'dim' },
    { text: implementer, role: 'implementer' },
    ...(density === 'full' && event.implementerModel ? [{ text: ` (${event.implementerModel})`, role: 'dim' as const }] : []),
  ];
}

function getWorkflowConfigWidth(event: WorkflowConfigEvent, density: WorkflowConfigDensity): number {
  return getWorkflowConfigSegments(event, density).reduce((width, segment) => width + segment.text.length, 0);
}

export function getWorkflowConfigDensity(event: WorkflowConfigEvent, maxWidth: number): WorkflowConfigDensity {
  if (getWorkflowConfigWidth(event, 'full') <= maxWidth) return 'full';
  if (getWorkflowConfigWidth(event, 'labels') <= maxWidth) return 'labels';
  return 'tools';
}

export function WorkflowConfigCard({
  event,
  compact = false,
  density,
}: {
  event: WorkflowConfigEvent;
  compact?: boolean;
  density?: WorkflowConfigDensity;
}) {
  const t = useTheme();
  const resolvedDensity = density ?? (compact ? 'labels' : 'full');
  const colorByRole = {
    mode: t.text,
    dim: t.textDim,
    planner: t.planner,
    implementer: t.implementer,
  } satisfies Record<WorkflowConfigSegmentRole, string>;

  return (
    <Box>
      {getWorkflowConfigSegments(event, resolvedDensity).map((segment, i) => (
        <Text key={i} color={colorByRole[segment.role]}>{segment.text}</Text>
      ))}
    </Box>
  );
}
