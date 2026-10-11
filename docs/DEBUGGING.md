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

# Brief, plan and task check results
jq 'select(.type == "checks_run") | {taskId, results: .data.results}' \
  .splitbrief/sessions/<id>/session.jsonl

# Reviewer check results
jq 'select(.type == "full_suite" and .data.status != "running") | .data | {id, command, moment, status, passed, detail}' \
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

`--json` requires a feature argument on `start`. `resume` and `continue` pick an open run up from its saved state.

### Debug environment variables

SPLITBRIEF has no `debug` package or namespace logger. The diagnostic surface is:

| Variable | Effect | Source |
|---|---|---|
| `SPLITBRIEF_CONTEXT_LENGTH` | Override detected implementer context length (integer) | `src/engine/providers/capabilities.ts` |
| `CI` | Suppresses fullscreen TUI (`--no-fullscreen` is equivalent) | `src/cli/setup.ts` |

For finer-grained traces, use the event log. The API-key-bearing env vars SPLITBRIEF reads are listed in [CONFIGURATION.md §Provider authentication](./CONFIGURATION.md#provider-authentication) — a missing credential fails config load for an API seat and shows as a readiness blocker for a CLI seat.

### Terminal diagnostics

Direct terminal diagnostics are sanitized before printing. `warnStderr`, `warnError`, process-output errors, and generic CLI error formatting strip ANSI/OSC/control sequences, redact shared secret patterns including JWT-like tokens, and bound diagnostic text before writing to stderr. First-party styling may wrap the sanitized text after that; untrusted subprocess/provider text should not be styled before sanitization.

## Common issues

### "Configuration errors in .splitbrief/config.yaml"

Cause: YAML failed zod validation. The message lists each failing path. Check:
- `version: 3` is present — no other version loads.
- Top-level `planner` / `implementer` have a valid `kind`.
- Per-kind required fields are set (e.g. `kind: api` requires `provider` and `apiBase`).
- No unknown keys in `workflow`, `codebase`, `hooks` — those sections are strict. Removed fields (`workflow.autoApproveSpec`, `workflow.autoApprovePlan`, top-level `workflow.commitStrategy`) fail here rather than being ignored. The retired planning keys do not fail: `workflow.mode`, `workflow.task_review`, `workflow.brief_review`, `workflow.speckit`, `approval.tiers` and the `workflow.approve` values `all`, `spec` and `default` each load with one notice.

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
2. Check the runner limits — the opt-in `timeout` and `idleKillMs` fields in `planner.*` / `implementer.*` / `reviewer.*`. A `cli`, `shell` or `agent` seat has no default limit; the watchdog only warns after 5 minutes of no output.
3. For API runners, check network reachability to `apiBase`.
4. For CLI runners, ensure the tool is on `PATH` (planner CLI probe is in `src/engine/planners/cli.ts`).
5. `cost_update` events stop arriving → the subprocess is live but not producing tokens; check remote provider status.


### "No active workflow" on `resume`

Cause: `.splitbrief/active` is missing — closing a run releases it — or the pointed-to session has no readable `state.json`, or its `stateVersion` is one `WORKFLOW_STATE_VERSION` cannot load. Name an older run with `splitbrief continue <session-id>`.

Fix:
- Incompatible `stateVersion`: the state file is ignored with a warning — start a fresh workflow with `splitbrief start`.
- A closed run (ended by the user, or `complete` with a passing review): it is a record, not a workspace — start a fresh workflow with `splitbrief start`. Every other stop is continuable.
- The `resume` command's exact error messages are in `src/cli/commands/resume.ts`.

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

1. **Reproduce minimally.** `splitbrief start --json "minimal repro"` with `workflow.approve: none` in the config — one planning session and no plan card; easiest to script.
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
