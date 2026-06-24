import { Box, Text } from 'ink';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { useTheme } from '../../../../components/theme.js';
import { SOFT_SEP, ARROW_SEP } from '../../../../components/separators.js';
import { getProviderDisplayName } from '../../../../core/providers/catalog.js';
import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
} from '../../../../utils/display-text.js';

type WorkflowConfigEvent = Extract<EngineEvent, { type: 'workflow_config' }>;
export type WorkflowConfigDensity = 'full' | 'labels' | 'tools';
type WorkflowConfigSegmentRole = 'mode' | 'dim' | 'planner' | 'implementer';
type WorkflowConfigSegment = { text: string; role: WorkflowConfigSegmentRole };

function getWorkflowConfigSegments(
  event: WorkflowConfigEvent,
  density: WorkflowConfigDensity,
): WorkflowConfigSegment[] {
  const mode = sanitizeTerminalDisplayText(event.mode);
  const planner = sanitizeTerminalDisplayText(getProviderDisplayName(event.plannerTool));
  const implementer = sanitizeTerminalDisplayText(getProviderDisplayName(event.implementerTool));
  const plannerModel =
    event.plannerModel === undefined ? undefined : sanitizeTerminalDisplayText(event.plannerModel);
  const implementerModel =
    event.implementerModel === undefined
      ? undefined
      : sanitizeTerminalDisplayText(event.implementerModel);

  if (density === 'tools') {
    return [
      { text: mode, role: 'mode' },
      { text: SOFT_SEP, role: 'dim' },
      { text: planner, role: 'planner' },
      { text: ARROW_SEP, role: 'dim' },
      { text: implementer, role: 'implementer' },
    ];
  }

  return [
    { text: mode, role: 'mode' },
    { text: SOFT_SEP, role: 'dim' },
    { text: 'Planner: ', role: 'dim' },
    { text: planner, role: 'planner' },
    ...(density === 'full' && plannerModel
      ? [{ text: ` (${plannerModel})`, role: 'dim' as const }]
      : []),
    { text: SOFT_SEP, role: 'dim' },
    { text: 'Implementer: ', role: 'dim' },
    { text: implementer, role: 'implementer' },
    ...(density === 'full' && implementerModel
      ? [{ text: ` (${implementerModel})`, role: 'dim' as const }]
      : []),
  ];
}

function getWorkflowConfigWidth(
  event: WorkflowConfigEvent,
  density: WorkflowConfigDensity,
): number {
  return getWorkflowConfigSegments(event, density).reduce(
    (width, segment) => width + getTerminalCellWidth(segment.text),
    0,
  );
}

export function getWorkflowConfigDensity(
  event: WorkflowConfigEvent,
  maxWidth: number,
): WorkflowConfigDensity {
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
        <Text key={i} color={colorByRole[segment.role]}>
          {segment.text}
        </Text>
      ))}
    </Box>
  );
}
