import {
  readReviewChanges,
  REVIEW_CHANGES_FILE,
} from '../../../../core/evidence/review-changes.js';
import type { ReviewFileEntry, ReviewProvenance } from '../../../../core/schemas/review-changes.js';
import type { Task } from '../../../../core/schemas/task.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../../core/scope/declared-set.js';
import type { SessionRef } from '../../../../core/types/session-ref.js';
import { diffFileEntries } from '../../../../lib/git/entry-diff.js';
import { splitDiffByFile } from '../../../../lib/git/diff-sections.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { hashTaskBrief } from '../../../../core/evidence/brief-hash.js';
import { readConfinedEntry } from '../../approval/file-snapshots/entry.js';

export type RunReviewFile = { path: string; taskIds: string[]; diff: string };

export type RunReviewScope = {
  /** One diff per file the run's tasks changed, sorted by path. */
  files: RunReviewFile[];
  /** Current workspace vs the last recorded output; raw diffs, without a heading. */
  laterDiff: string;
  /** Workspace diffs of files with no recorded run effect. */
  workspaceContext: RunReviewFile[];
  description: string;
  provenance: ReviewProvenance;
};

function bytes(entry: ReviewFileEntry): { bytes: Buffer; mode: number } | null {
  return entry === null ? null : { bytes: Buffer.from(entry.base64, 'base64'), mode: entry.mode };
}

export async function resolveRunReviewScope(opts: {
  ref: SessionRef;
  workspaceDir: string;
  tasks: readonly Task[];
  workspaceFiles: readonly string[];
  /** The whole workspace diff, from the base to the workspace. */
  workspaceDiff: string;
  /** The files already changed when the run started. */
  preRunFiles: readonly string[];
  mergedPaths?: readonly string[];
}): Promise<RunReviewScope> {
  let status: ReviewProvenance['status'] = 'available';
  let recorded: ReturnType<typeof readReviewChanges> = null;
  try {
    recorded = readReviewChanges(opts.ref);
    if (recorded === null) status = 'missing';
  } catch {
    status = 'invalid';
  }
  const taskHashes = new Map(opts.tasks.map((task) => [task.id, hashTaskBrief([task])]));
  const mergedPaths = new Set(opts.mergedPaths ?? []);
  const mergedDiffs = new Map(
    splitDiffByFile(opts.workspaceDiff).map(({ after, diff }) => [after, diff]),
  );
  const promotedFiles = new Set<string>();
  const uncertainFiles = new Set<string>();
  const lastOutputs = new Map<string, ReviewFileEntry>();
  const changesByPath = new Map<
    string,
    { before: ReviewFileEntry; after: ReviewFileEntry; taskIds: Set<string> }
  >();
  const files: RunReviewFile[] = [];
  const laterDiffs: string[] = [];
  for (const change of recorded?.changes ?? []) {
    if (change.kind === 'unknown' || taskHashes.get(change.taskId) !== change.briefHash) {
      uncertainFiles.add(change.path);
      continue;
    }
    const merged = changesByPath.get(change.path);
    if (merged === undefined) {
      changesByPath.set(change.path, {
        before: change.before,
        after: change.after,
        taskIds: new Set([change.taskId]),
      });
    } else {
      merged.after = change.after;
      merged.taskIds.add(change.taskId);
    }
  }
  for (const [path, change] of [...changesByPath].sort(([a], [b]) => a.localeCompare(b))) {
    lastOutputs.set(path, change.after);
    try {
      const override = mergedPaths.has(path) ? mergedDiffs.get(path) : undefined;
      const diff =
        override ??
        (await diffFileEntries({
          path,
          before: bytes(change.before),
          after: bytes(change.after),
        }));
      if (diff !== '') {
        files.push({ path, taskIds: [...change.taskIds], diff });
        promotedFiles.add(path);
      }
    } catch {
      uncertainFiles.add(path);
    }
  }
  for (const [path, expected] of lastOutputs) {
    if (mergedPaths.has(path)) continue;
    try {
      const current = await readConfinedEntry(opts.workspaceDir, path);
      const matches =
        expected === null
          ? current.kind === 'absent'
          : current.kind === 'file' &&
            current.sha256 === expected.sha256 &&
            (current.mode & 0o777) === expected.mode;
      if (!matches) {
        uncertainFiles.add(path);
        if (promotedFiles.has(path)) {
          laterDiffs.push(
            await diffFileEntries({
              path,
              before: bytes(expected),
              after: current.kind === 'file' ? current : null,
            }),
          );
        }
      }
    } catch {
      uncertainFiles.add(path);
    }
  }
  for (const path of opts.workspaceFiles) {
    if (!promotedFiles.has(path)) uncertainFiles.add(path);
  }
  const suggested = opts.tasks.flatMap((task) => [...taskDeclaredPatterns(task)]);
  const notSuggested = [...promotedFiles].filter((path) => !isInDeclaredSet(path, suggested));
  const provenance: ReviewProvenance = {
    path: REVIEW_CHANGES_FILE,
    status,
    promotedFiles: uniqueSorted([...promotedFiles]),
    workspaceFiles: uniqueSorted([...opts.workspaceFiles]),
    uncertainFiles: uniqueSorted([...uncertainFiles]),
    preRunFiles: uniqueSorted([...opts.preRunFiles]),
  };
  return {
    files,
    laterDiff: laterDiffs.join('\n'),
    workspaceContext: splitDiffByFile(opts.workspaceDiff)
      .filter(({ before, after }) => !promotedFiles.has(after) && !promotedFiles.has(before))
      .map(({ after, diff }) => ({ path: after, taskIds: [], diff })),
    provenance,
    description: [
      `Task completion evidence: ${status} (${REVIEW_CHANGES_FILE}).`,
      'Implementation Diff has one diff per file, from before the first task that touched it to after the last one, headed by the tasks that touched it. Pre-existing operator edits in that input are not run changes.',
      'These are historical effects, not a claim that every effect survives in the current workspace. Workspace Context carries only files with no recorded run effect. Later edits are shown separately; authorship is unknown. Check the current workspace for reversions and interactions across files.',
      `Files with recorded run effects: ${provenance.promotedFiles.join(', ') || 'none recorded'}.`,
      `Files touched, not suggested by any brief: ${uniqueSorted(notSuggested).join(', ') || 'none'}.`,
      `Files with uncertain attribution or later edits: ${provenance.uncertainFiles.join(', ') || 'none observed'}.`,
      `Files already changed when this run started: ${provenance.preRunFiles.join(', ') || 'none'}.`,
      "Those changes are the user's own work, not changes of this run: raise no finding and give no fix task for them. A file among them that the run changed too is a run change only in what the run did; its diff starts at the user's version.",
      'Unknown attribution is not proof of either implementer or operator authorship. Missing or invalid evidence, direct writes without capture and obsolete brief records remain unknown; they are not evidence of an empty run.',
      'Deterministic drift covers the recorded task changes only. A missing expected file in that report can mean missing provenance; inspect the workspace and task evidence before judging it.',
    ].join('\n\n'),
  };
}
