import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeFileEntries } from '../../../lib/git/entry-merge.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { type FileSnapshotEntry, writeConfinedEntry } from '../approval/file-snapshots/entry.js';
import {
  type ApplyStates,
  type BaseEntry,
  readBaseBytes,
  readSideEntry,
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

function equalsBase(side: SideEntry, base: BaseEntry): boolean {
  return base.kind === 'absent'
    ? side.kind === 'absent'
    : side.kind === 'file' && base.sha256 !== '' && side.sha256 === base.sha256;
}

async function canWriteWorkspaceEntry(workspaceDir: string, path: string): Promise<boolean> {
  assertPathConfined(path, workspaceDir);
  const segments = path.split('/');
  for (let depth = 1; depth <= segments.length; depth++) {
    try {
      const stat = await lstat(join(workspaceDir, ...segments.slice(0, depth)));
      if (depth === segments.length) return stat.isFile();
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
  integrated?: ReadonlyMap<string, string>,
): Promise<ApplyMerge> {
  const paths = [
    ...new Set([...states.base.keys(), ...states.ours.keys(), ...states.theirs.keys()]),
  ].sort();
  const result: ApplyMerge = { promote: [], conflicts: [] };
  const writes: { path: string; entry: FileSnapshotEntry }[] = [];
  for (const path of paths) {
    const base = states.base.get(path) ?? { kind: 'absent' };
    const ours = states.ours.get(path) ?? { kind: 'absent' };
    const theirs = states.theirs.get(path) ?? { kind: 'absent' };
    const conflict = { path, base, ours, theirs };
    if (
      integrated !== undefined &&
      theirs.kind === 'file' &&
      integrated.get(path) === theirs.sha256
    ) {
      result.promote.push(path);
      continue;
    }
    if (ours.kind === 'symlink' || theirs.kind === 'symlink') {
      if (!sameSideEntry(ours, theirs)) {
        result.conflicts.push({ ...conflict, kind: 'unsupported-entry' });
      }
      continue;
    }
    if (sameSideEntry(ours, theirs)) continue;
    if (
      ours.kind === 'file' &&
      theirs.kind === 'file' &&
      ours.sha256 === theirs.sha256 &&
      ours.mode !== theirs.mode
    ) {
      result.conflicts.push({ ...conflict, kind: 'mode' });
      continue;
    }
    if (equalsBase(ours, base)) {
      const entry =
        theirs.kind === 'absent'
          ? theirs
          : await readSideEntry({ states, path, side: 'theirs', expected: theirs });
      writes.push({ path, entry });
      continue;
    }
    if (equalsBase(theirs, base)) {
      result.promote.push(path);
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
    } else if (ours.mode !== theirs.mode) {
      result.conflicts.push({ ...conflict, kind: 'mode' });
    } else {
      writes.push({
        path,
        entry: {
          kind: 'file',
          bytes: merged.bytes,
          sha256: sha256Hex(merged.bytes),
          mode: ours.mode,
        },
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
    await writeConfinedEntry(states.workspaceDir, path, entry);
  }
  return result;
}
