import type { SeatIds } from '../../../../core/crew/seat-ids.js';
import { costAmountBasis } from '../../../../core/schemas/cost.js';
import type { RunnerKind } from '../../../../core/schemas/enums.js';
import type { ReviewPacket } from '../../../../core/schemas/review/packet.js';
import type { Summary } from '../../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { readSeatIdentities } from '../../../../core/state/seats/record.js';
import type { PacketEvent, BuildReviewPacketOptions } from './types.js';

export function buildCost(summary: Summary): ReviewPacket['cost'] {
  return {
    tokenUsage: summary.tokenUsage,
    costBreakdown: summary.costBreakdown
      ? {
          actualPlannerCost: summary.costBreakdown.actualPlannerCost,
          actualImplementerCost: summary.costBreakdown.actualImplementerCost,
          ...(summary.costBreakdown.actualReviewerCost !== undefined && {
            actualReviewerCost: summary.costBreakdown.actualReviewerCost,
          }),
          totalActualCost: summary.costBreakdown.totalActualCost,
          ...(summary.costBreakdown.hasPricedUsage !== undefined && {
            hasPricedUsage: summary.costBreakdown.hasPricedUsage,
          }),
          ...(summary.costBreakdown.hasUnpricedUsage !== undefined && {
            hasUnpricedUsage: summary.costBreakdown.hasUnpricedUsage,
          }),
          ...(summary.costBreakdown.isActualReviewerCostKnown !== undefined && {
            isActualReviewerCostKnown: summary.costBreakdown.isActualReviewerCostKnown,
          }),
          ...(summary.costBreakdown.isTotalActualCostKnown !== undefined && {
            isTotalActualCostKnown: summary.costBreakdown.isTotalActualCostKnown,
          }),
          ...(summary.costBreakdown.requestEstimate !== undefined && {
            requestEstimate: summary.costBreakdown.requestEstimate,
          }),
          ...(summary.costBreakdown.providerRunMetadata !== undefined && {
            providerRunMetadata: summary.costBreakdown.providerRunMetadata,
          }),
        }
      : null,
    amountBasis: costAmountBasis(summary.costBreakdown),
  };
}

function latestWorkflowComplete(events: PacketEvent[]): string | null {
  return events.filter((event) => event.type === 'workflow_complete').at(-1)?.ts ?? null;
}

/**
 * One seat of the packet's run section, tool, model and kind taken from the single record that
 * named the tool: a legacy summary with no kind never borrows the kind, or the model, of a
 * different seat the state happens to hold, and an unknown field stays `null` rather than
 * reading as a default.
 */
function packetSeat(
  summary: { tool?: string | undefined; model?: string | undefined; kind?: RunnerKind | undefined },
  state: { tool?: string | undefined; model?: string | undefined; kind?: RunnerKind | undefined },
  recorded: SeatIds | undefined,
): ReviewPacket['run']['planner'] {
  const record = summary.tool !== undefined ? summary : state;
  const matchesRecorded =
    recorded !== undefined &&
    record.tool === recorded.tool &&
    record.model === recorded.model &&
    (record.kind === undefined || record.kind === recorded.kind);
  return {
    tool: record.tool ?? null,
    model: record.model ?? null,
    kind: record.kind ?? null,
    ...(matchesRecorded && recorded.axes !== undefined && { axes: [...recorded.axes] }),
  };
}

function reviewSeat(record: Summary | WorkflowState) {
  return record.reviewerTool !== undefined
    ? { tool: record.reviewerTool, model: record.reviewerModel, kind: record.reviewerKind }
    : { tool: record.plannerTool, model: record.plannerModel, kind: record.plannerKind };
}

export function buildRun(
  opts: BuildReviewPacketOptions,
  events: PacketEvent[],
): ReviewPacket['run'] {
  const recorded = readSeatIdentities(opts)?.ids;
  const planner = packetSeat(
    {
      tool: opts.summary.plannerTool,
      model: opts.summary.plannerModel,
      kind: opts.summary.plannerKind,
    },
    {
      tool: opts.state.plannerTool,
      model: opts.state.plannerModel,
      kind: opts.state.plannerKind,
    },
    recorded?.plan,
  );
  const reviewer = packetSeat(reviewSeat(opts.summary), reviewSeat(opts.state), recorded?.review);
  return {
    sessionId: opts.sessionId,
    feature: opts.summary.feature,
    mode: null,
    phase: opts.state.phase,
    planner,
    implementer: packetSeat(
      {
        tool: opts.summary.implementerTool,
        model: opts.summary.implementerModel,
        kind: opts.summary.implementerKind,
      },
      {
        tool: opts.state.implementerTool,
        model: opts.state.implementerModel,
        kind: opts.state.implementerKind,
      },
      recorded?.build,
    ),
    reviewer,
    startedAt: opts.state.startedAt ?? null,
    completedAt: latestWorkflowComplete(events),
    totalTimeMs: opts.summary.totalTime,
    totalTasks: opts.summary.totalTasks,
    escalated: opts.summary.escalatedToPlanner,
    skipped: opts.summary.skipped,
    failed: opts.summary.failed,
  };
}
