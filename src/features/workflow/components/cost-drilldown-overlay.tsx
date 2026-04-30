import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { OverlayPanel } from '../../../components/overlays/overlay-panel.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { formatCost } from '../../../core/formatting.js';
import { formatCacheHitPct } from '../../../core/features/cost-chrome.js';
import { useStores } from '../../../stores/use-stores.js';
import { resolvePricing } from '../../../engine/providers/pricing-resolver.js';
import { isPlannerCostPhase } from '../../../core/phases.js';

export { formatCacheHitPct } from '../../../core/features/cost-chrome.js';

export type PhaseRow = {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: number;
};

export type TaskRow = {
  taskId: string;
  title: string;
  totalTokens: number;
};

export function buildPhaseRows(
  perPhase: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    cost: number;
  }>,
): PhaseRow[] {
  return Object.entries(perPhase)
    .map(([phase, data]) => ({ phase, ...data }))
    .sort((a, b) => b.cost - a.cost);
}

export function buildTaskRows(
  perTask: Record<string, { totalTokens: number; cost: number; title: string }>,
): TaskRow[] {
  return Object.entries(perTask)
    .map(([taskId, data]) => ({ taskId, title: data.title, totalTokens: data.totalTokens }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function renderBar(value: number, max: number, width: number): string {
  if (max === 0) return '';
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function formatCacheCreateTokens(cacheCreate: number): string {
  if (cacheCreate === 0) return '';
  if (cacheCreate > 1000) return `create ${(cacheCreate / 1000).toFixed(1)}k`;
  return `create ${cacheCreate}`;
}

export function formatInputOutputSplit(inputTokens: number, outputTokens: number): string {
  const total = inputTokens + outputTokens;
  if (total > 1000) {
    return `in: ${(inputTokens / 1000).toFixed(1)}k / out: ${(outputTokens / 1000).toFixed(1)}k`;
  }
  return `in: ${inputTokens} / out: ${outputTokens}`;
}

export function formatTotalTokens(totalTokens: number): string {
  if (totalTokens > 1000) {
    return `${(totalTokens / 1000).toFixed(1)}k tokens (total)`;
  }
  return `${totalTokens} tokens (total)`;
}

export function formatPhaseCost(cost: number, isPhasePriced: boolean, pricingMode: string | null): string {
  // If we have a recorded cost, always show it — it was already computed under the relevant
  // pricing context. Only fall back to a textual label for zero-cost rows on unpriced providers.
  if (cost > 0 || isPhasePriced) return formatCost(cost);
  if (pricingMode === 'unpriced-local') return 'local';
  if (pricingMode === 'unpriced-cli' || pricingMode === 'unpriced-meta') return 'unpriced';
  return 'n/a';
}

export function CostDrilldownOverlay() {
  const t = useTheme();
  const [tokens, { cols }] = useStores(tokensStore, terminalSizeStore);
  const { perPhase, perTask, pricingContext } = tokens;
  const phaseRows = buildPhaseRows(perPhase);
  const taskRows = buildTaskRows(perTask);
  const maxCost = phaseRows[0]?.cost ?? 0;
  const maxTaskTokens = taskRows[0]?.totalTokens ?? 0;
  const barWidth = Math.max(10, Math.min(30, cols - 40));

  const plannerPricing = pricingContext
    ? resolvePricing(pricingContext.plannerTool, modelCacheStore, pricingContext.plannerModel)
    : null;
  const implementerPricing = pricingContext
    ? resolvePricing(pricingContext.implementerTool, modelCacheStore, pricingContext.implementerModel)
    : null;

  return (
    <OverlayPanel title="Cost Breakdown" hint="press any key to dismiss" width="auto">
      <Box flexDirection="column">
        <Text color={t.textDim}>— by phase —</Text>
        {phaseRows.map(row => {
          const pricing = isPlannerCostPhase(row.phase) ? plannerPricing : implementerPricing;
          const isPriced = pricing?.isPriced ?? false;
          const costLabel = formatPhaseCost(row.cost, isPriced, pricing?.pricingMode ?? null);
          return (
            <Box key={row.phase} flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                <Text color={t.text}>{row.phase.slice(0, 18).padEnd(18)}</Text>
                <Text color={t.accent}>{renderBar(row.cost, maxCost, barWidth)}</Text>
                <Text color={t.textDim}>{costLabel}</Text>
              </Box>
              <Box marginLeft={2} gap={2}>
                <Text color={t.textDim}>{formatInputOutputSplit(row.inputTokens, row.outputTokens)}</Text>
                <Text color={t.textDim}>{formatCacheHitPct(row.cacheReadTokens, row.inputTokens)}</Text>
                {row.cacheCreateTokens > 0 && (
                  <Text color={t.textDim}>{formatCacheCreateTokens(row.cacheCreateTokens)}</Text>
                )}
              </Box>
            </Box>
          );
        })}
        {phaseRows.length === 0 && <Text color={t.textDim}>No phase data yet.</Text>}

        <Box height={1} />
        <Text color={t.textDim}>— by task —</Text>
        {taskRows.map(row => (
          <Box key={row.taskId} gap={1}>
            <Text color={t.text}>{row.title.slice(0, 20).padEnd(20)}</Text>
            <Text color={t.accent}>{renderBar(row.totalTokens, maxTaskTokens, barWidth)}</Text>
            <Text color={t.textDim}>{formatTotalTokens(row.totalTokens)}</Text>
          </Box>
        ))}
        {taskRows.length === 0 && <Text color={t.textDim}>No task data yet.</Text>}
      </Box>
    </OverlayPanel>
  );
}
