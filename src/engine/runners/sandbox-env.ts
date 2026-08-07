import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import {
  cliAuthChannelHostStateAccess,
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
import { createSanitizedChildEnv } from '../../lib/process/spawn/lifecycle.js';
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

/**
 * A file-bridged session channel gets a snapshot of the selected CLI's state,
 * never the host HOME itself.  Keep this list explicit: adding a path here is
 * an admission decision and must be backed by the corresponding catalog entry.
 * A channel whose credential is an OS keychain item has no entry here at all —
 * see `hostAccountState`.
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
};

const READONLY_STATE_FILE_MODE = 0o400;
// Keep snapshot directories owner-only and removable by the staged-project
// teardown.  Individual state files are sealed read-only; a runner may remove
// or replace its private copy without ever reaching the host source.
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
  await writeFile(destination, content, {
    mode: READONLY_STATE_FILE_MODE,
    flag: 'wx',
  });
  await chmod(destination, READONLY_STATE_FILE_MODE);
  await chmod(dirname(destination), READONLY_STATE_DIRECTORY_MODE);
  return credentialValues;
}

async function bridgeCliState(
  tool: CliToolId,
  hostEnv: NodeJS.ProcessEnv,
  sandboxState: Readonly<Record<SandboxStateRoot, string>>,
): Promise<readonly string[]> {
  const paths = CLI_STATE_PATHS[tool];
  const credentialValues = new Set<string>();
  for (const statePath of paths) {
    const sourceRoot = hostEnv[statePath.source];
    if (sourceRoot === undefined || !isAbsolute(sourceRoot)) continue;
    const source = join(sourceRoot, statePath.relativePath);
    const destination = join(sandboxState[statePath.destination], statePath.destinationPath);
    try {
      for (const value of await copyReadOnlyStateEntry(source, destination, tool)) {
        credentialValues.add(value);
      }
    } catch {
      // Never fall back to the host path if an admitted snapshot cannot be
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
    if ((await existingPath(join(root, statePath.destinationPath))) === 'file') return true;
  }
  return false;
}

const SANDBOX_ROLES: readonly RunnerRole[] = ['planner', 'implementer'];

/**
 * Each role gets its own sandbox root. A run's roles share one worktree, so a
 * single root would make one role's bridged-credential destination the other's,
 * and two runners of the same tool on different auth channels would clear and
 * re-bridge over each other. The unscoped root is left only for a caller that
 * has no role to name — a detection probe, a readiness probe, a conformance
 * harness, each of which works in its own fresh temporary directory — and no
 * role-scoped acquisition ever writes into it. Every runner acquisition names
 * its role, which `createRunnerSandboxEnv` requires.
 */
function sandboxRoot(projectDir: string, role: RunnerRole | undefined): string {
  const root = join(projectDir, SANDBOX_DIR);
  return role === undefined ? root : join(root, role);
}

async function clearBridgedStateUnder(root: string, tool: CliToolId | undefined): Promise<void> {
  const stateRoots: Readonly<Record<SandboxStateRoot, string>> = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    data: join(root, 'data'),
  };
  const cleared = tool === undefined ? Object.values(CLI_STATE_PATHS) : [CLI_STATE_PATHS[tool]];
  for (const paths of cleared) {
    for (const statePath of paths) {
      await rm(join(stateRoots[statePath.destination], statePath.destinationPath), { force: true });
    }
  }
}

/**
 * Drop bridged host-credential snapshots from every sandbox root a project
 * carries. The bridge re-creates whatever the next call needs, so an admitted
 * subscription token never outlives the run it was staged for. A `tool` narrows
 * the clear to that tool's destinations: one role's sandbox still serves that
 * role's runners — two implementer profiles on different tools — and dropping a
 * tool the caller is not re-bridging would strand the runner still reading it.
 * Without one every snapshot goes, which is what teardown needs.
 */
export async function clearBridgedCliState(projectDir: string, tool?: CliToolId): Promise<void> {
  for (const role of [undefined, ...SANDBOX_ROLES]) {
    await clearBridgedStateUnder(sandboxRoot(projectDir, role), tool);
  }
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
 * the login keychain through `HOME` and keys the Claude Code session item on the
 * account name in `USER`; measured against `claude auth status` on 2026-08-06, a
 * child given the real `HOME` but not `USER` still reports `"loggedIn": false`.
 * Nothing else the sandbox redirects is handed back, so temp, cache and XDG
 * state stay isolated — but this child does read and write the real home
 * directory. See docs/WORKTREES.md.
 */
function hostAccountState(): Readonly<Record<string, string>> {
  const home = homedir();
  return { HOME: home, USERPROFILE: home, USER: userInfo().username };
}

/**
 * Builds the sandbox environment one runner is handed. `selectedCli` names the
 * CLI the environment belongs to: only that tool's snapshot is cleared, so a
 * second runner sharing this sandbox keeps the state it is still reading.
 * `hostState` says how that CLI's host credential reaches the child —
 * `bridged-files` copies the allowlisted snapshot in, `host-account` copies
 * nothing and hands back the host `HOME`/`USER` its OS keychain resolves
 * through, `none` does neither. Without a `selectedCli` — an `api` or
 * `agent-sdk` runner — nothing is cleared and nothing is bridged: the child
 * reads no CLI state, so it has none to refresh. `role` selects that runner's
 * own sandbox root, which is what keeps a role's clear off a sibling role's
 * live snapshot.
 */
export async function createSandboxEnv(
  projectDir: string,
  preserveEnvKeys: string[] = [],
  selectedCli?: CliToolId | undefined,
  hostState: CliHostStateAccess = 'bridged-files',
  role?: RunnerRole | undefined,
): Promise<NodeJS.ProcessEnv> {
  const root = sandboxRoot(projectDir, role);
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
      mkdir(dir, { recursive: true }),
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
    credentialValues = await bridgeCliState(selectedCli, process.env, {
      home,
      config,
      data,
    });
  }
  const result = { ...env, ...sandboxState };
  Object.defineProperty(result, SANDBOX_CREDENTIAL_VALUES, {
    value: Object.freeze([...credentialValues]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
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
    return createSandboxEnv(projectDir, runnerAuthEnvKeys(runner), undefined, 'none', role);
  }
  return createSandboxEnv(
    projectDir,
    runnerAuthEnvKeys(runner),
    runner.tool,
    cliAuthChannelHostStateAccess(resolveCliRunnerAuth(runner)),
    role,
  );
}
