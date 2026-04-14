# API Key Security

diptych connects to AI providers (planner + implementer) that may require API keys. This guide covers how keys are handled and best practices for keeping them secure.

## Recommended: Environment Variables

Set your API key as an environment variable. This keeps it out of project files and version control.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Add the export to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) so it persists across sessions.

### Provider Reference

| Provider | Environment Variable | Notes |
|----------|---------------------|-------|
| Anthropic / Agent SDK | `ANTHROPIC_API_KEY` | Required for Claude Code planner and Agent SDK |
| OpenRouter | `OPENROUTER_API_KEY` | |
| DeepSeek | `DEEPSEEK_API_KEY` | |
| Custom provider | `<PROVIDER_NAME>_API_KEY` | Auto-generated from provider name (uppercased, non-alphanumeric → `_`) |
| Ollama | Not required | Local provider |
| LM Studio | Not required | Local provider |

✅ Environment variables are not committed to git, not stored on disk in project files, and work across all tools that read from the environment.

## Alternative: Config File

You can set `apiKey` directly in `.diptych/config.yaml` under `planner` or `implementer`:

```yaml
planner:
  kind: api
  provider: anthropic
  apiKey: sk-ant-...

implementer:
  tool: deepseek
  apiKey: sk-...
```

⚠️ **diptych warns when API keys are detected in config files** — it will recommend switching to the corresponding environment variable. Config file storage is a convenience tradeoff, not the recommended approach.

## Security Measures

diptych takes several steps to protect your API keys:

- **Restrictive file permissions** — `.diptych/` directories are created with `0700` (owner-only access) and config files with `0600` (owner-only read/write). **Note (Windows):** File permission modes (0600/0700) are Unix-specific. On Windows, file access is managed through OS-level ACLs. Ensure your config directory is in a user-private location.
- **Automatic redaction** — error messages and logs are passed through `redactSecrets()`, which strips patterns matching API keys (`sk-ant-...`, `sk-...`, Bearer tokens, and generic key/token assignments)
- **No key logging** — API keys are never written to console output, state files, or session files
- **Header-only transport** — keys are only used in HTTP `Authorization` headers, never embedded in URLs or query parameters
- **Boolean detection flags** — provider detection returns `hasKey: true/false`, never the actual key value
- **Key format validation** — known providers (e.g., Anthropic keys starting with `sk-ant-`) are validated against expected formats; mismatches produce warnings, not errors, since key formats may change over time

## Best Practices

1. ✅ **Use environment variables** over config file storage
2. ✅ **Add `.diptych/` to `.gitignore`** — prevents accidental commits of config files that may contain keys
3. ✅ **Never commit** `.diptych/config.yaml` with API keys to version control
4. ✅ **Rotate keys periodically** — especially if you suspect exposure
5. ✅ **Use minimum-privilege scopes** — if your provider offers restricted API key scopes, use the narrowest one that works
6. ✅ **One key per developer** — in team environments, each developer should use their own API keys via their own environment
