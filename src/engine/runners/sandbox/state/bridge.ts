import { realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { CliToolId } from '../../../../core/runners/cli-tool/types.js';
import { isENOENT } from '../../../../utils/errno.js';
import { xdgBaseDir, hasCliToolHome, cliToolHome } from '../../host-model-selection.js';
import { existingPath, stateBridgeFailure, copyReadOnlyStateEntry } from './copy.js';
import { passthroughStateFile, passthroughStateEntry } from './passthrough.js';
import {
  type CliStateSource,
  type SandboxStateRoot,
  CLI_STATE_PATHS,
  CLI_CREDENTIAL_MODELS,
  FILE_LINKED_CREDENTIAL_TOOLS,
  sandboxRootCandidates,
  sandboxRoot,
} from './paths.js';

function hostStateRoot(
  source: CliStateSource,
  tool: CliToolId,
  hostEnv: NodeJS.ProcessEnv,
): string | undefined {
  switch (source) {
    case 'xdg-config':
      return xdgBaseDir(hostEnv, 'XDG_CONFIG_HOME', hostEnv.HOME);
    case 'xdg-data':
      return xdgBaseDir(hostEnv, 'XDG_DATA_HOME', hostEnv.HOME);
    case 'tool-home':
      return hasCliToolHome(tool) ? cliToolHome(tool, hostEnv, hostEnv.HOME) : undefined;
    default:
      return hostEnv[source];
  }
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
    const sourceRoot = hostStateRoot(statePath.source, tool, hostEnv);
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
      if (model === 'rotating-oauth') {
        values = FILE_LINKED_CREDENTIAL_TOOLS.has(tool)
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
      if (isENOENT(err)) continue;
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
