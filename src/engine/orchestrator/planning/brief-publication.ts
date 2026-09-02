import type { BriefQualityReport } from '../../spec/brief-quality.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { writeBriefQualityReport } from '../../spec/brief-quality-file.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type {
  BriefOwnerCommitPort,
  BriefOwnerCommitResult,
  BriefOwnerEvent,
  BriefOwnerExpected,
} from '../../../core/schemas/brief-owner.js';
import { BriefOwnerEventSchema } from '../../../core/schemas/brief-owner.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { labelError } from '../../../utils/format-errors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { EventBus } from '../../events/types.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import {
  installBriefGeneration,
  storeBriefSupportSnapshot,
  type BriefGenerationCandidate,
  type BriefGenerationIdentity,
} from './brief-generation.js';

export type BriefPublicationOptions = Readonly<{
  ref: SessionRef;
  candidate: BriefGenerationCandidate;
  expected: BriefOwnerExpected;
  operationId: string;
  eventId: string;
  recoveryRevision: number;
  phase: Phase;
  ts: number;
  commit: BriefOwnerCommitPort;
  bus: EventBus;
  metadata: SpecMetadata;
}>;

export type BriefPublicationFault = 'parse' | 'quality' | 'storage' | 'event' | 'cas';

export type BriefPublicationResult =
  | Readonly<{
      ok: true;
      identity: BriefGenerationIdentity;
      committed: Extract<BriefOwnerCommitResult, { kind: 'committed' }>;
    }>
  | Readonly<{
      ok: false;
      fault: 'quality';
      report: BriefQualityReport;
      message: string;
    }>
  | Readonly<{
      ok: false;
      fault: Exclude<BriefPublicationFault, 'quality'>;
      message: string;
    }>;

function provenanceDigest(candidate: BriefGenerationCandidate): string {
  return sha256Hex(
    canonicalJSON({
      programId: candidate.programId,
      parentGenerationId: candidate.parentGenerationId,
      batchReceiptDigests: [...candidate.batchReceiptDigests],
    }),
  );
}

function parkSupportSnapshot(ref: SessionRef, candidate: BriefGenerationCandidate): void {
  if (candidate.programId === null) return;
  const research = candidate.support.find((artifact) => artifact.name === 'research.md');
  const spec = candidate.support.find((artifact) => artifact.name === 'spec.md');
  const plan = candidate.support.find((artifact) => artifact.name === 'plan.md');
  if (research === undefined || spec === undefined || plan === undefined) return;
  try {
    storeBriefSupportSnapshot({
      ref,
      snapshot: {
        programId: candidate.programId,
        research: research.text,
        spec: spec.text,
        plan: plan.text,
      },
    });
  } catch {
    // The support snapshot is a bounded candidate-store artifact; losing it
    // must not mask the quality fault it accompanies.
  }
}

/**
 * The sole initial-planning publication seam: complete evaluation, then the
 * immutable generation install, then the fenced owner commit, then the fixed
 * compatibility projections. Every fault before the owner commit leaves the
 * previous authoritative Brief and permit unchanged; the committed generation
 * is the only receipt that may refresh `tasks.md` or `brief-quality.json`.
 */
export function publishBriefGeneration(options: BriefPublicationOptions): BriefPublicationResult {
  const { ref, candidate, expected, commit } = options;

  let evaluated: ReturnType<typeof parseTasksStrict>;
  try {
    evaluated = parseTasksStrict(candidate.tasksText);
  } catch (err) {
    return {
      ok: false,
      fault: 'parse',
      message: labelError('Task Brief candidate does not parse', err),
    };
  }
  if (evaluated.length === 0) {
    return {
      ok: false,
      fault: 'parse',
      message: 'a Brief candidate with no Tasks cannot be published',
    };
  }
  const report = candidate.qualityReport;
  if (report.passed !== true || report.issues.some((issue) => issue.severity === 'error')) {
    parkSupportSnapshot(ref, candidate);
    return {
      ok: false,
      fault: 'quality',
      report,
      message: 'the evaluated Brief contract has error-level issues and cannot be published',
    };
  }

  let identity: BriefGenerationIdentity;
  try {
    identity = installBriefGeneration({ ref, candidate }).identity;
  } catch (err) {
    return {
      ok: false,
      fault: 'storage',
      message: labelError('failed to install the immutable Brief generation', err),
    };
  }

  let event: BriefOwnerEvent;
  try {
    event = BriefOwnerEventSchema.parse({
      type: 'brief_generation_published',
      ts: options.ts,
      phase: options.phase,
      version: 1,
      eventId: options.eventId,
      sessionId: ref.sessionId,
      epochId: expected.epochId,
      recoveryRevision: options.recoveryRevision,
      operationId: options.operationId,
      generation: identity.ref,
      provenanceDigest: provenanceDigest(candidate),
    });
  } catch (err) {
    return {
      ok: false,
      fault: 'event',
      message: labelError('the generation publication event is invalid', err),
    };
  }

  let committed: BriefOwnerCommitResult;
  try {
    committed = commit({
      expected,
      operationId: options.operationId,
      evidence: { epochId: expected.epochId, kind: 'outcome', payload: event },
      event,
      projectNext: ({ current }) => ({
        disposition: 'parked',
        authorityRevision: expected.authorityRevision + 1,
        generation: identity.ref,
        permit: null,
        recovery: current,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      fault: 'event',
      message: labelError('the owner publication commit failed', err),
    };
  }
  if (committed.kind !== 'committed') {
    return {
      ok: false,
      fault: 'cas',
      message: `the owner commit did not succeed: ${committed.kind}`,
    };
  }

  writeAndPublishArtifacts({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    bus: options.bus,
    phase: options.phase,
    metadata: options.metadata,
    generation: identity.ref,
    items: [{ kind: 'task-briefs', text: candidate.tasksText }],
  });
  writeBriefQualityReport({
    ref,
    content: { issues: candidate.qualityReport.issues },
    metadata: options.metadata,
  });
  return { ok: true, identity, committed };
}
