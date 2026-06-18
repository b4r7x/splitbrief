# Hook system (workflow lifecycle hooks)

> **Different from `docs/HOOKS.md`!** That doc covers React hooks. This doc covers user-extensible **workflow lifecycle hooks** — shell commands or built-in scanners that fire at well-known moments during a diptych workflow. Lifecycle hooks are not React hooks.

User-extensible hook system inspired by Claude Agent SDK. Declare commands or modules in `.diptych/config.yaml`, or drop convention-named JS/TS modules into `.diptych/hooks/`, to fire at workflow events (pre/post task, pre/post validation, optional pre/post commit, etc.). Used for `prettier --write` after each task, secret scanning when product-level commit hooks are enabled, Slack notifications, custom validators — anything you can run from a script or module.

## Quick start

```yaml
# .diptych/config.yaml
hooks:
  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
      on_failure: warn
  pre_commit:
    - command: ".diptych/hooks/check-secrets.sh"
      timeout_ms: 10000
      on_failure: block
```

```bash
diptych start --allow-hooks "add JWT auth"
```

The first time you run with hooks defined, diptych prompts to trust them. Use `--allow-hooks` in CI.

## Hook events

Ten events fire during a workflow (plus `pre_compact`, a reserved key with no dispatch site yet). Each can have multiple hooks declared.

| Event            | When                                        | Payload (event fields)                                              |
|------------------|---------------------------------------------|----------------------------------------------------------------------|
| `pre_planning`   | Before any planner phase starts             | `feature`                                                            |
| `pre_task`       | Before each implementer task starts         | `taskId`, `title`, `file`, `action`, `index`, `total`                |
| `post_task`      | After each implementer task succeeds        | `taskId`, `title`, `method`, `file`, `retries`, `duration`           |
| `pre_validation` | Before tsc/lint/test runs                   | `taskId`                                                            |
| `post_validation`| After validation finishes                   | `taskId`, `passed`, `stages` (`{typecheck,lint,test}`), `error?`     |
| `pre_commit`     | Before optional product-level git commit    | `taskId`, `file`                                                     |
| `post_commit`    | After optional product-level git commit succeeds | `taskId`, `message`                                             |
| `pre_escalation` | Before planner escalation runs              | `taskId`                                                             |
| `pre_compact`    | Reserved for transcript compaction (FUTURE) | (none)                                                               |
| `on_error`       | Any unrecoverable engine error              | `message`                                                            |
| `on_complete`    | `workflow_complete` event                   | (none)                                                               |

`pre_*` hooks **block** the workflow until they finish. `post_*` and `on_*` hooks are fire-and-forget — failures log a warning but don't gate the flow.

## Configuration shape

```yaml
hooks:
  builtin:                   # Toggle built-ins
    prettier-on-change: true
    block-secrets: true

  pre_task:                  # Per-event hook list
    - name: "lint-check"     # Optional name (else uses command)
      command: "npx"         # Required — script or binary path
      args: ["prettier", "--check", "${event.file}"]
      timeout_ms: 5000       # Default 30000, max 300000
      on_failure: block      # 'block' | 'warn' (default) | 'ignore'

  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
```

Schema: `src/core/schemas/hooks.ts`. Strict — unknown keys rejected.

### `kind` field

Each hook entry has an explicit `kind` discriminant. When `kind` is omitted, it defaults to `"command"` (backward compatible).

| `kind`    | Description                                                                 |
|-----------|-----------------------------------------------------------------------------|
| `command` | Shell command or script. Spawned as a subprocess. Default when kind omitted. |
| `module`  | In-process JS/TS module. Loaded via dynamic `import()`. No subprocess cost. |

### `kind: module` — JS/TS module hooks

Module hooks run in-process and are ideal for type-safe, low-latency logic that doesn't need a subprocess.

```yaml
hooks:
  pre_task:
    - kind: module
      path: ./hooks/my-hook.js   # relative to projectDir; default export required
      timeout_ms: 5000
      on_failure: block
  post_commit:
    - kind: module
      name: "notify-done"
      path: ./hooks/notify.js
      on_failure: warn
```

The module must have a default export matching:

```js
// hooks/my-hook.js (ESM)
export default async function hook(event, ctx) {
  // event: EngineEvent  — the triggering event
  // ctx: { projectDir: string, sessionId: string }
  if (event.type === 'task_started' && event.file.startsWith('migrations/')) {
    return { kind: 'deny', message: 'migrations require manual approval' };
  }
  return { kind: 'allow' };
}
```

Return value shape:

| Return                              | Effect                          |
|-------------------------------------|---------------------------------|
| `{ kind: 'allow' }`                 | Continue normally               |
| `{ kind: 'deny', message?: string }` | Always blocks the action (independent of `on_failure`) |
| `{ kind: 'warn', message?: string }` | Log warning, continue          |
| `{ kind: 'crash', message: string }` | Treated as crash                |
| Any other shape                     | Treated as `warn` with an unrecognized-outcome message |

**Module loading:** Modules are loaded via ESM `import()` which is cached by URL — each module is loaded once per process lifetime. The default export must be a function. A missing default export or a non-function default fails with a clear load error and then follows `on_failure`.

**Timeout:** Module hooks use the same timeout defaults as command hooks: `timeout_ms` defaults to 30000 ms and is capped at 300000 ms. Module calls are raced against a `setTimeout`. If the module exceeds `timeout_ms`, the promise is abandoned (not killed — JS cannot terminate in-process code). The outcome follows `on_failure`.

**Module not found:** Treated as `warn` regardless of `on_failure` config, same as ENOENT for command hooks.

### `.diptych/hooks/` auto-discovery

Diptych also auto-discovers JS/TS module hooks from `.diptych/hooks/`. Files named after hook events in kebab-case are registered for the matching event:

| File                              | Event             |
|-----------------------------------|-------------------|
| `.diptych/hooks/pre-task.ts`      | `pre_task`        |
| `.diptych/hooks/post-task.js`     | `post_task`       |
| `.diptych/hooks/pre-validation.ts` | `pre_validation`  |
| `.diptych/hooks/on-complete.js`   | `on_complete`     |

Discovery only considers `.js` and `.ts` files. Non-matching filenames such as `utils.ts`, `readme.md`, or `pre_task.ts` are ignored. A missing `.diptych/hooks/` directory is fine and registers no hooks.

Discovered hooks are equivalent to `kind: module` entries with their `path` set to the project-relative discovered file, for example `.diptych/hooks/pre-task.js`. For the same event, explicitly configured hooks run first, then discovered hooks.

### `command` restrictions

`command` cannot be `sh`, `bash`, `/bin/sh`, or `/bin/bash`. Inline shell is rejected because diptych doesn't run with `shell: true` — substitution values pass through as argv elements safely.

To run a shell pipeline, put it in a script file:

```yaml
hooks:
  pre_commit:
    - command: ".diptych/hooks/scan.sh"
      args: ["${event.file}"]
```

Then make the script executable: `chmod +x .diptych/hooks/scan.sh`.

## Variable substitution

Hook `args` strings can reference event fields via `${event.<path>}`:

```yaml
args: ["${event.file}", "--task=${event.taskId}"]
```

| Placeholder          | Available in events with that field    | Resolution                               |
|----------------------|----------------------------------------|------------------------------------------|
| `${event.file}`      | task_*, pre_commit                     | Project-relative path string             |
| `${event.taskId}`    | task_*, validate, escalate, git_commit | Branded TaskId string                    |
| `${event.title}`     | task_started, task_completed           | Task description                         |
| `${event.action}`    | task_started                           | `'create'` or `'modify'`                 |
| `${event.message}`   | error, warning, git_commit             | String                                   |
| `${event.stages}`    | validate                               | JSON-stringified `{typecheck, lint, test}` |
| `${event.feature}`   | workflow_started                       | The user's feature prompt                |
| `${event.duration}`  | task_completed, validate               | Number (ms)                              |
| `${event.method}`    | task_completed, task_tokens            | One of `'local'`, `'escalated-intermediate'`, `'escalated-hint'`, `'escalated-full'`, `'failed'`, `'skipped'`, `'mcp-tool'` |

Missing fields collapse to empty string. Object/array values are JSON-stringified. Placeholder values are secret-redacted and bounded before substitution; oversized strings are truncated with a placeholder. **No `eval`** — substitution is regex-based.

### Shell quoting

Subprocesses are spawned without `shell: true`, so substituted values are passed as individual argv elements. Shell metacharacters (`;`, `&&`, `|`, backticks, `$(...)`, etc.) in an event field never cause command injection — the child process sees the literal string as one argument. This is why `command` cannot be `sh`/`bash` with a `-c` arg (see [command restrictions](#command-restrictions)); inline shell would defeat the argv boundary.

### Per-event availability

Which placeholders resolve depends on the event type. Missing fields collapse to empty strings.

| Event             | Resolvable placeholders                                                           |
|-------------------|-----------------------------------------------------------------------------------|
| `pre_planning`    | `${event.feature}`, `${event.ts}`, `${event.phase}`, `${event.type}`              |
| `pre_task`        | `${event.taskId}`, `${event.title}`, `${event.file}`, `${event.action}`, `${event.index}`, `${event.total}` |
| `post_task`       | `${event.taskId}`, `${event.title}`, `${event.file}`, `${event.method}`, `${event.retries}`, `${event.duration}` |
| `pre_validation`  | `${event.taskId}`                                                                 |
| `post_validation` | `${event.taskId}`, `${event.stages}`, `${event.passed}`, `${event.error}`         |
| `pre_commit`      | `${event.taskId}`, `${event.file}`                                                |
| `post_commit`     | `${event.taskId}`, `${event.file}`, `${event.message}`                            |
| `pre_escalation`  | `${event.taskId}`                                                                 |
| `on_error`        | `${event.message}`                                                                |
| `on_complete`     | `${event.ts}`, `${event.phase}`, `${event.type}`                                 |

## Subprocess protocol

For `kind: command` hooks, diptych communicates with the child process over stdio using JSON. The same shape applies whether the hook is a shell script, a Node program, or a binary.

### stdin — input to the hook

A single JSON object is written to the child's stdin, then stdin is closed:

```json
{
  "event": {
    "type": "task_started",
    "ts": 1713561600000,
    "phase": "implement",
    "taskId": "T-0004",
    "title": "add JWT middleware",
    "file": "src/auth/middleware.ts",
    "action": "create",
    "index": 4,
    "total": 12
  },
  "context": {
    "projectDir": "/Users/you/project",
    "sessionId": "s_01H...",
    "phase": "implement",
    "mode": "standard"
  }
}
```

- `event` is the in-flight `EngineEvent` — the same payload rendered in the TUI. Fields present depend on event type (see [per-event availability](#per-event-availability)). The stdin payload is bounded and secret-redacted before it is written to the child process.
- `context` is static for the run: `projectDir` (absolute), `sessionId` (per-invocation), `phase` (`plan` / `implement` / `validate`), `mode` (`instant` / `quick` / `standard` / `speckit`).

### stdout — optional response

A hook that only needs to run side effects can exit 0 and write nothing. To influence the workflow, write a single JSON object to stdout:

```json
{
  "decision": "deny",
  "message": "migrations/ touched — requires manual review"
}
```

| Field     | Type                              | Meaning                                                                                       |
|-----------|-----------------------------------|-----------------------------------------------------------------------------------------------|
| `decision`| `"allow" \| "deny" \| "warn"`     | Workflow control. On a `pre_*` hook, `deny` always aborts the upcoming action regardless of `on_failure`. A `decision` value outside this trio is surfaced as a `warn` (it never silently allows). |
| `message` | string                            | Surfaced in the TUI and in the `hook_blocked` / `warning` event.                               |

The response is read from the **last JSON object line** of stdout, so a hook may log diagnostics first and emit the `{ "decision": … }` object on its final line. If no line parses as a JSON object the output is treated as success with an empty body (the hook's side effects stand; no warning is emitted).

### stderr

Anything written to stderr is surfaced as a `warning` event regardless of exit code. Use it for diagnostics that should always be visible to the user without influencing flow.

### Exit codes

- **`0`** — success. Stdout (if valid JSON) is applied per above.
- **non-zero** — failure. Treated as `decision: "deny"` if `on_failure: block`, `warn` otherwise. Stderr is still surfaced.

### `decision` on `post_*` hooks

Post hooks fire after the action has already happened. A `deny` returned from `post_task` / `post_commit` / `post_validation` is **ignored** for flow purposes (logged informationally). Use `pre_*` hooks when you need to block.

## Execution order

Hooks for the **same event** run **sequentially** — built-ins first, explicitly configured hooks in `.diptych/config.yaml` declaration order, then discovered `.diptych/hooks/` modules. There is no fan-out or parallelism.

Hooks for **different events** never overlap — the orchestrator runs one task at a time, so `post_task` for task N completes before `pre_task` for task N+1 starts. A hung or slow hook at one event does not race with hooks at another event for the same task.

If a `pre_*` hook returns `decision: "deny"` (or fails with `on_failure: block`), the remaining hooks for that event are skipped and the action is aborted.

## Failure modes

### `on_failure` outcomes

`on_failure` governs **crashes, timeouts, and non-zero exit codes** — not explicit denials. A `decision: "deny"` (or a module returning `{ kind: 'deny' }`) always blocks a `pre_*` action regardless of `on_failure`.

| `on_failure`       | On crash / timeout / non-zero exit | Effect on workflow                                        |
|--------------------|-------------------------------------|-----------------------------------------------------------|
| `block`            | Treated as failure                  | Aborts the upcoming action (skip task, skip optional commit, etc.) |
| `warn` (default)   | Logs a warning event                | Workflow continues                                        |
| `ignore`           | Treated as success                  | No log                                                    |

`block` only meaningful on `pre_*` hooks. On `post_*` hooks, `block` is logged informationally — the action already happened.

The aborted action is event-specific: `pre_task` and `pre_validation` mark the current task `skipped` (recording skipped evidence) and continue with the next task; `pre_commit` skips the optional commit but still completes the task; `pre_planning` aborts the planner run; `pre_escalation` surfaces a recovery prompt named after the hook (reason `retry-exhausted`) instead of silently giving up.

### Per-scenario behavior

Specific runtime failures are handled as follows, independent of (or layered on top of) `on_failure`:

| Scenario                                         | Behavior                                                                                   |
|--------------------------------------------------|--------------------------------------------------------------------------------------------|
| Command not found (ENOENT)                       | Always emits `warning` and proceeds — treated as `on_failure: warn` regardless of config.  |
| Module `path` does not resolve (`kind: module`)  | Same as ENOENT — warn and proceed.                                                         |
| Module default export is missing or not a function | Clear load error; treated as failure per `on_failure`.                                    |
| Timeout (`timeout_ms` exceeded)                  | Child killed (`SIGTERM`, then `SIGKILL`). Treated as failure per `on_failure`.             |
| Module exceeds `timeout_ms`                      | Promise abandoned (JS cannot terminate in-process code). Treated as failure per `on_failure`. |
| Stdout has no JSON object line                   | Treated as success with empty body. Side effects of the hook stand.                        |
| Stdout's last JSON line has an unrecognized `decision` | Surfaced as a `warn` (never silently allowed); side effects stand.                     |
| `decision: "deny"` returned on a `post_*` event  | Ignored for flow; logged informationally.                                                  |
| Hook crashes mid-stream                          | Partial stderr flushed as `warning`; treated as failure per `on_failure`.                  |
| Non-zero exit code                               | Treated as `deny` if `on_failure: block`; `warn` otherwise.                                |

A hung hook can never stall the workflow indefinitely — `timeout_ms` is mandatory at the schema level (default 30000 ms, hard ceiling 300000 ms).

## Security model

Hook commands run with the user's **full shell privileges** — the same authority as any other process they launch. This is intentional and matches the posture of Claude Agent SDK hooks and comparable tools (opencode plugins, Cursor Composer hooks). Without full privileges, hooks could not invoke `npx prettier`, open a scanner, or call the user's CI.

Because of that authority, diptych layers several guardrails:

1. **No inline shell.** Schema rejects `command: "sh"` / `"bash"` (and absolute variants) with `args` containing `-c`. Substitution never uses `shell: true`, so event-field values cannot be injected as shell syntax. If you need a pipeline, put it in a script file and invoke the script.
2. **Mandatory timeout.** `timeout_ms` has a default (30000 ms) and a hard ceiling (300000 ms). A hung hook cannot stall the workflow indefinitely.
3. **Same-cwd trust boundary.** Hooks run in `cwd: projectDir` — the same filesystem scope as the implementer subprocess. They cannot silently escape into other projects.
4. **Transitive hook coverage.** Any shell spawned from a diptych hook is still subject to `block-git-commits.sh` (the PreToolUse hook wired through Claude Code). In this repository, hooks inherit the same prohibition against `git commit` / `git add` from inside a diptych run. Product-level commit hooks may exist for downstream users, but they are not this repo's agent workflow.

### Trust model

Adding a hook to `.diptych/config.yaml` is RCE on the next `diptych start`. A malicious PR could drop a `hooks:` block and own the reviewer's machine. To prevent this:

- The first time diptych sees a hook config, it computes `sha256(canonical-JSON + module file digests)` and prompts in TTY: `Trust these hooks for this project? [y/N]`
- On `y`: hash stored in `.diptych/hook-trust.json`. Future runs compare against the stored hash.
- On `N`: refuses to start.
- Editing the config or a module hook file invalidates the trust — next run re-prompts.

**In CI** (non-TTY): you must pass `--allow-hooks` explicitly. Without it, diptych refuses to start with an actionable error message.

## Built-in hooks

Two built-ins ship — both **off by default**:

### `prettier-on-change`

Runs `npx prettier --write ${event.file}` on `post_task`. Failures `warn` (don't block).

```yaml
hooks:
  builtin:
    prettier-on-change: true
```

### `block-secrets`

Scans `event.file` on `pre_commit` for known credential patterns when optional product-level commit hooks are in use:

- AWS access keys (`AKIA[0-9A-Z]{16}`)
- GitHub PATs (`ghp_[A-Za-z0-9]{36}`)
- OpenAI keys (`sk-[A-Za-z0-9]{48}`)
- Anthropic keys (`sk-ant-[A-Za-z0-9-]{40,}`)

Match returns `deny` — the optional commit step is skipped. Built-ins always have effective `on_failure: block` for `pre_*` events.

```yaml
hooks:
  builtin:
    block-secrets: true
```

To disable a built-in you previously enabled, set its value to `false`.

Built-ins run **before** user-declared hooks for the same event.

## Writing your first hook

Goal: auto-run Prettier after each task.

1. Edit `.diptych/config.yaml`:

```yaml
hooks:
  builtin:
    prettier-on-change: true
```

2. Run:

```bash
diptych start --allow-hooks "add login form"
```

3. Diptych runs the workflow. After each task succeeds, Prettier reformats the touched file.

That's it. No script needed — `prettier-on-change` is shipped as a built-in.

For a custom hook, write a script that returns exit 0 on success or non-zero on failure. Optional: write JSON to stdout (`{"decision":"deny","message":"..."}`) for explicit denials with a message.

## Implementation

Module: `src/engine/hooks/`

- `types.ts` — `HookOutcome` (allow/deny/warn/crash), `HookContext`
- `dispatch.ts` — `runHook(entry, event, ctx)` — spawns subprocess via `lib/process/spawn.ts`
- `substitute.ts` — `${event.field}` regex substitution (no eval)
- `sink.ts` — `EventBus` sink for post_*/on_* events (fire-and-forget)
- `run-pre.ts` — sequential pre_* runner; deny short-circuits
- `builtins/{registry,prettier-on-change,block-secrets}.ts` — built-in hook implementations

Trust:
- `src/core/hooks/trust.ts` — sha256 + canonical JSON
- `src/cli/hook-trust-prompt.ts` — `ensureHooksTrusted()` interactive prompt + non-TTY refusal

Schema: `src/core/schemas/hooks.ts`.

## Design decisions

Alternatives that were considered and rejected when the hook system was designed:

- **JS modules only (no shell).** Type-safe and in-process, but excludes users who want to wire up `prettier`, a secret scanner, or a Slack notifier without writing TypeScript against a not-yet-public SDK. Shell / script hooks cover the common case today; `kind: module` was added later as a complement, not a replacement.
- **Reuse Claude Code's hooks file format.** Their schema (`~/.claude/settings.json`, `PreToolUse(tool_name)` matchers) is shaped around tool-call lifecycles, not a workflow lifecycle. Forcing the same shape would lie about what diptych exposes — our events are workflow-shaped (`pre_task`, `post_validation`, optional `pre_commit`). Tool calls belong to the configured planner or implementer runner, while diptych hooks stay at deterministic workflow boundaries.
- **Auto-trust hook config (no `--allow-hooks` prompt).** Simpler UX, but a malicious diff that adds a hook becomes RCE on the next `diptych start`. Unacceptable. Explicit trust (hash + prompt) is the cost of safety.
- **Parallel / async fan-out within an event.** Lower latency, but deny short-circuiting is order-dependent — a later hook should never run after an earlier one has already aborted the action. The latency win is hypothetical; five hooks on one event is already pathological.
