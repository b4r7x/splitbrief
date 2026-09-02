import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import {
  OverlayPanel,
  overlayInnerRowCapacity,
} from '../../../components/overlays/overlay-panel.js';
import { ListRow } from '../../../components/list-row.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { overlayRect } from '../../../core/navigation/overlay-rect.js';
import { CREW_LABEL_WIDTH, CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { formatCacheHitPct } from '../layout/cost-chrome.js';
import { useStores } from '../../../stores/use-stores.js';
import { resolvePricing } from '../../../engine/providers/pricing-resolver.js';
import { glyph } from '../../../lib/glyphs.js';
import {
  buildPhaseRows,
  calculatePhaseRowCost,
  formatCacheCreateTokens,
  formatInputOutputSplit,
  formatPhaseCost,
  formatSplitPhaseCost,
  hasRoleSplit,
  pricingForPhase,
  roleHasTokens,
} from './phase-breakdown.js';
import { buildTaskRows, formatTaskAttemptMetadata, formatTotalTokens } from './task-breakdown.js';
import { buildSeatRows, costBar } from './seat-bar.js';

const SEAT_BAR_MAX = 40;
const SEAT_BAR_RESERVE = 25;
const SEAT_BAR_MIN_INNER = 60;
const PANEL_TITLE_ROWS = 2;
const PANEL_HINT_ROWS = 2;

function SectionHeader({ label, width }: { label: string; width: number }) {
  const t = useTheme();
  const dashes = Math.max(0, width - label.length - 1);
  return (
    <Box height={1} overflow="hidden" flexShrink={0} width={width}>
      <Text color={t.textDim}>{`${label} ${glyph('divider').repeat(dashes)}`}</Text>
    </Box>
  );
}

export function CostDrilldownOverlay() {
  const t = useTheme();
  const [tokens, { cols, rows }] = useStores(tokensStore, terminalSizeStore);
  const { perPhase, perTask, pricingContext, tokenUsage } = tokens;

  const plannerPricing = pricingContext
    ? resolvePricing(pricingContext.plannerTool, modelCacheStore, pricingContext.plannerModel)
    : null;
  const implementerPricing = pricingContext
    ? resolvePricing(
        pricingContext.implementerTool,
        modelCacheStore,
        pricingContext.implementerModel,
      )
    : null;
  const reviewerHasOwnSeat = pricingContext?.reviewerTool !== undefined;
  const reviewerPricing =
    pricingContext?.reviewerTool !== undefined
      ? resolvePricing(pricingContext.reviewerTool, modelCacheStore, pricingContext.reviewerModel)
      : null;
  const phaseRows = buildPhaseRows(perPhase, (row) =>
    calculatePhaseRowCost({
      row,
      plannerPricing,
      implementerPricing,
      reviewerPricing,
      reviewerHasOwnSeat,
    }),
  );
  const taskRows = buildTaskRows(perTask);
  const panelWidth = overlayRect({ cols, rows, density: 'wide' }).innerWidth;

  const allSeatRows =
    tokenUsage === null
      ? []
      : buildSeatRows({
          tokenUsage,
          pricingContext,
          pricing: {
            planner: plannerPricing,
            implementer: implementerPricing,
            reviewer: reviewerPricing,
          },
        });
  const seatRows = allSeatRows.filter((row) => row.tokens > 0).length < 2 ? [] : allSeatRows;
  const barWidth = Math.min(SEAT_BAR_MAX, panelWidth - SEAT_BAR_RESERVE);
  const showBar = panelWidth >= SEAT_BAR_MIN_INNER;

  const seatBlock = seatRows.length === 0 ? 0 : seatRows.length + 2;
  const phaseBlock = 1 + Math.max(1, phaseRows.length);
  const previewBlock = phaseRows.length;
  const taskBlock =
    2 +
    Math.max(
      1,
      taskRows.reduce((total, row) => total + 1 + (row.attempts?.length ?? 0), 0),
    );
  const capacity = overlayInnerRowCapacity({
    rows,
    outerChromeRows: PANEL_TITLE_ROWS + PANEL_HINT_ROWS,
  });
  const showPreviews = seatBlock + phaseBlock + previewBlock + taskBlock <= capacity;
  const showTasks =
    seatBlock + phaseBlock + (showPreviews ? previewBlock : 0) + taskBlock <= capacity;

  return (
    <OverlayPanel title="Cost · breakdown" hint={`esc${SOFT_SEP}any key to close`} density="wide">
      <Box flexDirection="column">
        {seatRows.length > 0 ? (
          <Box flexDirection="column">
            <SectionHeader label="By seat" width={panelWidth} />
            {seatRows.map((row) => (
              <Box key={row.seat} height={1} overflow="hidden">
                <Text color={t.text}>
                  {`  ${CREW_SEAT_LABELS[row.seat].padEnd(CREW_LABEL_WIDTH)}`}
                </Text>
                <Text color={t.textDim}>
                  {`${row.cost.padEnd(8)}${showBar ? costBar({ share: row.share, width: barWidth }) : ''}  ${String(Math.round(row.share * 100)).padStart(3)}%`}
                </Text>
              </Box>
            ))}
            <Box height={1} />
          </Box>
        ) : null}
        <SectionHeader label="By phase" width={panelWidth} />
        {phaseRows.map((row) => {
          const split = hasRoleSplit(row);
          const plannerActive = roleHasTokens({ row, role: 'planner', reviewerHasOwnSeat });
          const implementerActive = roleHasTokens({ row, role: 'implementer', reviewerHasOwnSeat });
          const cacheText = formatCacheHitPct(row.cacheReadTokens, row.inputTokens);
          const reviewerActive = roleHasTokens({ row, role: 'reviewer', reviewerHasOwnSeat });
          const seats = [
            {
              priced: plannerActive && (plannerPricing?.isPriced ?? false),
              mode: plannerPricing?.pricingMode ?? null,
            },
            {
              priced: implementerActive && (implementerPricing?.isPriced ?? false),
              mode: implementerPricing?.pricingMode ?? null,
            },
            ...(reviewerHasOwnSeat && reviewerActive
              ? [
                  {
                    priced: reviewerPricing?.isPriced ?? false,
                    mode: reviewerPricing?.pricingMode ?? null,
                  },
                ]
              : []),
          ];
          const costLabel = split
            ? formatSplitPhaseCost({ cost: row.cost, seats })
            : formatPhaseCost({
                cost: row.cost,
                isPhasePriced:
                  pricingForPhase(row.phase, plannerPricing, implementerPricing)?.isPriced ?? false,
                pricingMode:
                  pricingForPhase(row.phase, plannerPricing, implementerPricing)?.pricingMode ??
                  null,
              });
          const preview = [
            formatInputOutputSplit({
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
            }),
            cacheText === 'cache n/a' ? '' : cacheText,
            row.cacheCreateTokens > 0 ? formatCacheCreateTokens(row.cacheCreateTokens) : '',
          ]
            .filter(Boolean)
            .join(SOFT_SEP);
          return (
            <Box key={row.phase} flexDirection="column">
              <ListRow label={row.phase} metadata={costLabel} labelWidth={18} />
              {showPreviews && preview !== '' ? (
                <Box marginLeft={4}>
                  <Text color={t.textDim}>{preview}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
        {phaseRows.length === 0 && <Text color={t.textDim}>No phase data yet</Text>}

        {showTasks ? (
          <Box flexDirection="column">
            <Box height={1} />
            <SectionHeader label="By task" width={panelWidth} />
            {taskRows.map((row) => (
              <Box key={row.taskId} flexDirection="column">
                <ListRow
                  label={row.title}
                  metadata={formatTotalTokens(row.totalTokens)}
                  labelWidth={20}
                />
                {(row.attempts ?? []).map((attempt, attemptIndex) => {
                  const metadata = formatTaskAttemptMetadata(attempt, pricingContext);
                  if (!metadata) return null;
                  const prefix =
                    (row.attempts?.length ?? 0) > 1 ? `attempt ${attemptIndex + 1} · ` : '';
                  return (
                    <Box key={`${row.taskId}-${attemptIndex}`} marginLeft={4}>
                      <Text color={t.textDim}>{prefix + metadata}</Text>
                    </Box>
                  );
                })}
              </Box>
            ))}
            {taskRows.length === 0 && <Text color={t.textDim}>No task data yet</Text>}
          </Box>
        ) : null}
      </Box>
    </OverlayPanel>
  );
}
