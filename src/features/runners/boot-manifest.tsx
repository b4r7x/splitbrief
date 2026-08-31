import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { glyph } from '../../lib/glyphs.js';
import { FIRST_RUN_NOTE } from '../../core/discovery/copy.js';
import {
  CREW_LABEL_WIDTH,
  PLANNER_INHERITANCE,
  type CrewSeatId,
} from '../../core/crew/identity.js';
import { deriveCrewSeats } from '../../core/crew/seats.js';
import { useCrewDisplayNames } from '../../hooks/use-crew-display-names.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { useStores } from '../../stores/use-stores.js';
import { assertNever } from '../../utils/type-guards.js';
import type { CliToolDetection } from '../../core/discovery/detection.js';
import type { DiscoverySourceRefresh } from '../../stores/discovery/model-cache.js';

interface SeatMarkInput {
  readonly refreshing: boolean;
  readonly landed: boolean;
  readonly detection: CliToolDetection | undefined;
  readonly isCliSeat: boolean;
  readonly frame: string;
}

function SeatMark({ refreshing, landed, detection, isCliSeat, frame }: SeatMarkInput) {
  const t = useTheme();
  if (isCliSeat && detection !== undefined) {
    if (detection.diagnostic.state === 'ready') {
      return <Text color={t.success}>{glyph('check')}</Text>;
    }
    return <Text color={t.warning}>{glyph('statusWarning')}</Text>;
  }
  if (refreshing) return <Text color={t.accent}>{frame}</Text>;
  if (!landed) return <Text color={t.textDim}>·</Text>;
  if (isCliSeat) return <Text color={t.error}>{glyph('statusFailed')}</Text>;
  return <Text color={t.success}>{glyph('check')}</Text>;
}

function LaneMark({
  lane,
  frame,
}: {
  readonly lane: DiscoverySourceRefresh;
  readonly frame: string;
}) {
  const t = useTheme();
  if (lane.refreshing) return <Text color={t.accent}>{frame}</Text>;
  switch (lane.outcome) {
    case 'fresh':
    case 'cached':
    case 'not-modified':
      return <Text color={t.success}>{glyph('check')}</Text>;
    case 'failed':
      return <Text color={t.error}>{glyph('statusFailed')}</Text>;
    // A remembered record hydrates its lane as stale, whatever context wrote
    // it: presentation rows waiting on the live refresh, never a verdict.
    case 'stale':
    case 'uninitialized':
    case 'not-run':
      return <Text color={t.textDim}>·</Text>;
    default:
      return assertNever(lane.outcome);
  }
}

/**
 * First-run loading manifest: the configured crew with live per-seat marks and
 * the discovery lanes ticking in as they land. Sources stay unnamed — the
 * reader cares that the freshest results arrive, not where they come from.
 */
export function BootManifest() {
  const t = useTheme();
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
  const [{ cliTools, refresh }] = useStores(detectionStore);
  const { frame } = useSpinnerFrame(true);

  const seats = deriveCrewSeats({ config, displayNames });
  const seatColor: Record<CrewSeatId, string> = {
    plan: t.planner,
    build: t.implementer,
    review: t.reviewer,
  };
  const readinessLanded = refresh.readiness.fetchedAt !== null;

  return (
    <Box flexDirection="column">
      {seats.map((seat) => {
        const inheritRow = seat.id === 'review' && seat.source === 'planner';
        const runner = seat.runner;
        const detection =
          runner.kind === 'cli'
            ? cliTools.find((candidate) => candidate.tool === runner.tool)
            : undefined;
        return (
          <Box key={seat.id} gap={1}>
            <Text color={seatColor[seat.id]}>▍</Text>
            <Box width={CREW_LABEL_WIDTH} flexShrink={0}>
              <Text color={seatColor[seat.id]}>{seat.label}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={inheritRow ? t.textDim : t.text} wrap="truncate-end">
                {inheritRow ? PLANNER_INHERITANCE.sentence : seat.model}
              </Text>
            </Box>
            {!inheritRow && (
              <Box width={2} paddingLeft={1} flexShrink={0}>
                <SeatMark
                  refreshing={refresh.readiness.refreshing}
                  landed={readinessLanded}
                  detection={detection}
                  isCliSeat={runner.kind === 'cli'}
                  frame={frame}
                />
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={1} flexDirection="column">
        {(
          [
            ['tools', refresh.readiness],
            ['model catalog', refresh.modelsDev],
            ['model lists', refresh.cliModels],
          ] as const
        ).map(([label, lane]) => (
          <Box key={label} gap={1}>
            <LaneMark lane={lane} frame={frame} />
            <Text color={t.textDim}>{label}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={t.textDim}>{FIRST_RUN_NOTE}</Text>
      </Box>
    </Box>
  );
}
