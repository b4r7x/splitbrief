import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { configStore } from '../../../stores/project/config.js';
import { detectionStore } from '../../../stores/project/detection.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { getWorkflowMode } from '../../../core/config/accessors/values.js';
import { DETECTING_TOOLS_STATUS } from '../../../core/discovery/copy.js';
import {
  CREW_LABEL_WIDTH,
  PLANNER_INHERITANCE,
  formatCollapsedSeatLine,
  type CrewSeatId,
} from '../../../core/crew/identity.js';
import { deriveCrewSeats, type CrewSeat } from '../../../core/crew/seats.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { homeConfigBlockRows } from '../layout.js';

const CREW_HINT = '/crew to change';
const LABEL_GAP = '  ';

function seatIdentity(seat: CrewSeat): string {
  return seat.id === 'review' && seat.source === 'planner'
    ? PLANNER_INHERITANCE.sentence
    : seat.model;
}

export function HomeSeatBlock({ rows, width }: { rows: number; width: number }) {
  const theme = useTheme();
  const config = configStore.useConfig();
  const skillCount = skillsStore.use((s) => s.selected.size);
  // Dim until the first discovery result ever lands: the seats are what the
  // config says, not yet what the machine confirmed.
  const coldDiscovery = detectionStore.use((s) => s.refresh.readiness.fetchedAt === null);

  const seats = deriveCrewSeats({ config });
  const seatColor: Record<CrewSeatId, string> = {
    plan: theme.planner,
    build: theme.implementer,
    review: theme.reviewer,
  };

  // The hint is the point of the row, so it is the last thing to go: drop the
  // skills count, then the detection notice, until the line fits `width`.
  const mode = getWorkflowMode(config);
  const optional = [`${skillCount} skills`, ...(coldDiscovery ? [DETECTING_TOOLS_STATUS] : [])];
  while (
    optional.length > 0 &&
    getTerminalCellWidth([mode, ...optional, CREW_HINT].join(SOFT_SEP)) > width
  ) {
    optional.shift();
  }
  const status = [mode, ...optional, CREW_HINT].join(SOFT_SEP);

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {homeConfigBlockRows(rows) < seats.length + 1 ? (
        <Text color={coldDiscovery ? theme.textDim : theme.text} wrap="truncate-end">
          {formatCollapsedSeatLine({
            planner: config.planner,
            build: resolveImplementerProfiles(config).defaultProfile.config,
            reviewer: configuredReviewerRunner(config),
          })}
        </Text>
      ) : (
        seats.map((seat) => (
          <Text key={seat.id} wrap="truncate-end">
            <Text color={coldDiscovery ? theme.textDim : seatColor[seat.id]} bold>
              {seat.label.padEnd(CREW_LABEL_WIDTH)}
            </Text>
            <Text color={coldDiscovery ? theme.textDim : theme.text}>
              {LABEL_GAP}
              {seatIdentity(seat)}
            </Text>
          </Text>
        ))
      )}
      <Text color={theme.textDim} wrap="truncate-end">
        {status}
      </Text>
    </Box>
  );
}
