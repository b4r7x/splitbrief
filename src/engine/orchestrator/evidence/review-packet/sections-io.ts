import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import type {
  ReviewPacket,
  ReviewPacketFinalReviewStatus,
} from '../../../../core/schemas/review-packet.js';
import { REVIEW_FILE, STATE_FILE, sessionDir } from '../../../../core/paths.js';
import { getCommittedFilesSince } from '../../../../lib/git/diff.js';
import { getCurrentChangedFiles } from '../../../../lib/git/files.js';
import { getRunStartHead } from '../../../../lib/git/refs.js';
import { userVisibleChangedFiles } from '../../changed-files-baseline.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { extractFrontmatter } from '../../../../utils/frontmatter.js';
import type { DriftReport } from '../../../../core/schemas/drift.js';
import { RUN_COMMIT_MESSAGE_PREFIX } from '../../task/commit.js';
import { addMissing } from './missing-artifacts.js';

const REVIEW_EXCERPT_MAX = 500;

export async function resolveChangedFiles(
  projectDir: string,
  drift: DriftReport | null,
  missing: string[],
): Promise<string[]> {
  if (drift) return uniqueSorted(drift.changedFiles);
  // No drift report: live `git status` alone is not the run-attributed universe
  // (per-task commits move changes out of the working tree), so it must be unioned
  // with files committed since the run-start HEAD; an empty result is unavailable
  // evidence rather than a confident "nothing changed".
  try {
    const runStartHead = await getRunStartHead(projectDir, RUN_COMMIT_MESSAGE_PREFIX);
    const status = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
    const committed =
      runStartHead === null
        ? []
        : userVisibleChangedFiles(await getCommittedFilesSince(projectDir, runStartHead));
    const files = uniqueSorted([...committed, ...status]);
    if (files.length === 0) addMissing(missing, 'changed files');
    return files;
  } catch {
    addMissing(missing, 'git status');
    return [];
  }
}

async function reviewExcerpt(projectDir: string, sessionId: string): Promise<string | null> {
  const target = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
  if (!existsSync(target)) return null;
  const normalized = extractFrontmatter(await readFile(target, 'utf8'))
    .body.replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= REVIEW_EXCERPT_MAX) return normalized;
  return `${normalized.slice(0, REVIEW_EXCERPT_MAX - 3)}...`;
}

export async function buildFinalReview(opts: {
  projectDir: string;
  sessionId: string;
  requestedStatus: 'written' | 'failed';
  ledger: EvidenceLedger | null;
  missing: string[];
}): Promise<ReviewPacket['finalReview']> {
  const { projectDir, sessionId, requestedStatus, ledger, missing } = opts;
  const target = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
  const exists = existsSync(target);
  if (!exists) addMissing(missing, REVIEW_FILE);
  const status: ReviewPacketFinalReviewStatus =
    requestedStatus === 'failed' ? 'failed' : exists ? 'written' : 'missing';
  const statusText =
    status === 'written'
      ? `Planner final review written to ${REVIEW_FILE}.`
      : status === 'failed'
        ? `Planner final review failed; ${REVIEW_FILE} may be absent.`
        : `${REVIEW_FILE} was not available.`;
  return {
    path: REVIEW_FILE,
    status,
    evidenceStatus: ledger?.finalReview?.status ?? null,
    statusText,
    excerpt: await reviewExcerpt(projectDir, sessionId),
  };
}

export function sourceArtifactMissing(
  projectDir: string,
  sessionId: string,
  missing: string[],
): void {
  if (!existsSync(join(sessionDir(projectDir, sessionId), STATE_FILE)))
    addMissing(missing, STATE_FILE);
}
