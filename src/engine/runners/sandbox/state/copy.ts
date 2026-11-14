import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import { error } from '../../../../utils/error.js';
import { collectStateStrings, addStateRedactionValue } from '../credential-values.js';

const READONLY_STATE_FILE_MODE = 0o400;
// Keep snapshot directories owner-only and removable by the staged-project
// teardown.  Individual state files are sealed read-only; a runner may remove
// or replace its private copy without ever reaching the host source. Both
// modes apply to `static-secret` snapshots only: a rotating credential has no
// sandbox copy to seal.
const READONLY_STATE_DIRECTORY_MODE = 0o700;
export const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;

export function collectStateCredentialValues(content: Buffer, tool: CliToolId): readonly string[] {
  const text = content.toString('utf8');
  if (text.includes('\uFFFD')) throw stateBridgeFailure(tool);

  const values = new Set<string>();
  try {
    collectStateStrings(JSON.parse(text) as unknown, values);
  } catch {
    // A few supported CLIs have historically used line-oriented state files.
    // Preserve fail-closed isolation while still redacting every
    // credential-shaped token in a bounded plain-text snapshot.
    for (const token of text.split(/[^\p{L}\p{N}_./:+@=-]+/u)) {
      addStateRedactionValue(token, values);
    }
    if (values.size === 0 && text.length > 0) values.add(text);
  }
  return [...values];
}

export function stateBridgeFailure(tool: CliToolId): Error {
  return error(
    'cli-state-bridge-failed',
    `Unable to create an isolated session state bridge for ${tool}`,
    { tool },
  );
}

export async function existingPath(
  path: string,
): Promise<'directory' | 'file' | 'symlink' | 'other' | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function ensureReadOnlyDirectory(path: string, tool: CliToolId): Promise<void> {
  const kind = await existingPath(path);
  if (kind === 'symlink' || (kind !== null && kind !== 'directory')) {
    throw stateBridgeFailure(tool);
  }
  // Keep the directory writable while its snapshot entries are copied; the
  // caller seals it with READONLY_STATE_DIRECTORY_MODE after the last child.
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function copyReadOnlyStateEntry(
  source: string,
  destination: string,
  tool: CliToolId,
): Promise<readonly string[]> {
  const sourceKind = await existingPath(source);
  if (sourceKind === null || sourceKind === 'symlink' || sourceKind === 'other') return [];
  if (sourceKind === 'directory') {
    throw stateBridgeFailure(tool);
  }

  // The destination's parent must be examined before the destination itself:
  // a child-planted symlink there would make every check below — and the
  // replace-on-change `rm` — operate on the host's real file.
  const destinationDirKind = await existingPath(dirname(destination));
  if (destinationDirKind !== null && destinationDirKind !== 'directory') {
    throw stateBridgeFailure(tool);
  }

  const destinationKind = await existingPath(destination);
  if (
    destinationKind === 'symlink' ||
    destinationKind === 'other' ||
    destinationKind === 'directory'
  ) {
    throw stateBridgeFailure(tool);
  }

  const stat = await lstat(source);
  if (!stat.isFile() || stat.size > MAX_STATE_FILE_BYTES) {
    throw stateBridgeFailure(tool);
  }
  const content = await readFile(source);
  const credentialValues = collectStateCredentialValues(content, tool);
  // A snapshot that outlives a re-login or a rotated session token keeps handing
  // the child a credential the host no longer holds, so replace it whenever the
  // admitted source has moved on.
  if (destinationKind !== null) {
    if ((await readFile(destination)).equals(content)) return credentialValues;
    await rm(destination, { force: true });
  }
  await ensureReadOnlyDirectory(dirname(destination), tool);
  try {
    await writeFile(destination, content, {
      mode: READONLY_STATE_FILE_MODE,
      flag: 'wx',
    });
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
    // A concurrent acquisition sealed the same snapshot between the check above
    // and this write (teardown runs outside the creation lock). Accept it only
    // when the content is already the intended copy; anything else is a genuine
    // conflict.
    const existing = await readFile(destination);
    if (!existing.equals(content)) throw stateBridgeFailure(tool);
  }
  await chmod(destination, READONLY_STATE_FILE_MODE);
  await chmod(dirname(destination), READONLY_STATE_DIRECTORY_MODE);
  return credentialValues;
}
