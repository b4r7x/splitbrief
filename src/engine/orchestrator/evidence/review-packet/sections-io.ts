import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceLedger } from '../../../../core/schemas/evidence.js';
import type {
  ReviewPacket,
  ReviewPacketFinalReviewStatus,
} from '../../../../core/schemas/review-packet.js';
import {
  REVIEW_FILE,
  STATE_FILE,
  isInternalGitStatusPath,
  sessionDir,
} from '../../../../core/paths.js';
import { getCommittedFilesSince, getCurrentDiff, getDiffSince } from '../../../../lib/git/diff.js';
import { getCurrentChangedFiles } from '../../../../lib/git/files.js';
import { resolveRunStartBase } from '../../../../lib/git/refs.js';
import { userVisibleChangedFiles } from '../../changed-files-baseline.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { extractFrontmatter } from '../../../../utils/frontmatter.js';
import type { DriftReport } from '../../../../core/schemas/drift.js';
import { parseFinalReview, type ParsedFinalReview } from '../../../parsers/final-review.js';
import { addMissing } from './missing-artifacts.js';

const REVIEW_EXCERPT_MAX = 500;

type PersistedRunBaseline = { head: string | null };

type RunUniverse = {
  fullDiff: string;
  changedFiles: string[];
};

export async function resolveRunUniverse(
  projectDir: string,
  baseline: PersistedRunBaseline,
): Promise<RunUniverse> {
  const base = await resolveRunStartBase({ projectDir, head: baseline.head });
  const status = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  if (base.kind === 'working-tree-only') {
    return {
      fullDiff: await getCurrentDiff(projectDir, isInternalGitStatusPath),
      changedFiles: uniqueSorted(status),
    };
  }
  const committed = userVisibleChangedFiles(await getCommittedFilesSince(projectDir, base.ref));
  return {
    fullDiff: await getDiffSince(projectDir, base.ref, isInternalGitStatusPath),
    changedFiles: uniqueSorted([...committed, ...status]),
  };
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
    const { changedFiles: files } = await resolveRunUniverse(projectDir, baseline);
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

function countFindings(
  findings: ParsedFinalReview['findings'],
): ReviewPacket['finalReview']['findingCounts'] {
  const counts: ReviewPacket['finalReview']['findingCounts'] = {
    critical: 0,
    warning: 0,
    note: 0,
  };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
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
  const body = await readReviewBody(projectDir, sessionId);
  const parsed = body === null ? null : parseFinalReview(body);
  return {
    path: REVIEW_FILE,
    status,
    evidenceStatus: ledger?.finalReview?.status ?? null,
    statusText,
    excerpt: body === null ? null : reviewExcerpt(body),
    verdict: parsed?.verdict ?? null,
    criteriaPassed: parsed?.criteria.filter((criterion) => criterion.passed).length ?? 0,
    criteriaFailed: parsed?.criteria.filter((criterion) => !criterion.passed).length ?? 0,
    findingCounts:
      parsed === null ? { critical: 0, warning: 0, note: 0 } : countFindings(parsed.findings),
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
