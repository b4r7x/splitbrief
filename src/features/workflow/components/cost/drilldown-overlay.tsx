import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { OverlayPanel } from '../../../../components/overlays/overlay-panel.js';
import { tokensStore } from '../../../../stores/workflow/tokens.js';
import type {
  PerTaskTokens,
  PhaseTokens,
  TaskAttemptTokens,
} from '../../../../stores/workflow/tokens.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { modelCacheStore } from '../../../../stores/discovery/model-cache.js';
import { formatCost, formatTokensShort } from '../../../../core/formatting.js';
import { formatCacheHitPct } from '../../layout/cost-chrome.js';
import { useStores } from '../../../../stores/use-stores.js';
import {
  calculateUsageCost,
  resolveTaskPricingModel,
} from '../../../../engine/providers/cost-math.js';
import {
  resolvePricing,
  type PricingMode,
  type ResolvedPricing,
} from '../../../../engine/providers/pricing-resolver.js';
import { phaseCostRole } from '../../../../core/phases.js';
import { PhaseSchema, type Phase } from '../../../../core/schemas/enums.js';
import { renderMeterBar } from '../../../../utils/meter-bar.js';

type PhaseRowData = PhaseTokens & { phase: Phase };
type PricingContext = NonNullable<ReturnType<typeof tokensStore.get>['pricingContext']>;

export type PhaseRow = PhaseRowData & { cost: number };

export type TaskRow = { taskId: string } & Pick<PerTaskTokens, 'title' | 'attempts'> & {
    totalTokens: number;
  };

export function buildPhaseRows(
  perPhase: Partial<Record<Phase, PhaseTokens>>,
  costForRow: (row: PhaseRowData) => number = () => 0,
): PhaseRow[] {
  return Object.entries(perPhase)
    .flatMap(([phase, data]) => {
      if (!data) return [];
      const parsed = PhaseSchema.safeParse(phase);
      if (!parsed.success) return [];
      const phaseRow = parsed.data;
      const typedRow = { ...data, phase: phaseRow };
      return [{ ...typedRow, cost: costForRow(typedRow) }];
    })
    .sort((a, b) => b.cost - a.cost);
}

export function buildTaskRows(perTask: Record<string, PerTaskTokens>): TaskRow[] {
  return Object.entries(perTask)
    .flatMap(([taskId, data]) => {
      const attempts = data.attempts ?? [];
      if (data.totalTokens === 0 && !attempts.some(attemptHasTokens)) return [];
      return [
        {
          taskId,
          title: data.title,
          totalTokens: data.totalTokens,
          attempts: data.attempts,
        },
      ];
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function attemptHasTokens(attempt: TaskAttemptTokens): boolean {
  return (
    attempt.implementerTokens +
      attempt.escalationTokens +
      (attempt.implementerCacheReadTokens ?? 0) +
      (attempt.implementerCacheCreateTokens ?? 0) +
      (attempt.escalationCacheReadTokens ?? 0) +
      (attempt.escalationCacheCreateTokens ?? 0) >
    0
  );
}

export function renderBar(options: { value: number; max: number; width: number }): string {
  const { value, max, width } = options;
  if (max === 0) return '';
  return renderMeterBar(value, max, width);
}

export function formatCacheCreateTokens(cacheCreate: number): string {
  if (cacheCreate === 0) return '';
  if (cacheCreate > 1000) return `create ${formatTokensShort(cacheCreate)}`;
  return `create ${cacheCreate}`;
}

export function formatInputOutputSplit(options: {
  inputTokens: number;
  outputTokens: number;
}): string {
  const { inputTokens, outputTokens } = options;
  const total = inputTokens + outputTokens;
  if (total > 1000) {
    return `in: ${(inputTokens / 1000).toFixed(1)}k / out: ${(outputTokens / 1000).toFixed(1)}k`;
  }
  return `in: ${inputTokens} / out: ${outputTokens}`;
}

export function formatTotalTokens(totalTokens: number): string {
  if (totalTokens > 1000) {
    return `${formatTokensShort(totalTokens)} tokens (total)`;
  }
  return `${totalTokens} tokens (total)`;
}

function formatAttemptFit(attempt: TaskAttemptTokens): string {
  if (!attempt.contextFit) return '';
  if (attempt.estimatedTokens !== undefined && attempt.contextLength !== undefined) {
    return `fit ${attempt.contextFit} ${formatTokensShort(attempt.estimatedTokens)}/${formatTokensShort(attempt.contextLength)}`;
  }
  if (attempt.estimatedTokens !== undefined) {
    return `fit ${attempt.contextFit} ${formatTokensShort(attempt.estimatedTokens)}`;
  }
  return `fit ${attempt.contextFit}`;
}

function formatCostPostureLabel(costPosture: string | undefined): string {
  if (!costPosture) return '';
  const lower = costPosture.toLowerCase();
  if (lower.includes('unknown') && lower.includes('price')) return 'price unknown';
  if (lower.includes('unknown') && lower.includes('cost')) return 'cost unknown';
  if (lower.includes('unpriced')) return 'unpriced';
  if (lower.includes('local')) return 'local';
  return '';
}

function pricingModeLabel(mode: PricingMode): string {
  if (mode === 'unpriced-local') return 'local';
  if (mode === 'unpriced-cli' || mode === 'unpriced-meta') return 'unpriced';
  if (mode === 'unpriced-unknown') return 'price unknown';
  return '';
}

function formatAttemptPricingLabel(
  attempt: TaskAttemptTokens,
  pricingContext: PricingContext | null,
): string {
  const posture = formatCostPostureLabel(attempt.costPosture);
  if (posture) return posture;
  const implementerUsageTokens =
    attempt.implementerTokens +
    (attempt.implementerCacheReadTokens ?? 0) +
    (attempt.implementerCacheCreateTokens ?? 0);
  if (!pricingContext || implementerUsageTokens <= 0) return '';
  const taskTool = attempt.tool ?? pricingContext.implementerTool;
  const taskModel = resolveTaskPricingModel({
    taskTool,
    fallbackTool: pricingContext.implementerTool,
    taskModel: attempt.model,
    fallbackModel: pricingContext.implementerModel,
  });
  const pricing = resolvePricing(taskTool, modelCacheStore, taskModel);
  if (
    pricing.isPriced &&
    (((attempt.implementerCacheReadTokens ?? 0) > 0 && pricing.cacheReadPer1M === undefined) ||
      ((attempt.implementerCacheCreateTokens ?? 0) > 0 && pricing.cacheWritePer1M === undefined))
  ) {
    return 'price partially unknown';
  }
  return pricingModeLabel(pricing.pricingMode);
}

function formatTaskAttemptMetadata(
  attempt: TaskAttemptTokens,
  pricingContext: PricingContext | null,
): string {
  const fit = formatAttemptFit(attempt);
  const pricing = formatAttemptPricingLabel(attempt, pricingContext);
  const routingReason =
    attempt.routingReason && shouldShowRoutingReason(attempt, pricing)
      ? `why ${attempt.routingReason}`
      : '';
  const parts = [
    attempt.implementerProfile ? `profile ${attempt.implementerProfile}` : '',
    fit,
    pricing,
    routingReason,
  ];
  return parts.filter(Boolean).join(' · ');
}

function shouldShowRoutingReason(attempt: TaskAttemptTokens, pricingLabel: string): boolean {
  if (attempt.contextFit === 'tight' || attempt.contextFit === 'overflow') return true;
  return pricingLabel.includes('unknown');
}

export function formatPhaseCost(options: {
  cost: number;
  isPhasePriced: boolean;
  pricingMode: string | null;
}): string {
  const { cost, isPhasePriced, pricingMode } = options;
  if (cost > 0 || isPhasePriced) return formatCost(cost);
  if (pricingMode === 'unpriced-local') return 'local';
  if (pricingMode === 'unpriced-cli' || pricingMode === 'unpriced-meta') return 'unpriced';
  return 'n/a';
}

export function formatSplitPhaseCost(options: {
  cost: number;
  plannerPriced: boolean;
  implementerPriced: boolean;
  plannerMode: string | null;
  implementerMode: string | null;
}): string {
  const { cost, plannerPriced, implementerPriced, plannerMode, implementerMode } = options;
  if (plannerPriced && implementerPriced) return formatCost(cost);
  if (!plannerPriced && !implementerPriced) {
    if (plannerMode === 'unpriced-local' && implementerMode === 'unpriced-local') return 'local';
    return 'n/a';
  }
  if (cost > 0) return `${formatCost(cost)} + partial`;
  return 'partial';
}

function roleHasTokens(row: PhaseRowData, role: 'planner' | 'implementer'): boolean {
  if (!hasRoleSplit(row)) return phaseCostRole(row.phase) === role;
  if (role === 'planner') {
    return (
      (row.plannerInputTokens ?? 0) +
        (row.plannerOutputTokens ?? 0) +
        (row.plannerCacheReadTokens ?? 0) +
        (row.plannerCacheCreateTokens ?? 0) >
      0
    );
  }
  return (
    (row.implementerInputTokens ?? 0) +
      (row.implementerOutputTokens ?? 0) +
      (row.implementerCacheReadTokens ?? 0) +
      (row.implementerCacheCreateTokens ?? 0) >
    0
  );
}

function hasRoleSplit(row: PhaseRowData): boolean {
  return (
    row.plannerInputTokens !== undefined ||
    row.plannerOutputTokens !== undefined ||
    row.plannerCacheReadTokens !== undefined ||
    row.plannerCacheCreateTokens !== undefined ||
    row.implementerInputTokens !== undefined ||
    row.implementerOutputTokens !== undefined ||
    row.implementerCacheReadTokens !== undefined ||
    row.implementerCacheCreateTokens !== undefined
  );
}

export function calculatePhaseRowCost(
  row: PhaseRowData,
  plannerPricing: ResolvedPricing | null,
  implementerPricing: ResolvedPricing | null,
): number {
  const role = phaseCostRole(row.phase);
  const split = hasRoleSplit(row);
  const plannerTokens = {
    input: split ? (row.plannerInputTokens ?? 0) : role === 'planner' ? row.inputTokens : 0,
    output: split ? (row.plannerOutputTokens ?? 0) : role === 'planner' ? row.outputTokens : 0,
    cacheRead: split
      ? (row.plannerCacheReadTokens ?? 0)
      : role === 'planner'
        ? row.cacheReadTokens
        : 0,
    cacheCreate: split
      ? (row.plannerCacheCreateTokens ?? 0)
      : role === 'planner'
        ? row.cacheCreateTokens
        : 0,
  };
  const implementerTokens = {
    input: split ? (row.implementerInputTokens ?? 0) : role === 'implementer' ? row.inputTokens : 0,
    output: split
      ? (row.implementerOutputTokens ?? 0)
      : role === 'implementer'
        ? row.outputTokens
        : 0,
    cacheRead: split
      ? (row.implementerCacheReadTokens ?? 0)
      : role === 'implementer'
        ? row.cacheReadTokens
        : 0,
    cacheCreate: split
      ? (row.implementerCacheCreateTokens ?? 0)
      : role === 'implementer'
        ? row.cacheCreateTokens
        : 0,
  };
  const plannerCost = plannerPricing
    ? calculateUsageCost({
        inputTokens: plannerTokens.input,
        outputTokens: plannerTokens.output,
        cacheReadTokens: plannerTokens.cacheRead,
        cacheCreateTokens: plannerTokens.cacheCreate,
        pricing: plannerPricing,
      })
    : 0;
  const implementerCost = implementerPricing
    ? calculateUsageCost({
        inputTokens: implementerTokens.input,
        outputTokens: implementerTokens.output,
        cacheReadTokens: implementerTokens.cacheRead,
        cacheCreateTokens: implementerTokens.cacheCreate,
        pricing: implementerPricing,
      })
    : 0;
  return plannerCost + implementerCost;
}

function pricingForPhase(
  phase: Phase,
  plannerPricing: ResolvedPricing | null,
  implementerPricing: ResolvedPricing | null,
): ResolvedPricing | null {
  const role = phaseCostRole(phase);
  if (role === 'planner') return plannerPricing;
  if (role === 'implementer') return implementerPricing;
  return null;
}

export function CostDrilldownOverlay() {
  const t = useTheme();
  const [tokens, { cols }] = useStores(tokensStore, terminalSizeStore);
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
  const phaseRows = buildPhaseRows(perPhase, (row) =>
    calculatePhaseRowCost(row, plannerPricing, implementerPricing),
  );
  const taskRows = buildTaskRows(perTask);
  const maxCost = phaseRows[0]?.cost ?? 0;
  const maxTaskTokens = taskRows[0]?.totalTokens ?? 0;
  const barWidth = Math.max(10, Math.min(30, cols - 40));

  return (
    <OverlayPanel title="Cost Breakdown" hint="press any key to dismiss" width="auto">
      <Box flexDirection="column">
        <Text color={t.textDim}>— by phase —</Text>
        {phaseRows.map((row) => {
          const split = hasRoleSplit(row);
          const plannerActive = roleHasTokens(row, 'planner');
          const implementerActive = roleHasTokens(row, 'implementer');
          const cacheText = formatCacheHitPct(row.cacheReadTokens, row.inputTokens);
          const plannerPriced = plannerActive && (plannerPricing?.isPriced ?? false);
          const implementerPriced = implementerActive && (implementerPricing?.isPriced ?? false);
          const costLabel = split
            ? formatSplitPhaseCost({
                cost: row.cost,
                plannerPriced,
                implementerPriced,
                plannerMode: plannerPricing?.pricingMode ?? null,
                implementerMode: implementerPricing?.pricingMode ?? null,
              })
            : formatPhaseCost({
                cost: row.cost,
                isPhasePriced:
                  pricingForPhase(row.phase, plannerPricing, implementerPricing)?.isPriced ?? false,
                pricingMode:
                  pricingForPhase(row.phase, plannerPricing, implementerPricing)?.pricingMode ??
                  null,
              });
          return (
            <Box key={row.phase} flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                <Text color={t.text}>{row.phase.slice(0, 18).padEnd(18)}</Text>
                <Text color={t.accent}>
                  {renderBar({ value: row.cost, max: maxCost, width: barWidth })}
                </Text>
                <Text color={t.textDim}>{costLabel}</Text>
              </Box>
              <Box marginLeft={2} gap={2}>
                <Text color={t.textDim}>
                  {formatInputOutputSplit({
                    inputTokens: row.inputTokens,
                    outputTokens: row.outputTokens,
                  })}
                </Text>
                {cacheText !== 'cache n/a' && <Text color={t.textDim}>{cacheText}</Text>}
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
        {taskRows.map((row) => (
          <Box key={row.taskId} flexDirection="column">
            <Box gap={1}>
              <Text color={t.text}>{row.title.slice(0, 20).padEnd(20)}</Text>
              <Text color={t.accent}>
                {renderBar({ value: row.totalTokens, max: maxTaskTokens, width: barWidth })}
              </Text>
              <Text color={t.textDim}>{formatTotalTokens(row.totalTokens)}</Text>
            </Box>
            {(row.attempts ?? []).map((attempt, index) => {
              const metadata = formatTaskAttemptMetadata(attempt, pricingContext);
              if (!metadata) return null;
              const prefix = (row.attempts?.length ?? 0) > 1 ? `attempt ${index + 1} · ` : '';
              return (
                <Box key={`${row.taskId}-${index}`} marginLeft={2}>
                  <Text color={t.textDim}>{prefix + metadata}</Text>
                </Box>
              );
            })}
          </Box>
        ))}
        {taskRows.length === 0 && <Text color={t.textDim}>No task data yet.</Text>}
      </Box>
    </OverlayPanel>
  );
}
