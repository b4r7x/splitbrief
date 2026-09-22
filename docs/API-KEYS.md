# API key security

SPLITBRIEF connects to AI providers (planner + implementer) that may require API keys. This guide covers how keys are handled and best practices for keeping them secure.

An explicit session or api-key method requires current invocation-enforcement evidence; otherwise remove the selection to use the host CLI configuration.

The current enforcement matrix is empty. No admitted installed CLI version has a proven selectable authentication method, and an explicit unproven choice is refused before dispatch. Provider/model choice does not prove subscription or API billing. Configure authentication in the host CLI, omit `authChannel`, and inspect its own account state. SPLITBRIEF never logs in or switches that account.

For local API connections, Settings → Crew opens the seat picker and connection editor. Set the address and exact model there, and use Retry after starting the server externally. The dedicated credential control accepts an environment reference such as `env:YOUR_VAR`, not a raw token. Export the value in your shell; never paste it into the composer, screenshots or versioned files. Known local endpoints retain their loopback policy; a connection editor does not grant trust to arbitrary remote origins.

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

Every credential environment variable SPLITBRIEF reads. The first four describe credentials understood by host CLIs, not API providers or proven method switches. An environment variable alone does not establish the authentication or billing method actually used.

The `api-key` channel rows describe what that channel stages. Selecting it explicitly (`auth_channel: api-key`) is refused at readiness until [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md) records an enforceable row for the tool; until then the host CLI's own login decides.

| Credential | Environment variable | Prefix validation | Notes |
|----------|---------------------|-------------------|-------|
| Claude Code CLI (`api-key` channel) | `ANTHROPIC_API_KEY` | — | Passed to the `claude` subprocess; nothing else in the environment is copied |
| Codex CLI (`api-key` channel) | `OPENAI_API_KEY` | — | Passed to the `codex` subprocess |
| Copilot CLI (`session`, its only channel) | `GH_TOKEN` / `GITHUB_TOKEN` | — | Passed to the `copilot` subprocess, whichever variable is set; with neither, the bridged `copilot` login is used |
| Cursor Agent CLI (`api-key` channel) | `CURSOR_API_KEY` | — | Passed to the `cursor-agent` subprocess |
| Local Ollama | `OLLAMA_LOCAL_API_KEY` | — | Optional only for a secured loopback daemon; configure `apiKey: env:OLLAMA_LOCAL_API_KEY`. `OLLAMA_API_KEY` is never accepted or sent locally. |
| LM Studio | Not inferred | — | Local provider; no key required. A daemon you put behind one takes it inline or as `apiKey: env:YOUR_VAR` |
| Custom remote provider | Not inferred | — | Carries an inline `apiKey`, accepted only when you accept **normalized-origin trust** for the declared `apiBase` |

A provider descriptor may declare a `credentialPrefix`; a mismatch fails closed before network access (`provider-credential-prefix-mismatch`), and offering selection never follows from the prefix alone. None of the three admitted providers (Ollama, LM Studio and llama.cpp) declares one. All three connect to local servers and accept an optional credential for a secured daemon.

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
  model: qwen2.5-coder-7b
```

The key must be inline. An `env:` reference on a custom provider is rejected at load (`API key exfiltration risk`) so a key you exported for one host is never sent to another; keep it inline only when you accept **normalized-origin trust** for that `apiBase`. `apiKey: env:VAR` is accepted only for a catalog provider: local `ollama` takes exactly one reference, `apiKey: env:OLLAMA_LOCAL_API_KEY`, and `lm-studio` takes any variable you name.

Never paste real or placeholder secrets (`sk-ant-…`, `sk-or-…`, `gsk_…`) into committed YAML examples.

## Missing credentials in the runner picker

The runner picker (`/crew plan`, `/crew build`) marks rows whose credential is missing as **Auth required** and names the tool's own sign-in command — for example `opencode auth login opencode-go`. It never asks you for a key: SPLITBRIEF does not accept, validate, or store credentials typed into the TUI. Selecting such a row still saves the selection, with the same sign-in note repeated as feedback.

Run the named command in your shell, or export the provider's environment variable (above), and the row stops being marked.

## Generic remote endpoints

Custom OpenAI-compatible providers must declare both `apiBase` and explicit `service` / `offering` fields. Because SPLITBRIEF cannot infer a safe environment variable name, the key is inline — one you rotate immediately.

**Normalized-origin trust** means:

- The credential is sent only to the normalized HTTPS origin of the configured `apiBase`.
- Cross-origin redirects are rejected: the request fails with `provider-endpoint-invalid` instead of following a redirect to another origin.
- Arbitrary env-key forwarding to unknown hosts is unsafe and unsupported for catalog providers.

See [CONFIGURATION.md](./CONFIGURATION.md) §18 for admitted provider endpoints and the generic remote example.

## Security measures

SPLITBRIEF takes several steps to protect your API keys:

- **Restrictive file permissions** — `.splitbrief/` directories are created with `0700` (owner-only access) and config files with `0600` (owner-only read/write). **Note (Windows):** File permission modes (0600/0700) are Unix-specific. On Windows, file access is managed through OS-level ACLs. Ensure your config directory is in a user-private location.
- **Automatic redaction** — error messages and logs are passed through `redactSecrets()`, which strips patterns matching API keys (`sk-ant-…`, `sk-…`, Bearer tokens, and generic key/token assignments)
- **No intentional key persistence** — SPLITBRIEF does not intentionally persist configured provider keys to state/session output, and protected outputs redact known secret patterns. Do not paste secrets into prompts or rely on this for external runner logs.
- **Header-only transport** — keys are only used in HTTP `Authorization` headers, never embedded in URLs or query parameters
- **Boolean detection flags** — provider detection returns `hasKey: true/false`, never the actual key value
- **Key format validation** — a provider that declares a credential prefix has its key checked against it; prefix mismatches fail closed before any network request
- **Bridged CLI session state** — a CLI runner on a host-state channel whose credential is a file (`session` for Codex and Copilot, `provider-dependent` for OpenCode and Kilo Code, and `session` for Claude Code and Cursor Agent CLI on Linux and Windows) cannot read your real `HOME`, so SPLITBRIEF copies only that tool's admitted credential file (for example `~/.claude/.credentials.json`) into `<project>/.splitbrief/sandbox/`, owner-only and read-only. The copy is refreshed when the host credential rotates and deleted when the run finishes; `.splitbrief/` must stay in `.gitignore`. Omit `authChannel` to use the host CLI configuration; a private environment alone does not prove method enforcement.

### Claude Code on macOS

Claude Code stores its subscription session in the macOS login keychain, not in a file, so there is nothing for the file bridge to copy. The keychain's default search list resolves through `HOME`, and the item is keyed on the account name in `USER`. SPLITBRIEF therefore hands a macOS Claude Code `session` runner **your real `HOME` and `USER`** instead of a sandbox home, and copies nothing. That is the only way the subscription you already pay for can plan; the declared host-state staging policy remains distinct from a selected authentication method, and `splitbrief doctor` reports `authenticated` only when `claude auth status`, run inside that staged environment, says so.

The cost is stated plainly: on that one channel the planner child resolves `~` to your real home and writes Claude Code's own state (`~/.claude.json`, history) there, exactly as it does when you run `claude` yourself. Everything else the sandbox redirects — `TMPDIR`, `XDG_*`, `npm_config_cache`, `PIP_CACHE_DIR`, `CARGO_HOME` — still points inside `<project>/.splitbrief/sandbox/`. The full accounting of what that child can and cannot reach is below.

The historical `api-key` staging alternative is not an available method switch today. Explicit method selection requires invocation-enforcement evidence; omit the field and configure the host CLI.

### Cursor Agent CLI on macOS

Cursor Agent CLI stores its subscription session in the macOS login keychain, not in the files the Linux file-bridge copies, so there is nothing for the file bridge to copy. `agent status` inside a remapped HOME reports `Not logged in` even when the host is already signed in via `agent login`. SPLITBRIEF therefore hands a macOS Cursor Agent CLI `session` runner **your real `HOME` and `USER`** (`host-account`) instead of a sandbox home, and copies nothing. That is how the paid subscription plans.

The cost is the same as Claude Code's `session` channel on macOS: `~` resolves to your real home. Everything else the sandbox redirects still points inside `<project>/.splitbrief/sandbox/`.

The historical `api-key` staging alternative is not an available method switch today. Explicit method selection requires invocation-enforcement evidence; omit the field and configure the host CLI.

### Antigravity on macOS

The admitted Antigravity adapter uses the host-configured session channel and has no credential file to bridge. SPLITBRIEF hands a macOS Antigravity `session` runner **your real `HOME` and `USER`** (`host-account`) and copies nothing. Being able to reach the keychain is not treated as being signed in: readiness reports `authenticated`, and the picker lists models, only when `agy models` run in that staged environment exits `0`. A non-zero exit is `unauthenticated`, and SPLITBRIEF never runs a sign-in command for you.

The cost is the same as Claude Code's: `~` resolves to your real home, and `agy` may write its own state there. Everything else the sandbox redirects still points inside `<project>/.splitbrief/sandbox/`. SPLITBRIEF has no admitted Antigravity `api-key` channel or proven per-invocation method switch. [Upstream Antigravity documentation](https://antigravity.google/docs/cli/install/#using-a-gemini-api-key) describes a Gemini API-key mode configured through settings and `GEMINI_API_KEY`; that upstream capability is not an authentication method this adapter can select or enforce. This distinction was checked on 2026-09-17.

SPLITBRIEF has no admitted Antigravity credential bridge on Linux or Windows. No host credential is handed over and `agy models` is not run. Authentication stays unknown, catalog access is unsupported, and readiness explains that signing in again cannot enable the bridge on those platforms.

<a id="exception-one-keychain-backed-session-channels-on-macos"></a>

### What a `host-account` child can and cannot reach

The discriminants are declared, not scattered through the engine as platform checks: a channel declares `hostKeychainPlatforms` (`src/core/runners/cli-tool-catalog.ts`), and the Claude Code, Cursor Agent CLI and Antigravity `session` channels declare `['darwin']`; `cliAuthChannelHostStateAccess()` maps that to `host-account`, everything else to `bridged-files` or `none`. Within `bridged-files`, `CLI_CREDENTIAL_MODELS` (`src/engine/runners/sandbox-state-paths.ts`) declares per tool whether the credential is a `static-secret` (sealed snapshot copy) or `rotating-oauth` (live passthrough).

Which runners keep a private HOME, and which do not:

| Runner | HOME | Host state it reads |
|---|---|---|
| Claude Code, `session` channel, **macOS** | your real `HOME`, plus real `USER` | the login keychain, through its default search list |
| Claude Code, `session` channel, Linux / Windows | private, under `.splitbrief/sandbox/<role>/home` | a read-only copy of `~/.claude/.credentials.json` |
| Cursor Agent CLI, `session` channel, **macOS** | your real `HOME`, plus real `USER` | the login keychain, through its default search list |
| Cursor Agent CLI, `session` channel, Linux / Windows | private, under `.splitbrief/sandbox/<role>/home` | a file bridge of the declared Cursor state paths |
| Antigravity, `session` channel, **macOS** | your real `HOME`, plus real `USER` | the login keychain, through its default search list |
| Antigravity, `session` channel, Linux / Windows | private | none — unsupported credential bridge; authentication remains unknown |
| Copilot, `session` channel, every platform | private | a read-only copy of Copilot's own credential files |
| Codex, `session` channel, every platform | private, but `~/.codex` inside it is a link to your real `~/.codex` | your real `~/.codex`, live — reads **and writes** |
| OpenCode and Kilo Code, `provider-dependent` channel | private, but that tool's own state directory is a link to the real one | that tool's real state directory, live — reads **and writes** |
| Any runner on an `api-key` channel | private | none — the credential arrives as an environment variable |
| Every `api`, `shell`, or `agent` runner | private | none |

One probe, not a runner, also takes your real `HOME` and `USER`: OpenCode 2's model listing, `opencode api GET /api/model`. It is a read that its own server answers, and OpenCode runs keep the row above. The reason and the measured writes are in the catalog-probe exception of [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md).

What the `host-account` child gains:

- `~`-relative resolution lands in your real home, so a tool reading its own defaults there — `~/.ssh/config`, `~/.aws/credentials`, `~/.npmrc`, `~/.gitconfig` — finds the real file instead of an empty sandbox.
- The login keychain becomes reachable through its **default** search list, so `security find-generic-password …` with no keychain argument now returns your items. That is the point of the change; it is also its cost.
- Claude Code writes its own state to your real home (`~/.claude.json`, history, project permissions), exactly as it does when you run `claude` yourself — the sandbox no longer absorbs those writes. Cursor Agent CLI may write under the real `~/.cursor` (the IDE home) the same way, and `agy` under whatever it keeps in your home.

And what it does **not** gain, so the accounting is not overstated:

- Nothing beyond `HOME`, `USERPROFILE` and `USER` is handed back. `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `APPDATA`, `LOCALAPPDATA`, `npm_config_cache`, `PIP_CACHE_DIR` and `CARGO_HOME` still point inside `<project>/.splitbrief/sandbox/`, and the environment allowlist still strips every credential variable it strips today.
- No new *filesystem* reach. The sandbox is env redirection, not confinement: a child in a sandbox HOME could already read `/Users/you/.ssh/` by absolute path, and could already open the login keychain by naming `~/Library/Keychains/login.keychain-db` explicitly. What changes is which paths the child finds *by default*, not which paths it is permitted to open.
- No credential is copied anywhere. The session token stays in the keychain; nothing is written to disk, so nothing can outlive the run or be committed by accident.

One consequence of never holding the token: the parent-side redactor that strips a *bridged* credential value out of runner output has no value to strip on this channel, because SPLITBRIEF never learns one. Pattern-based secret redaction still applies to everything a runner emits.

If that host-state access is unacceptable, do not use that CLI connection. A manually selected `api-key` method cannot bypass the enforcement gate.

## Best practices

1. **Use environment variables** over config file storage
2. **Add `.splitbrief/` to `.gitignore`** — prevents accidental commits of config files that may contain keys
3. **Never commit** `.splitbrief/config.yaml` with API keys to version control
4. **Rotate keys periodically** — especially if you suspect exposure
5. **Use minimum-privilege scopes** — if your provider offers restricted API key scopes, use the narrowest one that works
6. **One key per developer** — in team environments, each developer should use their own API keys via their own environment
