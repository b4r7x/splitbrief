# Models.dev Migration Notes

diptych now treats `models.dev` as the primary model catalog and pricing source.

## Precedence

1. `models.dev`
2. Runtime provider detection / CLI discovery
3. Bundled offline fallback manifest

## Important behavior

- CLI tools and subscriptions stay unpriced. We no longer proxy-price `claude-code`, `codex`, `copilot`, `opencode`, `kilo-code`, or `aider` through upstream APIs.
- Claude Code uses tool-native aliases: `default`, `sonnet`, `opus`, `opusplan`.
- Legacy stored `claude-code: auto` still works and normalizes to `default`.
- `opencode` and `kilo-code` should usually stay on `auto`; configure the real model in the tool itself.
- `models.dev` prices are already expressed in USD per 1M tokens. Do not multiply them again.
