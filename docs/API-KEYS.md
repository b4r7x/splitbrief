# API key security

SPLITBRIEF connects to AI providers (planner + implementer) that may require API keys. This guide covers how keys are handled and best practices for keeping them secure.

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

Every credential environment variable SPLITBRIEF reads. The first four are CLI auth-channel credentials, not API providers: Claude Code, Codex and Cursor Agent read theirs on the metered `api-key` alternative to the tool's subscription `session` channel, while Copilot declares a single `session` channel and reads its token there.

| Credential | Environment variable | Prefix validation | Notes |
|----------|---------------------|-------------------|-------|
| Claude Code CLI (`auth_channel: api-key`) | `ANTHROPIC_API_KEY` | — | Passed to the `claude` subprocess; nothing else in the environment is copied |
| Codex CLI (`auth_channel: api-key`) | `OPENAI_API_KEY` | — | Passed to the `codex` subprocess |
| Copilot CLI (`session`, its only channel) | `GH_TOKEN` / `GITHUB_TOKEN` | — | Passed to the `copilot` subprocess, whichever variable is set; with neither, the bridged `copilot` login is used |
| Cursor Agent CLI (`auth_channel: api-key`) | `CURSOR_API_KEY` | — | Passed to the `cursor-agent` subprocess |
| Local Ollama | `OLLAMA_LOCAL_API_KEY` | — | Optional only for a secured loopback daemon; configure `apiKey: env:OLLAMA_LOCAL_API_KEY`. `OLLAMA_API_KEY` is never accepted or sent locally. |
| LM Studio | Not inferred | — | Local provider; no key required. A daemon you put behind one takes it inline or as `apiKey: env:YOUR_VAR` |
| Custom remote provider | Not inferred | — | Carries an inline `apiKey`, accepted only when you accept **normalized-origin trust** for the declared `apiBase` |

A provider descriptor may declare a `credentialPrefix`; a mismatch fails closed before network access (`provider-credential-prefix-mismatch`), and offering selection never follows from the prefix alone. Neither admitted provider declares one — both are local, and neither requires a credential.

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

The runner picker (`/planner`, `/implementer`) marks rows whose credential is missing as **Auth required** and names the tool's own sign-in command — for example `opencode auth login opencode-go`. It never asks you for a key: SPLITBRIEF does not accept, validate, or store credentials typed into the TUI. Selecting such a row still saves the selection, with the same sign-in note repeated as feedback.

Run the named command in your shell, or export the provider's environment variable (above), and the row stops being marked.

## Generic remote endpoints

Custom OpenAI-compatible providers must declare both `apiBase` and explicit `service` / `offering` fields. Because SPLITBRIEF cannot infer a safe environment variable name, the key is inline — one you rotate immediately.

**Normalized-origin trust** means:

- The credential is sent only to the normalized HTTPS origin of the configured `apiBase`.
- Cross-origin redirects are rejected: the request fails with `provider-endpoint-invalid` instead of following a redirect to another origin.
- Arbitrary env-key forwarding to unknown hosts is unsafe and unsupported for catalog providers.

See [CONFIGURATION.md](./CONFIGURATION.md) §20 for admitted provider endpoints and the generic remote example.

## Security measures

SPLITBRIEF takes several steps to protect your API keys:

- **Restrictive file permissions** — `.splitbrief/` directories are created with `0700` (owner-only access) and config files with `0600` (owner-only read/write). **Note (Windows):** File permission modes (0600/0700) are Unix-specific. On Windows, file access is managed through OS-level ACLs. Ensure your config directory is in a user-private location.
- **Automatic redaction** — error messages and logs are passed through `redactSecrets()`, which strips patterns matching API keys (`sk-ant-…`, `sk-…`, Bearer tokens, and generic key/token assignments)
- **No intentional key persistence** — SPLITBRIEF does not intentionally persist configured provider keys to state/session output, and protected outputs redact known secret patterns. Do not paste secrets into prompts or rely on this for external runner logs.
- **Header-only transport** — keys are only used in HTTP `Authorization` headers, never embedded in URLs or query parameters
- **Boolean detection flags** — provider detection returns `hasKey: true/false`, never the actual key value
- **Key format validation** — a provider that declares a credential prefix has its key checked against it; prefix mismatches fail closed before any network request
- **Bridged CLI session state** — a CLI runner on a host-state channel whose credential is a file (`session` for Codex and Copilot, `provider-dependent` for OpenCode and Kilo Code, and `session` for Claude Code and Cursor Agent CLI on Linux and Windows) cannot read your real `HOME`, so SPLITBRIEF copies only that tool's admitted credential file (for example `~/.claude/.credentials.json`) into `<project>/.splitbrief/sandbox/`, owner-only and read-only. The copy is refreshed when the host credential rotates and deleted when the run finishes; `.splitbrief/` must stay in `.gitignore`. Use `authChannel: api-key` if you would rather pass an environment credential and copy nothing.

### Claude Code on macOS

Claude Code stores its subscription session in the macOS login keychain, not in a file, so there is nothing for the file bridge to copy. The keychain's default search list resolves through `HOME`, and the item is keyed on the account name in `USER`. SPLITBRIEF therefore hands a macOS Claude Code `session` runner **your real `HOME` and `USER`** instead of a sandbox home, and copies nothing. That is the only way the subscription you already pay for can plan; `session` stays the default on every platform, and `splitbrief doctor` reports `authenticated` only when `claude auth status`, run inside that staged environment, says so.

The cost is stated plainly: on that one channel the planner child resolves `~` to your real home and writes Claude Code's own state (`~/.claude.json`, history) there, exactly as it does when you run `claude` yourself. Everything else the sandbox redirects — `TMPDIR`, `XDG_*`, `npm_config_cache`, `PIP_CACHE_DIR`, `CARGO_HOME` — still points inside `<project>/.splitbrief/sandbox/`. See [docs/WORKTREES.md](./WORKTREES.md) for the full accounting of what that child can reach.

If you would rather not hand over the home directory, set `auth_channel: api-key` and export `ANTHROPIC_API_KEY` — that channel is metered, and it copies and exposes nothing.

### Cursor Agent CLI on macOS

Cursor Agent CLI stores its subscription session in the macOS login keychain, not in the files the Linux file-bridge copies, so there is nothing for the file bridge to copy. `agent status` inside a remapped HOME reports `Not logged in` even when the host is already signed in via `agent login`. SPLITBRIEF therefore hands a macOS Cursor Agent CLI `session` runner **your real `HOME` and `USER`** (`host-account`) instead of a sandbox home, and copies nothing. That is how the paid subscription plans.

The cost is the same as Claude Code's `session` channel on macOS: `~` resolves to your real home. Everything else the sandbox redirects still points inside `<project>/.splitbrief/sandbox/`.

If you would rather not hand over the home directory, set `auth_channel: api-key` and export `CURSOR_API_KEY` — that channel is already the metered api-key alternative, and it copies and exposes nothing.

## Best practices

1. **Use environment variables** over config file storage
2. **Add `.splitbrief/` to `.gitignore`** — prevents accidental commits of config files that may contain keys
3. **Never commit** `.splitbrief/config.yaml` with API keys to version control
4. **Rotate keys periodically** — especially if you suspect exposure
5. **Use minimum-privilege scopes** — if your provider offers restricted API key scopes, use the narrowest one that works
6. **One key per developer** — in team environments, each developer should use their own API keys via their own environment
