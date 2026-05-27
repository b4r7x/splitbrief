import type { Phase } from '../../../core/schemas/enums.js';
import type { CostPrediction, Summary } from '../../../core/schemas/summary.js';
import type { ReviewPacket } from '../../../core/schemas/review-packet.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionLogEventEntry } from '../../../core/schemas/session-log.js';

export type DeterministicEstimate = NonNullable<CostPrediction['deterministic']>;
export type ExplainCostConfidence = 'known' | 'partial' | 'unavailable';
export type ExplainFinalReviewStatus = ReviewPacket['finalReview']['status'] | 'not-reached' | 'unavailable';

export interface RunExplainArtifact {
  key: string;
  path: string;
  present: boolean;
}

export interface RunExplainRoute {
  taskId: string;
  title: string | null;
  status: string | null;
  method: string | null;
  selectedProfile: string | null;
  tool: string | null;
  model: string | null;
  contextFit: string | null;
  contextConfidence: string | null;
  priceConfidence: string | null;
  estimatedTokens: number | null;
  contextLength: number | null;
  costPosture: string | null;
  routingReason: string | null;
  sources: string[];
  notes: string[];
}

export interface ReadinessSummary {
  present: boolean;
  status: string | null;
  checks: Array<{ id: string; severity: string; summary: string }>;
}

export interface ExplainArtifactInputs {
  summary: Summary | null;
  reviewPacket: ReviewPacket | null;
  state: WorkflowState | null;
  readiness: ReadinessSummary | null;
  events: SessionLogEventEntry[];
  artifacts: RunExplainArtifact[];
}

export interface RunExplain {
  sessionId: string;
  feature: string;
  phase: Phase | null;
  status: string | null;
  cost: {
    actual: string;
    baseline: string;
    savings: string;
    confidence: ExplainCostConfidence;
    unknownPricing: string[];
    estimate: {
      present: boolean;
      taskFitCounts: DeterministicEstimate['taskFitCounts'] | null;
      contextConfidenceCounts: DeterministicEstimate['contextConfidenceCounts'] | null;
      priceConfidenceCounts: DeterministicEstimate['priceConfidenceCounts'] | null;
      plannerEstimateReview: CostPrediction['plannerEstimateReview'] | null;
    };
  };
  routing: RunExplainRoute[];
  activity: {
    retries: Array<{ taskId: string; retryCount: number; lastError: string | null }>;
    escalatedTasks: Array<{ taskId: string; title: string | null; method: string | null }>;
    skippedTasks: Array<{ taskId: string; title: string | null; reason: string | null }>;
    failedTasks: Array<{ taskId: string; title: string | null }>;
    recoveryRisks: string[];
  };
  review: {
    taskReview: { triggeredCount: number; taskIds: string[]; status: string };
    finalReview: { status: ExplainFinalReviewStatus; path: string; evidenceStatus: string | null };
    reviewPacket: { present: boolean; path: string; finalReviewStatus: string | null };
  };
  warnings: {
    readinessStatus: string | null;
    silentReadinessWarnings: string[];
    runtimeWarnings: string[];
    missingArtifacts: string[];
  };
  artifacts: RunExplainArtifact[];
}
