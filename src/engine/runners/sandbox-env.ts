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
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import {
  cliAuthChannelHostStateAccess,
  CLI_TOOL_IDS,
  defaultCliAuthChannel,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliHostStateAccess,
  type CliToolId,
  type RunnerRole,
} from '../../core/runners/cli-tool-catalog.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import { apiKeyEnvReference } from '../providers/client/api-key.js';
import { SECURE_DIR_MODE } from '../../lib/fs.js';
import { createSanitizedChildEnv } from '../../lib/process/spawn/child-env.js';
import { error } from '../../utils/error.js';
import { sanitizedRuntimePath } from './resolve-cli-executable.js';

type RunnerLike = PlannerConfig | ImplementerConfig;

type HostStateEnvKey =
  | 'HOME'
  | 'USERPROFILE'
  | 'XDG_CONFIG_HOME'
  | 'XDG_DATA_HOME'
  | 'APPDATA'
  | 'LOCALAPPDATA';

type SandboxStateRoot = 'home' | 'config' | 'data';

type CliStatePath = Readonly<{
  source: HostStateEnvKey;
  relativePath: string;
  destination: SandboxStateRoot;
  destinationPath: string;
}>;

/**
 * Keeps a resolved CLI's directory first without discarding the sanitized
 * runtime PATH its shebang interpreter needs.
 */
export function prependCliExecutableDirectory({
  executablePath,
  safeRuntimePath,
}: Readonly<{ executablePath: string; safeRuntimePath: string }>): string {
  if (!isAbsolute(executablePath)) {
    throw error('cli-executable-path-invalid', 'Resolved CLI executable path must be absolute.');
  }
  const paths = new Set<string>([dirname(executablePath)]);
  for (const entry of safeRuntimePath.split(delimiter)) {
    if (entry.length > 0 && isAbsolute(entry)) paths.add(entry);
  }
  return [...paths].join(delimiter);
}

/**
 * Returns a new environment with `directory` first on PATH. The spread over
 * the input drops the non-enumerable credential metadata, so it is re-attached
 * from the source env before the copy is handed to a child.
 */
export function withPrependedPathDirectory(
  env: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv {
  if (!isAbsolute(directory)) {
    throw error('prepended-path-invalid', 'Directory to prepend to PATH must be absolute.');
  }
  const result = { ...env };
  const entries = new Set<string>([directory]);
  for (const entry of (result.PATH ?? '').split(delimiter)) {
    if (entry.length > 0 && isAbsolute(entry)) entries.add(entry);
  }
  result.PATH = [...entries].join(delimiter);
  const credentialValues = sandboxCredentialValues(env);
  if (credentialValues.length > 0) {
    Object.defineProperty(result, SANDBOX_CREDENTIAL_VALUES, {
      value: credentialValues,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

const CURSOR_CLI_CONFIG_DESTINATION = '.cursor/cli-config.json';
const CURSOR_SANDBOX_CLI_CONFIG = JSON.stringify({
  version: 1,
  editor: { vimMode: false },
  permissions: { allow: [], deny: [] },
  approvalMode: 'allowlist',
  sandbox: { mode: 'enabled' },
});

/**
 * The allowlisted host state a file-bridged session channel may reach — never
 * the host HOME itself. Keep this list explicit: adding a path here is an
 * admission decision and must be backed by the corresponding catalog entry.
 * A channel whose credential is an OS keychain item has no entry here at all —
 * see `hostAccountState`. How an entry reaches the child is decided per tool
 * by `CLI_CREDENTIAL_MODELS`: a static secret is copied as a sealed read-only
 * snapshot, a rotating credential is passed through live. Cursor splits by
 * path: the session file is live, the policy file is sandbox-owned.
 */
const CLI_STATE_PATHS: Readonly<Record<CliToolId, readonly CliStatePath[]>> = {
  'claude-code': [
    {
      source: 'HOME',
      relativePath: '.claude/.credentials.json',
      destination: 'home',
      destinationPath: '.claude/.credentials.json',
    },
    {
      source: 'APPDATA',
      relativePath: 'Claude/credentials.json',
      destination: 'config',
      destinationPath: 'Claude/credentials.json',
    },
  ],
  codex: [
    {
      source: 'HOME',
      relativePath: '.codex/auth.json',
      destination: 'home',
      destinationPath: '.codex/auth.json',
    },
  ],
  opencode: [
    {
      source: 'HOME',
      relativePath: '.config/opencode/auth.json',
      destination: 'config',
      destinationPath: 'opencode/auth.json',
    },
    {
      source: 'XDG_CONFIG_HOME',
      relativePath: 'opencode/auth.json',
      destination: 'config',
      destinationPath: 'opencode/auth.json',
    },
    {
      source: 'APPDATA',
      relativePath: 'opencode/auth.json',
      destination: 'config',
      destinationPath: 'opencode/auth.json',
    },
    {
      source: 'HOME',
      relativePath: '.local/share/opencode/auth.json',
      destination: 'data',
      destinationPath: 'opencode/auth.json',
    },
    {
      source: 'XDG_DATA_HOME',
      relativePath: 'opencode/auth.json',
      destination: 'data',
      destinationPath: 'opencode/auth.json',
    },
    {
      source: 'LOCALAPPDATA',
      relativePath: 'opencode/auth.json',
      destination: 'data',
      destinationPath: 'opencode/auth.json',
    },
  ],
  aider: [],
  copilot: [
    {
      source: 'HOME',
      relativePath: '.copilot/config.json',
      destination: 'home',
      destinationPath: '.copilot/config.json',
    },
    {
      source: 'HOME',
      relativePath: '.config/github-copilot/apps.json',
      destination: 'config',
      destinationPath: 'github-copilot/apps.json',
    },
    {
      source: 'HOME',
      relativePath: '.config/github-copilot/hosts.json',
      destination: 'config',
      destinationPath: 'github-copilot/hosts.json',
    },
    {
      source: 'XDG_CONFIG_HOME',
      relativePath: 'github-copilot/apps.json',
      destination: 'config',
      destinationPath: 'github-copilot/apps.json',
    },
    {
      source: 'XDG_CONFIG_HOME',
      relativePath: 'github-copilot/hosts.json',
      destination: 'config',
      destinationPath: 'github-copilot/hosts.json',
    },
    {
      source: 'APPDATA',
      relativePath: 'GitHub Copilot/apps.json',
      destination: 'config',
      destinationPath: 'GitHub Copilot/apps.json',
    },
    {
      source: 'LOCALAPPDATA',
      relativePath: 'GitHub Copilot/hosts.json',
      destination: 'data',
      destinationPath: 'GitHub Copilot/hosts.json',
    },
  ],
  'kilo-code': [
    {
      source: 'HOME',
      relativePath: '.config/kilo/auth.json',
      destination: 'config',
      destinationPath: 'kilo/auth.json',
    },
    {
      source: 'HOME',
      relativePath: '.config/kilocode/auth.json',
      destination: 'config',
      destinationPath: 'kilocode/auth.json',
    },
    {
      source: 'HOME',
      relativePath: '.kilocode/auth.json',
      destination: 'home',
      destinationPath: '.kilocode/auth.json',
    },
    {
      source: 'XDG_CONFIG_HOME',
      relativePath: 'kilo/auth.json',
      destination: 'config',
      destinationPath: 'kilo/auth.json',
    },
    {
      source: 'XDG_CONFIG_HOME',
      relativePath: 'kilocode/auth.json',
      destination: 'config',
      destinationPath: 'kilocode/auth.json',
    },
    {
      source: 'APPDATA',
      relativePath: 'kilo/auth.json',
      destination: 'config',
      destinationPath: 'kilo/auth.json',
    },
    {
      source: 'HOME',
      relativePath: '.local/share/kilo/auth.json',
      destination: 'data',
      destinationPath: 'kilo/auth.json',
    },
    {
      source: 'XDG_DATA_HOME',
      relativePath: 'kilo/auth.json',
      destination: 'data',
      destinationPath: 'kilo/auth.json',
    },
    {
      source: 'LOCALAPPDATA',
      relativePath: 'kilo/auth.json',
      destination: 'data',
      destinationPath: 'kilo/auth.json',
    },
  ],
  cursor: [
    {
      source: 'HOME',
      relativePath: CURSOR_CLI_CONFIG_DESTINATION,
      destination: 'home',
      destinationPath: CURSOR_CLI_CONFIG_DESTINATION,
    },
    {
      source: 'HOME',
      relativePath: '.cursor/agent-cli-state.json',
      destination: 'home',
      destinationPath: '.cursor/agent-cli-state.json',
    },
  ],
};

/**
 * Whether a tool's file credential is an immutable secret to snapshot or
 * mutable OAuth state the tool must be able to rewrite mid-run.
 *
 * `static-secret` — the credential does not change when used; a sealed
 * read-only copy is safe and keeps the host file out of the child's reach.
 *
 * `rotating-oauth` — the provider invalidates the previous refresh token
 * server-side the moment the tool refreshes, before the tool persists the
 * replacement. A snapshot of such a credential is a time bomb: the child's
 * refresh rotates the token at the provider, the rotated value lands in a copy
 * (or nowhere, against a read-only copy), teardown discards it, and the host
 * is left holding a refresh token the server has already burned. Measured
 * first-hand against codex on 2026-08-06: a 0o400 snapshot turned one expired
 * access token into an unrecoverable signed-out host. These tools read their
 * state through a live passthrough instead — a directory link
 * (`passthroughStateEntry`) when that directory is tool-private, or a per-file
 * link (`passthroughStateFile`) when it is not.
 *
 * Classification is per tool and evidence-driven: codex rotates its ChatGPT
 * refresh token on every refresh (measured); opencode stores the same rotating
 * OAuth family in its auth.json (`"type": "oauth"` entries with refresh
 * tokens, observed on a live install); kilo-code stores kilo.ai session state
 * the same way. Cursor's session file also rotates, but `~/.cursor` is the Cursor
 * IDE home — not a tool-private directory like `~/.codex` — so only
 * `agent-cli-state.json` is passed through live (`passthroughStateFile`);
 * linking the parent would admit every other file there. `cli-config.json` is
 * policy (`approvalMode`, sandbox), not a credential: a live link would hand
 * the child the host's `unrestricted` / yolo setting and write-enable a planner
 * that was not given `--force`. Copilot's `oauth_token` is a long-lived GitHub
 * token that does not rotate on use, and Claude Code's file store has shown no
 * rotation — both stay on the sealed snapshot. Misclassification is asymmetric:
 * passing a static credential through costs only that directory's default
 * privacy, while snapshotting a rotating one destroys the login.
 */
type CliCredentialModel = 'static-secret' | 'rotating-oauth';

const CLI_CREDENTIAL_MODELS: Readonly<Record<CliToolId, CliCredentialModel>> = {
  'claude-code': 'static-secret',
  codex: 'rotating-oauth',
  opencode: 'rotating-oauth',
  aider: 'static-secret',
  copilot: 'static-secret',
  'kilo-code': 'rotating-oauth',
  cursor: 'rotating-oauth',
};

const READONLY_STATE_FILE_MODE = 0o400;
// Keep snapshot directories owner-only and removable by the staged-project
// teardown.  Individual state files are sealed read-only; a runner may remove
// or replace its private copy without ever reaching the host source. Both
// modes apply to `static-secret` snapshots only: a rotating credential has no
// sandbox copy to seal.
const READONLY_STATE_DIRECTORY_MODE = 0o700;
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Internal-only metadata attached to a sandbox environment for parent-side
 * redaction. It is non-enumerable, never copied into a child process, and is
 * deliberately kept out of the public environment key space.
 */
export const SANDBOX_CREDENTIAL_VALUES = Symbol('splitbrief.sandboxCredentialValues');

const MAX_STATE_REDACTION_VALUE_BYTES = 8 * 1024 * 1024;
/**
 * Bridged state files carry long opaque tokens next to short descriptive
 * values — `subscriptionType: "max"`, `type: "oauth"`. Redacting those would
 * shred every runner delta containing "max" or "oauth", so only values long
 * enough to be a credential are handed to the redactor.
 */
const MIN_STATE_REDACTION_VALUE_LENGTH = 12;

function addStateRedactionValue(candidate: string, values: Set<string>): void {
  if (candidate.length < MIN_STATE_REDACTION_VALUE_LENGTH) return;
  if (Buffer.byteLength(candidate, 'utf8') > MAX_STATE_REDACTION_VALUE_BYTES) return;
  values.add(candidate);
}

export function sandboxCredentialValues(environment: unknown): readonly string[] {
  if (typeof environment !== 'object' || environment === null) return [];
  let value: unknown;
  try {
    value = Reflect.get(environment, SANDBOX_CREDENTIAL_VALUES);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
}

function collectStateStrings(value: unknown, values: Set<string>): void {
  if (typeof value === 'string') {
    addStateRedactionValue(value, values);
    // A composite value ("Bearer <token>") reaches the child as its token
    // alone, so keep the credential-shaped parts as well.
    for (const token of value.split(/[^\p{L}\p{N}_./:+@=-]+/u)) {
      addStateRedactionValue(token, values);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStateStrings(entry, values);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const entry of Object.values(value)) collectStateStrings(entry, values);
}

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

async function bridgeCliState(
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

const SANDBOX_ROLES: readonly RunnerRole[] = ['planner', 'implementer'];

function sandboxRootCandidates(
  tool?: CliToolId,
): readonly { role: RunnerRole | undefined; tool: CliToolId | undefined }[] {
  if (tool !== undefined) {
    return SANDBOX_ROLES.map((role) => ({ role, tool }));
  }
  return [
    { role: undefined, tool: undefined },
    ...SANDBOX_ROLES.flatMap((role) => [
      { role, tool: undefined },
      ...CLI_TOOL_IDS.map((cliTool) => ({ role, tool: cliTool })),
    ]),
  ];
}

/**
 * Each role gets its own sandbox root; each CLI tool on that role gets a root
 * beneath it so one tool's live credential link never lands in another tool's
 * HOME. A run's roles share one worktree, so a single root would make one
 * role's bridged-credential destination the other's, and two runners of the
 * same tool on different auth channels would clear and re-bridge over each
 * other. The unscoped root is left only for a caller that has no role to name —
 * a detection probe, a readiness probe, a conformance harness, each of which
 * works in its own fresh temporary directory — and no role-scoped acquisition
 * ever writes into it. Every runner acquisition names its role, which
 * `createRunnerSandboxEnv` requires.
 */
function sandboxRoot(
  projectDir: string,
  role: RunnerRole | undefined,
  tool?: CliToolId | undefined,
): string {
  const root = join(projectDir, SANDBOX_DIR);
  if (role === undefined) return root;
  return tool === undefined ? join(root, role) : join(root, role, tool);
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
async function clearBridgedStateUnder(root: string, tool: CliToolId | undefined): Promise<void> {
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

/**
 * Drops per-project npm cache directories staged under every sandbox root a run
 * may have written. Each role and CLI tool carries its own cache so one
 * project's install artifacts never leak into another's.
 */
export async function pruneSandboxNpmCache(projectDir: string): Promise<void> {
  await Promise.all(
    sandboxRootCandidates().map(({ role, tool }) =>
      rm(join(sandboxRoot(projectDir, role, tool), 'npm-cache'), { recursive: true, force: true }),
    ),
  );
}

export function resolveCliRunnerAuth(runner: Extract<RunnerLike, { kind: 'cli' }>): CliAuthChannel {
  if (runner.authChannel === undefined) return defaultCliAuthChannel(runner.tool);
  const channel = selectCliAuthChannel(runner.tool, { channel: runner.authChannel });
  if (channel === undefined) {
    throw error(
      'runner-auth-channel-invalid',
      `CLI runner "${runner.tool}" does not support authChannel "${runner.authChannel}"`,
      { tool: runner.tool, authChannel: runner.authChannel },
    );
  }
  return channel;
}

export function runnerAuthEnvKeys(runner: RunnerLike): string[] {
  const keys = new Set<string>();
  if ('apiKey' in runner) {
    const ref = apiKeyEnvReference(runner.apiKey);
    if (ref) keys.add(ref);
  }
  switch (runner.kind) {
    case 'api': {
      const descriptor = getApiProviderDescriptor(runner.provider);
      if (descriptor?.credentialEnv) keys.add(descriptor.credentialEnv);
      break;
    }
    case 'agent-sdk':
      keys.add('ANTHROPIC_API_KEY');
      break;
    case 'cli': {
      const channel = resolveCliRunnerAuth(runner);
      for (const envVar of channel.env) keys.add(envVar);
      break;
    }
  }
  return [...keys];
}

/**
 * Two runners with the same identity are handed byte-identical sandbox
 * environments for a directory, so one env may be built once and reused for
 * both. Only non-secret discriminators go in: environment variable names,
 * never their values, and never a literal `apiKey`.
 */
export function runnerSandboxIdentity(runner: RunnerLike): string {
  const parts: string[] = [runner.kind];
  if (runner.kind === 'cli') parts.push(runner.tool, resolveCliRunnerAuth(runner).id);
  if (runner.kind === 'api') parts.push(runner.provider);
  return [...parts, ...runnerAuthEnvKeys(runner).toSorted()].join('\u0000');
}

/**
 * The host account state a `host-account` channel's child keeps. macOS resolves
 * the login keychain through `HOME` and keys the session item on the account
 * name in `USER` for keychain-backed session channels (Claude Code and Cursor).
 * Measured against `claude auth status` on 2026-08-06, a child given the real
 * `HOME` but not `USER` still reports `"loggedIn": false`. Nothing else the
 * sandbox redirects is handed back, so temp, cache and XDG state stay isolated
 * — but this child does read and write the real home directory. See
 * docs/WORKTREES.md.
 */
function hostAccountState(): Readonly<Record<string, string>> {
  const home = homedir();
  return { HOME: home, USERPROFILE: home, USER: userInfo().username };
}

/**
 * Serializes sandbox creation for one (projectDir, role, tool) root. Concurrent
 * acquisitions of the same root — exactly what concurrent batches do — would
 * interleave clear and bridge: one clears while the other writes, `wx` writes
 * collide with EEXIST, and a just-sealed read-only state dir can reject a
 * concurrent `rm` with EACCES. Each root gets one in-process chain; teardown
 * (`clearBridgedCliState`) still runs outside it, so the snapshot write
 * re-checks EEXIST instead of assuming the chain held.
 */
const sandboxCreationChains = new Map<string, Promise<void>>();

function withSandboxCreationLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = sandboxCreationChains.get(key) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.then(releaseChain, releaseChain);
  sandboxCreationChains.set(key, tail);
  return run;

  function releaseChain(): void {
    if (sandboxCreationChains.get(key) === tail) sandboxCreationChains.delete(key);
  }
}

/**
 * Builds the sandbox environment one runner is handed. `selectedCli` names the
 * CLI the environment belongs to: only that tool's snapshot is cleared, so a
 * second runner sharing this sandbox keeps the state it is still reading.
 * `hostState` says how that CLI's host credential reaches the child —
 * `bridged-files` bridges the allowlisted state in (a sealed snapshot for a
 * static secret, a live passthrough for a rotating one — see
 * `CLI_CREDENTIAL_MODELS`), `host-account` copies nothing and hands back the
 * host `HOME`/`USER` its OS keychain resolves through, `none` does neither. Without a `selectedCli` — an `api` or
 * `agent-sdk` runner — nothing is cleared and nothing is bridged: the child
 * reads no CLI state, so it has none to refresh. `role` selects that runner's
 * own sandbox root, which is what keeps a role's clear off a sibling role's
 * live snapshot.
 */
export async function createSandboxEnv(options: {
  projectDir: string;
  preserveEnvKeys?: string[];
  selectedCli?: CliToolId | undefined;
  hostState?: CliHostStateAccess;
  role?: RunnerRole | undefined;
}): Promise<NodeJS.ProcessEnv> {
  const {
    projectDir,
    preserveEnvKeys = [],
    selectedCli,
    hostState = 'bridged-files',
    role,
  } = options;
  return withSandboxCreationLock(
    `${projectDir}\u0000${role ?? ''}\u0000${selectedCli ?? ''}`,
    async () => {
      const root = sandboxRoot(projectDir, role, selectedCli);
      const home = join(root, 'home');
      const tmp = join(root, 'tmp');
      const cache = join(root, 'cache');
      const config = join(root, 'config');
      const data = join(root, 'data');
      const npmCache = join(root, 'npm-cache');
      const pipCache = join(root, 'pip-cache');
      const cargoHome = join(root, 'cargo');
      await Promise.all(
        [home, tmp, cache, config, data, npmCache, pipCache, cargoHome].map((dir) =>
          mkdir(dir, { recursive: true, mode: SECURE_DIR_MODE }),
        ),
      );
      // A new child must never inherit a previous run's selected session state,
      // including when this invocation selects an API-key channel instead. The clear
      // is confined to this role's own root, so it can only reach a snapshot this
      // role bridged. A runner with no CLI identity has no snapshot of its own to
      // drop and must not touch another runner's. Teardown sweeps what is left.
      if (selectedCli !== undefined) await clearBridgedStateUnder(root, selectedCli);
      const env = createSanitizedChildEnv(process.env, preserveEnvKeys);
      const sandboxState = {
        PATH: await sanitizedRuntimePath(projectDir),
        ...(hostState === 'host-account' ? hostAccountState() : { HOME: home, USERPROFILE: home }),
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        XDG_CACHE_HOME: cache,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        APPDATA: config,
        LOCALAPPDATA: data,
        npm_config_cache: npmCache,
        PIP_CACHE_DIR: pipCache,
        CARGO_HOME: cargoHome,
      };
      let credentialValues: readonly string[] = [];
      if (selectedCli !== undefined && hostState === 'bridged-files') {
        credentialValues = await bridgeCliState(selectedCli, process.env, { home, config, data });
      }
      const result = { ...env, ...sandboxState };
      Object.defineProperty(result, SANDBOX_CREDENTIAL_VALUES, {
        value: Object.freeze([...credentialValues]),
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return result;
    },
  );
}

/**
 * `role` is required. A runner always has one, and an omitted role would put the
 * acquisition back in the shared unscoped root — the exact topology per-role
 * roots exist to remove. Requiring it makes the next call site a type error
 * rather than something a reviewer has to notice.
 */
export async function createRunnerSandboxEnv(
  projectDir: string,
  runner: RunnerLike,
  role: RunnerRole,
): Promise<NodeJS.ProcessEnv> {
  if (runner.kind !== 'cli') {
    return createSandboxEnv({
      projectDir,
      preserveEnvKeys: runnerAuthEnvKeys(runner),
      hostState: 'none',
      role,
    });
  }
  return createSandboxEnv({
    projectDir,
    preserveEnvKeys: runnerAuthEnvKeys(runner),
    selectedCli: runner.tool,
    hostState: cliAuthChannelHostStateAccess(resolveCliRunnerAuth(runner)),
    role,
  });
}
