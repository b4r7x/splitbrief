import { join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';
import { CLI_TOOL_IDS, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { RunnerRole } from '../../core/runners/seat-roles.js';

type HostStateEnvKey =
  | 'HOME'
  | 'USERPROFILE'
  | 'XDG_CONFIG_HOME'
  | 'XDG_DATA_HOME'
  | 'APPDATA'
  | 'LOCALAPPDATA';

export type SandboxStateRoot = 'home' | 'config' | 'data';

type CliStatePath = Readonly<{
  source: HostStateEnvKey;
  relativePath: string;
  destination: SandboxStateRoot;
  destinationPath: string;
}>;

export const CURSOR_CLI_CONFIG_DESTINATION = '.cursor/cli-config.json';

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
 * privacy, while snapshotting a rotating one destroys the login. CommandCode's
 * `~/.commandcode/auth.json` holds a named long-lived `apiKey` minted once at
 * login — it carries no refresh token and no rotation to lose — so it takes the
 * sealed snapshot rather than a live link.
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
};

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
