import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { error } from '../../utils/error.js';
import { addStateRedactionValue, collectStateStrings } from './sandbox-credential-values.js';
import {
  CLI_CREDENTIAL_MODELS,
  CLI_STATE_PATHS,
  CURSOR_CLI_CONFIG_DESTINATION,
  sandboxRoot,
  sandboxRootCandidates,
  type SandboxStateRoot,
} from './sandbox-state-paths.js';

const CURSOR_SANDBOX_CLI_CONFIG = JSON.stringify({
  version: 1,
  editor: { vimMode: false },
  permissions: { allow: [], deny: [] },
  approvalMode: 'allowlist',
  sandbox: { mode: 'enabled' },
});

const READONLY_STATE_FILE_MODE = 0o400;
// Keep snapshot directories owner-only and removable by the staged-project
// teardown.  Individual state files are sealed read-only; a runner may remove
// or replace its private copy without ever reaching the host source. Both
// modes apply to `static-secret` snapshots only: a rotating credential has no
// sandbox copy to seal.
const READONLY_STATE_DIRECTORY_MODE = 0o700;
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;

function collectStateCredentialValues(content: Buffer, tool: CliToolId): readonly string[] {
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

function stateBridgeFailure(tool: CliToolId): Error {
  return error(
    'cli-state-bridge-failed',
    `Unable to create an isolated session state bridge for ${tool}`,
    { tool },
  );
}

async function existingPath(
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

async function copyReadOnlyStateEntry(
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
 * Sandbox-owned Cursor policy. `cli-config.json` is not a rotating credential;
 * live-linking the host file would copy `approvalMode: unrestricted` into the
 * planner child. The destination still exists so the child sees the path.
 * Host content is never read.
 */
async function seedCursorCliConfig(
  destination: string,
  tool: CliToolId,
): Promise<readonly string[]> {
  const destDir = dirname(destination);
  const destDirKind = await existingPath(destDir);
  if (destDirKind !== null && destDirKind !== 'directory') {
    throw stateBridgeFailure(tool);
  }
  await mkdir(destDir, { recursive: true });

  const destKind = await existingPath(destination);
  if (destKind === 'directory' || destKind === 'other') throw stateBridgeFailure(tool);
  if (destKind !== null) await rm(destination, { force: true });
  await writeFile(destination, CURSOR_SANDBOX_CLI_CONFIG, { mode: 0o600, flag: 'wx' });
  return [];
}

/**
 * Live file passthrough for a rotating credential whose parent directory is
 * not tool-private. Cursor's `~/.cursor` is the IDE home; linking it would
 * admit every file there. The sandbox parent is a real directory and only
 * the rotating session file is a symlink to the host file, so in-place
 * rotation still lands on the host without exposing sibling paths.
 */
async function passthroughStateFile(
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
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
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
 * Live passthrough for a `rotating-oauth` tool whose state directory is
 * tool-private: the sandbox path to that directory is a symlink to the real
 * host directory, so the tool itself persists a refreshed token to the host
 * file with its own write path. That is the only shape that survives every
 * way a rotation can land — in-place write, tempfile-and-rename inside the
 * directory, a run killed before any teardown — because there is no copy to
 * go stale and no copy-back step to miss. The directory, not the credential
 * file, is linked: a file symlink is silently replaced by a rename-persisting
 * tool and the rotation is lost again.
 *
 * The host directory must be a real directory; anything else fails the bridge
 * closed rather than guessing at what the link would expose. An absent host
 * directory bridges nothing — the child truthfully sees no credential.
 */
async function passthroughStateEntry(
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
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
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

export async function bridgeCliState(
  tool: CliToolId,
  hostEnv: NodeJS.ProcessEnv,
  sandboxState: Readonly<Record<SandboxStateRoot, string>>,
): Promise<readonly string[]> {
  const paths = CLI_STATE_PATHS[tool];
  const model = CLI_CREDENTIAL_MODELS[tool];
  const credentialValues = new Set<string>();
  const verifiedRoots = new Set<string>();
  for (const statePath of paths) {
    const sourceRoot = hostEnv[statePath.source];
    if (sourceRoot === undefined || !isAbsolute(sourceRoot)) continue;
    const root = sandboxState[statePath.destination];
    const source = join(sourceRoot, statePath.relativePath);
    const destination = join(root, statePath.destinationPath);
    try {
      // A sandbox root that is not a real directory — a child-planted symlink,
      // say — would route every path below into the host. Fail closed instead.
      if (!verifiedRoots.has(root)) {
        if ((await existingPath(root)) !== 'directory') throw stateBridgeFailure(tool);
        verifiedRoots.add(root);
      }
      let values: readonly string[];
      if (tool === 'cursor' && statePath.destinationPath === CURSOR_CLI_CONFIG_DESTINATION) {
        values = await seedCursorCliConfig(destination, tool);
      } else if (model === 'rotating-oauth') {
        values =
          tool === 'cursor'
            ? await passthroughStateFile(source, destination, tool)
            : await passthroughStateEntry(source, destination, root, tool);
      } else {
        values = await copyReadOnlyStateEntry(source, destination, tool);
      }
      for (const value of values) {
        credentialValues.add(value);
      }
    } catch {
      // Never fall back to the host path if an admitted bridge cannot be
      // produced.  The caller receives a stable, path-free diagnostic.
      throw stateBridgeFailure(tool);
    }
  }
  return [...credentialValues];
}

/**
 * Whether a credential actually landed where `tool`'s child will look inside
 * `env`. Only the exact destinations `bridgeCliState` writes count: the sandbox
 * roots also hold whatever the child itself writes — Claude Code drops
 * `.claude.json` and a backup during a readiness probe — so "the sandbox HOME
 * is non-empty" is a probe reading its own litter, not evidence of a credential.
 *
 * For a rotating-credential tool the destination resolves through the
 * passthrough link, so presence reports the host file the child will actually
 * read — including a login or logout that happened after the env was built.
 *
 * Ask this only about a `bridged-files` channel. A `host-account` env points at
 * the real home, where these paths belong to the host rather than to any
 * snapshot, and the credential the channel actually uses is a keychain item
 * that leaves no file at all.
 */
export async function bridgedCliStatePresent(
  env: NodeJS.ProcessEnv,
  tool: CliToolId,
): Promise<boolean> {
  const roots: Readonly<Record<SandboxStateRoot, string | undefined>> = {
    home: env.HOME,
    config: env.XDG_CONFIG_HOME,
    data: env.XDG_DATA_HOME,
  };
  for (const statePath of CLI_STATE_PATHS[tool]) {
    // Sandbox-owned policy is not a credential; the session file is.
    if (tool === 'cursor' && statePath.destinationPath === CURSOR_CLI_CONFIG_DESTINATION) {
      continue;
    }
    const root = roots[statePath.destination];
    if (root === undefined) continue;
    const destination = join(root, statePath.destinationPath);
    const kind = await existingPath(destination);
    if (kind === 'file') return true;
    if (
      kind !== 'symlink' ||
      CLI_CREDENTIAL_MODELS[tool] !== 'rotating-oauth' ||
      (await existingPath(dirname(destination))) !== 'directory'
    ) {
      continue;
    }
    let resolved: string;
    try {
      resolved = await realpath(destination);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') continue;
      throw err;
    }
    if ((await existingPath(resolved)) === 'file') return true;
  }
  return false;
}

/**
 * Removes what the bridge itself put at a destination — a snapshot file or a
 * passthrough link — without ever resolving a symlink on the way. Resolving
 * one is how a teardown deletes the user's real credential: with a passthrough
 * (or child-planted) link at the state directory, the naive
 * `rm(<home>/.codex/auth.json)` lands on the host's own auth.json. Every
 * `destinationPath` nests exactly one directory under its root, so one parent
 * check covers the whole traversal.
 */
export async function clearBridgedStateUnder(
  root: string,
  tool: CliToolId | undefined,
): Promise<void> {
  const stateRoots: Readonly<Record<SandboxStateRoot, string>> = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    data: join(root, 'data'),
  };
  const cleared = tool === undefined ? Object.values(CLI_STATE_PATHS) : [CLI_STATE_PATHS[tool]];
  const traversableRoots = new Map<string, boolean>();
  for (const paths of cleared) {
    for (const statePath of paths) {
      const stateRoot = stateRoots[statePath.destination];
      let traversable = traversableRoots.get(stateRoot);
      if (traversable === undefined) {
        const kind = await existingPath(stateRoot);
        // A root that is not a real directory is disarmed, never traversed.
        if (kind !== null && kind !== 'directory') await rm(stateRoot, { force: true });
        traversable = kind === 'directory';
        traversableRoots.set(stateRoot, traversable);
      }
      if (!traversable) continue;
      const parent = dirname(statePath.destinationPath);
      if (parent !== '.') {
        const parentPath = join(stateRoot, parent);
        if ((await existingPath(parentPath)) === 'symlink') {
          // A passthrough's whole footprint is this link; `rm` unlinks it
          // without following, and the host directory stays untouched.
          await rm(parentPath, { force: true });
          continue;
        }
      }
      await rm(join(stateRoot, statePath.destinationPath), { force: true });
    }
  }
}

/**
 * Drop bridged host-credential state — sealed snapshots and passthrough links
 * alike — from every sandbox root a project carries. The bridge re-creates
 * whatever the next call needs, so an admitted snapshot never outlives the run
 * it was staged for, and a passthrough link never outlives it either (the host
 * state behind the link is the user's own and is never touched). A `tool` narrows
 * the clear to that tool's destinations: one role's sandbox still serves that
 * role's runners — two implementer profiles on different tools — and dropping a
 * tool the caller is not re-bridging would strand the runner still reading it.
 * Without one every snapshot goes, which is what teardown needs.
 */
export async function clearBridgedCliState(projectDir: string, tool?: CliToolId): Promise<void> {
  for (const { role, tool: scopedTool } of sandboxRootCandidates(tool)) {
    await clearBridgedStateUnder(sandboxRoot(projectDir, role, scopedTool), scopedTool);
  }
}
