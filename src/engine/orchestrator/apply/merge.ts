import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeFileEntries } from '../../../lib/git/entry-merge.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  type ChangeEntry,
  linkStaysInProject,
  writeConfinedEntryOrLink,
} from '../approval/file-snapshots/entry.js';
import {
  type ApplyStates,
  type BaseEntry,
  entryKey,
  readApplyEntry,
  readBaseBytes,
  readSideEntry,
  sameAsBase,
  sameSideEntry,
  type SideEntry,
  verifyApplyStates,
} from './states.js';

export type ApplyConflictKind =
  | 'text'
  | 'binary'
  | 'delete-modify'
  | 'add-add'
  | 'mode'
  | 'symlink'
  | 'unsupported-entry';

export type ApplyConflict = {
  path: string;
  kind: ApplyConflictKind;
  base: BaseEntry;
  ours: SideEntry;
  theirs: SideEntry;
  markers?: Buffer;
};

export type ApplyMerge = { promote: string[]; conflicts: ApplyConflict[] };

async function canWriteWorkspaceEntry(workspaceDir: string, path: string): Promise<boolean> {
  assertPathConfined(path, workspaceDir);
  const segments = path.split('/');
  for (let depth = 1; depth <= segments.length; depth++) {
    try {
      const stat = await lstat(join(workspaceDir, ...segments.slice(0, depth)));
      if (depth === segments.length) return stat.isFile() || stat.isSymbolicLink();
      if (!stat.isDirectory()) return false;
    } catch (cause) {
      if (isENOENT(cause)) return true;
      throw cause;
    }
  }
  return true;
}

export async function mergeApplyStates(
  states: ApplyStates,
  integrated?: ReadonlyMap<string, { checkout: string; workspace: string | null }>,
): Promise<ApplyMerge> {
  const paths = [
    ...new Set([...states.base.keys(), ...states.ours.keys(), ...states.theirs.keys()]),
  ].sort();
  const result: ApplyMerge = { promote: [], conflicts: [] };
  const writes: { path: string; entry: ChangeEntry }[] = [];
  for (const path of paths) {
    const base = states.base.get(path) ?? { kind: 'absent' };
    const ours = states.ours.get(path) ?? { kind: 'absent' };
    const theirs = states.theirs.get(path) ?? { kind: 'absent' };
    const conflict = { path, base, ours, theirs };
    // A file an earlier Apply handed to the workspace takes the workspace
    // entry while the checkout still holds what that Apply saw and the
    // workspace still holds the resolution the user made; a workspace back at
    // the base still takes the checkout's side.
    const handOff = integrated?.get(path);
    const handedOff =
      handOff !== undefined &&
      handOff.checkout === entryKey(theirs) &&
      handOff.workspace === entryKey(ours);
    if (sameSideEntry(ours, theirs)) continue;
    // A base without a mode, or without the file, cannot tell which side
    // changed a mode-only difference.
    if (
      !handedOff &&
      (base.kind === 'absent' || (base.kind === 'file' && base.mode === undefined)) &&
      ours.kind === 'file' &&
      theirs.kind === 'file' &&
      ours.sha256 === theirs.sha256
    ) {
      result.conflicts.push({ ...conflict, kind: 'mode' });
      continue;
    }
    if (sameAsBase(ours, base)) {
      if (theirs.kind === 'file') {
        writes.push({
          path,
          entry: await readSideEntry({ states, path, side: 'theirs', expected: theirs }),
        });
      } else if (theirs.kind === 'absent') {
        writes.push({ path, entry: theirs });
      } else {
        // A checkout link that leaves the project stays in the checkout only.
        const link = await readApplyEntry(states.projectDir, path);
        if (link?.kind === 'symlink') writes.push({ path, entry: link });
      }
      continue;
    }
    if (handedOff || sameAsBase(theirs, base)) {
      // Apply writes a symlink only when it stays inside the project, in the
      // workspace and through the links of the checkout it lands in.
      const leaves =
        (ours.kind === 'symlink' &&
          ((await readApplyEntry(states.workspaceDir, path)) === null ||
            !(await linkStaysInProject(states.projectDir, path, ours.target)))) ||
        (theirs.kind === 'symlink' && (await readApplyEntry(states.projectDir, path)) === null);
      if (leaves) result.conflicts.push({ ...conflict, kind: 'unsupported-entry' });
      else result.promote.push(path);
      continue;
    }
    if (base.kind === 'absent') {
      result.conflicts.push({ ...conflict, kind: 'add-add' });
      continue;
    }
    if (ours.kind === 'absent' || theirs.kind === 'absent') {
      result.conflicts.push({ ...conflict, kind: 'delete-modify' });
      continue;
    }
    if (base.kind === 'symlink' || ours.kind === 'symlink' || theirs.kind === 'symlink') {
      result.conflicts.push({ ...conflict, kind: 'symlink' });
      continue;
    }

    const [baseBytes, oursEntry, theirsEntry] = await Promise.all([
      readBaseBytes(path, base),
      readSideEntry({ states, path, side: 'ours', expected: ours }),
      readSideEntry({ states, path, side: 'theirs', expected: theirs }),
    ]);
    if (baseBytes?.includes(0) || oursEntry.bytes.includes(0) || theirsEntry.bytes.includes(0)) {
      result.conflicts.push({ ...conflict, kind: 'binary' });
      continue;
    }
    if (baseBytes === null) {
      result.conflicts.push({ ...conflict, kind: 'text' });
      continue;
    }
    const merged = await mergeFileEntries({
      base: baseBytes,
      ours: oursEntry.bytes,
      theirs: theirsEntry.bytes,
    });
    if (merged.kind === 'conflict') {
      result.conflicts.push({ ...conflict, kind: 'text', markers: merged.bytes });
    } else if (merged.kind === 'unmergeable') {
      result.conflicts.push({ ...conflict, kind: 'text' });
    } else {
      const mode =
        ours.mode === theirs.mode || theirs.mode === base.mode
          ? ours.mode
          : ours.mode === base.mode
            ? theirs.mode
            : undefined;
      if (mode === undefined) {
        result.conflicts.push({ ...conflict, kind: 'mode' });
        continue;
      }
      writes.push({
        path,
        entry: { kind: 'file', bytes: merged.bytes, sha256: sha256Hex(merged.bytes), mode },
      });
      result.promote.push(path);
    }
  }

  const supportedWrites: typeof writes = [];
  for (const write of writes) {
    if (await canWriteWorkspaceEntry(states.workspaceDir, write.path)) {
      supportedWrites.push(write);
    } else {
      result.conflicts.push({
        path: write.path,
        kind: 'unsupported-entry',
        base: states.base.get(write.path) ?? { kind: 'absent' },
        ours: states.ours.get(write.path) ?? { kind: 'absent' },
        theirs: states.theirs.get(write.path) ?? { kind: 'absent' },
      });
      result.promote = result.promote.filter((path) => path !== write.path);
    }
  }
  result.conflicts.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  await verifyApplyStates(states);
  for (const { path, entry } of supportedWrites) {
    await writeConfinedEntryOrLink(states.workspaceDir, path, entry);
  }
  return result;
}
