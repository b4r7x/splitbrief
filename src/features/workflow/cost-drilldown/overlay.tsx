import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { OverlayPanel } from '../../../components/overlays/overlay-panel.js';
import { ListRow } from '../../../components/list-row.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { getResponsivePanelWidth } from '../../../utils/terminal-width.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
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
  const [tokens, { cols, isSmall }] = useStores(tokensStore, terminalSizeStore);
  const { perPhase, perTask, pricingContext } = tokens;

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
  const panelWidth = getResponsivePanelWidth({ cols, size: isSmall ? 'small' : 'large' });

  return (
    <OverlayPanel title="Cost · breakdown" hint={`esc${SOFT_SEP}any key to close`} width="auto">
      <Box flexDirection="column">
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
              {preview !== '' ? (
                <Box marginLeft={4}>
                  <Text color={t.textDim}>{preview}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
        {phaseRows.length === 0 && <Text color={t.textDim}>No phase data yet</Text>}

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
    </OverlayPanel>
  );
}
