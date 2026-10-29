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
import { diffFileEntries } from '../../../../lib/git/entry-diff.js';
import { splitDiffByFile } from '../../../../lib/git/diff-sections.js';
import { error } from '../../../../utils/error.js';
import { readConfinedEntry } from '../../approval/file-snapshots/entry.js';
import { createRunBaseReader, type RunBaseFile } from '../../isolation/acquisition.js';
import type { RunBase } from '../../isolation/base-tree.js';
import { gitignoreDiffersOnlyBySplitbriefBookkeeping } from '../../../../core/gitignore-bookkeeping.js';
import { userVisibleChangedFiles } from '../../changed-files-baseline.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { extractFrontmatter } from '../../../../utils/frontmatter.js';
import type { DriftReport } from '../../../../core/schemas/drift.js';
import { readFinalReviewRecord } from '../../../../core/review/store.js';
import { addMissing } from './missing-artifacts.js';

const REVIEW_EXCERPT_MAX = 500;

type PersistedRunBaseline = {
  head: string | null;
  runStartChangedFiles?: readonly string[] | undefined;
};

type RunUniverse = {
  /** The diff of every run change, each from the file as the run started. */
  fullDiff: string;
  changedFiles: string[];
  /** The files already changed when the run started: the user's own work, never a run change. */
  preRunFiles: string[];
  /** SPLITBRIEF's own setup change: a .gitignore that differs only by its ignore lines. */
  setupFiles: string[];
};

type RunWorkingTree = {
  base: RunStartBase;
  changedFiles: string[];
  /** The untracked run changes the git diff adds. */
  untracked: string[];
  preRunFiles: string[];
  /** A .gitignore that differs from the base commit only by SPLITBRIEF's own lines. */
  setupFiles: string[];
  /** The files whose diff from the base commit is not the run's: the pre-run and setup files. */
  notRunFiles: ReadonlySet<string>;
  /** The pre-run files the run changed again, as the run base holds them. */
  preRunChanges: Map<string, Extract<RunBaseFile, { kind: 'new' | 'changed' }>>;
};

// The changes of this run: the workspace against its state when the run started. Git compares
// with the base commit, so a file already changed then is a run change only when the run base
// shows the run changed it again. One `git status` per call: it lists the changed files and the
// untracked files the diff adds, so the diff never reads it again.
async function readRunWorkingTree(
  workspaceDir: string,
  baseline: PersistedRunBaseline,
  runBase: RunBase | undefined,
): Promise<RunWorkingTree> {
  const base = await resolveRunStartBase({ projectDir: workspaceDir, head: baseline.head });
  const status = await getGitStatus(workspaceDir);
  const working = userVisibleChangedFiles(status.files.map((file) => file.path));
  const committed =
    base.kind === 'working-tree-only'
      ? []
      : userVisibleChangedFiles(await getCommittedFilesSince(workspaceDir, base.ref));
  // A workspace without its own git (a staged copy) recorded every file at run start, not the
  // files changed then, so it has no pre-run list to set apart.
  const preRunFiles = existsSync(join(workspaceDir, '.git'))
    ? uniqueSorted([...(baseline.runStartChangedFiles ?? [])])
    : [];
  // SPLITBRIEF's own .gitignore lines are neither the user's change nor the run's.
  const setupFiles =
    working.includes('.gitignore') &&
    !committed.includes('.gitignore') &&
    (await gitignoreDiffersOnlyBySplitbriefBookkeeping(workspaceDir))
      ? ['.gitignore']
      : [];
  const notRunFiles = new Set([...preRunFiles, ...setupFiles]);
  const preRunChanges: RunWorkingTree['preRunChanges'] = new Map();
  if (preRunFiles.length > 0) {
    if (runBase === undefined) throw runUniverseError.missingRunBase();
    const read = await createRunBaseReader({ ...runBase, workspaceDir });
    for (const file of preRunFiles) {
      const atBase = await read(file);
      if (atBase.kind === 'new' || atBase.kind === 'changed') preRunChanges.set(file, atBase);
    }
  }
  const ownFiles = [...committed, ...working].filter((file) => !notRunFiles.has(file));
  return {
    base,
    changedFiles: uniqueSorted([...ownFiles, ...preRunChanges.keys()]),
    untracked: userVisibleChangedFiles(status.not_added).filter((file) => !notRunFiles.has(file)),
    preRunFiles,
    setupFiles,
    notRunFiles,
    preRunChanges,
  };
}

const runUniverseError = {
  missingRunBase: () =>
    error(
      'run-universe-missing-run-base',
      'The run recorded files changed before it started but no run base to compare them with, so its own changes cannot be told apart. Start a new run.',
    ),
} as const;

export async function resolveRunUniverse(input: {
  workspaceDir: string;
  baseline: PersistedRunBaseline;
  runBase: RunBase | undefined;
}): Promise<RunUniverse> {
  const { workspaceDir } = input;
  const tree = await readRunWorkingTree(workspaceDir, input.baseline, input.runBase);
  const gitDiff =
    tree.base.kind === 'working-tree-only'
      ? await getCurrentDiff(workspaceDir, tree.untracked)
      : await getDiffSince(workspaceDir, tree.base.ref, tree.untracked);
  const sections = splitDiffByFile(gitDiff);
  const diffs = sections
    .filter(({ before, after }) => !tree.notRunFiles.has(before) && !tree.notRunFiles.has(after))
    .map(({ diff }) => diff);
  for (const [path, atBase] of tree.preRunChanges) {
    const before = atBase.kind === 'changed' ? atBase.base : null;
    if (atBase.kind === 'changed' && before === null) {
      // The base snapshot holds no copy to start from: the diff from the base commit stands.
      diffs.push(...sections.filter(({ after }) => after === path).map(({ diff }) => diff));
      continue;
    }
    const current = await readConfinedEntry(workspaceDir, path);
    const after = current.kind === 'file' ? current : null;
    diffs.push(
      await diffFileEntries({
        path,
        // A manifest older than modes recorded none: the current mode stands in for it.
        before:
          before === null
            ? null
            : { bytes: before.bytes, mode: before.mode ?? after?.mode ?? 0o644 },
        after,
      }),
    );
  }
  return {
    fullDiff: diffs.join(''),
    changedFiles: tree.changedFiles,
    preRunFiles: tree.preRunFiles,
    setupFiles: tree.setupFiles,
  };
}

/** The user's own files the run left alone: changed when the run started, not changed by the run. */
export function runUserFiles(
  universe: Pick<RunUniverse, 'preRunFiles' | 'changedFiles'>,
): ReadonlySet<string> {
  return new Set(universe.preRunFiles.filter((file) => !universe.changedFiles.includes(file)));
}

export async function resolveChangedFiles(opts: {
  workspaceDir: string;
  drift: DriftReport | null;
  missing: string[];
  baseline: PersistedRunBaseline | undefined;
  runBase: RunBase | undefined;
}): Promise<string[]> {
  const { workspaceDir, drift, missing, baseline } = opts;
  if (drift) return uniqueSorted(drift.changedFiles);
  if (!baseline) {
    addMissing(missing, 'run-start baseline');
    return [];
  }
  try {
    const { changedFiles: files } = await readRunWorkingTree(workspaceDir, baseline, opts.runBase);
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
