# API key security

SPLITBRIEF connects to AI providers (planner + implementer) that may require API keys. This guide covers how keys are handled and best practices for keeping them secure.

## Recommended: environment variables

Set your API key as an environment variable. This keeps it out of project files and version control.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Add the export to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) so it persists across sessions.

### Provider reference

| Provider | Environment Variable | Notes |
|----------|---------------------|-------|
| Anthropic / Agent SDK | `ANTHROPIC_API_KEY` | Required for Anthropic API and Agent SDK |
| OpenAI | `OPENAI_API_KEY` | |
| Groq | `GROQ_API_KEY` | |
| Together AI | `TOGETHER_API_KEY` | |
| OpenRouter | `OPENROUTER_API_KEY` | |
| DeepSeek | `DEEPSEEK_API_KEY` | |
| Ollama | `OLLAMA_API_KEY` | Optional for secured local/proxy deployments |
| Custom provider | Not inferred | Set `apiKey` inline with `apiBase` unless the provider is added to the catalog |
| LM Studio | Not required | Local provider |

✅ Environment variables are not committed to git, not stored on disk in project files, and work across all tools that read from the environment.

## Alternative: config file

You can set `apiKey` directly in `.splitbrief/config.yaml` under `planner` or `implementer`:

```yaml
planner:
  kind: api
  provider: anthropic
  apiKey: sk-ant-...

implementer:
  tool: deepseek
  apiKey: sk-...
```

⚠️ **SPLITBRIEF warns when API keys are detected in config files** — it will recommend switching to the corresponding environment variable when the provider uses its official endpoint. Keep an inline key for a known provider with a custom/proxy `apiBase`; environment keys are intentionally rejected for that case to avoid sending your provider key to an unexpected endpoint.

## Security measures

SPLITBRIEF takes several steps to protect your API keys:

- **Restrictive file permissions** — `.splitbrief/` directories are created with `0700` (owner-only access) and config files with `0600` (owner-only read/write). **Note (Windows):** File permission modes (0600/0700) are Unix-specific. On Windows, file access is managed through OS-level ACLs. Ensure your config directory is in a user-private location.
- **Automatic redaction** — error messages and logs are passed through `redactSecrets()`, which strips patterns matching API keys (`sk-ant-...`, `sk-...`, Bearer tokens, and generic key/token assignments)
- **No intentional key persistence** — SPLITBRIEF does not intentionally persist configured provider keys to state/session output, and protected outputs redact known secret patterns. Do not paste secrets into prompts or rely on this for external runner logs.
- **Header-only transport** — keys are only used in HTTP `Authorization` headers, never embedded in URLs or query parameters
- **Boolean detection flags** — provider detection returns `hasKey: true/false`, never the actual key value
- **Key format validation** — known providers (e.g., Anthropic keys starting with `sk-ant-`) are validated against expected formats; mismatches produce warnings, not errors, since key formats may change over time

## Best practices

1. ✅ **Use environment variables** over config file storage
2. ✅ **Add `.splitbrief/` to `.gitignore`** — prevents accidental commits of config files that may contain keys
3. ✅ **Never commit** `.splitbrief/config.yaml` with API keys to version control
4. ✅ **Rotate keys periodically** — especially if you suspect exposure
5. ✅ **Use minimum-privilege scopes** — if your provider offers restricted API key scopes, use the narrowest one that works
6. ✅ **One key per developer** — in team environments, each developer should use their own API keys via their own environment
