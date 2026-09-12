# Debugging

Common issues, diagnostic tools, and a troubleshooting workflow for SPLITBRIEF. Factual — everything below is backed by code in `src/` or documented configuration.

## Diagnostic modes

### Event log (JSONL sink)

Every run writes its full `EngineEvent` stream to:

```
.splitbrief/sessions/<session-id>/session.jsonl
```

One JSON object per line. Written by `src/engine/events/sinks/jsonl.ts` through the protected session-log appender in `src/core/sessions/log-writer.ts`. See `src/engine/events/schema.ts` (`EngineEventSchema`) for the full event union -- `workflow_*`, `planner_*`, `task_*`, `validate`, `escalate`, `cost_update`, `error`, `warning`, and more.

Inspect with `jq`:

```bash
# All events across sessions
cat .splitbrief/sessions/*/session.jsonl | jq .

# Only failures
jq 'select(.type == "task_full_fail" or .type == "error")' \
  .splitbrief/sessions/<id>/session.jsonl

# Validation outcomes
jq 'select(.type == "validate") | {taskId, passed: .data.passed, stages: .data.stages, error: .data.error}' \
  .splitbrief/sessions/<id>/session.jsonl

# Cost accumulation
jq 'select(.type == "cost_update")' .splitbrief/sessions/<id>/session.jsonl

# Runner-call warnings with grouping fields
jq 'select(.type == "runner_call_warning") | {callId: .data.callId, phase, warning: .data.warning}' \
  .splitbrief/sessions/<id>/session.jsonl
```

Stderr is diagnostic by default. A `call_stderr_delta` from the raw runner stream is not projected into `session.jsonl` as a `runner_call_warning` and does not create a primary warning row. Actionable warnings appear as `runner_call_warning` and carry `code`, `severity`, `source`, `surface`, `fingerprint`, `message`, and optional `rawRef`. Repeated warnings are grouped in the TUI by fingerprint/code/source/surface.

### Active session pointer

`.splitbrief/active` stores the active session id. If commands like `splitbrief status` or `splitbrief resume` report "no active session", the pointer is missing or stale — start a new workflow or manually `cat .splitbrief/active`.

### Headless mode (`--json`)

For CI or programmatic inspection, bypass the Ink TUI entirely and emit NDJSON `EngineEvent` records to stdout:

```bash
splitbrief start --json "feature description" 2>/dev/null | jq .
```

Implementation: `src/cli/headless.ts` wires a `createStdoutJsonSink()` (`src/engine/events/sinks/stdout-json.ts`) in place of the TUI. The JSONL sink still writes the on-disk session log.

`--json` requires a feature argument on `start`. `resume` and `continue` rehydrate interrupted sessions from saved state.

### Debug environment variables

There is no `debug` package / namespace logger in SPLITBRIEF today. The diagnostic surface is:

| Variable | Effect | Source |
|---|---|---|
| `SPLITBRIEF_CONTEXT_LENGTH` | Override detected implementer context length (integer) | `src/engine/providers/capabilities.ts` |
| `CI` | Suppresses fullscreen TUI (`--no-fullscreen` is equivalent) | `src/cli/setup.ts` |
| `SPLITBRIEF_REAL_CLI_E2E` | Set to `1` to enable the paid live CLI e2e tier (default: every case skips) | `testing/e2e/helpers/live-harness.ts` |
| `SPLITBRIEF_REAL_CLI_TIER` | `easy` (default) / `heavy` / `all` — which live scenarios run | `testing/e2e/helpers/live-harness.ts` |

For finer-grained traces, use the event log. The API-key-bearing env vars SPLITBRIEF reads are listed in [CONFIGURATION.md §Provider authentication](./CONFIGURATION.md#provider-authentication) — a missing credential fails config load for an API seat and shows as a readiness blocker for a CLI seat.

### Terminal diagnostics

Direct terminal diagnostics are sanitized before printing. `warnStderr`, `warnError`, process-output errors, and generic CLI error formatting strip ANSI/OSC/control sequences, redact shared secret patterns including JWT-like tokens, and bound diagnostic text before writing to stderr. First-party styling may wrap the sanitized text after that; untrusted subprocess/provider text should not be styled before sanitization.

### Live CLI e2e tier

Reading a skip in `testing/e2e/scenarios/live/`: with `SPLITBRIEF_REAL_CLI_E2E` unset every case is skipped silently — that is the default and means nothing is wrong. With the master switch set, a per-tool skip prints the readiness reason from `liveToolBlocker`, which is the tool's own detection state; `ready` requires trusted + compatible + authenticated, so `not ready (…)` almost always means the binary is missing from `PATH` or the login expired. Fix it with the tool's own install or login command, not with SPLITBRIEF.

A refused model pin throws instead of skipping. That is intentional: the ceiling exists to stop a mistyped `SPLITBRIEF_REAL_CLI_<TOOL>_MODEL` from billing a frontier model, and a silent skip would hide the typo.

## Common issues

### "Configuration errors in .splitbrief/config.yaml"

Cause: YAML failed zod validation. The message lists each failing path. Check:
- `version: 3` is present — no other version loads.
- Top-level `planner` / `implementer` have a valid `kind`.
- Per-kind required fields are set (e.g. `kind: api` requires `provider` and `apiBase`).
- No unknown keys in `workflow`, `codebase`, `hooks` — those sections are strict. Removed fields (`workflow.autoApproveSpec`, `workflow.autoApprovePlan`, top-level `workflow.commitStrategy`) fail here rather than being ignored.

See [CONFIGURATION.md](./CONFIGURATION.md) for the full schema. The loader throws `ConfigError` (`src/core/config/errors.ts`) and `loadConfigOrExit` in `src/cli/setup.ts` exits with code 1.

### "Hook config is not trusted and no TTY available"

Cause: `.splitbrief/config.yaml` declares `hooks:` but `~/.splitbrief/trust/hooks.json` holds no receipt for this checkout at the current hook config hash, and stdin is not a TTY (CI).

Fix: run interactively once to trust (`splitbrief start`), or pass `--allow-hooks` on every CI run. See [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) §Trust model. Editing the hook config invalidates trust and triggers a re-prompt.

### Planner hangs / implementer times out

Diagnostic path:

1. Inspect `session.jsonl` — the last event tells you which phase was active:
   ```bash
   tail -20 .splitbrief/sessions/<id>/session.jsonl | jq .
   ```
2. Check the runner timeout — the `timeout` field in `planner.*` / `implementer.*` (max 600000 ms, schema ceiling).
3. For API runners, check network reachability to `apiBase`.
4. For CLI runners, ensure the tool is on `PATH` (planner CLI probe is in `src/engine/planners/cli.ts`).
5. `cost_update` events stop arriving → the subprocess is live but not producing tokens; check remote provider status.

`--budget` / `workflow.maxBudget` caps dollar cost but does not enforce wall-clock timeouts directly.

### "Cannot find module" for a relative import

Cause: missing `.js` extension in a relative import. ESM requires explicit `.js` on every intra-project import:

```ts
// correct
import { loadConfig } from './core/config/load/io.js';
// wrong — ERR_MODULE_NOT_FOUND
import { loadConfig } from './core/config/load/io';
```

See [PRINCIPLES.md](./PRINCIPLES.md) — ESM rule.

### "No active workflow" on `resume`

Cause: `.splitbrief/active` is missing, or the pointed-to session has no `state.json`, or `stateVersion` does not match the current version.

Fix:
- Incompatible `stateVersion`: the state file is ignored with a warning — start a fresh workflow with `splitbrief start`.
- Unresumable phase (e.g. `complete`): start a fresh workflow with `splitbrief start`.
- The `resume` command's exact error messages are in `src/cli/commands/resume.ts`.

### Tests pass locally but fail in CI (or vice versa)

Diagnostic checklist:
- Node version: engines field requires `>=22`. Check `node --version` matches CI.
- `CI=1` is set in CI → TUI disabled, some tests depend on non-TTY stdout. Run locally with `CI=1 npm test` to reproduce.
- Temp dir state: some tests write under `os.tmpdir()`. Flake when runs don't clean up; rerun after `rm -rf $TMPDIR/splitbrief-*`.
- API-key env vars from your shell leak into tests. CI runs cleaner. Unset local keys to reproduce CI.
- Reproduce CI's split gate with `npm run release-check` (the same steps minus coverage). CI runs `static`, `unit` (four vitest shards), `e2e-replay` and `smoke` as parallel jobs, and coverage nightly.
- Add the nightly coverage job on top with `npm run test-ci` (format:check → typecheck → lint → test:coverage → e2e → invariants → skills:check) — the superset of both CI workflows.

### Config load fails with "API key exfiltration risk"

Two variants, both errors — the config does not load:

- `Custom/unknown provider <x> <role> cannot use env apiKey reference env:<VAR> with apiBase <url> (API key exfiltration risk). Use an inline apiKey for this custom provider.`
- `<Provider> <role> with custom endpoint <url> cannot use <VAR> without an inline apiKey (API key exfiltration risk).`

Cause: an `api` runner points at an endpoint SPLITBRIEF does not own (a custom/unknown `provider`, or a known provider with an `apiBase` of a different origin than its official one) while its key comes from the environment. Sending an env-held key to an arbitrary host would leak it.

Fix: for a custom/unknown `provider`, give the seat an inline `apiKey: sk-...` — an `env:` reference is never accepted there, whatever the `apiBase`. For a known provider pointed at a foreign `apiBase`, either set an inline `apiKey` for that endpoint or drop the `apiBase` override so the provider's official endpoint and its env var apply. Source: `src/core/config/credentials.ts`. See [API-KEYS.md](./API-KEYS.md) and [CONFIGURATION.md](./CONFIGURATION.md) §Environment variables.

### `.splitbrief/config.yaml` permissions warning

Cause: on non-Windows, the config file permissions are looser than `0600`. Source: `src/core/config/load/io.ts`. Fix:

```bash
chmod 600 .splitbrief/config.yaml
chmod 700 .splitbrief
```

## Troubleshooting workflow

1. **Reproduce minimally.** `splitbrief start --json --mode quick "minimal repro"` — the quick mode is one planner call with no approval gates; easiest to script.
2. **Check the session log.**
   ```bash
   cat .splitbrief/active
   jq . .splitbrief/sessions/$(cat .splitbrief/active)/session.jsonl | less
   ```
   The last event before failure usually points at the failing phase/task.
3. **Run headless.** Decouples TUI from engine logic. `splitbrief start --json …` lets you see events without Ink rendering errors.
4. **Check invariants.** If the bug looks like an architecture regression (engine importing React, barrels reappearing, etc.), see [INVARIANTS.md](./INVARIANTS.md) for the pre-merge grep gates — run them.

## Getting help

- [WORKFLOW.md](./WORKFLOW.md) — expected behavior per `mode`.
- [CHANGELOG.md](../CHANGELOG.md) — recent changes that may have caused regressions.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — system diagram, planner/implementer contracts.
- Open an issue with: the session id (`.splitbrief/active`), the contents of `.splitbrief/sessions/<id>/session.jsonl`, and your `.splitbrief/config.yaml` with any `apiKey` values stripped.
