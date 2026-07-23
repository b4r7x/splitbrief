import { join } from 'node:path';
import type { Summary } from '../../../core/schemas/summary.js';
import type { ReviewPacketCheckpoint } from '../../../core/schemas/review-packet.js';
import { ReviewPacketSchema } from '../../../core/schemas/review-packet.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { buildEvidenceSummary } from '../evidence/reporting.js';
import { readDriftReport } from '../drift/io.js';
import { readDriftChainState } from '../drift/chain-state.js';
import {
  BRIEF_QUALITY_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  reviewPacketJsonPath,
  sessionDir,
} from '../../../core/paths.js';
import { isBriefQualityReport, type BriefQualityReport } from '../../spec/brief-quality.js';
import { readJsonSafe } from '../../../lib/fs.js';
import { countBySeverity } from '../../../utils/collections.js';

export type SessionArtifactRollups = {
  evidenceSummary?: Summary['evidenceSummary'];
  briefQuality?: Summary['briefQuality'];
  driftSummary?: Summary['driftSummary'];
  chainDriftSummary?: Summary['chainDriftSummary'];
  checkpointSummary?: Summary['checkpointSummary'];
  reviewPacket?: Summary['reviewPacket'];
};

function readBriefQualityReport(projectDir: string, sessionId: string): BriefQualityReport | null {
  const raw = readJsonSafe(join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE));
  if (raw === null) return null;
  return isBriefQualityReport(raw) ? raw : null;
}

function readReviewPacketRollups(
  projectDir: string,
  sessionId: string,
): { checkpointSummary?: Summary['checkpointSummary']; reviewPacket?: Summary['reviewPacket'] } {
  const raw = readJsonSafe(reviewPacketJsonPath(projectDir, sessionId));
  if (raw === null) return {};
  const parsed = ReviewPacketSchema.safeParse(raw);
  if (!parsed.success) return {};
  const packet = parsed.data;
  const latest = packet.checkpoints.latestRunCheckpoint ?? packet.checkpoints.items.at(-1) ?? null;
  return {
    checkpointSummary: {
      count: packet.checkpoints.items.length,
      latestId: latest?.id ?? null,
      latestName: latest?.name ?? null,
      latestKind: checkpointKindLabel(latest),
      latestRunCheckpointId: packet.checkpoints.latestRunCheckpoint?.id ?? null,
      preFinalReviewId: packet.checkpoints.preFinalReview?.id ?? null,
      accepted: packet.checkpoints.runLedger.accepted,
      rejected: packet.checkpoints.runLedger.rejected,
      diffCommand: latest?.diffCommand ?? null,
      restoreCommand: latest?.restoreCommand ?? null,
    },
    reviewPacket: {
      jsonPath: REVIEW_PACKET_JSON_FILE,
      markdownPath: REVIEW_PACKET_MARKDOWN_FILE,
      generatedAt: packet.generatedAt,
      finalReviewStatus: packet.finalReview.status,
      driftPassed: packet.drift.passed,
      evidenceValidatedTasks: packet.validation.summary.passed,
      evidenceTotalTasks: packet.run.totalTasks,
      missingArtifactCount: packet.missingArtifacts.length,
    },
  };
}

function checkpointKindLabel(checkpoint: ReviewPacketCheckpoint | null): string | null {
  if (!checkpoint) return null;
  return checkpoint.inferredKind
    ? `${checkpoint.kind} (inferred ${checkpoint.inferredKind})`
    : checkpoint.kind;
}

export function loadSessionArtifactRollups(
  projectDir: string,
  sessionId: string,
): SessionArtifactRollups {
  const out: SessionArtifactRollups = {};

  const ledger = readEvidenceLedger({ projectDir, sessionId });
  if (ledger) out.evidenceSummary = buildEvidenceSummary(ledger);

  const bqReport = readBriefQualityReport(projectDir, sessionId);
  if (bqReport) {
    const counts = countBySeverity(bqReport.issues);
    out.briefQuality = {
      score: bqReport.score,
      passed: bqReport.passed,
      errorCount: counts.error,
      warningCount: counts.warning,
    };
  }

  const drift = readDriftReport({ projectDir, sessionId });
  if (drift) {
    const counts = countBySeverity(drift.findings);
    out.driftSummary = {
      passed: drift.passed,
      score: drift.score,
      errorCount: counts.error,
      warningCount: counts.warning,
    };
  }

  const chainState = readDriftChainState({ projectDir, sessionId });
  if (chainState && chainState.emittedChains.length > 0) {
    const best = chainState.emittedChains.reduce((a, b) => (a.score >= b.score ? a : b));
    out.chainDriftSummary = {
      score: best.score,
      chainLength: best.chainLength,
      uniqueOutOfBoundsFiles: best.uniqueOutOfBoundsFiles,
      representativePath: best.representativePath,
      emittedChainCount: chainState.emittedChains.length,
    };
  }

  const packetRollups = readReviewPacketRollups(projectDir, sessionId);
  if (packetRollups.checkpointSummary) out.checkpointSummary = packetRollups.checkpointSummary;
  if (packetRollups.reviewPacket) out.reviewPacket = packetRollups.reviewPacket;

  return out;
}
