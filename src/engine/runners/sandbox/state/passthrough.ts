import { lstat, mkdir, readFile, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import { isENOENT } from '../../../../utils/errno.js';
import {
  existingPath,
  MAX_STATE_FILE_BYTES,
  stateBridgeFailure,
  collectStateCredentialValues,
} from './copy.js';

async function passthroughCredentialValues(
  source: string,
  tool: CliToolId,
): Promise<readonly string[]> {
  if ((await existingPath(source)) !== 'file') return [];
  const stat = await lstat(source);
  if (stat.size > MAX_STATE_FILE_BYTES) throw stateBridgeFailure(tool);
  return collectStateCredentialValues(await readFile(source), tool);
}

/**
 * Live file passthrough for a rotating credential of a tool in
 * `FILE_LINKED_CREDENTIAL_TOOLS`. The sandbox parent is a real directory and
 * only the rotating credential file is a symlink to the host file, so in-place
 * rotation still lands on the host while the tool's other state stays in the
 * sandbox.
 */
export async function passthroughStateFile(
  source: string,
  destination: string,
  tool: CliToolId,
): Promise<readonly string[]> {
  const sourceKind = await existingPath(source);
  if (sourceKind === null) return [];
  if (sourceKind === 'directory' || sourceKind === 'other') throw stateBridgeFailure(tool);

  let resolvedSource: string;
  try {
    resolvedSource = await realpath(source);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  if ((await existingPath(resolvedSource)) !== 'file') throw stateBridgeFailure(tool);

  const destDir = dirname(destination);
  const destDirKind = await existingPath(destDir);
  if (destDirKind !== null && destDirKind !== 'directory') {
    throw stateBridgeFailure(tool);
  }
  await mkdir(destDir, { recursive: true });

  const destKind = await existingPath(destination);
  if (destKind === 'symlink' && (await readlink(destination)) === resolvedSource) {
    return passthroughCredentialValues(resolvedSource, tool);
  }
  if (destKind === 'directory' || destKind === 'other') throw stateBridgeFailure(tool);
  if (destKind !== null) await rm(destination, { force: true });
  await symlink(resolvedSource, destination, 'file');
  return passthroughCredentialValues(resolvedSource, tool);
}

/**
 * Live passthrough for a `rotating-oauth` tool outside
 * `FILE_LINKED_CREDENTIAL_TOOLS`: the sandbox path to its state directory is
 * a symlink to the real host directory, so the tool itself persists a
 * refreshed token to the host file with its own write path. That is the only
 * shape that survives every way a rotation can land — in-place write,
 * tempfile-and-rename inside the directory, a run killed before any teardown — because there is no copy to
 * go stale and no copy-back step to miss. The directory, not the credential
 * file, is linked: a file symlink is silently replaced by a rename-persisting
 * tool and the rotation is lost again.
 *
 * The host directory must be a real directory; anything else fails the bridge
 * closed rather than guessing at what the link would expose. An absent host
 * directory bridges nothing — the child truthfully sees no credential.
 */
export async function passthroughStateEntry(
  source: string,
  destination: string,
  root: string,
  tool: CliToolId,
): Promise<readonly string[]> {
  const sourceDir = dirname(source);
  const linkDir = dirname(destination);
  // Linking the sandbox root itself would hand the child its whole HOME back.
  if (linkDir === root) throw stateBridgeFailure(tool);
  let resolvedSourceDir: string;
  try {
    resolvedSourceDir = await realpath(sourceDir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  if ((await existingPath(resolvedSourceDir)) !== 'directory') throw stateBridgeFailure(tool);

  const linkKind = await existingPath(linkDir);
  if (linkKind === 'symlink' && (await readlink(linkDir)) === resolvedSourceDir) {
    return passthroughCredentialValues(source, tool);
  }
  if (linkKind === 'symlink') {
    await rm(linkDir, { force: true });
  } else if (linkKind !== null) {
    // A sealed snapshot left by an earlier build, or child litter. It is a
    // verified real directory inside the sandbox, and `rm` never follows the
    // symlinks it may contain.
    await rm(linkDir, { recursive: true, force: true });
  }
  await mkdir(dirname(linkDir), { recursive: true });
  await symlink(resolvedSourceDir, linkDir, 'dir');
  return passthroughCredentialValues(source, tool);
}
