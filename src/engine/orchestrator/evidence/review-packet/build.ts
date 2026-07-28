import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import {
  ReviewPacketSchema,
  REVIEW_PACKET_VERSION,
} from '../../../../core/schemas/review-packet.js';
import {
  DRIFT_CHAINS_FILE,
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  sessionDir,
} from '../../../../core/paths.js';
import { nowIso } from '../../../../utils/format-time.js';
import { readEvidenceLedger } from '../../../../core/evidence/ledger-storage.js';
import { readDriftReport } from '../../drift/io.js';
import { readDriftChainState } from '../../drift/chain-state.js';
import {
  buildChanges,
  buildCost,
  buildDrift,
  buildEscalations,
  buildEvidence,
  buildRun,
  buildValidation,
} from './sections.js';
import { buildFinalReview, resolveChangedFiles, sourceArtifactMissing } from './sections-io.js';
import { readBriefQuality, readCheckpoints, readPacketEvents, readReadiness } from './artifacts.js';
import { addMissing } from './missing-artifacts.js';
import type { BuildReviewPacketOptions } from './types.js';
import { makeRecoveryWithSources } from './recovery.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';

export const REVIEWER_CHECKLIST = [
  'Inspect changed files against the requested scope.',
  'Review drift findings and out-of-scope warnings.',
  'Confirm validation commands passed or understand failures.',
  'Check escalated, skipped, or retried tasks.',
  'Inspect expected vs observed evidence for each completed task.',
  `Run or review any project-specific tests not covered by ${SPLITBRIEF_IDENTITY.displayName}.`,
  `Use \`${SPLITBRIEF_IDENTITY.executable} snapshot diff SNAPSHOT_ID\` before any restore.`,
  `Use \`${SPLITBRIEF_IDENTITY.executable} snapshot restore SNAPSHOT_ID\` only after conflicts are understood.`,
] as const;

export async function buildReviewPacket(opts: BuildReviewPacketOptions): Promise<ReviewPacket> {
  const missing: string[] = [];
  sourceArtifactMissing(opts.projectDir, opts.sessionId, missing);

  const ledger = readEvidenceLedger(opts);
  if (!ledger) addMissing(missing, EVIDENCE_FILE);

  const drift = readDriftReport(opts);
  if (!drift) addMissing(missing, DRIFT_REPORT_FILE);

  const chainState = readDriftChainState(opts);
  if (!existsSync(join(sessionDir(opts.projectDir, opts.sessionId), DRIFT_CHAINS_FILE)))
    addMissing(missing, DRIFT_CHAINS_FILE);
  const briefQuality = readBriefQuality(opts.projectDir, opts.sessionId, missing);
  const readiness = readReadiness(opts.projectDir, opts.sessionId, missing);
  const events = await readPacketEvents(opts.projectDir, opts.sessionId, missing);
  const changedFiles = await resolveChangedFiles({
    projectDir: opts.projectDir,
    drift,
    missing,
    baseline: opts.state.changedFilesBaseline,
  });
  const checkpoints = await readCheckpoints(opts.projectDir, opts.sessionId, missing);
  const finalReview = await buildFinalReview({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    requestedStatus: opts.finalReviewStatus,
    ledger,
    missing,
  });

  const packet: ReviewPacket = {
    version: REVIEW_PACKET_VERSION,
    sessionId: opts.sessionId,
    generatedAt: nowIso(),
    run: buildRun(opts, events),
    readiness,
    changes: buildChanges(opts.state, ledger, drift, changedFiles),
    checkpoints,
    recoveryDecisions: makeRecoveryWithSources({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      state: opts.state,
      events,
      ledger,
      missing,
    }),
    validation: buildValidation(opts.state, ledger),
    evidence: buildEvidence(ledger),
    drift: buildDrift(chainState, drift, briefQuality),
    escalations: buildEscalations(opts.state, ledger, events),
    cost: buildCost(opts.summary, events),
    finalReview,
    reviewerChecklist: [...REVIEWER_CHECKLIST],
    missingArtifacts: [...missing].sort((a, b) => a.localeCompare(b)),
  };

  return ReviewPacketSchema.parse(packet);
}
