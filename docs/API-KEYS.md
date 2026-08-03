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

### Admitted provider reference

| Provider | Environment variable | Prefix validation | Notes |
|----------|---------------------|-------------------|-------|
| Anthropic / Agent SDK | `ANTHROPIC_API_KEY` | `sk-ant-` | Required for Anthropic API and Agent SDK |
| OpenAI | `OPENAI_API_KEY` | `sk-` | |
| Groq | `GROQ_API_KEY` | `gsk_` | |
| Together AI | `TOGETHER_API_KEY` | — | |
| OpenRouter | `OPENROUTER_API_KEY` | `sk-or-` | |
| DeepSeek | `DEEPSEEK_API_KEY` | `sk-` | |
| Local Ollama | `OLLAMA_LOCAL_API_KEY` | — | Optional only for a secured loopback daemon; configure `apiKey: env:OLLAMA_LOCAL_API_KEY`. `OLLAMA_API_KEY` is never accepted or sent locally. |
| Ollama Cloud | `OLLAMA_API_KEY` | — | Required for the fixed remote Ollama Cloud API. |
| LM Studio | — | — | Local provider; no key required |
| Custom remote provider | Not inferred | — | Set `apiKey: env:YOUR_VAR` or inline only when you accept **normalized-origin trust** for the declared `apiBase` |

Prefix mismatches fail closed before network access (`provider-credential-prefix-mismatch`); offering selection never follows from the prefix alone.

## Alternative: config file

You can reference a key indirectly in `.splitbrief/config.yaml`:

```yaml
planner:
  kind: api
  provider: anthropic
  service: anthropic
  offering: payg
  apiBase: https://api.anthropic.com/v1
  apiKey: env:ANTHROPIC_API_KEY
  model: claude-sonnet-4-6
```

**SPLITBRIEF warns when inline API keys are detected in config files** — it recommends switching to the matching environment variable when the provider uses its official normalized endpoint. For a known provider with a custom/proxy `apiBase`, keep the key inline only when you accept **normalized-origin trust** for that host; environment keys are intentionally rejected for that case so your provider key is not sent to an unexpected origin.

Never paste real or placeholder secrets (`sk-ant-…`, `sk-or-…`, `gsk_…`) into committed YAML examples.

## Entering a key in the runner picker

The runner picker (`/planner`, `/implementer`) marks offerings whose credential is missing as **Auth required**. Pressing Enter on such a row opens a masked key-entry panel instead of selecting the runner:

- Input is masked while you type.
- The key is validated against the provider **before** anything is saved. A key the provider rejects is discarded — nothing is written.
- Pressing esc closes the panel and saves nothing.
- Only after successful validation is the key stored in `.splitbrief/config.yaml` with `0600` permissions, alongside a check that `.splitbrief/` is gitignored.

This is a convenience path for getting unblocked inside the TUI. Exporting the provider's environment variable (above) remains the preferred place for a credential; once you export it, remove the stored `apiKey` entry from `.splitbrief/config.yaml` — the loader keeps warning while an inline key remains.

## Generic remote endpoints

Custom OpenAI-compatible providers must declare both `apiBase` and explicit `service` / `offering` fields. Because SPLITBRIEF cannot infer a safe environment variable name, use `apiKey: env:YOUR_VAR_NAME` or an inline key you rotate immediately.

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
- **Key format validation** — known providers (for example Anthropic keys starting with `sk-ant-`) are validated against expected formats; prefix mismatches fail closed before any network request
- **Bridged CLI session state** — a CLI runner configured with `authChannel: session` (Claude Code, Codex, Copilot, OpenCode, Kilo Code) cannot read your real `HOME`, so SPLITBRIEF copies only that tool's admitted credential file (for example `~/.claude/.credentials.json`) into `<project>/.splitbrief/sandbox/`, owner-only and read-only. The copy is refreshed when the host credential rotates and deleted when the run finishes; `.splitbrief/` must stay in `.gitignore`. Use `authChannel: api-key` if you would rather pass an environment credential and copy nothing.

## Best practices

1. **Use environment variables** over config file storage
2. **Add `.splitbrief/` to `.gitignore`** — prevents accidental commits of config files that may contain keys
3. **Never commit** `.splitbrief/config.yaml` with API keys to version control
4. **Rotate keys periodically** — especially if you suspect exposure
5. **Use minimum-privilege scopes** — if your provider offers restricted API key scopes, use the narrowest one that works
6. **One key per developer** — in team environments, each developer should use their own API keys via their own environment
