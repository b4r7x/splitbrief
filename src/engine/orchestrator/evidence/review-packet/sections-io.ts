import {
  reviewFindingCounts,
  reviewOutcomeOf,
  reviewOutcomeWord,
} from '../../../../core/review/verdict.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import type {
  ReviewPacket,
  ReviewPacketFinalReviewStatus,
} from '../../../../core/schemas/review-packet.js';
import { REVIEW_FILE, STATE_FILE, sessionDir } from '../../../../core/paths.js';
import { getCommittedFilesSince, getCurrentDiff, getDiffSince } from '../../../../lib/git/diff.js';
import { getGitStatus } from '../../../../lib/git/files.js';
import { type RunStartBase, resolveRunStartBase } from '../../../../lib/git/refs.js';
import { userVisibleChangedFiles } from '../../changed-files-baseline.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { extractFrontmatter } from '../../../../utils/frontmatter.js';
import type { DriftReport } from '../../../../core/schemas/drift.js';
import { readFinalReviewRecord } from '../../../../core/review/store.js';
import { addMissing } from './missing-artifacts.js';

const REVIEW_EXCERPT_MAX = 500;

type PersistedRunBaseline = { head: string | null };

type RunUniverse = {
  fullDiff: string;
  changedFiles: string[];
};

type RunWorkingTree = {
  base: RunStartBase;
  changedFiles: string[];
  untracked: string[];
};

// One `git status` per call: it lists the changed files and the untracked files
// the diff adds, so the diff never reads it again.
async function readRunWorkingTree(
  projectDir: string,
  baseline: PersistedRunBaseline,
): Promise<RunWorkingTree> {
  const base = await resolveRunStartBase({ projectDir, head: baseline.head });
  const status = await getGitStatus(projectDir);
  const working = userVisibleChangedFiles(status.files.map((file) => file.path));
  const untracked = userVisibleChangedFiles(status.not_added);
  if (base.kind === 'working-tree-only') {
    return { base, changedFiles: uniqueSorted(working), untracked };
  }
  const committed = userVisibleChangedFiles(await getCommittedFilesSince(projectDir, base.ref));
  return { base, changedFiles: uniqueSorted([...committed, ...working]), untracked };
}

export async function resolveRunUniverse(
  projectDir: string,
  baseline: PersistedRunBaseline,
): Promise<RunUniverse> {
  const { base, changedFiles, untracked } = await readRunWorkingTree(projectDir, baseline);
  const fullDiff =
    base.kind === 'working-tree-only'
      ? await getCurrentDiff(projectDir, untracked)
      : await getDiffSince(projectDir, base.ref, untracked);
  return { fullDiff, changedFiles };
}

export async function resolveChangedFiles(opts: {
  projectDir: string;
  drift: DriftReport | null;
  missing: string[];
  baseline: PersistedRunBaseline | undefined;
}): Promise<string[]> {
  const { projectDir, drift, missing, baseline } = opts;
  if (drift) return uniqueSorted(drift.changedFiles);
  if (!baseline) {
    addMissing(missing, 'run-start baseline');
    return [];
  }
  try {
    const { changedFiles: files } = await readRunWorkingTree(projectDir, baseline);
    if (files.length === 0) addMissing(missing, 'changed files');
    return files;
  } catch {
    addMissing(missing, 'git status');
    return [];
  }
}

async function readReviewBody(projectDir: string, sessionId: string): Promise<string | null> {
  const target = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
  if (!existsSync(target)) return null;
  const body = extractFrontmatter(await readFile(target, 'utf8')).body;
  if (body.replace(/\s+/g, ' ').trim().length === 0) return null;
  return body;
}

function reviewExcerpt(body: string): string | null {
  const normalized = body.replace(/\s+/g, ' ').trim();
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
      ? `Reviewer final review written to ${REVIEW_FILE}.`
      : status === 'failed'
        ? `Reviewer final review failed; ${REVIEW_FILE} may be absent.`
        : `${REVIEW_FILE} was not available.`;
  const review = readFinalReviewRecord({ projectDir, sessionId });
  const body = review.kind === 'task-only' ? null : await readReviewBody(projectDir, sessionId);
  const outcome = review.kind === 'final' ? reviewOutcomeOf(review.record) : null;
  return {
    path: REVIEW_FILE,
    status,
    evidenceStatus: ledger?.finalReview?.status ?? null,
    statusText,
    excerpt: body === null ? null : reviewExcerpt(body),
    verdict: outcome === null ? null : reviewOutcomeWord(outcome),
    criteriaPassed:
      outcome?.criteria.filter((criterion) => criterion.status === 'pass').length ?? 0,
    criteriaFailed:
      outcome?.criteria.filter((criterion) => criterion.status !== 'pass').length ?? 0,
    findingCounts:
      outcome === null ? { critical: 0, warning: 0, note: 0 } : reviewFindingCounts(outcome),
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
