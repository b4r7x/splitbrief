import type { Summary } from '../../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';

export type BuildReviewPacketOptions = {
  projectDir: string;
  sessionId: string;
  summary: Summary;
  state: WorkflowState;
  finalReviewStatus: 'written' | 'failed';
};

export type BriefQualityArtifact = {
  version: 1;
  passed: boolean;
  score: number;
  issues: Array<{ severity: 'error' | 'warning'; message: string }>;
};

export type PacketEvent = ReviewPacket['recoveryDecisions']['events'][number];
