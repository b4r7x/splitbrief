import type { Stats } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { sessionDir } from '../../../core/paths.js';
import {
  assertSessionConfinement,
  assertSessionDirConfined,
} from '../../../core/sessions/confinement.js';
import { CallIdSchema } from '../../calls/schema.js';
import { confinedEnsureDir } from '../../../lib/confined-fs.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { error } from '../../../utils/error.js';
import { validateSafeIdentifier } from '../../../utils/validate-identifier.js';
import {
  PLANNER_ARTIFACT_MAX_BYTES,
  type ArtifactApprovalReview,
  type BeginDeclaredArtifactReviewInput,
  type PreparedDeclaredArtifactReview,
} from '../../runners/types.js';
import { prepareArtifactStageLease } from './artifact-stage-manifest.js';

const REVIEW_DIRECTORY = '.custom-runner-review';
const ARTIFACT_REVIEW_LABEL = 'Custom planner artifact';

type BeginPlannerArtifactReviewInput = BeginDeclaredArtifactReviewInput &
  Readonly<{
    projectDir: string;
    sessionId: string;
    onApprovalNeeded: (
      type: 'artifact',
      review: ArtifactApprovalReview,
    ) => Promise<ApprovalReviewResult>;
  }>;

const plannerArtifactError = {
  invalidArtifact: (reason: string) =>
    error(
      'custom-planner-artifact-invalid',
      `Configured custom planner artifact is invalid: ${reason}`,
      { reason },
    ),
  invalidCallId: (callId: string) =>
    error('custom-planner-artifact-call-id', 'Configured custom planner call id is invalid.', {
      callId,
    }),
  rejected: () =>
    error(
      'custom-planner-artifact-rejected',
      'Configured custom planner artifact was not approved.',
    ),
  disposed: () =>
    error(
      'custom-planner-artifact-review-disposed',
      'Configured custom planner artifact review is already disposed.',
    ),
} as const;

export async function cleanupStaleArtifactReviews(
  input: Readonly<{ projectDir: string; sessionId: string }>,
): Promise<void> {
  const sessionRoot = await prepareSessionRoot({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
  });
  await clearReviewRoot({
    sessionRoot,
    reviewRoot: join(sessionRoot, REVIEW_DIRECTORY),
  });
}

/**
 * Binds the pre-spawn result descriptor to a one-shot immutable approval
 * payload. There is deliberately no review candidate: neither this adapter nor
 * any reviewer reopens a child-controlled artifact pathname after the child.
 */
export async function beginDeclaredArtifactReview(
  input: BeginPlannerArtifactReviewInput,
): Promise<PreparedDeclaredArtifactReview> {
  assertSafeCallId(input.callId);
  const lease = await prepareArtifactStageLease({ stagedProjectDir: input.stagedProjectDir });
  let disposed = false;
  let reviewStarted = false;

  return {
    reviewAfterChild: async () => {
      if (disposed) throw plannerArtifactError.disposed();
      if (reviewStarted) {
        throw plannerArtifactError.invalidArtifact('artifact review was already started');
      }
      reviewStarted = true;

      const reviewedText = await lease.readAfterChild({
        declaredRedactionValues: input.declaredRedactionValues,
      });
      assertArtifactTextBound(reviewedText);
      const approval = await input.onApprovalNeeded(
        'artifact',
        immutableArtifactReview(reviewedText),
      );
      if (!approval.approved) throw plannerArtifactError.rejected();

      const promotedText = await lease.revalidateBeforePromotion();
      if (promotedText !== reviewedText) {
        throw plannerArtifactError.invalidArtifact('declared artifact changed after review');
      }
      return promotedText;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await lease.dispose();
    },
  };
}

function immutableArtifactReview(text: string): ArtifactApprovalReview {
  return Object.freeze({ label: ARTIFACT_REVIEW_LABEL, text });
}

function assertArtifactTextBound(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > PLANNER_ARTIFACT_MAX_BYTES) {
    throw plannerArtifactError.invalidArtifact('declared artifact exceeds the maximum size');
  }
}

function assertSafeCallId(callId: string): void {
  const parsed = CallIdSchema.safeParse(callId);
  const identifier = validateSafeIdentifier(callId);
  if (!parsed.success || !identifier.ok || callId === '.') {
    throw plannerArtifactError.invalidCallId(callId);
  }
}

async function prepareSessionRoot({
  projectDir,
  sessionId,
}: Readonly<{
  projectDir: string;
  sessionId: string;
}>): Promise<string> {
  assertSessionDirConfined(projectDir, sessionId);
  const root = sessionDir(projectDir, sessionId);
  const rootRelativePath = relative(projectDir, root);
  assertPathConfined(rootRelativePath, projectDir);
  confinedEnsureDir(projectDir, rootRelativePath);
  assertSessionConfinement(root, root);
  return realpath(root);
}

async function clearReviewRoot({
  sessionRoot,
  reviewRoot,
}: Readonly<{
  sessionRoot: string;
  reviewRoot: string;
}>): Promise<void> {
  let rootStat: Stats;
  try {
    rootStat = await lstat(reviewRoot);
  } catch (err) {
    if (isNoEntry(err)) return;
    throw err;
  }
  if (!rootStat.isDirectory()) {
    throw plannerArtifactError.invalidArtifact('review candidate root is not a directory');
  }
  assertSessionConfinement(reviewRoot, sessionRoot);
  // This deletes only stale legacy candidates. Fresh artifact review content is
  // carried in memory and never written beneath this directory.
  await rm(reviewRoot, { recursive: true, force: false });
}

function isNoEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
