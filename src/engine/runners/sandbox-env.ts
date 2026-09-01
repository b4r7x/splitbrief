import { mkdir, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import {
  cliAuthChannelHostStateAccess,
  defaultCliAuthChannel,
  selectCliAuthChannel,
  type CliAuthChannel,
  type CliHostStateAccess,
  type CliToolId,
} from '../../core/runners/cli-tool-catalog.js';
import type { RunnerRole } from '../../core/runners/seat-roles.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import { apiKeyEnvReference } from '../providers/client/api-key.js';
import { SECURE_DIR_MODE } from '../../lib/fs.js';
import { createSanitizedChildEnv } from '../../lib/process/spawn/child-env.js';
import { error } from '../../utils/error.js';
import { sanitizedRuntimePath } from './resolve-cli-executable.js';
import { SANDBOX_CREDENTIAL_VALUES, sandboxCredentialValues } from './sandbox-credential-values.js';
import { bridgeCliState, clearBridgedStateUnder } from './sandbox-state-bridge.js';
import { sandboxRoot, sandboxRootCandidates } from './sandbox-state-paths.js';

type RunnerLike = PlannerConfig | ImplementerConfig;

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
 * host `HOME`/`USER` its OS keychain resolves through, `none` does neither. Without a `selectedCli` — an `api`
 * runner — nothing is cleared and nothing is bridged: the child
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
