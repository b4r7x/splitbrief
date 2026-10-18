# Authentication method matrix

Whether SPLITBRIEF can *enforce* an authentication method for a single invocation, per supported CLI tool.

A **method** is how the tool proves who is paying: a subscription session the host holds, or a metered API credential. A **route** is which provider or model the tool talks to. `--oss`, `--local-provider`, `--model`, `--variant`, `COPILOT_PROVIDER_*` and `cmd --local-only` are routes, not methods, and are never presented as an authentication choice.

Verdicts:

- **enforceable** — the adapter forces the selected method for the invocation, and the invocation fails rather than falling back when the selected credential is absent.
- **host-configured** — the tool's own configuration, stored login or documented precedence decides; SPLITBRIEF stages a credential but cannot prove which one the tool takes.
- **unsupported** — no method choice exists to make.

**Result: every supported CLI tool is `host-configured`.** The tool's own configuration decides which method a call uses.

## Current invocation contract

SPLITBRIEF has no enforceable method for any CLI tool. Before it dispatches an explicit `session` or `api-key` choice, it requires positive evidence for the exact tool, platform and installed version. Without that evidence the invocation is refused; omit the selection to use the host CLI configuration. The picker offers no method switch for these tools. A stored login, staged environment or model listing does not establish which billing method a call used.

## Supported CLI tools

| Tool | Declared channels | Method choice offered | Verdict |
|---|---|---|---|
| `claude-code` | `session`, `api-key` | no | host-configured |
| `codex` | `session`, `api-key` | no | host-configured |
| `cursor` | `session`, `api-key` | no | host-configured |
| `opencode` | `provider-dependent` | no | host-configured |
| `kilo-code` | `provider-dependent` | no | host-configured |
| `copilot` | `session` | no | host-configured |
| `command-code` | `session` | no | host-configured |
| `antigravity` | `session` | no | host-configured |

Every tool can hold the planner and the implementer seat; the reviewer seat reuses the planner runner unless a `reviewer` block names its own. "Method choice offered" requires invocation-enforcement evidence, not merely multiple declared channels. The tools that SPLITBRIEF supports only as custom runners (`kiro`, `gemini`, `cline`, `qwen`, `auggie`, `junie`) have no row.

## Per-channel facts

| Tool · channel | Invocation control SPLITBRIEF emits | Credential sources the child keeps | Sources excluded |
|---|---|---|---|
| `claude-code` · `session` | none | macOS: real `HOME`/`USER`, so the login keychain resolves. Linux: sealed read-only copy of `.claude/.credentials.json` | `ANTHROPIC_API_KEY` (not in the channel's `env`) |
| `claude-code` · `api-key` | none | `ANTHROPIC_API_KEY` only | private `HOME`; nothing bridged |
| `codex` · `session` | none | live passthrough of `~/.codex/auth.json` (`rotating-oauth`) | `OPENAI_API_KEY` |
| `codex` · `api-key` | none | `OPENAI_API_KEY` only | private `HOME`; nothing bridged |
| `cursor` · `session` | none | macOS: real `HOME`/`USER` (keychain). Linux: live link to `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` | `CURSOR_API_KEY` |
| `cursor` · `api-key` | none | `CURSOR_API_KEY` only | private `HOME`; nothing bridged |
| `opencode` · `provider-dependent` | none | live passthrough of the OpenCode config and data folders your own OpenCode uses (`$XDG_CONFIG_HOME/opencode` and `$XDG_DATA_HOME/opencode`, or `~/.config/opencode` and `~/.local/share/opencode` when those variables are unset), **plus every `*_API_KEY` in the parent environment** | nothing |
| `kilo-code` · `provider-dependent` | none | live passthrough of the Kilo Code config and data folders your own Kilo Code uses (`$XDG_CONFIG_HOME/kilo` and `$XDG_DATA_HOME/kilo`, or `~/.config/kilo` and `~/.local/share/kilo` when those variables are unset), and of the folders of older Kilo Code versions when they exist (`~/.kilocode`, and `$XDG_CONFIG_HOME/kilocode` or `~/.config/kilocode`), **plus every `*_API_KEY` in the parent environment** | nothing |
| `copilot` · `session` | none | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` **and**, simultaneously, on macOS the real `HOME`/`USER` (keychain) plus a set `COPILOT_HOME`; on Linux a sealed copy of `config.json` from `COPILOT_HOME` or `~/.copilot` and of the Copilot editor-plugin files | nothing |
| `command-code` · `session` | none | sealed copy of the tool's credential files | no credential env var exists |
| `antigravity` · `session` | none | macOS: real `HOME`/`USER` (`host-account`), with no copied files. Linux: no credential bridge | no credential env var is accepted for this tool |

No adapter emits an authentication flag. SPLITBRIEF blocks `--api-key` in a Cursor seat's `invocationArgs`. Method selection therefore reaches every tool the same way: by what the staged environment holds, never by argv.

The `claude-code` implementer argv carries `--settings <JSON>`, but that JSON holds only `sandbox` and `permissions` keys: no `apiKeyHelper` and no `env` block, so it selects no method. Claude Code's sandbox wraps the Bash commands of the seat, not the CLI process, and the seat authenticates on the host-account `session` channel as usual. See [the Claude Code implementer sandbox](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth).

The `*_API_KEY` passthrough on provider-dependent channels is deliberate: OpenCode and Kilo hold no credential of their own, so stripping the host's provider keys would strand the very credentials their model listing was built from. The cost is that these two channels retain *all* competing credentials by construction, so a model on one provider can read the keys of every other provider.

## Behavior under competing, missing and shared credentials

**Competing credentials.** Only Copilot documents a precedence, and it is the host's, not SPLITBRIEF's: `copilot help environment` states that `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in that order) are "an authentication token that takes precedence over previously stored credentials". SPLITBRIEF's Copilot `session` channel declares both the env vars and the host state (the keychain on macOS, the file bridge elsewhere), so both sources are present at once and the tool's rule decides. No other supported tool documents a precedence between an environment credential and a stored login, so for every other tool the installed build decides.

**Missing selected credential.** An explicit `session` or `api-key` selection without exact invocation-enforcement evidence is refused before the child starts, regardless of alternate host credentials. Use host configuration by omitting the choice.

**Shared login state.** SPLITBRIEF does not invoke login, logout or account-switch commands. File staging depends on the tool: Codex, OpenCode and Kilo use live state paths; Cursor does so where its channel uses files. Claude Code, Copilot and Command Code use sealed copies where file staging applies. The macOS session channels for Claude Code, Cursor, Antigravity and Copilot instead keep the real `HOME` and `USER` so the OS keychain is reachable. Those children can update their own host state; the sealed-file guarantee does not apply to them. Antigravity has no file bridge on Linux. These are staging rules, not an authentication-method guarantee.

**Staging parity.** The readiness probe and the runner build their environment from the same channel rules. The only difference is the sandbox root, which changes which directory the child gets, not which credential. A channel that readiness reports as authenticated is staged the same way for the run.

**Catalog-probe exception: OpenCode enumeration.** One probe stands outside that parity, and only for listing models. OpenCode 2 answers `model.list` (`opencode api GET /api/model`) from its own background server. The sandbox cannot supply an `env`-type provider connection to that server, so a staged listing would miss the providers whose credential is an environment variable. The OpenCode catalog probe therefore runs with the host account. It runs in a neutral temporary directory, where the server lists the providers of your stored credentials and of your global OpenCode config. When the project's config puts OpenCode on a seat or a fallback, the probe also names the project directory in the `x-opencode-directory` header, so the list includes the providers that the project's own `opencode.json` sets up. To answer that request, your OpenCode server loads the project's OpenCode config with its plugins and its local MCP servers, as an OpenCode run in that project does. A project whose crew does not use OpenCode is never named to the server. OpenCode's **dispatch** staging is unchanged, so this exception widens no credential — it only lets a listing see the environment the user's own shell has.

## Child environment

SPLITBRIEF builds a separate environment for each kind of child. Seats, readiness probes and catalog probes keep only named variables. Commands SPLITBRIEF runs itself inherit the defined variables and drop credential names, selectors and helpers. Workflow hooks and the `git` commands SPLITBRIEF runs itself keep the full SPLITBRIEF environment.

| Child | What the child gets |
|---|---|
| Planner, reviewer and implementer of kind `cli`, `shell` or `agent`; readiness probe; catalog probe | The runtime keys (`LANG`, `LC_*`, `TZ`, `TERM`, `COLORTERM`, `TERM_PROGRAM*`, `NO_COLOR`, `FORCE_COLOR`, `COLUMNS`, `LINES`), a `PATH` with the project's own directories removed, the staged `HOME`, `XDG_*` and caches, a private `TMPDIR` outside the project (`<system tmp>/sb-<hash>`), and the credential variables of the runner (next table). |
| `customCommands` runner | The runtime keys and the names in the command's `env` list. |
| Plan check, reviewer check, base re-run, the checks of a fix task, `render` check, the formatter, the `--version` availability probe | All defined environment variables except credential names, selectors and helpers. Project settings such as `NODE_OPTIONS`, `DATABASE_URL`, `DISPLAY`, `XDG_RUNTIME_DIR` and `RAILS_ENV` stay. The real `HOME` and `USERPROFILE` stay; `PATH` keeps only absolute entries. Provider API keys, cloud credentials, tokens, AWS profiles, credential files, SSH sockets, Git helpers and npm userconfig selectors stay out. See [CONFIGURATION.md §What a check can reach](./CONFIGURATION.md#what-a-check-can-reach). |
| `api` runner | nothing: the HTTP call runs in process |
| Agent-skill recipe spawn (`skills/*/references/tool-recipes.md`) | The full environment of the agent session that runs the skill. |
| Workflow hook | The full SPLITBRIEF environment. The hook trust prompt discloses this, and you accept it per checkout ([HOOKS-CONFIG.md](./HOOKS-CONFIG.md)). |

The credential variables of a runner come from one place per kind:

| Runner | Variables | Source |
|---|---|---|
| `claude-code` `session` / `api-key` | none / `ANTHROPIC_API_KEY` | the channel's `env` |
| `codex` `session` / `api-key` | none / `OPENAI_API_KEY` | the channel's `env` |
| `cursor` `session` / `api-key` | none / `CURSOR_API_KEY` | the channel's `env` |
| `copilot` `session` | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | the channel's `env` |
| `command-code`, `antigravity` `session` | none | the channel's `env` |
| `opencode`, `kilo-code` `provider-dependent` | every `*_API_KEY` of the parent | the provider-dependent rule above |
| `shell`, `agent` (inline or in `customCommands`) | the names in the runner's `env` list | the runner config |
| `api` | the `apiKey: env:VAR` reference, or the provider's own variable | the runner config |

No child gets the parent agent's session variables (`CLAUDECODE`, `CLAUDE_CODE_*`) or `SSH_AUTH_SOCK`. A declared `env` list cannot name `SSH_AUTH_SOCK`, `HOME`, `PATH` or a code-loading variable.

A tool can set variables of its own for its own shell. What the shell of each seat sees:

- `antigravity`: no parent secret and no parent session variable. `agy` adds its own `ANTIGRAVITY_*` variables, `ANTIGRAVITY_CSRF_TOKEN` among them. The shell does not read `~/.zshrc`, so the keys that file exports stay out.
- `claude-code`: no parent secret. The `CLAUDE_CODE_*` and `CLAUDECODE` variables in its Bash tool belong to the child `claude` itself, not to the parent. The child also applies the `env` block of the real `~/.claude/settings.json`, which the `host-account` channel reaches. Its sandbox adds the proxy variables.
- `command-code`: no parent secret and no session variable.
- `opencode`: every `*_API_KEY` of the parent. That is the provider-dependent rule above.

## Why no tool is enforceable

For the three tools that offer a choice, the `api-key` channel gets a private `HOME` and no bridged state, so the subscription session is not reachable through the tool's default lookup — the macOS login keychain resolves through `HOME`, and `~/.codex` and `~/.claude` do not exist inside the sandbox. That is staging, not enforcement. It controls what the environment contains, not what the binary consults: a build free to open an absolute path, a keychain by explicit name, or a machine-wide configuration would still find a session, and nothing in these tools' help documents that they will not. So the verdict stays `host-configured`.

For the five single-channel tools there is nothing to enforce, because no method choice is offered. The host CLI's own configuration determines authentication, and SPLITBRIEF never presents the provider or model list as an authentication choice.
