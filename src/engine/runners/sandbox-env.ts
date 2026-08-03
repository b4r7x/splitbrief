import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import {
  defaultCliAuthChannel,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliToolId,
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
 * A session channel gets a snapshot of the selected CLI's state, never the
 * host HOME itself.  Keep this list explicit: adding a path here is an
 * admission decision and must be backed by the corresponding catalog entry.
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
 * Drop every bridged host-credential snapshot from a project's sandbox. The
 * bridge re-creates whatever the next call needs, so an admitted subscription
 * token never outlives the run it was staged for.
 */
export async function clearBridgedCliState(projectDir: string): Promise<void> {
  const root = join(projectDir, SANDBOX_DIR);
  const stateRoots: Readonly<Record<SandboxStateRoot, string>> = {
    home: join(root, 'home'),
    config: join(root, 'config'),
    data: join(root, 'data'),
  };
  for (const paths of Object.values(CLI_STATE_PATHS)) {
    for (const statePath of paths) {
      await rm(join(stateRoots[statePath.destination], statePath.destinationPath), { force: true });
    }
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

export async function createSandboxEnv(
  projectDir: string,
  preserveEnvKeys: string[] = [],
  bridgeHostCliState?: CliToolId | undefined,
): Promise<NodeJS.ProcessEnv> {
  const root = join(projectDir, SANDBOX_DIR);
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
  // including when this invocation selects an API-key channel instead.
  await clearBridgedCliState(projectDir);
  const env = createSanitizedChildEnv(process.env, preserveEnvKeys);
  const sandboxState = {
    PATH: await sanitizedRuntimePath(projectDir),
    HOME: home,
    USERPROFILE: home,
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
  if (bridgeHostCliState !== undefined) {
    credentialValues = await bridgeCliState(bridgeHostCliState, process.env, {
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

export async function createRunnerSandboxEnv(
  projectDir: string,
  runner: RunnerLike,
): Promise<NodeJS.ProcessEnv> {
  const channel = runner.kind === 'cli' ? resolveCliRunnerAuth(runner) : undefined;
  const bridgeTool =
    runner.kind === 'cli' && channel?.stateBridge === 'host-cli-state' ? runner.tool : undefined;
  return createSandboxEnv(projectDir, runnerAuthEnvKeys(runner), bridgeTool);
}
