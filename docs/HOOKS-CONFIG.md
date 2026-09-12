# Hook system (workflow lifecycle hooks)

> **Different from `docs/HOOKS.md`!** That doc covers React hooks. This doc covers user-extensible **workflow lifecycle hooks** — shell commands that fire at well-known moments during a SPLITBRIEF workflow. Lifecycle hooks are not React hooks.

User-extensible hook system inspired by Claude Code. Declare commands in `.splitbrief/config.yaml` to fire at workflow events (pre/post task, pre/post validation, optional pre/post commit, etc.). Used for `prettier --write` after each task, secret scanning, Slack notifications, custom validators — anything you can run from a script.

## Quick start

```yaml
# .splitbrief/config.yaml
hooks:
  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
      on_failure: warn
  pre_commit:
    - command: ".splitbrief/hooks/check-secrets.sh"
      timeout_ms: 10000
      on_failure: block
```

```bash
splitbrief start --allow-hooks "add JWT auth"
```

The first time you run with hooks defined, SPLITBRIEF prompts to trust them. Use `--allow-hooks` in CI.

## Hook events

Lifecycle events fire during a workflow. Each can have multiple hooks declared.

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
| `on_error`       | Any unrecoverable engine error              | `message`                                                            |
| `on_complete`    | `workflow_complete` event                   | (none)                                                               |

`pre_*` hooks **block** the workflow until they finish. `post_*` and `on_*` hooks are fire-and-forget — failures log a warning but don't gate the flow.

## Configuration shape

```yaml
hooks:
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

Every hook entry is a `command` hook. `kind` may be written explicitly as `"command"`; when omitted it defaults to `"command"`.

### `command` restrictions

Inline shell launchers are rejected. `command` cannot be `sh`, `bash`, `zsh`, `dash`, `fish`, `ksh`, `csh`, `tcsh`, `powershell`, `pwsh`, `cmd`, `cmd.exe`, common absolute variants such as `/bin/sh` and `/usr/bin/bash`, or `/usr/bin/env`. Hook `args` also cannot contain those shell launchers or shell-evaluation flags such as `-c`, `--command`, `/c`, and `/C`.

SPLITBRIEF does not run hooks with `shell: true`; substitution values pass through as argv elements safely. Inline shell is rejected so a hook cannot reintroduce shell evaluation at the argv boundary.

To run a shell pipeline, put it in a script file:

```yaml
hooks:
  pre_commit:
    - command: ".splitbrief/hooks/scan.sh"
      args: ["${event.file}"]
```

Then make the script executable: `chmod +x .splitbrief/hooks/scan.sh`.

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
| `${event.method}`    | task_completed, task_tokens            | One of `'local'`, `'escalated-intermediate'`, `'escalated-hint'`, `'escalated-full'`, `'failed'`, `'skipped'` |

Missing fields collapse to empty string. Object/array values are JSON-stringified. Placeholder values are secret-redacted and bounded before substitution; oversized strings are truncated with a placeholder. **No `eval`** — substitution is regex-based.

### Shell quoting

Subprocesses are spawned without `shell: true`, so substituted values are passed as individual argv elements. Shell metacharacters (`;`, `&&`, `|`, backticks, `$(...)`, etc.) in an event field never cause command injection — the child process sees the literal string as one argument. This is why shell launchers and shell-evaluation flags are rejected (see [command restrictions](#command-restrictions)); inline shell would defeat the argv boundary.

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

For `kind: command` hooks, SPLITBRIEF communicates with the child process over stdio using JSON. The same shape applies whether the hook is a shell script, a Node program, or a binary.

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
- `context` is static for the run: `projectDir` (absolute), `sessionId` (per-invocation), `phase` (`plan` / `implement` / `validate`), `mode` (`quick` / `standard` / `speckit`).

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
| `decision`| `"allow" \| "deny" \| "warn"`     | Workflow control. On a `pre_*` hook, `deny` always aborts the upcoming action regardless of `on_failure`. A value outside this trio is rejected as malformed. |
| `message` | string                            | Surfaced in the TUI and in the `hook_blocked` / `warning` event.                               |

The response is read from the **last JSON object line** of stdout, so a hook may log diagnostics first and emit the `{ "decision": … }` object on its final line. If no line parses as a JSON object and no line looks like a malformed JSON object, the output is treated as success with an empty body (the hook's side effects stand; no warning is emitted). If a JSON object response is unparseable, has unknown keys, non-string `message`, or a `decision` outside `allow` / `deny` / `warn`, it is rejected as malformed and handled by `on_failure`.

### stderr

Anything written to stderr is surfaced as a `warning` event regardless of exit code. Use it for diagnostics that should always be visible to the user without influencing flow.

### Exit codes

- **`0`** — success. Stdout (if valid JSON) is applied per above.
- **non-zero** — failure. Treated as `decision: "deny"` if `on_failure: block`, `warn` otherwise. Stderr is still surfaced.

### `decision` on `post_*` hooks

Post hooks fire after the action has already happened. A `deny` returned from `post_task` / `post_commit` / `post_validation` is **ignored** for flow purposes (logged informationally). Use `pre_*` hooks when you need to block.

## Execution order

Hooks for the **same event** run **sequentially**, in `.splitbrief/config.yaml` declaration order. There is no fan-out or parallelism.

Hooks for **different events** never overlap — the orchestrator runs one task at a time, so `post_task` for task N completes before `pre_task` for task N+1 starts. A hung or slow hook at one event does not race with hooks at another event for the same task.

If a `pre_*` hook returns `decision: "deny"` (or fails with `on_failure: block`), the remaining hooks for that event are skipped and the action is aborted.

## Failure modes

### `on_failure` outcomes

`on_failure` governs **crashes, timeouts, non-zero exit codes, and malformed hook responses** — not explicit denials. A `decision: "deny"` always blocks a `pre_*` action regardless of `on_failure`.

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
| Timeout (`timeout_ms` exceeded)                  | Child killed (`SIGTERM`, then `SIGKILL`). Treated as failure per `on_failure`.             |
| Stdout has no JSON-object-shaped response        | Treated as success with empty body. Side effects of the hook stand.                        |
| Stdout's JSON object response is malformed      | Treated as failure per `on_failure`; side effects that already happened still stand.        |
| `decision: "deny"` returned on a `post_*` event  | Ignored for flow; logged informationally.                                                  |
| Hook crashes mid-stream                          | Partial stderr flushed as `warning`; treated as failure per `on_failure`.                  |
| Non-zero exit code                               | Treated as `deny` if `on_failure: block`; `warn` otherwise.                                |

A hung hook can never stall the workflow indefinitely — `timeout_ms` is mandatory at the schema level (default 30000 ms, hard ceiling 300000 ms).

## Security model

Hook commands run with the user's **full shell privileges** — the same authority as any other process they launch. This is intentional and matches the posture of Claude Code hooks and comparable tools (opencode plugins, Cursor Composer hooks). Without full privileges, hooks could not invoke `npx prettier`, open a scanner, or call the user's CI.

Because of that authority, SPLITBRIEF layers several guardrails:

1. **No inline shell.** Schema rejects common shell launchers and shell-evaluation flags. Substitution never uses `shell: true`, so event-field values cannot be injected as shell syntax. If you need a pipeline, put it in a script file and invoke the script.
2. **Mandatory timeout.** `timeout_ms` has a default (30000 ms) and a hard ceiling (300000 ms). A hung hook cannot stall the workflow indefinitely.
3. **Project cwd start.** Hooks start in `cwd: projectDir`, matching the implementer subprocess. This is not a filesystem sandbox: hook commands retain normal user access and can read or write anywhere the user account can.
4. **Trust recheck before execution.** Before running a configured hook, SPLITBRIEF re-hashes the trusted hook configuration and referenced hook files. If bytes changed after trust, the hook is refused until the user re-trusts the new configuration.

Claude Code `PreToolUse` hooks do not sandbox or intercept child processes spawned by SPLITBRIEF hooks. In this repository, `.claude/hooks/block-git-commits.sh` guards agent tool calls, not arbitrary subprocesses launched by lifecycle hooks. Do not rely on it as a git guard for SPLITBRIEF hook scripts.

### Trust model

Adding a hook to `.splitbrief/config.yaml` is RCE on the next `splitbrief start`. A malicious PR could drop a `hooks:` block and own the reviewer's machine. To prevent this:

- The first time SPLITBRIEF sees a hook config, it computes `sha256(canonical-JSON + local command script digests)`. The prompt is the disclosure: it names each hook's executable, the absolute path that executable resolves to on this machine, its argv, and the trust boundary the hook runs inside, and ends with `Trust these hooks for this project? [y/N]`. A config-supplied `name:` is never shown in its place — you authorize the command, not the label the repository chose for itself.
- On `y`: a receipt is written to `~/.splitbrief/trust/hooks.json` (mode `0600`, in a `0700` directory), keyed by the canonical path of this checkout and the config digest. This is the same owner-only store that holds custom runner receipts.
- On `N`: refuses to start.
- Editing the config or a local command hook script invalidates the trust. The next run re-prompts, and an in-flight run refuses configured hook execution if the trusted bytes change before the hook runs.

**The grant never travels.** It lives on the machine that gave it, outside the repository, so a repository cannot ship one: a receipt committed into `.splitbrief/` is a file SPLITBRIEF never reads. A second `git clone`, a `cp -a` of a granted checkout, or the same checkout under another account resolves to a different key and prompts again. Receipts written by versions that stored `.splitbrief/hook-trust.json` inside the project are ignored; trust those hooks once more and the file can be deleted.

**In CI** (non-TTY): you must pass `--allow-hooks` explicitly. Without it, SPLITBRIEF refuses to start with an actionable error message. With it, the same disclosure is written to stderr before the grant, so the build log records what was authorized.

## Writing your first hook

Goal: auto-run Prettier after each task.

1. Edit `.splitbrief/config.yaml`:

```yaml
hooks:
  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
      on_failure: warn
```

2. Run:

```bash
splitbrief start --allow-hooks "add login form"
```

3. SPLITBRIEF runs the workflow. After each task succeeds, Prettier reformats the touched file.

For a custom hook, write a script that returns exit 0 on success or non-zero on failure. Optional: write JSON to stdout (`{"decision":"deny","message":"..."}`) for explicit denials with a message.

## Implementation

Module: `src/engine/hooks/`

- `types.ts` — `HookOutcome` (allow/deny/warn/crash), `HookContext`
- `dispatch.ts` — `runHook(entry, event, ctx)` — spawns subprocess via `lib/process/spawn/progress.ts`
- `substitute.ts` — `${event.field}` regex substitution (no eval)
- `sink.ts` — `EventBus` sink for post_*/on_* events (fire-and-forget)
- `run-pre.ts` — sequential pre_* runner; deny short-circuits

Trust:
- `src/core/hooks/trust.ts` — receipts in the owner's trust store
- `src/core/hooks/trust-digest.ts` — sha256 + canonical JSON over the config and the hook files it reaches
- `src/core/trust/receipt-store.ts` — the machine-scoped receipt store shared with custom runner trust (`~/.splitbrief/trust/`, canonical-checkout identity, owner-only read)
- `src/cli/hook-trust-prompt.ts` — `ensureHooksTrusted()` disclosure + prompt + non-TTY refusal

Schema: `src/core/schemas/hooks.ts`.

## Design decisions

Alternatives that were considered and rejected when the hook system was designed:

- **JS modules only (no shell).** Type-safe and in-process, but excludes users who want to wire up `prettier`, a secret scanner, or a Slack notifier without writing TypeScript against a not-yet-public SDK. Shell / script hooks cover the common case.
- **Reuse Claude Code's hooks file format.** Their schema (`~/.claude/settings.json`, `PreToolUse(tool_name)` matchers) is shaped around tool-call lifecycles, not a workflow lifecycle. Forcing the same shape would lie about what SPLITBRIEF exposes — our events are workflow-shaped (`pre_task`, `post_validation`, optional `pre_commit`). Tool calls belong to the configured planner or implementer runner, while SPLITBRIEF hooks stay at deterministic workflow boundaries.
- **Auto-trust hook config (no `--allow-hooks` prompt).** Simpler UX, but a malicious diff that adds a hook becomes RCE on the next `splitbrief start`. Unacceptable. Explicit trust (hash + prompt) is the cost of safety.
- **Parallel / async fan-out within an event.** Lower latency, but deny short-circuiting is order-dependent — a later hook should never run after an earlier one has already aborted the action. The latency win is hypothetical; five hooks on one event is already pathological.
