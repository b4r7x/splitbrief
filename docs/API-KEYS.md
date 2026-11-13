# API key security

SPLITBRIEF connects to AI providers (planner + implementer) that may require API keys. This guide covers how keys are handled and best practices for keeping them secure.

A CLI tool runs with the sign-in that the tool already has. Sign in with the tool's own command, and check its account state there. SPLITBRIEF never signs in, signs out or switches that account. A provider or model choice does not change how the tool signs in.

## Recommended: environment variables

Set your API key as an environment variable. This keeps it out of project files and version control.

```bash
# In your shell profile (~/.bashrc, ~/.zshrc, etc.) — the value stays local, never committed:
export ANTHROPIC_API_KEY=<paste-your-anthropic-key>

# Or keep the key in a secret manager and resolve it at shell start:
export ANTHROPIC_API_KEY="$(your-secret-manager get anthropic)"
```

Environment variables are not committed to git, are not stored on disk in project files, and work across all tools that read from the environment.

### Admitted credential reference

Every credential that an `api` runner reads. A session tool gets none of these: it uses its own sign-in. OpenCode and Kilo Code get every `*_API_KEY` variable of your shell; the full list is in [Child environment](#child-environment).

| Credential | Environment variable | Prefix validation | Notes |
|----------|---------------------|-------------------|-------|
| Custom remote provider | Not inferred | — | Carries an inline `apiKey`, accepted only when you accept **normalized-origin trust** for the declared `apiBase` |

A provider descriptor may declare a `credentialPrefix`; a mismatch fails closed before network access (`provider-credential-prefix-mismatch`), and offering selection never follows from the prefix alone.

## Alternative: config file

A custom OpenAI-compatible endpoint carries its key in `.splitbrief/config.yaml`:

```yaml
implementer:
  kind: api
  provider: my-endpoint
  service: my-endpoint
  offering: payg
  apiBase: https://api.my-endpoint.example/v1
  apiKey: your-key
  model: your-implementer-model
```

The key must be inline. An `env:` reference on a custom provider is rejected at load (`API key exfiltration risk`) so a key you exported for one host is never sent to another; keep it inline only when you accept **normalized-origin trust** for that `apiBase`.

Never paste real or placeholder secrets (`sk-ant-…`, `sk-or-…`, `gsk_…`) into committed YAML examples.

## Missing credentials in the runner picker

The runner picker (`/crew plan`, `/crew build`, `/crew review`) marks a tool that is not signed in as **Auth required** and names the tool's own sign-in command. It never asks you for a key: SPLITBRIEF does not accept, validate, or store credentials typed into the TUI.

An OpenCode or Kilo Code that holds no credential, but whose model listing serves a provider set up in its own config, is not marked, and its route rows for that provider read `available`. Setup, Settings › Fallback, `splitbrief doctor` and the start of a run accept it on a model its listing serves.

OpenCode and Kilo Code call a `provider/model` route through that provider's credential, so each route row names that provider, the first part of the id, and shows its own state. `openrouter/deepseek/deepseek-v4.1-flash` reads `openrouter`, `github-copilot/gpt-5.5` reads `github-copilot`, and every model of Kilo's own gateway (`kilo/…`) reads `kilo`. The row states:

| Route word | Meaning |
|---|---|
| `signed in · <source>` | The tool's credential listing names the provider: `oauth`, `api key`, `stored credential` or the environment variable, such as `$OPENROUTER_API_KEY`. |
| `available` | No credential of the tool names the provider, and its model listing serves a model of that provider, for example a provider set up in the tool's own config. This holds also when the tool holds no credential at all. |
| `needs sign-in` | The tool has no credential for the provider, and its model listing serves no model of that provider. The tool's own gateway (`opencode/…`, `kilo/…`) always needs its credential. When the tool holds no credential at all, every route that its model listing does not serve reads `needs sign-in`. The tool reads **Auth required** when its listing serves no provider besides its gateway, or was not read. The line under the lists names the sign-in command, for example `opencode auth login opencode-go`, or `signed in to no providers yet: opencode auth login opencode-go` when the tool holds no credential. |
| `sign-in unknown` | The tool's credential listing could not be read, or the tool has no credential for the provider and its model listing was not read. The line under the lists reads `ctrl+r to read the model list` in the second case. Press `ctrl+r` to read both again. |

Selecting a `needs sign-in` route, or saving a custom model on a provider that needs a sign-in, still saves the selection, and the save message adds the same sentence and command that `splitbrief doctor` gives: `OpenCode CLI has no credential for opencode-go — run opencode auth login opencode-go before start`. `splitbrief doctor` and the start of a run then warn about the seat, for example ``BUILD: OpenCode CLI has no credential for opencode-go.``, and name the same command. When OpenCode refuses a call on that route, the seat halts at once as **Seat down** with the same sentence and command, and a seat with a fallback moves to it. When the provider has a credential and OpenCode still refuses the model, the halt asks you to pick a listed model instead; see [Approval and recovery](./APPROVAL-AND-RECOVERY.md).

Run the named command in your shell, or export the provider's environment variable (above), and the row stops being marked.

## Generic remote endpoints

Custom OpenAI-compatible providers must declare both `apiBase` and explicit `service` / `offering` fields. Because SPLITBRIEF cannot infer a safe environment variable name, the key is inline — one you rotate immediately.

**Normalized-origin trust** means:

- The credential is sent only to the normalized HTTPS origin of the configured `apiBase`.
- Cross-origin redirects are rejected: the request fails with `provider-endpoint-invalid` instead of following a redirect to another origin.
- Arbitrary env-key forwarding to unknown hosts is unsafe and unsupported for catalog providers.

See [CONFIGURATION.md](./CONFIGURATION.md#generic-remote-openai-compatible-endpoint) for the generic remote example.

## Security measures

SPLITBRIEF takes several steps to protect your API keys:

- **Restrictive file permissions** — `.splitbrief/` directories are created with `0700` (owner-only access) and config files with `0600` (owner-only read/write). **Note (Windows):** File permission modes (0600/0700) are Unix-specific. On Windows, file access is managed through OS-level ACLs. Ensure your config directory is in a user-private location.
- **Automatic redaction** — error messages and logs are passed through `redactSecrets()`, which strips patterns matching API keys (`sk-ant-…`, `sk-…`, Bearer tokens, and generic key/token assignments)
- **No intentional key persistence** — SPLITBRIEF does not intentionally persist configured provider keys to state/session output, and protected outputs redact known secret patterns. Do not paste secrets into prompts or rely on this for external runner logs.
- **Header-only transport** — keys are only used in HTTP `Authorization` headers, never embedded in URLs or query parameters
- **Boolean detection flags** — provider detection returns `hasKey: true/false`, never the actual key value
- **Key format validation** — a provider that declares a credential prefix has its key checked against it; prefix mismatches fail closed before any network request
- **Bridged CLI session state** — a CLI runner on a host-state channel whose credential is a file (`session` for Codex and Command Code, `provider-dependent` for OpenCode and Kilo Code, and `session` for Claude Code and Cursor Agent CLI on Linux and Windows) cannot read your real `HOME`. SPLITBRIEF gives it only that tool's own sign-in, in one of two ways. Claude Code and Command Code get a copy of their credential file (for example `~/.claude/.credentials.json`) in `<project>/.splitbrief/sandbox/`, owner-only and read-only. The copy is replaced when your own file changes and deleted when the run finishes. Codex, Cursor Agent CLI, OpenCode and Kilo Code renew their sign-in during a run, and a copy would lose the new token. So SPLITBRIEF links Codex's `~/.codex/auth.json` and Cursor's `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` into the sandbox, and links the whole state folder of OpenCode and Kilo Code. Through that link the runner reads **and writes** your own sign-in, and SPLITBRIEF removes the link when the run finishes. When you set `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, SPLITBRIEF takes that tool's sign-in from the folder you set, and the runner still gets its private home. Codex can keep its sign-in in the system keyring (`cli_auth_credentials_store = "keyring"` or `"auto"` in `config.toml`). A run cannot reach the keyring, so readiness names that sign-in and tells you to set `cli_auth_credentials_store = "file"` and run `codex login` again. `.splitbrief/` must stay in `.gitignore`.

### Claude Code on macOS

Claude Code stores its subscription session in the macOS login keychain, not in a file, so there is nothing for the file bridge to copy. The keychain's default search list resolves through `HOME`, and the item is keyed on the account name in `USER`. SPLITBRIEF therefore hands a macOS Claude Code `session` runner **your real `HOME` and `USER`** instead of a sandbox home, and copies nothing. That is the only way the subscription you already pay for can plan. `splitbrief doctor` reports `authenticated` only when `claude auth status`, run inside that staged environment, says so.

The cost is stated plainly: on that one channel the planner child resolves `~` to your real home and writes Claude Code's own state (`~/.claude.json`, history) there, exactly as it does when you run `claude` yourself. Everything else the sandbox redirects — `XDG_*`, `npm_config_cache`, `PIP_CACHE_DIR`, `CARGO_HOME` — still points inside `<project>/.splitbrief/sandbox/`, and `TMPDIR` still points at the sandbox's private temp directory (see below). The full accounting of what that child can and cannot reach is below.

### Cursor Agent CLI on macOS

Cursor Agent CLI stores its subscription session in the macOS login keychain, so there is no file for a file bridge to copy. `agent status` inside a remapped HOME reports `Not logged in` even when the host is already signed in via `agent login`. SPLITBRIEF therefore hands a macOS Cursor Agent CLI `session` runner **your real `HOME` and `USER`** (`host-account`) instead of a sandbox home, and copies nothing. That is how the paid subscription plans.

The cost is the same as Claude Code's `session` channel on macOS: `~` resolves to your real home. Everything else the sandbox redirects still points inside `<project>/.splitbrief/sandbox/`, except the private `TMPDIR` in the system temp directory.

On Linux, Cursor Agent CLI keeps its sign-in in `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json`. SPLITBRIEF links that one file into the sandbox, so a token that Cursor refreshes during a run lands in your own file. Only that file counts as a Cursor sign-in.

### Antigravity on macOS

The admitted Antigravity adapter uses the sign-in that `agy` already has, and has no credential file to bridge. SPLITBRIEF hands a macOS Antigravity `session` runner **your real `HOME` and `USER`** (`host-account`) and copies nothing. Being able to reach the keychain is not treated as being signed in: readiness reports `authenticated`, and the picker lists models, only when `agy models` run in that staged environment exits `0`. A non-zero exit is `unauthenticated`, and SPLITBRIEF never runs a sign-in command for you.

The cost is the same as Claude Code's: `~` resolves to your real home, and `agy` may write its own state there. Everything else the sandbox redirects still points inside `<project>/.splitbrief/sandbox/`, except the private `TMPDIR` in the system temp directory. SPLITBRIEF passes no credential variable of your shell to `agy`, and `GEMINI_API_KEY` stays out too.

SPLITBRIEF has no admitted Antigravity credential bridge on Linux or Windows. No host credential is handed over and `agy models` is not run. Authentication stays unknown, catalog access is unsupported, and readiness explains that signing in again cannot enable the bridge on those platforms.

<a id="exception-one-keychain-backed-session-channels-on-macos"></a>

### What a `host-account` child can and cannot reach

The discriminants are declared, not scattered through the engine as platform checks: a channel declares `hostKeychainPlatforms`, and the Claude Code, Cursor Agent CLI and Antigravity `session` channels declare `['darwin']`; `cliAuthChannelHostStateAccess()` maps that to `host-account`, everything else to `bridged-files`. Within `bridged-files`, `CLI_CREDENTIAL_MODELS` declares per tool whether the credential is a `static-secret` (sealed snapshot copy) or `rotating-oauth` (live passthrough).

Which runners keep a private HOME, and which do not:

| Runner | HOME | Host state it reads |
|---|---|---|
| Claude Code, `session` channel, **macOS** | your real `HOME`, plus real `USER` | the login keychain, through its default search list |
| Claude Code, `session` channel, Linux / Windows | private, under `.splitbrief/sandbox/<role>/home` | a read-only copy of `~/.claude/.credentials.json`, or of `.credentials.json` in `CLAUDE_CONFIG_DIR` when you set it |
| Cursor Agent CLI, `session` channel, **macOS** | your real `HOME`, plus real `USER` | the login keychain, through its default search list |
| Cursor Agent CLI, `session` channel, Linux / Windows | private, under `.splitbrief/sandbox/<role>/home` | a live link to Cursor's sign-in file, `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` |
| Antigravity, `session` channel, **macOS** | your real `HOME`, plus real `USER` | the login keychain, through its default search list |
| Antigravity, `session` channel, Linux / Windows | private | none — unsupported credential bridge; authentication remains unknown |
| Codex, `session` channel, every platform | private, with Codex's sessions and history in it | your real `~/.codex/auth.json`, or `auth.json` in `CODEX_HOME` when you set it, live — reads **and writes** |
| OpenCode and Kilo Code, `provider-dependent` channel | private, but that tool's own state directory is a link to the real one | that tool's real state directory, live — reads **and writes** |
| Every `api`, `shell`, or `agent` runner | private | none |

OpenCode 2's model listing, `opencode api GET /api/model --standalone`, is staged as an OpenCode run is. The picker therefore lists a provider only when a run can sign in to it: through a `*_API_KEY` variable of your shell, through OpenCode's own `auth.json`, or with no credential, as OpenCode's `opencode` provider does. When OpenCode is on a seat or a fallback, the listing also names the project directory, and OpenCode then loads the project's OpenCode config with its plugins and its local MCP servers. The listing runs in a neutral temporary directory, and the project directory goes in the `x-opencode-directory` header. A project whose crew does not use OpenCode is never named to the listing. A provider that signs in without an API key, such as Amazon Bedrock through an AWS profile or Google Vertex through `GOOGLE_APPLICATION_CREDENTIALS`, is not listed.

What the `host-account` child gains:

- `~`-relative resolution lands in your real home, so a tool reading its own defaults there — `~/.ssh/config`, `~/.aws/credentials`, `~/.npmrc`, `~/.gitconfig` — finds the real file instead of an empty sandbox.
- The login keychain becomes reachable through its **default** search list, so `security find-generic-password …` with no keychain argument now returns your items. That is the point of the change; it is also its cost.
- Claude Code writes its own state to your real home (`~/.claude.json`, history, project permissions), exactly as it does when you run `claude` yourself — the sandbox no longer absorbs those writes. Cursor Agent CLI may write under the real `~/.cursor` (the IDE home) the same way, and `agy` under whatever it keeps in your home.

And what it does **not** gain, so the accounting is not overstated:

- Nothing beyond `HOME`, `USERPROFILE` and `USER` is handed back, plus `CLAUDE_CONFIG_DIR` for Claude Code when you set it. `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `APPDATA`, `LOCALAPPDATA`, `npm_config_cache`, `PIP_CACHE_DIR` and `CARGO_HOME` still point inside `<project>/.splitbrief/sandbox/`, `TMPDIR`, `TMP` and `TEMP` still point at the sandbox's private temp directory, and the environment allowlist still strips every credential variable it strips today.
- The temp directory is the one redirect outside the project: `<system tmp>/sb-<hash>`, owner-only (`0700`), one per sandbox root (the hash is the first 12 hex digits of the SHA-256 of the root path), and removed when the run, probe or staged copy that created it is torn down. Under a worktree's ignored `.splitbrief/` a temporary git repository sees the enclosing one, and the worktree path is long enough to push a unix socket bound in it (tsx's IPC pipe) past the 104-byte macOS limit, which fails with `EADDRINUSE`.
- No new *filesystem* reach. The sandbox is env redirection, not confinement: a child in a sandbox HOME could already read `/Users/you/.ssh/` by absolute path, and could already open the login keychain by naming `~/Library/Keychains/login.keychain-db` explicitly. What changes is which paths the child finds *by default*, not which paths it is permitted to open.
- No credential is copied anywhere. The session token stays in the keychain; nothing is written to disk, so nothing can outlive the run or be committed by accident.

One consequence of never holding the token: the parent-side redactor that strips a *bridged* credential value out of runner output has no value to strip on this channel, because SPLITBRIEF never learns one. Pattern-based secret redaction still applies to everything a runner emits.

If that host-state access is unacceptable, do not use that CLI connection.

## Child environment

SPLITBRIEF builds a separate environment for each kind of child. Seats, readiness probes and catalog probes keep only named variables. Commands SPLITBRIEF runs itself inherit the defined variables and drop credential names, selectors and helpers. Workflow hooks and the `git` commands SPLITBRIEF runs itself keep the full SPLITBRIEF environment.

| Child | What the child gets |
|---|---|
| Planner, reviewer and implementer of kind `cli`, `shell` or `agent`; readiness probe; catalog probe | The runtime keys (`LANG`, `LC_*`, `TZ`, `TERM`, `COLORTERM`, `TERM_PROGRAM*`, `NO_COLOR`, `FORCE_COLOR`, `COLUMNS`, `LINES`), a `PATH` with the project's own directories removed, the staged `HOME`, `XDG_*` and caches, a private `TMPDIR` outside the project (`<system tmp>/sb-<hash>`), and the credential variables of the runner (next table). |
| `customCommands` runner | The runtime keys and the names in the command's `env` list. |
| Plan check, reviewer check, base re-run, the checks of a fix task, `render` check, the formatter | All defined environment variables except credential names, selectors and helpers. Project settings such as `NODE_OPTIONS`, `DATABASE_URL`, `DISPLAY`, `XDG_RUNTIME_DIR` and `RAILS_ENV` stay. The real `HOME` and `USERPROFILE` stay; `PATH` keeps only absolute entries. Provider API keys, cloud credentials, tokens, AWS profiles, credential files, SSH sockets, Git helpers and npm userconfig selectors stay out. See [CONFIGURATION.md §What a check can reach](./CONFIGURATION.md#what-a-check-can-reach). |
| `api` runner | nothing: the HTTP call runs in process |
| Agent-skill recipe spawn (`skills/*/references/tool-recipes.md`) | The full environment of the agent session that runs the skill. |
| Workflow hook | The full SPLITBRIEF environment. The hook trust prompt discloses this, and you accept it per checkout ([HOOKS-CONFIG.md](./HOOKS-CONFIG.md)). |

The credential variables of a runner:

| Runner | Credential variables |
|---|---|
| `claude-code`, `codex`, `cursor`, `command-code`, `antigravity` | none: the tool uses the sign-in that it already has |
| `opencode`, `kilo-code` | every `*_API_KEY` of the parent |
| `shell`, `agent` (inline or in `customCommands`) | the names in the runner's `env` list |
| `api` | the `apiKey: env:VAR` reference, or the provider's own variable |

A seat or probe child gets no session variable of the parent agent (`CLAUDECODE`, `CLAUDE_CODE_*`) unless its `env` list names one, and it never gets `SSH_AUTH_SOCK`. A declared `env` list cannot name `SSH_AUTH_SOCK`, `HOME`, `PATH` or a code-loading variable.

OpenCode and Kilo Code route to many providers. Besides their own sign-in state, they can use the provider keys of your shell, and their model listing reads the same keys. So they get every `*_API_KEY`. The cost: a model on one provider can read the keys of every other provider.

No adapter adds an authentication flag to the command line. SPLITBRIEF blocks `--api-key` in a Cursor seat's `invocationArgs`. The `claude-code` implementer gets `--settings <JSON>`, and that JSON holds only `sandbox` and `permissions` keys ([the Claude Code implementer sandbox](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth)).

A tool can set variables of its own for its own shell. What the shell of each seat sees:

- `antigravity`: no parent secret and no parent session variable. `agy` adds its own `ANTIGRAVITY_*` variables, `ANTIGRAVITY_CSRF_TOKEN` among them. The shell does not read `~/.zshrc`, so the keys that file exports stay out.
- `claude-code`: no parent secret. The `CLAUDE_CODE_*` and `CLAUDECODE` variables in its Bash tool belong to the child `claude` itself, not to the parent. On macOS the child keeps your real home, so it also applies the `env` block of your `~/.claude/settings.json`. Its sandbox adds the proxy variables.
- `command-code`: no parent secret and no session variable.
- `opencode`: every `*_API_KEY` of the parent, as stated above.

### Competing and shared credentials

**Competing credentials.** A child can hold a credential variable and a stored sign-in at the same time. The installed build of the tool then decides which one it uses.

**Shared sign-in state.** SPLITBRIEF never runs a sign-in, sign-out or account-switch command. Codex, OpenCode and Kilo Code use live links to your own sign-in, and Cursor Agent CLI does so on Linux. Claude Code and Command Code get a sealed copy where a file is bridged. On macOS, Claude Code, Cursor Agent CLI and Antigravity keep your real `HOME` and `USER`, so the OS keychain is reachable, and these children can update their own state in your home. Antigravity has no file bridge on Linux.

**Same staging for readiness and the run.** The readiness probe and the runner build their environment from the same rules. Only the sandbox root differs: it changes which directory the child gets, not which credential. A tool that readiness reports as signed in is staged the same way for the run. The model listing is staged the same way too.

## Best practices

1. **Use environment variables** over config file storage
2. **Add `.splitbrief/` to `.gitignore`** — prevents accidental commits of config files that may contain keys
3. **Never commit** `.splitbrief/config.yaml` with API keys to version control
4. **Rotate keys periodically** — especially if you suspect exposure
5. **Use minimum-privilege scopes** — if your provider offers restricted API key scopes, use the narrowest one that works
6. **One key per developer** — in team environments, each developer should use their own API keys via their own environment
