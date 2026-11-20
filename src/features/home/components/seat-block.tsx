import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { TextSpans } from '../../../components/text-spans.js';
import { Box } from 'ink';
import { configStore } from '../../../stores/project/config.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import { skillsStore } from '../../../stores/project/skills.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { DETECTING_TOOLS_STATUS } from '../../../core/discovery/copy.js';
import { CREW_LABEL_WIDTH } from '../../../core/crew/identity.js';
import { formatCollapsedSeatRows, seatLineText } from '../../../core/crew/seat-line/collapse.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';
import {
  CREW_SEAT_ROLES,
  collapsedReviewSeat,
  crewSeatWord,
  deriveCrewSeats,
} from '../../../core/crew/seats.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { homeConfigBlockRows } from '../layout.js';
import { deriveHomeToolCheck } from '../tool-check.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';

const CREW_HINT = '/crew to change';
const LABEL_GAP = '  ';

function shedToFit(input: {
  lead: readonly string[];
  optional: readonly string[];
  tail?: readonly string[];
  width: number;
}): readonly string[] {
  const tail = input.tail ?? [];
  const kept = [...input.optional];
  while (
    kept.length > 0 &&
    getTerminalCellWidth([...input.lead, ...kept, ...tail].join(SOFT_SEP)) > input.width
  ) {
    kept.shift();
  }
  return kept;
}

// A count says a number and leaves the reader to open a picker to learn what it counts. The names
// are what every seat is actually carrying, and `none` is a state with a word rather than a zero.
function selectedSkillsText(skills: {
  available: readonly SkillMeta[];
  selected: ReadonlySet<string>;
}): string {
  const names = skills.available
    .filter((skill) => skills.selected.has(skill.id))
    .map((skill) => skill.name);
  return names.length === 0 ? 'skills: none' : `skills: ${names.join(', ')}`;
}

export function HomeSeatBlock({
  rows,
  width,
  seatLineRows,
}: {
  rows: number;
  width: number;
  /** The rows the collapsed crew may wrap onto, every seat whole. */
  seatLineRows: number;
}) {
  const theme = useTheme();
  const config = configStore.useConfig();
  const skills = skillsStore.use((s) => s);
  // Dim until the first discovery result ever lands: the seats are what the
  // config says, not yet what the machine confirmed.
  const coldDiscovery = detectionStore.use((s) => s.refresh.readiness.fetchedAt === null);
  // A first check that settled without a result says so above the composer; this line stops
  // saying it is still detecting.
  const settledCold = detectionStore.use((s) => {
    const toolCheck = deriveHomeToolCheck(s.refresh);
    return toolCheck === 'failed' || toolCheck === 'not-run';
  });
  const displayNames = useCrewDisplayNames(config);

  const seats = deriveCrewSeats({ config, displayNames });

  // The block is bare text, so it opens two cells inside the composer's column — where the
  // composer's own caret sits — and its lines have that much less of `width` to spend.
  const textWidth = Math.max(1, width - MARK_SLOT_CELLS);
  // The hint is the point of the row, so it is the last thing to go: drop the
  // skills count, then the detection notice, until the line fits.
  const optional = shedToFit({
    lead: [],
    optional: [
      selectedSkillsText(skills),
      ...(coldDiscovery && !settledCold ? [DETECTING_TOOLS_STATUS] : []),
    ],
    tail: [CREW_HINT],
    width: textWidth,
  });
  const status = [...optional, CREW_HINT].join(SOFT_SEP);

  return (
    <Box flexDirection="column" width={width} flexShrink={0} paddingLeft={MARK_SLOT_CELLS}>
      {homeConfigBlockRows(rows) < seats.length + 1
        ? formatCollapsedSeatRows({
            planner: config.planner,
            build: resolveImplementerProfiles(config).defaultProfile.config,
            reviewer: collapsedReviewSeat(config),
            budget: textWidth,
            rows: seatLineRows,
            displayNames,
          }).map((row) => (
            <Text key={seatLineText(row)} wrap="truncate-end">
              <TextSpans
                parts={row.map((span) => ({
                  text: span.text,
                  tone:
                    coldDiscovery || span.seat === undefined
                      ? 'textDim'
                      : CREW_SEAT_ROLES[span.seat],
                }))}
              />
            </Text>
          ))
        : seats.map((seat) => (
            <Text key={seat.id} wrap="truncate-end">
              <Text color={coldDiscovery ? theme.textDim : theme[CREW_SEAT_ROLES[seat.id]]} bold>
                {seat.label.padEnd(CREW_LABEL_WIDTH)}
              </Text>
              <Text color={theme.textDim}>{LABEL_GAP}</Text>
              <Text color={coldDiscovery ? theme.textDim : theme[CREW_SEAT_ROLES[seat.id]]}>
                {crewSeatWord(seat)}
              </Text>
            </Text>
          ))}
      <Text color={theme.textDim} wrap="truncate-end">
        {status}
      </Text>
    </Box>
  );
}
