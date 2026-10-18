import { realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { CLI_TOOL_IDS, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { RunnerRole } from '../../core/runners/seat-roles.js';
import { sha256Hex } from '../../utils/sha256.js';

type HostStateEnvKey = 'HOME' | 'USERPROFILE' | 'XDG_CONFIG_HOME' | 'APPDATA' | 'LOCALAPPDATA';

export type SandboxStateRoot = 'home' | 'config' | 'data';

/**
 * Where an entry's host root comes from: a host environment variable as it
 * stands, or a folder resolved the way the tool resolves it. `xdg-config` and
 * `xdg-data` are XDG base folders as OpenCode and Kilo Code resolve them
 * (`xdgBaseDir`), so a set `XDG_CONFIG_HOME` or `XDG_DATA_HOME` replaces the
 * HOME default instead of adding to it. `copilot-home` is Copilot's config
 * folder: `COPILOT_HOME` when set, else `HOME/.copilot`.
 */
export type CliStateSource = HostStateEnvKey | 'xdg-config' | 'xdg-data' | 'copilot-home';

type CliStatePath = Readonly<{
  source: CliStateSource;
  relativePath: string;
  destination: SandboxStateRoot;
  destinationPath: string;
}>;

export const CURSOR_CLI_CONFIG_DESTINATION = '.cursor/cli-config.json';

export const COPILOT_CONFIG_DESTINATION = '.copilot/config.json';

/**
 * The allowlisted host state a file-bridged session channel may reach — never
 * the host HOME itself. Keep this list explicit: adding a path here is an
 * admission decision and must be backed by the corresponding catalog entry.
 * A channel whose credential is an OS keychain item has no entry here at all —
 * see `hostAccountState`. How an entry reaches the child is decided per tool
 * by `CLI_CREDENTIAL_MODELS`: a static secret is copied as a sealed read-only
 * snapshot, a rotating credential is passed through live. Cursor splits by
 * path: the sign-in file is live, the policy file is sandbox-owned.
 */
export const CLI_STATE_PATHS: Readonly<Record<CliToolId, readonly CliStatePath[]>> = {
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
      source: 'xdg-config',
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
      source: 'xdg-data',
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
  copilot: [
    {
      source: 'copilot-home',
      relativePath: 'config.json',
      destination: 'home',
      destinationPath: COPILOT_CONFIG_DESTINATION,
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
      source: 'xdg-config',
      relativePath: 'kilo/auth.json',
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
      source: 'xdg-data',
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
      source: 'xdg-config',
      relativePath: 'cursor/auth.json',
      destination: 'config',
      destinationPath: 'cursor/auth.json',
    },
  ],
  // The installed CLI reads no credential environment variable of its own — its
  // only `CMD_*` names are routing and debug switches — so the session channel
  // carries `env: []` and nothing is allowlisted here. The state directory is
  // `.commandcode`, unhyphenated, unlike the tool id
  // (testing/fixtures/command-code/README.md).
  'command-code': [
    {
      source: 'HOME',
      relativePath: '.commandcode/auth.json',
      destination: 'home',
      destinationPath: '.commandcode/auth.json',
    },
  ],
  antigravity: [],
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
 * state through a live passthrough instead — a per-file link
 * (`passthroughStateFile`) for the tools in `FILE_LINKED_CREDENTIAL_TOOLS`, a
 * directory link (`passthroughStateEntry`) for the rest.
 *
 * Classification is per tool and evidence-driven: codex rotates its ChatGPT
 * refresh token on every refresh (measured); opencode stores the same rotating
 * OAuth family in its auth.json (`"type": "oauth"` entries with refresh
 * tokens, observed on a live install); kilo-code stores kilo.ai session state
 * the same way. Cursor's sign-in file also rotates: on Linux Cursor keeps it in
 * `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json`, and only that file is
 * passed through live. `cli-config.json` is
 * policy (`approvalMode`, sandbox), not a credential: a live link would hand
 * the child the host's `unrestricted` / yolo setting and write-enable a planner
 * that was not given `--force`. Copilot's `oauth_token` is a long-lived GitHub
 * token that does not rotate on use, and Claude Code's file store has shown no
 * rotation — both stay on the sealed snapshot where they use a file. On macOS
 * both keep the token in the login keychain instead, and their channels take
 * the host account (`hostKeychainPlatforms`), so nothing is copied there.
 * Misclassification is asymmetric: passing a static credential through costs
 * only that directory's default privacy, while snapshotting a rotating one
 * destroys the login. CommandCode's `~/.commandcode/auth.json` holds a named
 * long-lived `apiKey` minted once at login — it carries no refresh token and no
 * rotation to lose — so it takes the sealed snapshot rather than a live link.
 */
type CliCredentialModel = 'static-secret' | 'rotating-oauth';

export const CLI_CREDENTIAL_MODELS: Readonly<Record<CliToolId, CliCredentialModel>> = {
  'claude-code': 'static-secret',
  codex: 'rotating-oauth',
  opencode: 'rotating-oauth',
  copilot: 'static-secret',
  'kilo-code': 'rotating-oauth',
  cursor: 'rotating-oauth',
  'command-code': 'static-secret',
  antigravity: 'rotating-oauth',
};

/**
 * Rotating-credential tools whose credential file alone is linked to the host,
 * inside a state directory the sandbox owns. Their host state directory holds
 * more than the credential. Cursor's config folder also holds its
 * `cli-config.json` policy, which a folder link would hand the child. `~/.codex`
 * holds the user's own Codex sessions, thread index, history and logs: with
 * the whole directory linked, a sandboxed codex wrote its rollouts there under
 * the sandbox path, and every later codex call, the user's own included,
 * reported each removed sandbox as `state db returned stale rollout path`.
 * A file link keeps a rotation only when the tool rewrites the file in place.
 * Codex does: `codex login --with-api-key` 0.162.1 against a linked `auth.json`
 * kept the link and rewrote its target (measured 2026-10-13). Cursor writes
 * `auth.json` with `writeFile` and then `chmod`, in place too.
 */
export const FILE_LINKED_CREDENTIAL_TOOLS: ReadonlySet<CliToolId> = new Set(['cursor', 'codex']);

const SANDBOX_ROLES: readonly RunnerRole[] = ['planner', 'implementer'];

export function sandboxRootCandidates(
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
export function sandboxRoot(
  projectDir: string,
  role: RunnerRole | undefined,
  tool?: CliToolId | undefined,
): string {
  const root = join(projectDir, SANDBOX_DIR);
  if (role === undefined) return root;
  return tool === undefined ? join(root, role) : join(root, role, tool);
}

/**
 * The temp directory a sandbox root's children get. It sits in the real system
 * temp directory, outside every project and worktree: under a worktree's ignored
 * `.splitbrief/` a temporary git fixture sees the enclosing repository, and a
 * path as long as a worktree's pushes a unix socket bound in it (tsx's IPC pipe)
 * past macOS's 104-byte limit, which fails with EADDRINUSE. The name is a hash
 * of the root, so each root keeps its own directory and teardown can find it.
 */
export function sandboxTempDir(root: string): string {
  return join(realpathSync(tmpdir()), `sb-${sha256Hex(root).slice(0, 12)}`);
}

/**
 * Drops the temp directory of every sandbox root a project may carry. They live
 * outside the project (`sandboxTempDir`), so removing the project directory does
 * not remove them.
 */
export function removeSandboxTempDirs(projectDir: string): void {
  for (const { role, tool } of sandboxRootCandidates()) {
    rmSync(sandboxTempDir(sandboxRoot(projectDir, role, tool)), { recursive: true, force: true });
  }
}
