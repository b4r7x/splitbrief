# Debugging

Common issues, diagnostic tools, and a troubleshooting workflow for diptych. Factual — everything below is backed by code in `src/` or documented configuration.

## Diagnostic modes

### Event log (JSONL sink)

Every run writes its full `EngineEvent` stream to:

```
.diptych/sessions/<session-id>/session.jsonl
```

One JSON object per line. Written by `src/engine/events/sinks/jsonl.ts` via `appendEngineEvent` in `src/core/state/persistence.ts`. See `src/engine/events/types.ts` for the full event union — `workflow_*`, `planner_*`, `task_*`, `validate`, `escalate`, `cost_update`, `error`, `warning`, and more.

Inspect with `jq`:

```bash
# All events across sessions
cat .diptych/sessions/*/session.jsonl | jq .

# Only failures
jq 'select(.type == "task_full_fail" or .type == "error")' \
  .diptych/sessions/<id>/session.jsonl

# Validation outcomes
jq 'select(.type == "validate") | {taskId, passed: .data.passed, stages: .data.stages, error: .data.error}' \
  .diptych/sessions/<id>/session.jsonl

# Cost accumulation
jq 'select(.type == "cost_update")' .diptych/sessions/<id>/session.jsonl
```

The transcript events (`planner_text`) are suppressed when `workflow.persistTranscript: false` in config.

### Active session pointer

`.diptych/active` stores the active session id. If commands like `diptych status` or `diptych resume` report "no active session", the pointer is missing or stale — start a new workflow or manually `cat .diptych/active`.

### Headless mode (`--json`)

For CI or programmatic inspection, bypass the Ink TUI entirely and emit NDJSON `EngineEvent` records to stdout:

```bash
diptych start --json "feature description" 2>/dev/null | jq .
```

Implementation: `src/cli/headless.ts` wires a `createStdoutJsonSink()` (`src/engine/events/sinks/stdout-json.ts`) in place of the TUI. The JSONL sink still writes the on-disk session log.

`--json` requires a feature argument on `start`. `resume`, `continue`, and `last` rehydrate interrupted sessions from saved state.

### OpenTelemetry console exporter

For a timeline view with span hierarchy (workflow → phase → task), opt into OTel and use the built-in console exporter:

```bash
# One of:
OTEL_TRACES_EXPORTER=console diptych start --json --mode quick "…"
DIPTYCH_OTEL_EXPORTER=console diptych start --json --mode quick "…"
diptych start --otel-exporter console --json --mode quick "…"
```

Also set `otel.enabled: true` in `.diptych/config.yaml` — the env var / flag only registers the provider; the sink is only installed when config allows. The console exporter writes spans with `console.dir`, so it uses stdout and can interleave with `--json` output. Full details: [OTEL.md](./OTEL.md). Bootstrap source: `src/cli/otel-bootstrap.ts`.

### Debug environment variables

There is no `debug` package / namespace logger in diptych today. The diagnostic surface is:

| Variable | Effect | Source |
|---|---|---|
| `OTEL_TRACES_EXPORTER=console` | Bootstrap built-in OTel console exporter | `src/cli/otel-bootstrap.ts` |
| `DIPTYCH_OTEL_EXPORTER=console` | Alias for the above | `src/cli/otel-bootstrap.ts` |
| `DIPTYCH_CONTEXT_LENGTH` | Override detected implementer context length (integer) | `src/engine/providers/registry.ts` |
| `NODE_ENV=development` | Enables store-creation logging | `src/stores/create-store.ts` |
| `CI` | Suppresses fullscreen TUI (`--no-fullscreen` is equivalent) | `src/cli/setup.ts` |

For finer-grained traces, use the event log or OTel spans. API-key-bearing env vars (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, etc.) are listed in [CONFIGURATION.md](./CONFIGURATION.md) — missing keys surface as loud config-validation warnings.

## Common issues

### "Configuration errors in .diptych/config.yaml"

Cause: YAML failed zod validation. The message lists each failing path. Check:
- `version: 2` is present.
- Top-level `planner` / `implementer` have a valid `kind`.
- Per-kind required fields are set (e.g. `kind: api` requires `provider` and `apiBase`).
- No unknown keys in `codebase`, `hooks`, `otel` — those sections are `.strict()`.

See [CONFIGURATION.md](./CONFIGURATION.md) for the full schema. The loader throws `ConfigError` (`src/core/config/errors.ts`) and `loadConfigOrExit` in `src/cli/setup.ts` exits with code 1.

### "Hook config is not trusted and no TTY available"

Cause: `.diptych/config.yaml` declares `hooks:` but `.diptych/hook-trust.json` does not record the current hook config and module-file hash, and stdin is not a TTY (CI).

Fix: run interactively once to trust (`diptych start`), or pass `--allow-hooks` on every CI run. See [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) §Trust model. Editing the hook config or a module hook file invalidates trust and triggers a re-prompt.

### Planner hangs / implementer times out

Diagnostic path:

1. Inspect `session.jsonl` — the last event tells you which phase was active:
   ```bash
   tail -20 .diptych/sessions/<id>/session.jsonl | jq .
   ```
2. Check the runner timeout — the `timeout` field in `planner.*` / `implementer.*` (max 600000 ms, schema ceiling).
3. For API runners, check network reachability to `apiBase`.
4. For CLI runners, ensure the tool is on `PATH` (planner CLI probe is in `src/engine/planners/cli.ts`).
5. `cost_update` events stop arriving → the subprocess is live but not producing tokens; check remote provider status.

`--budget` / `workflow.maxBudget` caps dollar cost but does not enforce wall-clock timeouts directly.

### OTel spans never appear

Cause (most common): ESM dual-resolution. Diptych's sink imports `@opentelemetry/api` as a bare specifier; a pre-registration from an external wrapper script using an absolute path lands in a different module cache entry.

Fix: use the bundled bootstrap (`OTEL_TRACES_EXPORTER=console` / `DIPTYCH_OTEL_EXPORTER=console` / `--otel-exporter console`) or register your provider from within the same module-resolution context. See [OTEL.md](./OTEL.md) §Quick-start for the full explanation.

Also verify `otel.enabled: true` in config — the bootstrap registers the provider unconditionally, but the sink itself is gated on the config flag (`src/engine/orchestrator/run/init.ts`).

### "Cannot find module" for a relative import

Cause: missing `.js` extension in a relative import. ESM requires explicit `.js` on every intra-project import:

```ts
// correct
import { loadConfig } from './core/config/load/load.js';
// wrong — ERR_MODULE_NOT_FOUND
import { loadConfig } from './core/config/load/load';
```

See [PRINCIPLES.md](./PRINCIPLES.md) — ESM rule.

### "No active workflow" on `resume`

Cause: `.diptych/active` is missing, or the pointed-to session has no `state.json`, or `stateVersion` is from a pre-v3 layout.

Fix:
- Stale pre-v3 state: run `diptych migrate` (see `src/cli/commands/migrate.ts`).
- Unresumable phase (e.g. `complete`): start a fresh workflow with `diptych start`.
- The `resume` command's exact error messages are in `src/cli/commands/resume.ts`.

### Tests pass locally but fail in CI (or vice versa)

Diagnostic checklist:
- Node version: engines field requires `>=22`. Check `node --version` matches CI.
- `CI=1` is set in CI → TUI disabled, some tests depend on non-TTY stdout. Run locally with `CI=1 npm test` to reproduce.
- Temp dir state: some tests write under `os.tmpdir()`. Flake when runs don't clean up; rerun after `rm -rf $TMPDIR/diptych-*`.
- API-key env vars from your shell leak into tests. CI runs cleaner. Unset local keys to reproduce CI.
- Run the CI pipeline exactly: `npm run test-ci` (typecheck → lint → test → invariants).

### API key warning in logs

Cause: config file contains `apiKey: sk-...` inline. diptych detects and warns via `warnStderr` — config load still succeeds. Migrate to the corresponding env var (see [API-KEYS.md](./API-KEYS.md) and [CONFIGURATION.md](./CONFIGURATION.md) §Environment variables).

### `.diptych/config.yaml` permissions warning

Cause: on non-Windows, the config file permissions are looser than `0600`. Source: `src/core/config/load/load.ts`. Fix:

```bash
chmod 600 .diptych/config.yaml
chmod 700 .diptych
```

## Troubleshooting workflow

1. **Reproduce minimally.** `diptych start --json --mode quick "minimal repro"` — the quick mode is one planner call with no approval gates; easiest to script.
2. **Check the session log.**
   ```bash
   cat .diptych/active
   jq . .diptych/sessions/$(cat .diptych/active)/session.jsonl | less
   ```
   The last event before failure usually points at the failing phase/task.
3. **Run headless.** Decouples TUI from engine logic. `diptych start --json …` lets you see events without Ink rendering errors.
4. **Enable OTel.** For timing / hierarchy. `--otel-exporter console` is enough for local inspection.
5. **Check invariants.** If the bug looks like an architecture regression (engine importing React, barrels reappearing, etc.), see [INVARIANTS.md](./INVARIANTS.md) for the pre-merge grep gates — run them.

## Getting help

- [WORKFLOW.md](./WORKFLOW.md) — expected behavior per `mode`.
- [CHANGELOG.md](./CHANGELOG.md) — recent changes that may have caused regressions.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — system diagram, planner/implementer contracts.
- Open an issue with: the session id (`.diptych/active`), the contents of `.diptych/sessions/<id>/session.jsonl`, and your `.diptych/config.yaml` with any `apiKey` values stripped.
