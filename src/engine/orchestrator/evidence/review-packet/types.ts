import type { Summary } from '../../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import type { ReviewProvenance } from '../../../../core/schemas/review-changes.js';
import type { PromptLimit } from '../../../runners/input-limit.js';
import type { ReviewInputDrop } from './fit.js';

export type BuildReviewPacketOptions = {
  projectDir: string;
  /** The run workspace: the checkout itself for a run without a worktree or a staged copy. */
  workspaceDir: string;
  sessionId: string;
  summary: Summary;
  state: WorkflowState;
  finalReviewStatus: 'written' | 'failed';
  provenance?: ReviewProvenance;
  reviewInput?: { size: number; limit: PromptLimit; dropped: ReviewInputDrop[] };
};

export type BriefQualityArtifact = {
  version: 1;
  passed: boolean;
  score: number;
  issues: Array<{ severity: 'error' | 'warning'; message: string }>;
};

export type PacketEvent = ReviewPacket['recoveryDecisions']['events'][number];
