import type { Config } from '../../core/schemas/config.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { CostPrediction, PlannerEstimateReview, PlannerEstimateReviewClassification } from '../../core/schemas/summary.js';
import type { TaskId } from '../../core/schemas/task.js';
import { TaskIdSchema } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { SpecMetadata } from '../../core/paths-io.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import type { EventBus } from '../events/types.js';
import type { Planner } from '../planners/types.js';
import { includes, narrowRecord } from '../../utils/type-guards.js';
import { labelError } from '../../utils/format-errors.js';
import { buildPlannerEstimateReviewPrompt } from '../spec/prompts/estimate-review.js';
import { publishPlannerStatus, publishWarning } from './events.js';
import { runPlannerReview } from './planner-review.js';

type DeterministicEstimate = NonNullable<CostPrediction['deterministic']>;

export type PlannerEstimateReviewPacket = {
  version: 1;
  taskCount: number;
  totals: DeterministicEstimate['totals'];
  taskFitCounts: DeterministicEstimate['taskFitCounts'];
  warnings: {
    unknownCostReason: DeterministicEstimate['totals']['unknownCostReason'];
    unknownPriceTaskIds: string[];
    unknownContextTaskIds: string[];
    tightTaskIds: string[];
    overflowTaskIds: string[];
  };
  userSelections: {
    workflowMode: string;
    defaultProfileId: string | null;
    configuredProfileIds: string[];
    forcedProfileId: string | null;
  };
  tasks: Array<{
    taskId: string;
    title: string;
    estimatedPromptTokens: number;
    selectedProfileId: string | null;
    contextFit: DeterministicEstimate['tasks'][number]['contextFit'];
    contextConfidence: DeterministicEstimate['tasks'][number]['contextConfidence'];
    priceConfidence: DeterministicEstimate['tasks'][number]['priceConfidence'];
  }>;
};

export type PlannerEstimateReviewDecision = {
  classification: PlannerEstimateReviewClassification;
  affectedTaskIds: TaskId[];
  reason: string;
  recommendedUserDecision: string;
};

export type ReviewPlannerEstimateOptions = {
  planner: Planner;
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
  config: Config;
  estimate: DeterministicEstimate;
  metadata: SpecMetadata;
  forcedProfileId?: string | undefined;
};

const CLASSIFICATIONS = [
  'ok',
  'split-suggested',
  'risk',
  'needs-user-decision',
] as const satisfies readonly PlannerEstimateReviewClassification[];

export function runningPlannerEstimateReview(): PlannerEstimateReview {
  return {
    extraPlannerCall: true,
    status: 'running',
    classification: null,
    affectedTaskIds: [],
    reason: 'Planner estimate review requested; making an extra planner call.',
    recommendedUserDecision: null,
  };
}

function resolveProfileSelections(config: Config): PlannerEstimateReviewPacket['userSelections'] {
  try {
    const resolved = resolveImplementerProfiles(config);
    return {
      workflowMode: config.workflow.mode ?? 'standard',
      defaultProfileId: resolved.defaultProfile.name,
      configuredProfileIds: resolved.profiles.map(profile => profile.name),
      forcedProfileId: null,
    };
  } catch {
    return {
      workflowMode: config.workflow.mode ?? 'standard',
      defaultProfileId: config.implementerProfiles?.default ?? null,
      configuredProfileIds: Object.keys(config.implementerProfiles?.profiles ?? {}).sort((a, b) => a.localeCompare(b)),
      forcedProfileId: null,
    };
  }
}

export function buildPlannerEstimateReviewPacket(opts: {
  estimate: DeterministicEstimate;
  config: Config;
  mode: WorkflowMode;
  forcedProfileId?: string | undefined;
}): PlannerEstimateReviewPacket {
  const userSelections = resolveProfileSelections(opts.config);
  const tightTaskIds = opts.estimate.tasks
    .filter(task => task.contextFit === 'tight')
    .map(task => task.taskId);
  const overflowTaskIds = opts.estimate.tasks
    .filter(task => task.contextFit === 'overflow')
    .map(task => task.taskId);

  return {
    version: 1,
    taskCount: opts.estimate.taskCount,
    totals: opts.estimate.totals,
    taskFitCounts: opts.estimate.taskFitCounts,
    warnings: {
      unknownCostReason: opts.estimate.totals.unknownCostReason,
      unknownPriceTaskIds: opts.estimate.tasks
        .filter(task => task.priceConfidence !== 'price-known')
        .map(task => task.taskId),
      unknownContextTaskIds: opts.estimate.tasks
        .filter(task => task.contextConfidence === 'profile-unavailable')
        .map(task => task.taskId),
      tightTaskIds,
      overflowTaskIds,
    },
    userSelections: {
      ...userSelections,
      workflowMode: opts.mode,
      forcedProfileId: opts.forcedProfileId ?? null,
    },
    tasks: opts.estimate.tasks.map(task => ({
      taskId: task.taskId,
      title: task.title,
      estimatedPromptTokens: task.estimatedPromptTokens,
      selectedProfileId: task.selectedProfileId,
      contextFit: task.contextFit,
      contextConfidence: task.contextConfidence,
      priceConfidence: task.priceConfidence,
    })),
  };
}

function jsonCandidate(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function parseTaskIds(value: unknown): TaskId[] {
  if (!Array.isArray(value)) return [];
  const ids: TaskId[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length === 0) continue;
    const parsed = TaskIdSchema.safeParse(entry);
    if (parsed.success) ids.push(parsed.data);
  }
  return ids;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

export function parsePlannerEstimateReview(text: string): PlannerEstimateReviewDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate(text));
  } catch {
    return null;
  }

  const record = narrowRecord(parsed);
  if (!record || !includes(CLASSIFICATIONS, record.classification)) return null;

  const affectedTaskIds = parseTaskIds(record.affectedTaskIds ?? record.affected_task_ids);
  const reason = stringField(record, 'reason');
  const recommendedUserDecision = stringField(record, 'recommendedUserDecision', 'recommended_user_decision', 'recommendedDecision', 'recommendation');

  if (reason.length === 0 || recommendedUserDecision.length === 0) return null;
  if (record.classification !== 'ok' && affectedTaskIds.length === 0) return null;

  return {
    classification: record.classification,
    affectedTaskIds,
    reason,
    recommendedUserDecision,
  };
}

function completedReview(decision: PlannerEstimateReviewDecision): PlannerEstimateReview {
  return {
    extraPlannerCall: true,
    status: 'completed',
    classification: decision.classification,
    affectedTaskIds: decision.affectedTaskIds,
    reason: decision.reason,
    recommendedUserDecision: decision.recommendedUserDecision,
  };
}

function unavailableReview(error: string): PlannerEstimateReview {
  return {
    extraPlannerCall: true,
    status: 'unavailable',
    classification: null,
    affectedTaskIds: [],
    reason: 'Planner estimate review unavailable; deterministic estimate remains usable.',
    recommendedUserDecision: 'Continue with the deterministic estimate or rerun after fixing the planner.',
    error,
  };
}

export async function reviewPlannerEstimate(
  opts: ReviewPlannerEstimateOptions,
): Promise<{ state: WorkflowState; review: PlannerEstimateReview }> {
  const packet = buildPlannerEstimateReviewPacket({
    estimate: opts.estimate,
    config: opts.config,
    mode: opts.metadata.mode,
    forcedProfileId: opts.forcedProfileId,
  });
  const prompt = buildPlannerEstimateReviewPrompt(packet);
  const start = Date.now();
  publishPlannerStatus(opts.bus, opts.state, 'running', { summary: 'Planner estimate review (extra planner call)' });

  try {
    const result = await runPlannerReview({
      planner: opts.planner,
      prompt,
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      bus: opts.bus,
      state: opts.state,
      metadata: opts.metadata,
    });
    const decision = parsePlannerEstimateReview(result.text);
    publishPlannerStatus(opts.bus, result.state, 'done', {
      duration: Date.now() - start,
      summary: decision === null ? 'Planner estimate review unavailable' : `Planner estimate review: ${decision.classification}`,
    });
    if (decision === null) {
      return { state: result.state, review: unavailableReview('Planner response was not parseable estimate-review JSON') };
    }
    return { state: result.state, review: completedReview(decision) };
  } catch (err) {
    const message = labelError('Planner estimate review failed', err);
    publishWarning({ bus: opts.bus, phase: opts.state.phase }, message);
    publishPlannerStatus(opts.bus, opts.state, 'done', {
      duration: Date.now() - start,
      summary: 'Planner estimate review unavailable',
    });
    return { state: opts.state, review: unavailableReview(message) };
  }
}
