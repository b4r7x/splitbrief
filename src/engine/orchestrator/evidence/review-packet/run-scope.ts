import {
  readReviewChanges,
  REVIEW_CHANGES_FILE,
} from '../../../../core/evidence/review-changes.js';
import type { ReviewFileEntry, ReviewProvenance } from '../../../../core/schemas/review-changes.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { SessionRef } from '../../../../core/types/session-ref.js';
import { diffFileEntries } from '../../../../lib/git/entry-diff.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { hashTaskBrief } from '../../../brief-hash.js';
import { readConfinedEntry } from '../../approval/file-snapshots/entry.js';

export type RunReviewScope = {
  diff: string;
  laterDiff: string;
  description: string;
  provenance: ReviewProvenance;
};

function bytes(entry: ReviewFileEntry): { bytes: Buffer; mode: number } | null {
  return entry === null ? null : { bytes: Buffer.from(entry.base64, 'base64'), mode: entry.mode };
}

export async function resolveRunReviewScope(opts: {
  ref: SessionRef;
  tasks: readonly Task[];
  workspaceFiles: readonly string[];
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
  const promotedFiles = new Set<string>();
  const uncertainFiles = new Set<string>();
  const lastOutputs = new Map<string, ReviewFileEntry>();
  const diffs: string[] = [];
  const laterDiffs: string[] = [];
  for (const change of recorded?.changes ?? []) {
    if (change.kind === 'unknown' || taskHashes.get(change.taskId) !== change.briefHash) {
      uncertainFiles.add(change.path);
      continue;
    }
    try {
      const diff = await diffFileEntries({
        path: change.path,
        before: bytes(change.before),
        after: bytes(change.after),
      });
      if (diff !== '') {
        diffs.push(`# Promotion by ${change.taskId}\n${diff}`);
        promotedFiles.add(change.path);
      }
      lastOutputs.set(change.path, change.after);
    } catch {
      uncertainFiles.add(change.path);
    }
  }
  for (const [path, expected] of lastOutputs) {
    try {
      const current = await readConfinedEntry(opts.ref.projectDir, path);
      const matches =
        expected === null
          ? current.kind === 'absent'
          : current.kind === 'file' &&
            current.sha256 === expected.sha256 &&
            (current.mode & 0o777) === expected.mode;
      if (!matches) {
        uncertainFiles.add(path);
        laterDiffs.push(
          await diffFileEntries({
            path,
            before: bytes(expected),
            after: current.kind === 'file' ? current : null,
          }),
        );
      }
    } catch {
      uncertainFiles.add(path);
    }
  }
  for (const path of opts.workspaceFiles) {
    if (!promotedFiles.has(path)) uncertainFiles.add(path);
  }
  const provenance: ReviewProvenance = {
    path: REVIEW_CHANGES_FILE,
    status,
    promotedFiles: uniqueSorted([...promotedFiles]),
    workspaceFiles: uniqueSorted([...opts.workspaceFiles]),
    uncertainFiles: uniqueSorted([...uncertainFiles]),
  };
  return {
    diff: diffs.join('\n'),
    laterDiff:
      laterDiffs.length === 0
        ? ''
        : `# Changes after the last recorded promotion; authorship unknown\n${laterDiffs.join('\n')}`,
    provenance,
    description: [
      `Promotion evidence: ${status} (${REVIEW_CHANGES_FILE}).`,
      'Implementation Diff contains verified target transitions, in promotion order. Each compares the input accepted by the promotion with the exact bytes it wrote. Pre-existing operator edits in that input are not run changes.',
      'These are historical effects, not a claim that every effect survives in the current workspace. Check the complete Workspace Context for later edits, reversions and interactions across files.',
      `Files with recorded run effects: ${provenance.promotedFiles.join(', ') || 'none recorded'}.`,
      `Files with uncertain attribution or later edits: ${provenance.uncertainFiles.join(', ') || 'none observed'}.`,
      'Unknown attribution is not proof of either implementer or operator authorship. Missing or invalid evidence, direct writes without capture and obsolete brief records remain unknown; they are not evidence of an empty run.',
      'Deterministic drift covers the recorded promotions only. A missing expected file in that report can mean missing provenance; inspect the workspace and task evidence before judging it.',
    ].join('\n\n'),
  };
}
