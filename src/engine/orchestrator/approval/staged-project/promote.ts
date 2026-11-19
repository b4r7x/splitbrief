import { join } from 'node:path';
import type { EvidencePromotedFile } from '../../../../core/schemas/evidence.js';
import { reachesControlPlane } from '../../../../core/scope/control-plane.js';
import {
  pathConfinementError,
  assertWritablePathConfined,
  assertPathConfined,
} from '../../../../lib/fs/confinement.js';
import { error } from '../../../../utils/error.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { readCurrentFileContent } from '../file-snapshots/contents.js';
import {
  type AcquisitionBaseline,
  matchesAcquisitionBaseline,
} from '../file-snapshots/entry/baseline.js';
import { linkStaysInProject, readProjectSymlink } from '../file-snapshots/entry/link.js';
import { type ChangeEntry, readChangeEntry, sameFileEntry } from '../file-snapshots/entry/read.js';
import { writeConfinedEntryOrLink } from '../file-snapshots/entry/write.js';
import { lstatIfPresent } from './create.js';
import { GITIGNORE_FILE, stripGitignoreBookkeeping } from './gitignore.js';

/** Which file's apply failed and why; the promotion stopped there. */
export type PromotionFailure = { failedFile: string; error: unknown };

export type PromoteStagedChangesResult = {
  promotedFiles: string[];
  conflictedFiles: string[];
  failure?: PromotionFailure;
  /** Exact file entries this call wrote, including a stopped prefix; a symlink write is not listed. */
  appliedFiles?: EvidencePromotedFile[];
};

export const stagedProjectError = {
  conflict: (file: string) =>
    error('staged-promotion-conflict', `Target changed before promotion: ${file}`, { file }),
} as const;

async function entryToPromote(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  file: string;
}): Promise<ChangeEntry> {
  const { targetProjectDir, stagedProjectDir, file } = opts;
  const staged = await readChangeEntry(stagedProjectDir, file);
  if (
    staged.kind === 'symlink' &&
    !(await linkStaysInProject(stagedProjectDir, file, staged.target))
  ) {
    throw pathConfinementError.symlinkRead(join(stagedProjectDir, file));
  }
  if (file !== GITIGNORE_FILE || staged.kind !== 'file') return staged;
  // The .gitignore is the only promoted file whose bytes are decoded: it keeps
  // its bookkeeping strip; every other file is carried byte for byte with its
  // ordinary permission bits.
  const bytes = Buffer.from(
    stripGitignoreBookkeeping(
      staged.bytes.toString('utf8'),
      await readCurrentFileContent(targetProjectDir, file),
    ),
    'utf8',
  );
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode: staged.mode };
}

/**
 * The target already holds exactly what this promotion would write. That is a promotion that
 * already happened — the operator applied the same change, or an earlier attempt got there —
 * and rewriting it would only fail the acquisition recheck.
 */
async function targetHoldsStagedEntry(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  file: string;
}): Promise<boolean> {
  const staged = await entryToPromote(opts);
  const current = await readChangeEntry(opts.targetProjectDir, opts.file);
  if (staged.kind === 'symlink')
    return current.kind === 'symlink' && current.target === staged.target;
  return current.kind !== 'symlink' && sameFileEntry(current, staged);
}

/** The target still holds what it held at acquisition: the recorded link, else the baseline entry. */
async function targetUnchanged(opts: {
  targetProjectDir: string;
  file: string;
  targetBaseline: AcquisitionBaseline;
  targetLinks: ReadonlyMap<string, string> | undefined;
}): Promise<boolean> {
  const { targetProjectDir, file, targetBaseline, targetLinks } = opts;
  const link = targetLinks?.get(file);
  if (link !== undefined) return (await readProjectSymlink(targetProjectDir, file)) === link;
  return matchesAcquisitionBaseline(targetProjectDir, file, targetBaseline);
}

export async function promoteStagedChanges(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  files: string[];
  targetBaseline: AcquisitionBaseline | undefined;
  /** The project symlinks the target held at acquisition; without it the target held none. */
  targetLinks?: ReadonlyMap<string, string>;
  onWrite?: (file: string, entry: ChangeEntry) => void;
}): Promise<PromoteStagedChangesResult> {
  const { targetProjectDir, stagedProjectDir, files, targetBaseline, targetLinks } = opts;
  for (const file of files) {
    assertWritablePathConfined(file, targetProjectDir);
    assertPathConfined(file, stagedProjectDir);
  }
  // A workspace acquired without a baseline holds no authority over the target:
  // an unknown target is a conflict, never an overwrite.
  if (targetBaseline === undefined) return { promotedFiles: [], conflictedFiles: [...files] };

  const preflight = await Promise.all(
    files.map(async (file): Promise<'ok' | 'settled' | 'conflict'> => {
      // A symlink on either side is written over or from only when it stays
      // inside its project; any other link is left for the operator.
      const [target, staged] = await Promise.all([
        lstatIfPresent(join(targetProjectDir, file)),
        lstatIfPresent(join(stagedProjectDir, file)),
      ]);
      if (
        (target?.isSymbolicLink() && (await readProjectSymlink(targetProjectDir, file)) === null) ||
        (staged?.isSymbolicLink() && (await readProjectSymlink(stagedProjectDir, file)) === null)
      ) {
        return 'conflict';
      }
      // A symlinked parent in the target that resolves into `.git` or `.splitbrief`
      // would carry the file into the control plane; the approval saw only its spelling.
      if (reachesControlPlane(file, targetProjectDir)) return 'conflict';
      if (await targetUnchanged({ targetProjectDir, file, targetBaseline, targetLinks })) {
        return 'ok';
      }
      return (await targetHoldsStagedEntry({ targetProjectDir, stagedProjectDir, file }))
        ? 'settled'
        : 'conflict';
    }),
  );
  const conflictedFiles = files.filter((_, index) => preflight[index] === 'conflict');
  if (conflictedFiles.length > 0) {
    return { promotedFiles: [], conflictedFiles };
  }
  const settledFiles = new Set(files.filter((_, index) => preflight[index] === 'settled'));

  const promotedFiles: string[] = [];
  const appliedFiles: EvidencePromotedFile[] = [];
  for (const file of files) {
    const conflict = stagedProjectError.conflict(file);
    try {
      const entry = await entryToPromote({ targetProjectDir, stagedProjectDir, file });
      // Recheck after preparing bytes and mode, immediately before replacement.
      // A filesystem rename is atomic, but is not a portable compare-and-swap.
      if (!settledFiles.has(file)) {
        await writeConfinedEntryOrLink(targetProjectDir, file, entry, async () => {
          if (!(await targetUnchanged({ targetProjectDir, file, targetBaseline, targetLinks }))) {
            throw conflict;
          }
        });
        opts.onWrite?.(file, entry);
        if (entry.kind === 'file') {
          appliedFiles.push({
            path: file,
            sha256: entry.sha256,
            mode: entry.mode & 0o777,
            ...(!targetBaseline.has(file) ? { created: true as const } : {}),
          });
        } else if (entry.kind === 'absent') {
          appliedFiles.push({ path: file, sha256: null, mode: null });
        }
      }
    } catch (err) {
      if (err === conflict) return { promotedFiles, conflictedFiles: [file], appliedFiles };
      // A failed apply stops the promotion where it stands. Nothing is rolled
      // back and no later file is attempted, so promotedFiles is the exact
      // prefix the target now holds and the rest is untouched.
      return {
        promotedFiles,
        conflictedFiles: [],
        appliedFiles,
        failure: { failedFile: file, error: err },
      };
    }
    promotedFiles.push(file);
  }

  return { promotedFiles, conflictedFiles, appliedFiles };
}
