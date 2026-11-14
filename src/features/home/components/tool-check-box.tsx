import { Fragment } from 'react';
import { Box } from 'ink';
import { TextSpans } from '../../../components/text-spans.js';
import { useTheme, ThemeText as Text } from '../../../components/theme.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { seatLineText, formatCollapsedSeatSpans } from '../../../core/crew/seat-line/collapse.js';
import { collapsedReviewSeat, CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import {
  FIRST_RUN_NOTE,
  TOOL_CHECK_FAILED_TITLE,
  TOOLS_NOT_CHECKED_TITLE,
  BOOT_MANIFEST_TITLE,
} from '../../../core/discovery/copy.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { useCrewDisplayNames } from '../../../hooks/use-crew-display-names.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import { configStore } from '../../../stores/project/config.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { deriveHomeToolCheck } from '../tool-check.js';
import { shedToFit } from './seat-block.js';

/** `paddingX={2}` on both sides plus the round border on both — the cells the text cannot use. */
const DISCOVERY_PANEL_CHROME_COLS = 6;

/**
 * Cold-discovery box floating in the slack space between the content block and
 * the bottom-anchored composer. It exists only while the first check runs (or
 * has stalled), then vanishes without leaving a residue — the slack absorbs
 * both states, so nothing above or below ever moves.
 */
export function DiscoveryPanel({ width }: { width: number }) {
  const theme = useTheme();
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
  const toolCheck = detectionStore.use((s) => deriveHomeToolCheck(s.refresh));
  const { frame } = useSpinnerFrame(toolCheck === 'cold');

  if (toolCheck === null || toolCheck === 'warm') return null;

  // A settled cold check without a result: failed outright, or not-run
  // (offline/cancelled). Both need an actionable box, never a frozen spinner.
  const stalled = toolCheck !== 'cold';
  const failedOutcome = toolCheck === 'failed';
  const seatInput = {
    planner: config.planner,
    build: resolveImplementerProfiles(config).defaultProfile.config,
    reviewer: collapsedReviewSeat(config),
    displayNames,
  };
  const budget = width - DISCOVERY_PANEL_CHROME_COLS;
  const fullSeatLine = seatLineText(formatCollapsedSeatSpans(seatInput));
  const notes = shedToFit({
    lead: [fullSeatLine],
    optional: [FIRST_RUN_NOTE],
    width: budget,
  });
  const seatLine = formatCollapsedSeatSpans({
    ...seatInput,
    budget: budget - (notes.length > 0 ? getTerminalCellWidth(`${SOFT_SEP}${FIRST_RUN_NOTE}`) : 0),
  });

  return (
    <Box
      width={width}
      borderStyle={borderStyleFor('round')}
      borderColor={stalled ? (failedOutcome ? theme.error : theme.warning) : theme.accent}
      paddingX={2}
      flexDirection="column"
    >
      {stalled ? (
        <Fragment>
          <Text color={failedOutcome ? theme.error : theme.warning} bold>
            {failedOutcome ? TOOL_CHECK_FAILED_TITLE : TOOLS_NOT_CHECKED_TITLE}
          </Text>
          <Text color={theme.textDim}>Open /settings to retry.</Text>
        </Fragment>
      ) : (
        <Fragment>
          <Text>
            <Text color={theme.accent} bold>
              {frame} {BOOT_MANIFEST_TITLE}
            </Text>
          </Text>
          <Text color={theme.textDim}>
            <TextSpans
              parts={seatLine.map((span) => ({
                text: span.text,
                tone: span.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[span.seat],
              }))}
            />
            {notes.length > 0 && (
              <Text color={theme.textDim}>
                {SOFT_SEP}
                {FIRST_RUN_NOTE}
              </Text>
            )}
          </Text>
        </Fragment>
      )}
    </Box>
  );
}
