import { pathConfinementError, assertPathConfined } from '../../../lib/fs/confinement.js';
import { fsError } from '../../../lib/fs/secure.js';
import { isNodeError, isENOENT } from '../../../utils/errno.js';
import { linkStaysInProject } from '../approval/file-snapshots/entry/link.js';
import { type ChangeEntry, readChangeEntry } from '../approval/file-snapshots/entry/read.js';
import {
  type ApplyStates,
  type ApplySide,
  type SideEntry,
  normalizeWorkspaceEntry,
  sameSideEntry,
  sideChangedError,
} from './states.js';

type SideReadInput = {
  states: ApplyStates;
  path: string;
  side: ApplySide;
  expected: Extract<SideEntry, { kind: 'file' }>;
};

export function unsafeEntryError(cause: unknown): boolean {
  return (
    fsError.isInvalidId(cause) ||
    fsError.isSymlinkWrite(cause) ||
    pathConfinementError.isSymlinkRead(cause) ||
    pathConfinementError.isSymlinkParent(cause) ||
    pathConfinementError.isEscapesRoot(cause) ||
    (isNodeError(cause) && cause.code === 'ENOTDIR')
  );
}

/** The entry at `path`: a file, nothing, or a project symlink; null for any other entry. */
export async function readApplyEntry(dir: string, path: string): Promise<ChangeEntry | null> {
  assertPathConfined(path, dir);
  try {
    const entry = await readChangeEntry(dir, path);
    if (entry.kind === 'symlink' && !(await linkStaysInProject(dir, path, entry.target))) {
      return null;
    }
    return entry;
  } catch (cause) {
    if (isENOENT(cause)) return { kind: 'absent' };
    if (unsafeEntryError(cause)) return null;
    throw cause;
  }
}

export async function readSideEntry(
  input: SideReadInput,
): Promise<Extract<ChangeEntry, { kind: 'file' }>> {
  const { states, path, side } = input;
  const dir = side === 'ours' ? states.workspaceDir : states.projectDir;
  const observed = await readApplyEntry(dir, path);
  const current =
    observed !== null && side === 'ours'
      ? await normalizeWorkspaceEntry(observed, path, states.base)
      : observed;
  if (current === null || current.kind !== 'file' || !sameSideEntry(current, input.expected)) {
    throw sideChangedError(input.side, input.path);
  }
  return current;
}
