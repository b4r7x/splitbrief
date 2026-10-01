# SPLITBRIEF Configuration Reference

Complete reference for `.splitbrief/config.yaml` — the single declarative file that wires SPLITBRIEF to your planner, reviewer, implementer, validation tools, workflow gates, and hooks.

This document is a field-by-field reference. For end-user mode semantics see [WORKFLOW.md](./WORKFLOW.md); for hook plumbing see [HOOKS-CONFIG.md](./HOOKS-CONFIG.md); for repo-map tuning see [REPOMAP.md](./REPOMAP.md).

---

## 1. File location, format, and lifecycle

```
<project-root>/.splitbrief/config.yaml
```

- The file is created on first `splitbrief init` (or implicitly on first `splitbrief start`). Missing file → SPLITBRIEF runs with `createDefaultConfig()` (`src/core/config/load/defaults.ts`).
- **Schema version:** `version: 3`, required and exact. Any other value (or a missing one) fails the load with `config-unsupported-version`; run `splitbrief init --reconfigure` to write a current config.
- **Key style:** the loader transforms `snake_case` YAML into `camelCase` before validation (`src/core/config/load/transform.ts`), so both styles work. This document uses `camelCase`. Where one map spells a key both ways, the later line wins. A save from the TUI edits the key in the spelling your file already uses, removes an earlier twin spelling of it, and writes a key the file does not carry yet in `snake_case` (`src/core/config/load/document.ts`).
- **Permissions:** Configuration files with group- or other-writable bits (mode & 0o022) trigger a security warning. On POSIX, the loader emits this via `warnStderr` when `checkConfigPermissions` fails (`src/lib/fs.ts`). `init` writes the file at `0600` via `writeSecureFile`.
- **`.gitignore`:** config creation (`init` and any write that materializes `.splitbrief/config.yaml`) appends `.splitbrief/` and `.trees/` to your project `.gitignore` when those lines are absent, so secrets, per-machine state, and operator worktrees stay out of source control.

Top-level shape:

<!-- config-shape-sketch -->
```yaml
version: 3
planner:        { kind: cli|api|shell|agent, ... }
implementer:    { kind: cli|api|shell|agent, ... }
reviewer:       { kind: cli|api|shell|agent, ... }   # optional; planner reviews when absent
implementerProfiles:
  default: local-qwen
  profiles: { local-qwen: { kind: api, ... }, cheap-cloud: { kind: api, ... } }
validation:     { typecheck, lint, test, testCommand }
workflow:       { mode, approve, maxRetries, git, isolation, ... }
sessions:       { scope: project }
escalation:     { enabled, intermediateProvider, intermediateModel }
codebase:       { enabled, tokenBudget, include, exclude }
hooks:          { pre_task, post_task, ... }
palette:        { customActions: [...] }
approval:       { enabled, tiers, feedRejectionsToPlanner, allowedPaths }
customCommands: { <id>: { label, contract, executable, argv, ... } }
```

Top-level keys are **not** strict at the root — an unknown key is ignored — except the five keys this release removed (`otel`, `snapshots`, `trust`, `plannerEstimateReview`, `autoSplitOverflow`), which are named as load errors like any other removed key (§16). Most nested objects (`workflow` and its `git` / `speckit` blocks, `hooks`, `codebase`, `approval` and its `tiers` block, every runner config) are strict and will reject unknown fields.

---

## 2. `planner`

The planner is the expensive model that compiles a Task Brief. It is a discriminated union on `kind` with four variants. The planner accepts an **optional** `model` (because some CLI tools pick their own); the implementer requires `model`.

### Schema

```ts
type PlannerConfig =
  | { kind: 'cli';       tool: CliToolId; args?: string[]; outputFormat?: OutputFormat;
      model?: string; customModels?: string[]; contextLength?: number;
      temperature?: number; timeout?: number; effort?: EffortLevel; variant?: string }
  | { kind: 'api';       provider: string; service: string; offering: ApiOffering;
      apiBase: string; apiKey?: string; model?: string; ...common }
  | { kind: 'shell';     command: string; args?: string[]; outputFormat?: OutputFormat;
      capabilities?: Partial<PlannerCapabilities>; model?: string; ...common }
  | { kind: 'agent';     command: string; args?: string[]; outputFormat?: OutputFormat;
      capabilities?: Partial<PlannerCapabilities>; model?: string; ...common };
```

Every variant is `.strict()` — unknown fields fail validation with a `ConfigError`.

### Common generation fields

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | — | Model identifier, or `auto`. Planner: optional. Implementer: required for `api`, `shell`, and `agent`; optional for `cli`, where omitting `model` and writing `model: auto` are equivalent — both mean the model the tool itself has selected on this machine, read at preparation (see `kind: cli` below). |
| `customModels` | string[] | — | Extra model IDs merged into the provider catalog so they appear in pickers. Pricing remains unknown unless models.dev, runtime provider metadata, or the bundled catalog supplies rates. |
| `contextLength` | int > 0 | kind-dependent | Application budget override. Built-in local API calls use configured context, observed active context, then 8192; maximum model capacity is separate. CLI/legacy routing can use the 32768 conservative fallback. This field never changes the server. |
| `temperature` | 0..2 | provider default | Sampling temperature. Honored only by the `api` kind (planner, reviewer, and implementer); the `cli`, `shell`, and `agent` kinds cannot pass it to their backend and drop it with a stderr warning. Implementers usually want `0.2`-`0.4`; planners can run hotter. |
| `timeout` | ms (≤ 1200000) | API BUILD: 20 min; API PLAN/REVIEW: 10 min. CLI BUILD: 20 min; CLI REVIEW: 10 min; other CLI planning calls have no total-call default. | Total wall-clock budget for a call. API first-response and stream-idle deadlines also apply, each bounded by this total. Defaults come from `TIMEOUTS.implementerMs` / `TIMEOUTS.reviewerMs` (`src/core/pipeline-spec/timeouts.ts`). Two consecutive brief timeouts enter recovery. |
| `idleWarnMs` | ms (≤ 3600000) | `300000` | Inactivity watchdog warn threshold: after this much output silence on a running call, the byline shows a "still working" warning; any stdout/stderr output clears it and resets the timer. |
| `idleKillMs` | ms (≤ 3600000) | `1800000` | Inactivity watchdog kill threshold: at this much output silence the runner's process group is terminated (SIGTERM, then SIGKILL after a grace window) and the call is marked failed. For planner calls a retry prompt is offered; a failed implementer call feeds the task's retry/escalation ladder instead, whose retry prompts rebuild the full Task Brief per attempt. |
| `effort` | `none\|minimal\|low\|medium\|high\|xhigh\|max` | unset | Reasoning-effort hint. The union above is what config accepts; the levels a seat may actually use are the selected model's own ladder, not a fixed list per tool — the seat's tool accepts a subset and reports what it rejects. How a seat's effort intent reaches its tool is the seat's channel — `CliEffortChannel` (`src/core/runners/effort-channel.ts`), resolved by `seatEffortChannel` (`src/core/runners/capabilities.ts`) — and only one of the four channels carries this field. `cli` `claude-code`, `codex`, `copilot` and `command-code` are channel `effort-flag`: they deliver this `EffortLevel` verbatim on the tool's own effort argument, on the planner, reviewer, and implementer seats — `claude-code`, `copilot` and `command-code` emit `--effort <level>`, `codex` emits `-c model_reasoning_effort=<level>`. `cli` `opencode` and `kilo-code` are channel `variant`: they have a real effort channel, but it is a named preset delivered through the separate `variant` field — kilo's `--variant`, opencode's model suffix from 2.0.0 on — not through `effort`. `cli` `cursor` is channel `model-id`: effort is encoded in the selected model id's suffix, so there is no separate field to set — choose it in the model picker. Only the `api`, `shell`, and `agent` kinds are channel `none`. `seatSupportsEffort` is now `seatEffortChannel(...) !== 'none'`; a caller that means "takes the `effort` field" tests for `effort-flag`. An undeliverable value is not sent: changing a seat in the TUI clears it and says so (`Effort <level> cleared: <tool> has no effort channel`) on every seat whose channel is not `effort-flag`, and a headless run drops it, with a `planner-effort`/`reviewer-effort: dropped` stderr warning on the planner and review seats, silently on the implementer seat. The same clearing and dropping applies to `variant` on a seat whose channel is not `variant`. |
| `variant` | string | unset | The named execution preset of the `variant` channel — today `cli` `opencode` and `kilo-code`, delivered on `kilo run --variant <name>` and, for opencode, on the model itself: `opencode run --model <provider/model>#<name>` from 2.0.0 on, which rejects `--variant`, and `opencode run --variant <name>` below 2.0.0. The release the start gate admitted picks the form, and the arg-vector preflight checks the same one. Free-form and persisted verbatim, because an opencode user can declare custom variants in `opencode.json` that no static enum could know. The presets are per model, not per provider: the picker offers the ladder the model itself publishes (`opencode api GET /api/model`, or `opencode models --verbose` below 2.0.0, and `kilo models --verbose` for a detected route), so `openai/gpt-5.6-luna` offers `none\|low\|medium\|high\|xhigh\|max` and a model that publishes none offers no presets, though a hand-written value is still sent. `--variant` is a protected flag: configuring it through `args` is refused before spawn. |

`idleWarnMs` and `idleKillMs` apply to the `cli`, `shell`, and `agent` kinds only — `api` runners keep the 60s stream-idle guard, and their strict schema rejects both fields.

### Pricing metadata

Pricing is resolved from cached `models.dev` metadata first when available, then from runtime provider metadata or the bundled catalog. `models.dev` context pricing tiers are preserved: flat base rates apply below the tier threshold, and the highest matching context tier applies when prompt/cache context reaches that threshold. Local-only unpriced runners are displayed as local/unpriced rather than dollar-priced. Picker lane order is separate from this ladder — a CLI tool renders its own listing with the bundled `KNOWN_MODELS` aliases as the offline fallback, and an `api` runner adds models.dev rows beside its runtime list — and does not reorder pricing or context lookup; see [Model catalog lanes](./PLANNERS-AND-IMPLEMENTERS.md#model-catalog-lanes).

### `kind: cli`

Subprocess of a known coding-agent CLI. The wrapper handles auth, model selection, and output parsing.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `tool` | enum | yes | `claude-code` \| `codex` \| `opencode` \| `copilot` \| `kilo-code` \| `cursor` \| `command-code` \| `antigravity` |
| `model` | string | no | A model ID, or `auto`. Omitting `model` and writing `model: auto` are equivalent: both mean the model the tool itself has selected on this machine, which SPLITBRIEF reads at preparation and passes as `--model`. |
| `args` | string[] | no | Extra argv appended to the tool invocation. Every token is validated against the adapter-owned authority set: a flag that would override role, permissions, sandbox, cwd or added roots, config sources, tools, hooks/plugins/MCP, session selection, prompt transport, output format, terminal protocol, final-output path, updates, or approval behavior is refused before spawn. |
| `outputFormat` | enum | no | `stream-json` \| `jsonl` \| `text` \| `opencode`. Selects the parser for the configured-command and legacy command paths. An admitted CLI's parser and terminal protocol are adapter-owned: the backend's native parser stays authoritative, and an implementer `outputFormat` that would replace a structured terminal contract refuses before spawn. |

**What `model: auto` resolves to.** At preparation SPLITBRIEF reads the model the tool itself has selected on this host and starts the seat on it explicitly (`readHostModelSelection`, `src/engine/runners/host-model-selection.ts`), passing it as `--model`. The YAML is never rewritten: it keeps `auto`, which is the operator's intent, while the run's own record — `workflow_config`, `seats.json` and each task start — names the model that was resolved. A missing or unparseable file is not an error: the seat keeps automatic selection, no `--model` flag is passed, and readiness carries a warning saying the tool's own default applies.

| tool | where the selection is read | what is read |
|---|---|---|
| `opencode` | `$XDG_CONFIG_HOME/opencode/opencode.json` or `.jsonc` (`~/.config/opencode/…`), else `$XDG_STATE_HOME/opencode/model.json` (`~/.local/state/opencode/model.json`) | the config file's `model`, else `recent[0]` as `<providerID>/<modelID>` |
| `kilo-code` | the same layout under the name `kilo` | the same |
| `codex` | `~/.codex/config.toml` | the top-level `model = "…"`, before any `[section]` |
| `claude-code` | `~/.claude/settings.json` | the `model` string |
| `antigravity` | `~/.gemini/antigravity-cli/settings.json` | the `model` display name, matched to its catalog id |
| `cursor`, `copilot`, `command-code` | — | nothing: no selection file is known, so the tool's own default applies and readiness warns |

Planner mode does not grant artifact authority, and no CLI flag proves read-only behavior. Authority-bearing options are adapter-owned and cannot be overridden; see [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#planner-artifact-ownership) for the transport, role and containment contract.

YAML — minimal:

```yaml
planner:
  kind: cli
  tool: codex
  model: auto
```

YAML — full:

```yaml
planner:
  kind: cli
  tool: claude-code
  model: opus
  contextLength: 1000000
  timeout: 600000
  effort: high
```

YAML — the `variant` channel (opencode takes a named preset, not `effort`):

```yaml
planner:
  kind: cli
  tool: opencode
  model: openai/gpt-5.6-luna
  variant: high
```

**When to use:** you already pay for a Claude Code / Codex / OpenCode license and want SPLITBRIEF to drive it as a planner without separate API billing. Copilot, Cursor and Command Code plan with their `--mode plan`/read-only recipes like every other CLI planner.

### `kind: api`

OpenAI-compatible HTTP endpoint.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `provider` | non-empty string | yes | `ollama` \| `lm-studio` \| any custom name |
| `service` | non-empty string | yes | Billing/identity service behind the provider. Never inferred — write it out. For an admitted provider ID it must equal that ID's `API_PROVIDER_CATALOG` service (see the provider matrix in §18); a mismatch is a validation error. |
| `offering` | enum | yes | `payg` \| `free-quota` \| `coding-subscription` \| `local`. Never inferred — write it out. For an admitted provider ID it must equal that ID's catalog offering. |
| `apiBase` | non-empty string | yes | Base URL. For known providers, see "Default API base URLs" below. |
| `apiKey` | string | no | Optional for local providers. When authentication is enabled, `ollama` accepts only `env:OLLAMA_LOCAL_API_KEY`; `lm-studio` and `llama-cpp` accept an environment-variable reference such as `env:MY_TOKEN`. The local connection form stores references, not secret values. A custom provider must carry an **inline** key: an `apiKey: env:VAR` reference is refused for a provider the catalog does not know (see [API-KEYS.md](./API-KEYS.md)). |

Ollama and LM Studio support PLAN, BUILD, and REVIEW with independent configured endpoints and exact model IDs. The built-in `llama-cpp` connection profile supports the same seats. Each API block declares `provider`, `service`, `offering`, `apiBase` and its exact `model`; local authentication is optional.

YAML — minimal (custom endpoint):

```yaml
planner:
  kind: api
  provider: custom-endpoint
  service: custom-endpoint
  offering: payg
  apiBase: https://api.example.test/v1
  apiKey: <paste-your-endpoint-key>
  model: your-planner-model
```

YAML — full (custom endpoint with extra catalog entries):

```yaml
planner:
  kind: api
  provider: custom-endpoint
  service: custom-endpoint
  offering: payg
  apiBase: https://api.example.test/v1
  apiKey: <paste-your-endpoint-key>
  model: your-planner-model
  customModels:
    - your-secondary-model
  contextLength: 200000
  temperature: 0.5
  timeout: 300000
```

**When to use:** you run an OpenAI-compatible endpoint of your own — a hosted account, a gateway, or a self-hosted Ollama/LM Studio daemon — and want raw HTTP access without a CLI wrapper.

### `kind: shell`

Arbitrary `stdin → stdout` command. SPLITBRIEF writes the prompt to stdin and parses what comes out of stdout, using `outputFormat` to pick a parser. No shell or network sandbox is applied; the command runs as a normal child process under the current user.

**A `shell` or `agent` command is not trusted because it is in the config.** `.splitbrief/config.yaml` travels with `git clone`, so the command a project declares is the repository author's proposal until *this machine's* owner accepts it. See [Runner command trust](#runner-command-trust).

| Field | Type | Required | Description |
|---|---|:---:|---|
| `command` | non-empty string | yes | Executable path (relative to project or absolute). Availability is an existence/executability check (`fs.access` with `X_OK`, or a `$PATH` lookup for bare names) — SPLITBRIEF never runs your command with `--version`, so the script is not invoked until planning starts. |
| `args` | string[] | no | Argv |
| `outputFormat` | enum | no | Same values as `cli` |
| `env` | string[] | no | Uppercase names of the environment variables the command needs, for example `['MY_AGENT_TOKEN']`. The command runs in its staged runner environment: a private `HOME` and `TMPDIR`, your `PATH` without the project's own directories, the locale and terminal keys, and these names. No other variable of your shell reaches it ([AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md#child-environment)). |
| `capabilities` | partial object | no | **Planner and reviewer only.** Declares optional planner features such as `supportsConversationalPlanning`, `supportsHintEscalation`, `supportsSessionResume`, and `supportsSelfSummarisation` so the orchestrator skips features the wrapper cannot provide. `supportsEffort: true` and `supportsImages: true` are rejected on `shell`/`agent` planners and reviewers — the command-based adapter has no channel to deliver an effort hint or image attachments to the subprocess (use a `cli`/`api` planner or reviewer instead). Ignored (and rejected) on `implementer` — implementer write behavior is set via profile `capabilities.writesFiles`. |

```yaml
planner:
  kind: shell
  command: ./scripts/my-planner.sh
  args: ["--model", "custom"]
  outputFormat: text
  capabilities:
    supportsConversationalPlanning: false
    supportsHintEscalation: true
    supportsSessionResume: false
```

Set `supportsSelfSummarisation: true` only for planner wrappers that can summarize an existing transcript through `planner.summarize()`. It enables the resume-time transcript compaction governed by `workflow.compactionThreshold`; a planner without it leaves the persisted transcript untouched.

**When to use:** wrapping a tool SPLITBRIEF doesn't ship adapters for, or piping through your own pre/post-processing layer.

### `kind: agent`

Same shape as `shell`, but the contract is different: the subprocess **writes files directly to the working tree** and we don't extract anything from stdout. SPLITBRIEF reads the dirty filesystem after the call returns. It runs as a normal child process too; SPLITBRIEF does not sandbox its shell or network access.

```yaml
implementer:
  kind: agent
  command: ./scripts/my-coding-agent.sh
  args: ["--apply"]
  model: auto
```

A `planner` or `reviewer` may also be `kind: agent`; both accept `capabilities` (the same planner feature flags as `kind: shell`), the `implementer` variant does not.

**When to use:** integrating a tool whose contract is "I edit files, you check git diff" rather than "I print a unified diff".

### Runner command trust

Every `shell` and `agent` runner named in `.splitbrief/config.yaml` — planner, reviewer, implementer, or implementer profile — needs an explicit grant on the machine that runs it, before the first planner call.

- **Interactive:** SPLITBRIEF prints the resolved executable path, the argv, the working directory, and the environment names the runner declares in `env` (the only variables of your shell it gets), then asks you to type the confirmation phrase and a reason. A run the TUI prepares — from home, from Setup, or `splitbrief start "<feature>"` — asks on the confirmation panel inside the TUI; `continue` asks on the terminal before the TUI opens. Confirming writes an owner-only receipt to `~/.splitbrief/trust/custom-runners.json` (mode `0600`).
- **Headless** (`--json` or `--plain`): there is no prompt. The run is blocked unless a receipt already exists or you pass `--allow-repo-runners`, which grants that run only and persists nothing.

The receipt is keyed to the canonical path of *this* checkout and to a digest of the command tuple, so it never travels inside a clone, never applies to a second checkout of the same repository, and stops applying the moment the command, its argv, its declared environment references, or its watchdog thresholds change. Replacing the executable on disk invalidates it too: the receipt stores the executable's content digest.

A **repo-local** command needs `--allow-repo-runners` even in a terminal, because a receipt cannot bind files the checkout can change. The check reads the argv the way each program reads it (`src/core/trust/command-string-classification.ts`). A command is repo-local when:

- its executable, or a script, module or preload file it gives an interpreter, resolves inside the project. A relative script path always does, because the runner starts in the checkout.
- it runs `python -c` or `python -m`, which put the working directory first on the import path.
- it runs a task runner, build tool, test runner or package manager from the table in `src/core/trust/path-classification.ts` (`make`, `just`, `rake`, `cargo`, `go`, `pytest`, `tox`, `uv`, `poetry`, `npm`, `npx`, `yarn`, `pnpm`, `bun`, `deno`, `tsx`, `mvn`, `gradle`, `sbt`, `dotnet`, `mix`, `bundle`, `composer` and others) in any form except the version or help form pinned for that program, because the project's files decide what it runs. An unknown subcommand is repo-local. Some programs, such as `yarn`, `pnpm`, `pytest`, `mvn` and `dotnet`, read a project file even for `--version`, so every form of them is repo-local.
- it runs `rustup` or a rustup proxy (`cargo`, `rustc`, `rustdoc`, `rustfmt`, `cargo-fmt`, `cargo-clippy`, `clippy-driver`, `cargo-miri`, `rust-analyzer`, `rust-gdb`, `rust-gdbgui`, `rust-lldb`, `rls`) while a `rust-toolchain` or `rust-toolchain.toml` file exists. The same applies to `go` with `go.mod` or `go.work`, and to `bundle` with `Gemfile.lock`, `gems.locked`, `gems.rb.lock`, `gem.deps.rb.lock`, `Isolate.lock` or `.bundle/config`. These files select the binary that runs before any subcommand, so every form is repo-local, `--version` included. Each tool takes the first such file in its working directory or any directory above it, so the check looks in the project directory and every parent.
- its inline `node -e` program loads a module other than a `node:` builtin, names an evaluating or spawning builtin, or builds a name from data.
- a wrapper (`env`, `nice`, `nohup`, `timeout`, `stdbuf`, `time`, `command`, `exec`) runs a repo-local command, `env` sets a code-loading variable such as `NODE_OPTIONS` or `PYTHONPATH`, or the wrapper uses an option the check does not model. `xargs` is always repo-local, because its arguments come from stdin.
- a `sh -c` script contains a word that reaches the project or that the check cannot settle without running the shell.
- an argument is a path into the project, or names an interpreter, a shell or one of those programs, which the command could run.

`runners.planner.trust-boundary`, `runners.reviewer.trust-boundary` (only when a `reviewer` block is configured) and `runners.implementer.trust-boundary` in `splitbrief doctor` print the configured `command` and `args` (control-stripped and credential-redacted) so you can read them before starting anything. Only the prompt resolves the command to an absolute executable path, because readiness never touches the filesystem for this. Each check is emitted whenever its runner can execute a local command, at every approval level.

### Default API base URLs (`KNOWN_PROVIDER_BASE_URLS`)

Source: `src/core/providers/catalog.ts`.

| Provider | Default `apiBase` |
|---|---|
| `ollama` | `http://localhost:11434/v1` |
| `lm-studio` | `http://localhost:1234/v1` |

**See also:** §3 `implementer`, §13 environment variables, [API-KEYS.md](./API-KEYS.md).

Custom OpenAI-compatible API providers are allowed when `service`, `offering`, and `apiBase` are all set — the same three fields every admitted provider ID also has to spell out, because nothing is back-filled at load. Because SPLITBRIEF cannot infer a safe environment variable name for unknown providers, custom providers must set `apiKey` explicitly and inline: an `apiKey: env:VAR` reference is refused for a provider the catalog does not know, so a config cannot point an unrecognized endpoint at one of your environment credentials.

---

## 2a. `reviewer`

Optional. `reviewer` names the runner that performs the final review of the run diff. Leave it out and the planner holds that seat, exactly as it did before the seat became assignable (`resolveReviewerRunner`, `src/core/config/accessors/reviewer-runner.ts`). Set it when you want the diff read by a model other than the one that planned it.

The reviewer only reviews. Planning, Task Brief compilation, escalation and summarization stay on the planner whatever this block says.

### Schema

Same discriminated union as `planner` — the four kinds, the same [common generation fields](#common-generation-fields), an optional `model`, and `.strict()` on every variant, so an unknown field fails the load with a `ConfigError` (`ReviewerConfigSchema`, `src/core/schemas/reviewer-config.ts`).

| `kind` | Write the same fields as | Notes |
|---|---|---|
| `cli` | [`kind: cli`](#kind-cli) | `tool` must be a planner-side CLI: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`. |
| `api` | [`kind: api`](#kind-api) | Built-in local providers support the review seat through the planner role. Declare `service`, `offering`, `apiBase` and the exact model independently for this seat. Custom remote providers require their own inline credential. |
| `shell` | [`kind: shell`](#kind-shell) | Needs the same [runner command trust](#runner-command-trust) grant as a `shell` planner. |
| `agent` | [`kind: agent`](#kind-agent) | Same trust grant. |

The reviewer is a planner-tier seat and shares the planner's admission set, so a provider or tool that the planner may not use is rejected in this block too. The seat is built on the planner backends (`createReviewer`, `src/engine/runners/factory.ts`), so effort follows the same channel matrix as on the planner: `cli` `claude-code`, `codex`, `copilot` and `command-code` take the `effort` field on the tool's own effort argument, `cli` `opencode` and `kilo-code` take a named preset in `variant` instead, `cli` `cursor` reads its effort out of the selected model id, and only the `api`, `shell` and `agent` kinds have no channel at all. An `effort` or `variant` the backend cannot deliver is cleared with a toast when the seat is changed in the TUI and dropped with a stderr warning headless; a `temperature` outside the `api` kind is likewise dropped with a stderr warning headless, but is carried forward untouched in the TUI. With no `reviewer` block the review seat inherits the planner's effort and shows it read-only; make the seat independent before changing it.

### Falling back to the planner

- **No `reviewer` block:** the planner runner performs the review. Review tokens are priced at the planner's rates and folded into the planner line in the run summary.
- **A `reviewer` block:** the reviewer performs the review and gets its own priced line in both.
- **A configured reviewer that fails admission** blocks the run before it starts, with a readiness blocker naming the reviewer seat. **A configured reviewer that fails mid-call** is reported as a failed review (`finalReviewStatus: "failed"` in the run summary, `finalReview.status` in the review packet), with the reviewer's identity in the error and the final-review evidence still recorded. SPLITBRIEF never silently hands the review back to the planner.

### YAML — cross-lab review

Planning on Claude Code, building on a local model, reviewing on Codex, so the diff is read by a model from a different lab than the one that planned it:

```yaml
planner:
  kind: cli
  tool: claude-code
  model: opus

implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b

reviewer:
  kind: cli
  tool: codex
  model: auto
```

**See also:** `/crew review` in [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md), and the `--reviewer-*` flags in [CLI-REFERENCE.md](./CLI-REFERENCE.md).

---

## 3. `implementer`

The implementer is the weaker of the two models. What makes a runner the implementer is the model behind it, not the transport SPLITBRIEF uses to reach it: a coding-agent CLI pointed at a smaller model and an OpenAI-compatible API endpoint are equally first-class here, and SPLITBRIEF favors neither. They differ mechanically in one place — a `cli` or `agent` implementer writes files itself (`writesFiles: direct`), while an `api` or `shell` implementer returns file contents that SPLITBRIEF writes (`writesFiles: extracted-code`). Where a direct writer works before its changes reach your checkout is set by `workflow.isolation` (§5).

Same discriminated union as `planner`, with two schema differences: `model` is required on the `api`, `shell`, and `agent` implementer variants, and the `shell`/`agent` variants do **not** accept the planner-only `capabilities` field. The `cli` variant leaves `model` optional — omit it or write `model: auto` to follow the tool's own selection, which preparation reads from the tool's own config or state and passes as `--model`; the two spellings behave identically and neither is rewritten on save. On an `api` runner, `auto` resolves to that provider's catalog default model (for example `ollama` → `qwen3-coder:30b`), and a custom provider with no catalog default rejects `auto` — and model absence — at config load. Implementer write behavior (`extracted-code` vs `direct`) is not a choice: `capabilities.writesFiles` may be declared per profile under `implementerProfiles`, but it must match the runner kind's write mode, and config load rejects a mismatch.

YAML — minimal (local Ollama):

```yaml
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b
```

YAML — a coding-agent CLI running a smaller model than the planner:

```yaml
implementer:
  kind: cli
  tool: codex
  model: gpt-5-codex
```

That is the `direct` path: the tool edits files itself inside the run's isolation directory and SPLITBRIEF promotes the result. It is not a side door — the same Task Brief, validation pipeline, retry ladder, escalation, and drift accounting apply as for an `api` implementer.

YAML — full (a hosted model behind your own OpenAI-compatible endpoint):

```yaml
implementer:
  kind: api
  provider: custom-endpoint
  service: custom-endpoint
  offering: payg
  apiBase: https://api.example.test/v1
  apiKey: <paste-your-endpoint-key>
  model: your-implementer-model
  contextLength: 200000
  temperature: 0.3
  timeout: 240000
```

`contextLength` is an application budgeting input, not a server setting. The application context budget does not reconfigure the server or prove its active context capacity. For built-in local API seats, `resolveApplicationContextTokens` selects configured context, otherwise observed active context, otherwise the application default of 8192 tokens, then clamps that result to observed active and maximum context when known. The model's maximum context is a separate architectural ceiling and never substitutes for unknown active capacity. CLI and legacy routing metadata have their own conservative fallback (`DEFAULT_UNKNOWN_CONTEXT_LENGTH`); that does not replace the API dispatch budget.

For PLAN and REVIEW, reserve 2048 output tokens and add an input-estimation margin of ceil(inputEstimate * 0.15). `measureApiBudget` includes message/request overhead, requires input plus the 15% margin plus output reserve to fit, and refuses before dispatch if it does not. BUILD reserves output for the complete declared text bundle, including modify baselines and new targets. The output cap is independently bounded; an absent maximum-output report uses the 8192-token application fallback. Each dispatch rechecks the seat's own endpoint and exact model.

The first-response deadline defaults to 120000 ms and stream-idle to 60000 ms. `resolveApiDeadlinePolicy` clamps each to the total role timeout, which remains authoritative. First response means the first stream chunk; subsequent chunks reset idle timing. Cancellation closes the application request, but does not prove remote generation has stopped. SPLITBRIEF never reconfigures or unloads the server in response.

`resolveEffectiveRequestOptions` records whether controls were sent, not configured, or omitted as unsupported. Current OpenAI-compatible policy sends the budgeted `max_tokens` but omits temperature, effort/reasoning controls and stream-usage requests. A configured value or retry temperature increment is not evidence that the server received it.

**When to use:**
- *Coding-agent CLI on a smaller model* — you already pay for a Claude Code / Codex / Copilot subscription and want the implementer step to run there on a smaller model than the planner uses.
- *Cheap local API* — Ollama or LM Studio for cost-free iteration on small tasks.
- *Mid-tier API* — a below-frontier model behind your own custom endpoint.
- *Frontier* — the same model class as the planner when you want its quality for the implementer step too.

**See also:** §2 `planner`, §6 `escalation` (for mid-tier fallback), [REPOMAP.md](./REPOMAP.md) (codebase context the implementer never sees, only the planner).

### Optional `implementerProfiles`

`implementer` remains required for backwards compatibility and existing configs do not need to change. New configs may also define named implementer profiles so task routing can choose a cheap capable worker per Task Brief.

An implementer pool is still one product role: SPLITBRIEF selects one capable profile per Task Brief. Parallel implementer writes are out of scope. `workflow.isolation` separates one implementer's work from your checkout, not two implementers from each other.

Profile names must be stable event-safe identifiers: lowercase letters, numbers, and hyphens, starting with a letter, up to 64 characters.

```yaml
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b

implementerProfiles:
  default: local-qwen
  profiles:
    local-qwen:
      kind: api
      provider: ollama
      service: ollama
      offering: local
      apiBase: http://localhost:11434/v1
      model: qwen2.5-coder:7b
      contextLength: 32768
      label: Local Qwen
      capabilities:
        writesFiles: extracted-code
    small-cloud:
      kind: api
      provider: custom-endpoint
      service: custom-endpoint
      offering: payg
      apiBase: https://api.example.test/v1
      apiKey: <paste-your-endpoint-key>
      model: your-cheap-cloud-model
      contextLength: 131072
      label: Small cloud
      capabilities:
        writesFiles: extracted-code
```

`implementerProfiles.profiles.*` uses the same runner schema as `implementer`, plus:

| Field | Type | Description |
|---|---|---|
| `label` | string | Optional display label for TUI/events. |
| `capabilities.writesFiles` | `extracted-code\|direct` | Optional routing metadata. Defaults from runner kind: `api` applies text file bundles, `shell` extracts legacy single-file output, and `cli`/`agent` write directly. Explicit values must match the runner kind. |

If `implementerProfiles.default` is omitted, SPLITBRIEF resolves the default profile deterministically from the first profile name in sorted order. If `default` is set, it must name an existing profile.

Task-start rows name the selected worker (`worker default`) and, when the brief is `tight` or `overflow`, its estimate against the context window (`~24,310 of 32K context tokens (tight)`). The full routing reason stays in the run log, and the run's recorded per-task metadata carries richer routing and context data for post-run inspection.

When recovery offers `route-bigger-worker`, the issue names a target profile from this pool. Selecting that action resets only the current task and reruns it once with the named profile instead of the routing choice.

---

## 4. `validation`

What runs after every implementer task. The three master switches (`typecheck`, `lint`, `test`) are **required** in the schema; the loader fills them from `createDefaultConfig()` if absent. The command overrides are all optional and let you pin exact validation commands per project. When the lint stage is on, the brief's own changed files are formatted first with the project's own formatter — `npx biome format --write` when a Biome config file is present, `npx prettier --write` when a Prettier config is, and nothing when neither is; a formatter that exits non-zero is one warning (`validation_format_failed`) and the lint stage runs regardless.

### Schema

```ts
validation: {
  typecheck:    boolean;
  lint:         boolean;
  test:         boolean;
  testCommand?:      string; // optional, non-empty
  typecheckCommand?: string; // optional, non-empty
  lintCommand?:      string; // optional, non-empty
  testPattern?:      string; // optional, non-empty
  timeoutMs?:        number; // optional, int >= 1000, milliseconds
  stack?: 'typescript' | 'javascript' | 'python' | 'go' | 'rust'; // optional
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `typecheck` | boolean | `true` | Master switch for the type-checking stage |
| `lint` | boolean | `true` | Master switch for the linting stage |
| `test` | boolean | `true` | Master switch for the test stage |
| `testCommand` | string | — | The escape hatch for the test stage: an argv-style command that runs **as-is** (the full suite) — shell operators and environment expansion are not interpreted, and no test-file argument is appended. When omitted, the stage resolves down the ladder below and a stack default is narrowed to the affected test file. |
| `typecheckCommand` | string | — | The escape hatch for the type-checking stage (e.g. `cargo check`, `go vet ./...`, `mypy src/`). Same as-is semantics as `testCommand`. |
| `lintCommand` | string | — | The escape hatch for the linting stage (e.g. `cargo clippy --no-deps`, `ruff check`). Same as-is semantics as `testCommand`. |
| `testPattern` | string | — | Optional glob for finding test files (e.g. `*_test.go`, `test_*.py`). Overrides the stack's own patterns. |
| `timeoutMs` | number | `600000` | Per-stage timeout in milliseconds (minimum `1000`) for each validation command, applying to the run-start baseline probe, the `doctor --probe-validation` diagnostic, and per-task validation. One red or slow stage can hold the loop for this long before the probe moves on. |
| `stack` | enum | detected | Pin the validation stack instead of detecting it: `typescript`, `javascript`, `python`, `go`, or `rust`. Use it when a repo carries more than one marker file and the detection order picks the wrong one, or when the markers are missing entirely. |

YAML — TypeScript project (default):

```yaml
validation:
  typecheck: true
  lint: true
  test: true
  testCommand: npm test -- --run --reporter=dot
```

YAML — Rust project:

```yaml
validation:
  typecheck: true
  lint: true
  test: true
  typecheckCommand: cargo check
  lintCommand: cargo clippy --no-deps
  testCommand: cargo test
  testPattern: "*_test.rs"
```

### How commands are resolved

SPLITBRIEF resolves each validation stage through one ladder — `config → manifest → discovered → stack default → none` — and takes the first rung that yields a command:

1. **Project config** — `typecheckCommand`, `lintCommand`, `testCommand` override everything.
2. **Manifest** — a `package.json` script named `typecheck` / `lint` / `test`, a `Makefile` or `justfile` target of that name, or the matching `pyproject.toml` section (`[tool.mypy]` → `mypy .`, `[tool.ruff]` → `ruff check .`, `[tool.pytest.ini_options]` → `pytest`). Deterministic, and read before any model output.
3. **Planner-discovered** — during the research phase, the planner reads config files and reports the project's validation toolchain. Persisted to `WorkflowState.discoveredValidation`. The reader (`src/core/pipeline-spec/research-fields.ts`) finds the `Validation Tools` heading at any level, with or without a qualifier, and reads both `**Label**:` and `**Label:**`. A label with no value on its line takes the first bullet nested under it. A discovered command passes a safety check first. Among its rules, a package manager passes only as `<manager> test` with no path after it, `make` and `just` only as `<runner> <stage>`, `uv run` and `poetry run` only before a Python stack tool, and `node` or `python` only without a script, a module other than a Python stack tool, or inline code. A refused command becomes a `validation` warning that names the reason, and the stage uses config, the manifest or the stack default.
4. **Stack default** — the row `detectStack` picked from `src/core/validation/stacks/` (`validation.stack` pins it): rust, go, python, typescript or javascript, in that marker order. Per-stack commands are tabulated in [FEATURES.md §Validation pipeline](./FEATURES.md#validation-pipeline--checkpoints).
5. **None** — the stage is recorded as `skipped` with the reason `no <stage> command for an unrecognised stack`, never as passed. A run where every enabled stage is skipped that way emits a warning and prints `gates: NONE — review-only`; it still implements and still reviews, but nothing was verified by a gate. SPLITBRIEF never guesses `npm test` or `npx tsc --noEmit` on a project that is neither JavaScript nor TypeScript.

A command from rung 4, or from rung 2 on a recognised stack, is narrowed to the brief's affected test files (`npm test -- <file>`, `pytest <file>`, `go test ./<pkg>/`, `cargo test -- <name>`). When `npm test` is that command and every affected test file sits inside the `include` (and outside the `exclude`) of a vitest config that a `test:<name>` package script passes with `--config`, the stage runs `npm run test:<name> -- <file>` instead. An explicit `*Command` from rung 1 and a discovered command from rung 3 run as written.

Master switches (`typecheck`, `lint`, `test`) still gate each stage: setting `lint: false` skips lint regardless of whether a command is available.

**When to use the toggles:**
- Disable `test` for repos with no test suite.
- Disable `lint` if your linter is enforced only at PR time (CI) and you want faster local iteration.
- Leave `typecheck: true` for typed languages — it's the fastest signal that the implementer wrote compilable code.

### Baseline-relative acceptance

A task's validation is judged against the run's baseline, not absolute repository health. Before the first task, SPLITBRIEF probes every enabled stage and records which are already red, **the exact command each probe ran**, and **the set of failures it saw** — one key per (file, message) pair. Baseline red is not a blanket exemption: a stage is exempt — and the task may still be accepted — only when all four hold: the stage was already red at baseline, the failing run used the same command the baseline probed, its failures after the attempt are a **subset** of the baseline's failure set, **and** its failure evidence names none of the task's changed files. A new failure in a file the task never touched (`b.ts` broken by a change to `a.ts`) is therefore not exempt and fails the stage. The command binding matters most for `test`: a stack-default test command is narrowed to the affected test file of the task at hand, so a baseline measured against the first task's test file never exempts a later task's failure in a different file. The exemption is per-stage and per-file: a stage that was green at baseline always blocks, and a new failure in a stage that was red at baseline still blocks when its evidence names a file the task touched. A skipped stage is never exempt and never blocks. The pipeline keeps running past a baseline-red stage instead of stopping, so the stages behind it still get a verdict, and an accepted task produces no retry prompt.

**See also:** [WORKFLOW.md](./WORKFLOW.md) (where validation sits in the loop), `src/engine/orchestrator/validation/run.ts`.

---

## 5. `workflow`

Automatic staging, commits, and index checkpoints are not supported; commit changes manually.

workflow.briefReview is currently ignored and deprecated; it does not enable an extra review step.


Mode, spec/plan document gates, retries, git strategy, and brief-review style.

### Schema

```ts
workflow: {
  // Document approval gates
  approve?:               'none' | 'spec' | 'plan' | 'all' | 'default';

  // Retries
  maxRetries:             number; // int >= 0 — REQUIRED

  // Git
  git?: {
    commitStrategy?:      'none'; // deprecated input, stripped on load
    createBranch?:        boolean;
  };

  // Where a direct-writing implementer works before promotion
  isolation?:             'worktree' | 'staged-copy';

  // Mode + brief review
  mode?:                  'quick' | 'standard' | 'speckit';
  briefReview?:           'simple';
  taskReview?:            'none' | 'failed' | 'every';

  driftChainThreshold?:   0..1;

  // Speckit-only
  speckit?:               { minCoverage?: 0..1 };

  // Transcript
  compactionThreshold?:   number;  // int >= 10
  compactionFormat:       'auto' | 'freeform' | 'structured'; // default auto

  // Compatibility only; no rendered effect
  showSpend?:             boolean; // default true
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | enum | `standard` | `quick` \| `standard` \| `speckit`. The retired `instant` still loads as `quick` with a deprecation warning; any other value fails validation. |
| `approve` | enum | `default` | Document approval gates: `none` skips every approval gate; `spec`, `plan`, and `all` select spec, plan, or both and also open briefs review in standard/speckit. `default` follows the mode. Quick opens no gates. Brief quality checks still run. |
| `maxRetries` | int >= 0 | `2` | Per-task local retries before escalation kicks in, so a brief gets `1 + maxRetries` attempts. The default is `DEFAULT_LOCAL_RETRIES` (`src/core/pipeline-spec/retries.ts`), the same constant the Build progress block reads for `attempt <a> of <max>`. |
| `git.commitStrategy` | retired | absent | Legacy `none` is accepted with a deprecation warning and removed from the loaded config; `checkpoint` and `per-task` are rejected. Omit the field. |
| `git.createBranch` | boolean | `false` | Auto-create `splitbrief/<slug>` branch at workflow start. |
| `isolation` | enum | `worktree` | Where an implementer that writes files itself does its work before changes are promoted into the project: `worktree` (one linked git worktree per run) or `staged-copy` (a temporary copy of the project per task). Unused when the implementer returns file contents (`writesFiles: extracted-code`) — SPLITBRIEF writes those files into the project itself. |
| `briefReview` | deprecated | ignored | Compatibility input accepts only `simple`; `rich` is rejected. It does not control the existing brief approval gate or external editor. |
| `taskReview` | enum | `none` | Per-task review gate after implementation: `none` (never pause), `failed` (pause only when a task fails, hits recovery, or its validation fails), `every` (pause after every advancing task). **Requires an interactive TUI run** — any value other than `none` is rejected at startup in headless mode (`src/cli/headless.ts`), so leave it `none` for CI. |
| `driftChainThreshold` | 0..1 | `0.6` | Threshold used when omitted; higher = fewer drift-chain events. |
| `speckit.minCoverage` | 0..1 | `0.9` | Speckit-mode spec/plan→task traceability threshold. The analyze phase emits a `warning` event when measured `specTaskCoverage` or `planTaskCoverage` falls below this value. Not a test-coverage gate. |
| `compactionThreshold` | int >= 10 | unset | On resume, auto-compact persisted transcript context when compacted message count exceeds this threshold and the planner supports self-summarisation. |
| `compactionFormat` | enum | `auto` | Summary format for transcript compaction: `auto` selects structured JSON for `api` planners, freeform text for `cli`, `shell`, and `agent`; `freeform` preserves legacy markdown/text summaries; `structured` requires Zod-validated JSON and falls back to freeform text if validation fails. |
| `showSpend` (`show_spend`) | compatibility boolean | `true` | Retained in config, with no main-screen rendered effect. `/copy cost` copies the same spend text `/usage` reads rather than answering a switched-off display. Open `/usage` for usage details; there is no Show spend setting. |

### Per-mode defaults

| Mode | Planner calls | Default `approve` | Best for |
|---|:---:|:---:|---|
| `quick` | 1 | `none` | Trivial edits and small tasks that still want a brief |
| `standard` (default) | 4 | `spec` | Ordinary feature work |
| `speckit` | 6–7 | `all` | Large, risky, externally visible |

`approve: default` resolves to the table above via `resolveApproveLevel()` (`src/core/config/runtime/resolve.ts`).

**Deprecated: `workflow.mode: instant`.** The `instant` mode was merged into `quick`. The string still parses — `WorkflowModeSchema` (`src/core/schemas/enums.ts`) preprocesses it to `quick` — so an existing config keeps loading unchanged, and `validateConfig` pushes a deprecation warning telling you to update the value. `--mode instant` behaves the same way and warns on stderr. Nothing writes `instant` any more; update the file to `quick` to silence the notice.

`briefReview` remains a compatibility field; omit it from new configurations. The existing brief gate and external editor are independent of this field.

### Implementer isolation

An implementer whose runner writes files itself (`writesFiles: direct` — the `cli` and `agent` kinds) does not edit your checkout while it works. It works in an isolated directory, and SPLITBRIEF promotes the result into the real project directory through the hash-guarded promotion path, which refuses to overwrite a file you changed in the meantime. Isolation moves *where* the writing happens; it never changes *whether* the change reaches you.

| Value | What it does | Cost |
|---|---|---|
| `worktree` (default) | One linked git worktree created for the run. The implementer gets the repository's git history, its own branch, and the project's installed Node dependencies linked in (only Node — virtualenvs, Go module caches, and Rust target directories are not linked), so it can run typecheck, lint, and tests where it is working. | One `git worktree add` per run. |
| `staged-copy` | A temporary copy of the project per task under the system temp directory. Which files are copied comes from git's own list of tracked and untracked files (`.gitignore`, `.git/info/exclude`, and global excludes), so gitignored build and report artifacts never enter the copy; `.git`, `node_modules`, `.splitbrief/`, `.trees/`, and credential files are excluded on top of that. A fixture the repository gitignores is not present in the copy at execution time, so a runner that reads such a fixture while working in the copy will no longer find it. No git history and no installed dependencies, so the implementer cannot run the project's own checks. | A full project copy per task. |

**Worktree isolation is a file boundary, not a security boundary.** The worktree shares your git repository, your hooks, and your configuration, and it runs on the same machine, as the same user, against the same ports, databases, and network. It gives the implementer its own copy to write in, and SPLITBRIEF checks that it stays there: a tool call that reaches outside the isolation directory stops the call and halts the brief as `implementer-left-isolation`, and a change to the git state of your checkout during a call halts the brief as `checkout-changed` ([APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#recovery)). It does not constrain what the implementer's tool can execute. Neither strategy applies a shell or network sandbox. The workspace environment's PATH is widened to the linked `node_modules/.bin`, resolved to its real path inside the project — the widening is visible in the child's environment, not hidden behind the symlink.

A run's worktree is created once per run and reused across tasks and retries (a marker carrying the session id is what makes an isolation directory the session's own). It lives outside both `.git/` and the project root — under `$XDG_STATE_HOME/splitbrief/trees/<repo-key>/<session-id>` (or `~/.local/state/splitbrief/trees/<repo-key>/<session-id>` when `XDG_STATE_HOME` is unset), keyed by the first twelve hex characters of `sha256(realpath(git rev-parse --git-common-dir))` — because direct-writing CLIs refuse paths under `.git/` as sensitive and a project-rooted test glob would otherwise walk into the second copy and count every test twice. See [HOW-IT-WORKS.md §Isolation and promotion](./HOW-IT-WORKS.md#isolation-and-promotion). When the run ends, the worktree is removed with force and its branch deleted if nothing unpromoted remains; a run that ends with unpromoted work keeps the worktree and reports the retention, so interrupted work survives there for recovery — `git worktree list` shows the path.

This setting does not move validation. The deterministic typecheck → lint → test pipeline (§4) runs in the real project directory after promotion, and that pipeline plus the planner's review is what decides whether a task is correct. An implementer that can also run checks in its own directory raises the first-pass rate; it is never the authority on correctness. The dependency link is a symlink, which git records as a file, so the common `node_modules/` pattern — which matches directories only — would leave it untracked inside the worktree. When your repository already ignores its own `node_modules`, SPLITBRIEF adds a rooted `/node_modules` line to the repository's `.git/info/exclude` — the exclude file git shares between your checkout and every linked worktree — so the link stays out of change detection. The line is written under a `# splitbrief run isolation <session id>` marker and taken back out when the run's isolation is disposed, so your checkout is left exactly as it was found and a run that dies mid-flight leaves a block naming the session that wrote it. While it stands it changes nothing for your checkout, because your own rules already ignored that directory. A repository that does not ignore `node_modules` at all is left untouched and the run falls back to `staged-copy` rather than let the link pollute change detection.

```yaml
workflow:
  isolation: worktree
```

### YAML examples

Minimal (rely on per-mode defaults):

```yaml
workflow:
  mode: standard
  maxRetries: 2
```

Speckit with manual commits:

```yaml
workflow:
  mode: speckit
  approve: all
  maxRetries: 2
  driftChainThreshold: 0.6
  git:
    createBranch: false
  speckit:
    minCoverage: 0.8
```

Headless CI:

```yaml
workflow:
  mode: quick
  approve: none
  maxRetries: 2
```

**When to use what:**
- `git.createBranch: true` — when running SPLITBRIEF in CI or against `main` and you don't want the changes landing on the current branch.
- `isolation: worktree` — the default, and the only strategy where the implementer can run the project's own typecheck, lint, and tests before handing work back. Choose `staged-copy` only when a linked git worktree is not workable for your setup.

**See also:** [WORKFLOW.md](./WORKFLOW.md), [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) (`/mode` runtime override). Workflow approval level is set with `--approve` or `workflow.approve`.

---

## 6. `escalation`

After `maxRetries`, the optional tier 0 intermediate worker retries, then tier 1 asks the planner for a hint and retries with the implementer. Exhaustion enters explicit recovery. The planner never automatically takes over code-writing implementation.

### Schema

```ts
escalation: {
  enabled?:               boolean;
  intermediateProvider?:  string;
  intermediateModel?:     string;
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | on when `intermediateProvider` and `intermediateModel` are both set | Toggle for the intermediate tier. The tier is active by default once `intermediateProvider` and `intermediateModel` are configured; set `enabled: false` to disable it (failed tasks then escalate straight to the planner) without removing the provider config. |
| `intermediateProvider` | string | — | Provider id for the mid-tier model. The tier is always an `api` runner: name an API catalog provider (`ollama`, `lm-studio`, `llama-cpp`) or a custom provider; a custom name runs on the API implementer's endpoint and its inline key, and a CLI tool id here names a custom provider of that name, never the CLI tool. When unset, the intermediate tier never runs. |
| `intermediateModel` | string | — | Model id at that provider. Required whenever `intermediateProvider` is set: the config fails to load with `intermediateModel is required when intermediateProvider is set`, and there is no fallback to the implementer's model (`enabled: false` does not lift the requirement). |

YAML:

```yaml
escalation:
  intermediateProvider: ollama
  intermediateModel: qwen3-coder:30b
```

**Editing from the TUI.** The intermediate tier is configured in YAML only. The Crew section of Settings exposes planner, implementer, and reviewer seats; it has no escalation row or picker. Set `enabled: false` in YAML to disable the tier while retaining its provider and model configuration.

**When to use:** you run a small implementer (a local model, or a small model behind your own endpoint) and want a stop that is stronger than the implementer but weaker than the planner before the task reaches the planner itself. Skip if your implementer is already frontier-class. Set both `intermediateProvider` and `intermediateModel` to turn the tier on; add `enabled: false` only when you want to keep the provider config but bypass the tier.

**Pricing knownness.** Escalation and recovery provider calls follow the same knownness rules as every other call. Unknown provider cost is not zero. A call whose price does not resolve leaves the run's USD figure absent or unknown, never `0`, and SPLITBRIEF never invents a rate to fill the gap.

---

## 7. `codebase`

Repo-map context block injected into planner prompts. Detailed semantics: [REPOMAP.md](./REPOMAP.md).

### Schema

```ts
codebase: {
  enabled:     boolean;            // default true
  tokenBudget: int 1..50000;       // default 4000
  include?:    string[];           // glob patterns
  exclude?:    string[];           // regex strings
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Emit `<repo-map>` block to planner |
| `tokenBudget` | int 1..50000 | `4000` | Tokens reserved for the block. PageRank picks the top N symbols that fit. |
| `include` | string[] | walks `.ts`/`.tsx` | Glob patterns relative to project root |
| `exclude` | string[] | test files + `dist/` + `node_modules/` | **Regex strings** (note: not globs) |

YAML:

```yaml
codebase:
  enabled: true
  tokenBudget: 6000
  include:
    - "src/**/*.ts"
    - "src/**/*.tsx"
    - "lib/**/*.ts"
  exclude:
    - "\\.test\\.tsx?$"
    - "/__fixtures__/"
    - "^dist/"
```

**When to use:** raise `tokenBudget` for sprawling codebases where the planner needs broader context; lower it for monorepos where you want to scope the planner tightly via `include`. Disable entirely with `enabled: false` for prompt experiments.

**See also:** [REPOMAP.md](./REPOMAP.md).

---

## 8. `hooks`

Workflow lifecycle hooks. Quick overview here; full schema, trust model, and substitution rules in [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

### Schema

```ts
hooks: {
  pre_planning?:    HookEntry[];
  pre_task?:        HookEntry[];
  post_task?:       HookEntry[];
  pre_validation?:  HookEntry[];
  post_validation?: HookEntry[];
  pre_commit?:      []; // retired; nonempty entries rejected
  post_commit?:     []; // retired; nonempty entries rejected
  pre_escalation?:  HookEntry[];
  on_error?:        HookEntry[];
  on_halt?:         HookEntry[];
  on_complete?:     HookEntry[];
}

type HookEntry =
  { kind?: 'command'; name?: string; command: string; args?: string[];
    timeout_ms?: number; on_failure?: 'block' | 'warn' | 'ignore' };
```

`HookEntry` is preprocessed: a bare object without `kind` is treated as `kind: 'command'`. `command` rejects bare `sh` / `bash` / `/bin/sh` / `/bin/bash` — use a script file.

YAML:

```yaml
hooks:
  pre_task:
    - command: ./scripts/snapshot-state.sh
      timeout_ms: 10000
      on_failure: warn
  post_task:
    - name: notify
      command: ./scripts/slack-ping.sh
      args: ["task complete"]
      on_failure: ignore
  on_error:
    - command: ./scripts/page-oncall.sh
      on_failure: warn
```

**When to use:** any cross-cutting concern that should run regardless of which task is executing — formatting, secret-scanning, notifications, snapshotting external state, audit logging.

**See also:** [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) for trust prompts (`--allow-hooks`), substitution variables, environment passed to hook processes.

---

## 9. `approval`

Tiered approval system for declared file writes. It sits orthogonal to `workflow.approve`, which controls spec/plan gates. Both the block and its `tiers` sub-block are strict: an unknown key fails the load.

### Schema

```ts
approval: {
  enabled:                    boolean;        // default true
  tiers?: {
    read?:                ApprovalTier;
    write_in_scope?:      ApprovalTier;
    write_out_of_scope?:  ApprovalTier;
    destructive?:         ApprovalTier;   // ignored: protected paths always confirm
    package_change?:      ApprovalTier;   // ignored: protected paths always confirm
    sensitive_change?:    ApprovalTier;   // ignored: protected paths always confirm
  };
  feedRejectionsToPlanner:    boolean;        // default true
}

type ApprovalTier = 'auto' | 'sticky' | 'confirm';
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master toggle for file-write tiered approval; a protected-path write asks even when it is `false` |
| `tiers.<op>` | enum | per-op default | `auto` (no prompt), `sticky` (prompt once, remember), `confirm` (prompt for each path; a confirmation holds for the same path and operation for the rest of the run) |
| `feedRejectionsToPlanner` | boolean | `true` | When the user rejects an op, send the rejection back to the planner so it can adapt. |

### approval.allowedPaths

Type: `string[]` (optional)
Default: not set (no paths pre-approved)

Glob patterns for paths that are always treated as in-scope for writes. Writes to matching files are classified as `write_in_scope` (auto-approved by default) regardless of the current task's `inBounds`.

```yaml
approval:
  allowedPaths:
    - 'src/**'        # all files under src/
    - 'tests/**'      # all files under tests/
    - '*.md'          # all markdown files at any depth
```

This is a **union** with task-level `scope.inBounds` — either match is sufficient for in-scope classification. `allowedPaths` widens scope, never narrows it.

Supported glob patterns: exact match (`src/config.ts`), recursive directory (`src/**`), single-level directory (`src/*`), extension wildcard (`*.ts`), and simple star (`src/utils/*`).

Note: `allowedPaths` only affects the action *class* (`write_in_scope` vs `write_out_of_scope`), not the *tier*. If you override `approval.tiers.write_in_scope: 'sticky'`, writes to allowed paths will still prompt once per session.

**Tier keys:** `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, `package_change`, `sensitive_change`. The block is strict: any other key fails the load. `destructive`, `package_change` and `sensitive_change` still load, but the loader prints `approval.tiers.<key> is ignored: a write to a protected path always asks.` and the gate does not read them. There is no tier for validation, shell commands, or network access; SPLITBRIEF does not sandbox those.

**Default tiers:** `read`, `write_in_scope` and `write_out_of_scope` are `auto`: a brief's files are suggestions, so an unplanned ordinary file is recorded as touched, not suggested, and does not ask. The protected classes — `destructive` (`.git`, `.splitbrief`), `sensitive_change` (CI configuration, env and key files) and `package_change` (manifests and lockfiles) — are `confirm`. A write to one of those protected paths asks whatever `enabled`, `--yolo` or `tiers` say, and a confirmation holds for the same path for the rest of the run; a `tiers` override applies to the other three classes only (see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md)).

YAML — strict:

```yaml
approval:
  enabled: true
  feedRejectionsToPlanner: true
  tiers:
    read: auto
    write_in_scope: sticky
    write_out_of_scope: confirm
```

**When to use:** new projects, production codebases, or onboarding where you want explicit visibility into out-of-scope, control-plane, or package-file writes.

---

## 10. `palette`

Custom slash-command actions for the in-TUI command palette.

### Schema

```ts
palette: {
  customActions?: Array<{
    id:           string; // non-empty
    label:        string; // non-empty
    description?: string;
    command:      string; // must start with "/"
  }>;
}
```

YAML:

```yaml
palette:
  customActions:
    - id: accept-run
      label: "Accept current run"
      description: "Mark the current run state as accepted"
      command: /run accept
    - id: quick-mode
      label: "Switch to quick mode"
      command: /mode quick
```

**When to use:** surfacing project-specific runbook actions inside SPLITBRIEF's TUI without leaving the session.

**See also:** [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

---

## 11. `sessions`

A top-level field (a sibling of `workflow`, not nested under it).

| Field | Type | Default | Description |
|---|---|---|---|
| `sessions.scope` | enum | `project` | `project` is the only accepted value. Workflow commands write session state under `<projectDir>/.splitbrief`. |

```yaml
sessions:
  scope: project
```

---

## 12. `customCommands`

Named `shell` and `agent` runners, declared once and reused by any seat. An entry is the execution tuple SPLITBRIEF spawns — one literal executable plus literal argv — kept out of the seat blocks so the planner, reviewer, and implementer can all point at the same audited command. Schema: `src/core/config/custom-commands.ts`.

### Schema

```ts
customCommands: {
  [id: string]: {          // id: lowercase letters, digits, hyphens; starts with a letter
    label:         string;
    contract:      'output' | 'direct';
    executable:    string;
    argv?:         string[];
    outputFormat?: 'stream-json' | 'jsonl' | 'text' | 'opencode';
    idleWarnMs?:   number;
    idleKillMs?:   number;
    env?:          string[];
  };
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `label` | string | — | Display name in the runner picker and trust prompts |
| `contract` | enum | — | `output` is the `shell` contract (prompt on stdin, result parsed from stdout); `direct` is the `agent` contract (the subprocess writes files itself and stdout is ignored) |
| `executable` | string | — | One literal executable path. Shell metacharacters, `$VAR`, backticks and newlines are rejected — this is spawned directly, never through a shell |
| `argv` | string[] | `[]` | Literal arguments. An interpreter command string (`sh -c …`) is rejected; the prompt travels on stdin and never appears here |
| `outputFormat` | enum | `text` | stdout parser for the `output` contract |
| `idleWarnMs` | number | `RUNNER_IDLE_WARN_MS` | Warn when the process has produced nothing for this long |
| `idleKillMs` | number | `RUNNER_IDLE_KILL_MS` | Kill the process after this much silence; must be at least `idleWarnMs` |
| `env` | string[] | `[]` | Uppercase environment variable names to forward. Credentials belong here, never in `executable` or `argv` — a credential-shaped literal fails the load |

Two entries that normalize to the same execution tuple are rejected, so one command has exactly one id.

```yaml
customCommands:
  local-agent:
    label: Local agent
    contract: direct
    executable: /usr/local/bin/my-agent
    argv: ['--repo', '.']
    idleWarnMs: 120000
    idleKillMs: 600000
    env: ['MY_AGENT_TOKEN']
```

**When to use:** a home-grown tool that should be selectable in the picker like a known CLI, or one command shared by more than one seat. A one-off runner can still be declared inline on the seat with `kind: shell` / `kind: agent`.

---

## 13. Environment variables

Source: `src/core/providers/catalog.ts`, `src/cli/setup.ts`, `src/engine/providers/registry.ts`, `src/engine/providers/client/metadata.ts`, `src/features/workflow/review-parser.ts`.

### Provider authentication

CLI method selection requires exact tool/platform/version invocation-enforcement evidence. The current matrix is empty: an explicit `session` or `api-key` selection is refused; omit `authChannel` and configure authentication through the host CLI. Provider and model routes do not select or prove a billing method.

| Variable | Provider | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `cli` `claude-code` | A credential the host CLI may use. Its own configuration determines the method; this does not prove API billing. |
| `OPENAI_API_KEY` | `cli` `codex` | A credential the host CLI may use; SPLITBRIEF offers no enforced method switch today. |
| `GH_TOKEN` / `GITHUB_TOKEN` | `cli` `copilot` | A credential the host CLI may use; SPLITBRIEF offers no enforced method switch today. |
| `CURSOR_API_KEY` | `cli` `cursor` | A credential the host CLI may use; SPLITBRIEF offers no enforced method switch today. |
| `OLLAMA_LOCAL_API_KEY` | local `ollama` daemon | Optional. Only use it through `apiKey: env:OLLAMA_LOCAL_API_KEY` when your loopback daemon requires authentication. |

The three admitted local providers have no default credential environment variable; they are loopback connections with optional explicit authentication. A custom provider has no inferable env var name either, so it must set `service`, `offering`, `apiBase`, and an inline `apiKey` in YAML — an `apiKey: env:VAR` reference is refused for a provider the catalog does not know. `cli` `command-code` has no credential environment variable — its published CLI documentation names none, so it authenticates only through its own `cmd login` session, which the sandbox bridges as files.

### Runtime overrides

| Variable | Purpose |
|---|---|
| `SPLITBRIEF_CONTEXT_LENGTH` | Override SPLITBRIEF's detected implementer context length (`src/engine/providers/capabilities.ts`). Applies only to the default implementer profile; profiles that declare no window otherwise route at the shared default. This sizes prompt budgets only; it does not change Ollama `num_ctx` or any provider-side model limit. |

### TUI / process

| Variable | Purpose |
|---|---|
| `CI` | If truthy, suppress fullscreen/alternate-screen rendering. Use `--json` or `--plain` when stdout must be machine-readable. |
| `SHELL` | Shell detection for spawn fallback (`src/lib/process/spawn/progress.ts`). |
| `TERM_PROGRAM` | Kitty keyboard-protocol detection for advanced key bindings. |
| `FORCE_HYPERLINK` | `1` (or any non-empty value other than `0`/`false`) forces OSC 8 hyperlink emission for markdown links; `0`/`false` forces plain styled labels; otherwise SPLITBRIEF sniffs `TERM_PROGRAM`/`VTE_VERSION`/`KITTY_WINDOW_ID`/`WT_SESSION`/`TERM` (Apple Terminal is excluded from auto-detection). The only configuration-surface change of the file-link feature — no YAML key (`src/lib/terminal/hyperlinks.ts`). |
| `SPLITBRIEF_REDUCE_MOTION` / `REDUCE_MOTION` | Set to `1` to pin TUI spinner frames and slow status ticks to 1s (`src/lib/terminal/reduce-motion.ts`). |
| `VISUAL` | Explicit external editor for spec/plan/brief review. Takes precedence over every other editor source, including detected GUI editors. |
| `EDITOR` | External editor fallback when `VISUAL` is unset or empty. Non-terminal values are used before auto-detected GUI editors; terminal editors such as `vim` or `nano` are used only after GUI detection and macOS `open -W -t` fail. Implicit GUI detection probes only safe absolute `PATH` segments and honors Windows `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. |

---

## 14. CLI flags

Declared in `src/cli/options.ts` for workflow commands (`start`, `resume`, `continue`) plus command-specific registrations. These flags **override** the matching config field for the current invocation only. [`CLI-REFERENCE.md`](./CLI-REFERENCE.md) is the canonical flag matrix.

| Flag | Purpose | Commands |
|---|---|---|
| `--approve <level>` | Document approval gates: `none` \| `spec` \| `plan` \| `all` \| `default` | start, resume, continue |
| `--mode <mode>` | `quick` \| `standard` \| `speckit` | start, spec, resume, continue |
| `--model <m>` | Alias for `--implementer-model` | start, resume, continue |
| `--provider <p>` | Alias for `--implementer` | start, resume, continue |
| `--planner <tool>` | Planner tool override | start, resume, continue |
| `--planner-model <m>` | Planner model override | start, resume, continue |
| `--planner-command <cmd>` | Custom planner command (kind=shell) | start, resume, continue |
| `--planner-api-base <url>` | Planner API base URL (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--planner-api-key-env <var>` | Planner API key env var, stored as `env:<var>` (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--planner-args <arg>` | Append a planner CLI/shell arg (repeatable; kind=cli/shell/agent); authority-bearing flags are refused before spawn | start, resume, continue |
| `--planner-output-format <format>` | Planner output format (`stream-json` \| `jsonl` \| `text` \| `opencode`); an admitted CLI keeps its own native parser and terminal protocol | start, resume, continue |
| `--planner-context-length <tokens>` | Planner context length in tokens (kind=api only; sizes the request `max_tokens`, ignored by other kinds) | start, resume, continue |
| `--planner-effort <level>` | Planner effort hint (`none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`). The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it. | start, resume, continue |
| `--implementer <p>` | Implementer provider override | start, resume, continue |
| `--implementer-model <m>` | Implementer model override | start, resume, continue |
| `--implementer-command <cmd>` | Custom implementer command (kind=shell) | start, resume, continue |
| `--implementer-api-base <url>` | Implementer API base URL (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--implementer-api-key-env <var>` | Implementer API key env var, stored as `env:<var>` (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--implementer-args <arg>` | Append an implementer CLI/shell arg (repeatable; kind=cli/shell/agent) | start, resume, continue |
| `--implementer-output-format <format>` | Implementer output format (`stream-json` \| `jsonl` \| `text` \| `opencode`) | start, resume, continue |
| `--implementer-context-length <tokens>` | Implementer context length (tokens) | start, resume, continue |
| `--reviewer <tool>` | Reviewer tool override | start, resume, continue |
| `--reviewer-model <m>` | Reviewer model override | start, resume, continue |
| `--reviewer-command <cmd>` | Custom reviewer command (kind=shell) | start, resume, continue |
| `--reviewer-api-base <url>` | Reviewer API base URL (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--reviewer-api-key-env <var>` | Reviewer API key env var, stored as `env:<var>` (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--reviewer-args <arg>` | Append a reviewer CLI/shell arg (repeatable; kind=cli/shell/agent); authority-bearing flags are refused before spawn | start, resume, continue |
| `--reviewer-output-format <format>` | Reviewer output format (`stream-json` \| `jsonl` \| `text` \| `opencode`) | start, resume, continue |
| `--reviewer-context-length <tokens>` | Reviewer context length in tokens (kind=api only; sizes the request `max_tokens`, ignored by other kinds) | start, resume, continue |
| `--reviewer-effort <level>` | Reviewer effort hint (`none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`). The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it. | start, resume, continue |
| `--project <dir>` | Project directory (default cwd) | most commands |
| `--no-fullscreen` | Disable alt-screen buffer | start, resume, continue |
| `--no-mouse` | Disable mouse tracking | start, resume, continue |
| `--hover` | Opt in to hover highlighting (requires mouse + fullscreen) | start, resume, continue |
| `--allow-hooks` | Trust hook config without prompting (CI) | start, resume, continue, spec |
| `--allow-repo-runners` | Trust repo-local shell/agent runner execution from project config, including profiles and project-local PATH/script resolution | start, resume, continue, spec |
| `--allow-unverified-auth` | Let a headless run proceed with unverified CLI authentication (no effect interactively) | start, resume, continue |
| `--json` | Headless: NDJSON `EngineEvent`s to stdout, no TUI | start, resume, continue |
| `--plain` | Headless: one plain line per phase, task, review and completion (`phase:`, `task T00N: done\|failed (<gates>)`, `review:`, `done:`), no TUI. Refuses to run alongside `--json` (exit `2`) | start, resume, continue |
| `--yolo` | Skip file-write tiered approval prompts for this session; protected paths still ask | start, resume, continue |
| `--skills <ids>` | Comma-separated skill ids to attach to every seat (unknown id → exit `2`); on resume and continue, for that continue only | start (headless), resume, continue |
| `--action <action>` | Apply an action to the pending recovery before continuing: `skip`, `retry`, or `switch-seat:<tool>[:<model>]` | continue |
| `--reconfigure` | Overwrite existing config | init |

---

## 15. Validation behavior

Config is validated on every load (`src/core/config/load/io.ts:loadConfig`).

- Errors → `ConfigError` (`src/core/config/errors.ts`) → top-level catch in `src/cli/setup.ts` → exit code 1.
- Non-fatal warnings on stderr (`warnStderr` in `src/lib/warn.ts`):
  - Config file permission warning on POSIX (`config-file-permissions`; see §1 **Permissions**).
  - A `shell` or `agent` runner passing `{prompt}` through argv instead of stdin (`securityWarnings`, `src/core/config/load/validation/warnings.ts`).

Unknown top-level keys are tolerated, apart from the five removed ones named in §16, which fail the load; unknown nested keys in strict blocks (`workflow` and its `git` / `speckit` blocks, `hooks`, `codebase`, `approval` and its `tiers` block, every runner config, `PlannerCapabilities`) fail validation. Each unrecognized key is reported at its own dotted path — `workflow.autoApproveSpec: Unknown config key …`, not just `workflow` — and every error found in one load is reported together, one line per path, so a config with several problems is not corrected one attempt at a time.

---

## 16. Config version

`version: 3` is the only accepted schema version. A config carrying any other version — or none at all — is rejected at load with `Unsupported config version: <value>. Supported: 3.` Run `splitbrief init --reconfigure` to write a current config; there is no in-memory upgrade path.

Fields that older shapes used are gone rather than aliased — `workflow.autoApproveSpec` / `workflow.autoApprovePlan` are replaced by `workflow.approve`, `workflow.commitStrategy` and `workflow.git.commitStrategy` by manual commits, and `workflow.mode: full` by `workflow.mode: speckit`. These old fields and values fail validation with the offending path named, except `workflow.git.commitStrategy: none`: it loads with a deprecation warning and is removed from the resolved config. Delete the retired field when updating your config.

### Removed identities

Runner identities that a `version: 3` config once accepted are rejected by name, each with its own load error. Migrate as follows.

| You had | Load error | Migration |
|---|---|---|
| `kind: agent-sdk` | `Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.` | `kind: api` against your own endpoint — set `provider`/`service` to your own name, plus `offering`, `apiBase`, and an inline `apiKey`. |
| `provider:` `anthropic`, `deepseek`, `groq`, `ollama-cloud`, `openai`, `openrouter`, `together` | `API provider "<id>" was removed; only "ollama", "lm-studio", "llama-cpp" are built in. Configure it as a custom endpoint: set provider/service to your own name plus apiBase and an inline apiKey (docs/CONFIGURATION.md).` | Same custom-endpoint shape as above — see [`kind: api`](#kind-api). The removed id is refused even though custom names are otherwise free, so pick a new one. |
| `tool: aider` | `CLI tool "aider" was removed; supported tools are <the tools that seat accepts>.` | No replacement — choose another `cli` tool, or drive Aider as a `shell` runner. |

### Removed config keys

Twenty-one shapes that a `version: 3` config once carried are gone: eighteen removed keys, plus three
removed **values** of keys that still exist (`workflow.briefReview: rich`, a hook entry's
`kind: module`, `sessions.scope: global`). There is no version bump and no migration pass — every
one of them fails the load. One load names them all: `validateConfig`
(`src/core/config/load/validation/config.ts`) collects every error and the thrown message carries one
`  <path>: <message>` line per offending path, so a config carrying several is told about all of them
in a single run rather than one per attempt. That holds for a removed **top-level** key as well: the
root object is not strict (§15), so an unrelated stale root key is still tolerated, but the five
removed root keys are named explicitly (`REMOVED_TOP_LEVEL_KEYS`), so a stale `otel:` block has to be
deleted rather than left to rot. Every replacement below is the whole migration; nothing reads the old
key.

| You had | On load | Replacement |
|---|---|---|
| `workflow.persistTranscript` | rejected — `workflow.persistTranscript: Unknown config key …` | None. The transcript and `session.jsonl` are always written; persistence is no longer a policy. |
| `workflow.briefReview: rich` | rejected — `Invalid input: expected "simple"` | Omit the field; `simple` is accepted only for compatibility and ignored. |
| `hooks.builtin` | rejected — `hooks.builtin: Unknown config key …` | None. The built-in hook bundle is gone; write the check as an ordinary `kind: command` hook (§8). |
| `hooks.pre_compact` | rejected — `hooks.pre_compact: Unknown config key …` | None. Transcript compaction is automatic and fires no hook; `HOOK_EVENTS` is the eleven events in §8. |
| hook entry `kind: module` | rejected — `Invalid input: expected "command"` | `kind: command` — an executable and argv, the only hook kind. |
| `approval.headless` | rejected — `approval.headless: Unknown config key …` | None, and this is a **behaviour change**: a run with no reply channel (`--json`, `--plain`) already fails closed on its own, and a run that has one is now always prompted. See §9. |
| `approval.tiers.network` | rejected — `approval.tiers.network: Unknown config key …` | None. There is no network tier and never was a network sandbox; the five tiers in §9 are all of them. |
| `approval.tiers.validation` | rejected — `approval.tiers.validation: Unknown config key …` | None. Validation is gated by `validation.*` (§4), not by an approval tier. |
| `codebase.cacheDir` | rejected — `codebase.cacheDir: Unknown config key …` | None. The repo-map cache is always `.splitbrief/`. |
| `sessions.scope: global` | rejected — `Invalid input: expected "project"` | `scope: project` — sessions live under the project's `.splitbrief/`. |
| `trust` (the whole block, `trust.customRenderers`) | rejected — `trust: Unknown config key …` | None. Custom renderers are gone; nothing reads the flag. |
| `otel` (the whole block) | rejected — `otel: Unknown config key …` | None. The OpenTelemetry sink, its packages and `--otel-exporter` are gone; use the JSON event stream (`--json`) or a `post_task` hook. |
| `snapshots` (the whole block, including `snapshots.auto.*`) | rejected — `snapshots: Unknown config key …` | None. Snapshots are still taken as the baseline for change detection and for `/run reject`; the trigger points are fixed, not configurable, and there is no `splitbrief snapshot` command. A run captures its baseline before the first task and records one run snapshot at the end for `/run reject` to roll back to (see [`SLASH-COMMANDS-REFERENCE.md`](./SLASH-COMMANDS-REFERENCE.md)). |
| `plannerEstimateReview` | rejected — `plannerEstimateReview: Unknown config key …` | None. The estimate-review gate is gone; the brief-approval gate (§5 `approve`) is the remaining stop before implementation. |
| `autoSplitOverflow` | rejected — `autoSplitOverflow: Unknown config key …` | None. An overflowing task is reported rather than split automatically; re-plan or narrow the feature description. |
| `workflow.maxBudget` (`max_budget`) | rejected — `workflow.maxBudget: Unknown config key …` | None. Budget gates are gone; a run reports what it spent and stops when you stop it. |
| `workflow.budgetPauseThreshold` (`budget_pause_threshold`) | rejected — `workflow.budgetPauseThreshold: Unknown config key …` | None. There is no budget pause to threshold. |
| `workflow.costGate` (`cost_gate`) | rejected — `workflow.costGate: Unknown config key …` | None. The cost-approval gate is gone; the brief-approval gate (§5 `approve`) is the remaining stop before implementation. |
| `implementerProfiles.profiles.*.costTier` (`cost_tier`) | rejected — `cost_tier: Unknown config key …` | None. Routing is by capability — context window, then name — never by price. |
| `implementerProfiles.profiles.*.pricePer1M` (`price_per1_m`) | rejected — `price_per1_m: Unknown config key …` | None. Profiles carry no price. |
| `implementer.model: auto:cheapest` | rejected — `Unknown model …` from the runner, since the marker is no longer parsed | Name a concrete model, or `auto` to delegate to the tool's own default. |

---

## 17. Full production example

A representative config: Claude Code subscription as planner, a small local LM Studio model as implementer, mid-tier escalation to a larger local Ollama model, hooks, and tiered approval. Use it as a starting point, then adjust credentials, hooks, and approval tiers for your environment.

<!-- config-example: full-production -->
```yaml
version: 3

# ---------- Planner: host-configured Claude Code ----------
planner:
  kind: cli
  tool: claude-code
  model: opus
  contextLength: 1000000
  effort: high
  timeout: 600000

# ---------- Implementer: small local model through LM Studio ----------
# contextLength is the input window, not the output cap; max_tokens is clamped to
# the model's max-output limit independently.
implementer:
  kind: api
  provider: lm-studio
  service: lm-studio
  offering: local
  apiBase: http://localhost:1234/v1
  model: qwen2.5-coder-7b
  contextLength: 32768
  temperature: 0.3
  timeout: 240000

# ---------- Validation: full gauntlet after every task ----------
validation:
  typecheck: true
  lint: true
  test: true
  testCommand: npm test -- --run --reporter=dot

# ---------- Workflow: speckit, all gates, manual commits ----------
workflow:
  mode: speckit
  approve: all
  maxRetries: 2
  driftChainThreshold: 0.6
  git:
    createBranch: false
  isolation: worktree
  speckit:
    minCoverage: 0.8

# ---------- Mid-tier escalation to a larger local model (cheap stop before Opus) ----------
escalation:
  enabled: true
  intermediateProvider: ollama
  intermediateModel: qwen3-coder:30b

# ---------- Repo-map: 6k tokens, src + lib only ----------
codebase:
  enabled: true
  tokenBudget: 6000
  include:
    - "src/**/*.ts"
    - "src/**/*.tsx"
    - "lib/**/*.ts"
  exclude:
    - "\\.test\\.tsx?$"
    - "/__fixtures__/"
    - "^dist/"

# ---------- Hooks: format, secret-scan, notify ----------
hooks:
  pre_task:
    - command: ./scripts/snapshot-external-state.sh
      timeout_ms: 15000
      on_failure: warn
  post_task:
    - name: notify
      command: ./scripts/slack-ping.sh
      args: ["task complete"]
      on_failure: ignore
  on_error:
    - command: ./scripts/page-oncall.sh
      on_failure: warn
  on_complete:
    - command: ./scripts/upload-artifacts.sh
      timeout_ms: 60000
      on_failure: warn

# ---------- Tiered approval: prompt on out-of-scope/control-plane writes ----------
approval:
  enabled: true
  feedRejectionsToPlanner: true
  tiers:
    read: auto
    write_in_scope: sticky
    write_out_of_scope: confirm

# ---------- Custom palette actions ----------
palette:
  customActions:
    - id: quick-mode
      label: "Switch to quick mode"
      command: /mode quick
    - id: accept-run
      label: "Accept current run"
      command: /run accept

# ---------- Sessions ----------
sessions:
  scope: project
```

What this run needs locally (never commit credential values):
- A running LM Studio daemon on `localhost:1234` (implementer) and a running Ollama daemon on `localhost:11434` (escalation) — neither takes a credential
- CLI credentials according to the host tool’s configuration; explicit unproven method selection is refused

Then:

```bash
splitbrief start --allow-hooks "your feature description"
```

---

## 18. Admitted API providers

Canonical reference for every first-class `kind: api` provider in SPLITBRIEF. Source descriptors: `src/core/providers/api-provider-catalog.ts`. Credential handling: [API-KEYS.md](./API-KEYS.md).

### Service, offering, and billing

API runners store **service** identity separately from **offering** semantics:

| Field | Meaning |
|---|---|
| `service` | Stable provider identity (for example `ollama`, `lm-studio`, or your own custom-endpoint name). |
| `offering` | Commercial posture: `payg`, `free-quota`, `coding-subscription`, or `local`. |
| `billing` | How SPLITBRIEF reports spend: `api-metered`, `provider-dependent`, `subscription-included`, `local`, or `unknown`. |

Credential prefix or env presence validates the configured offering but **never chooses or changes** the offering. PAYG metered runs use dated pricing metadata when available; subscription-included runs never show a fictitious PAYG charge; local runs are labeled local/unpriced; opportunistic free pools on a custom endpoint are not presented as reproducible defaults.

### Provider matrix

`asOf` for every row: **2026-07-31** (release-time research; runtime does not fetch terms or pricing pages).

<!-- api-provider-matrix -->
| Provider | Service | Offering | Normalized endpoint | Credential env | Prefix validation | Roles | Billing |
|---|---|---|---|---|---|---|---|
| ollama | ollama | local | `http://localhost:11434/v1` | — | — | planner, implementer | local |
| lm-studio | lm-studio | local | `http://localhost:1234/v1` | — | — | planner, implementer | local |
| llama-cpp | llama-cpp | local | `http://localhost:8080/v1` | — | — | planner, implementer | local |

**Roles:** every admitted provider is available to PLAN, BUILD and REVIEW (the reviewer is a planner-tier seat), each seat keeping its own `apiBase` and exact model. `llama-cpp` is a **beta** connection profile on the shared OpenAI-compatible transport: it reads the catalog your `llama-server` already serves and ships no bundled model row, so its `model` is always explicit.

Local `ollama` talks only to a loopback daemon and normally omits `apiKey`; if that daemon requires authentication, the only accepted reference is `apiKey: env:OLLAMA_LOCAL_API_KEY`. `OLLAMA_API_KEY` is never resolved or sent to local Ollama.

**Deferred / not admitted:** researched subscription coding plans, retired consumer CLI entitlements, generic self-hosted OpenAI-compatible shims, and every other candidate without a PASS verdict have **no** first-class provider ID, descriptor, or support row here. Verdict-pending offerings remain absent until a credentialed production gate passes. Per-offering verdicts and dates: [Excluded API offerings](#excluded-api-offerings). Excluded CLI candidates: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#excluded-researched-candidates).

### Bundled model catalog (T-081 runtime state)

`KNOWN_MODELS` (`src/core/providers/known-models.ts`) is the offline picker fallback. Live native CLI rows — or, for an `api` provider, models.dev rows — hide `bundled-suggestion` placements in the picker (`buildRightRows`); `resolveModelCatalog` still emits them. For `api` runners pricing and context stay on models.dev first, as in [Pricing metadata](#pricing-metadata); a CLI tool's context comes from its own listing or this table.

Recommendation labels mirror `src/core/providers/known-models.ts`. A row becomes **`recommended`** only after T-080 records five-scenario evaluation metrics for it. No credentialed evaluation run exists, so every bundled row is **`compatible-only`** — selectable, with no SPLITBRIEF quality claim.

<!-- api-model-catalog -->
| Provider | Model | Recommendation | Notes |
|---|---|---|---|
| ollama | qwen3-coder:30b | compatible-only | Local default; context limit discovered from the daemon — not hard-coded. T-080: OMIT-NOT-APPLICABLE. |
| lm-studio | qwen2.5-coder-7b | compatible-only | Local default; context limit discovered from the daemon. T-080: OMIT-NOT-APPLICABLE. |

### Independent local seats

Start each server externally. No provider executable needs to be installed on the SPLITBRIEF host. Use the configured loopback address, choose the exact model ID returned by that server, and use Retry to check again after fixing the connection. SPLITBRIEF does not start, download, load, unload or silently replace a model. A listed model and an observed loaded model are separate facts; unknown load or context state remains unknown.

This example uses three independent servers and model IDs. Replace each model with an exact ID that its own server reports. The reviewer is optional; omitting it uses the planner's runner.

<!-- config-api-three-seats: local -->
```yaml
version: 3
planner:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b
implementer:
  kind: api
  provider: lm-studio
  service: lm-studio
  offering: local
  apiBase: http://localhost:1234/v1
  model: qwen2.5-coder-7b
reviewer:
  kind: api
  provider: llama-cpp
  service: llama-cpp
  offering: local
  apiBase: http://localhost:8080/v1
  model: Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf
```

### Minimal YAML per admitted provider

Every admitted provider is a loopback server that takes no credential by default: omit `apiKey` entirely. A `llama-server` started with an API key accepts an explicit `apiKey`, still only on its loopback endpoint. Local `ollama` accepts exactly one reference when its daemon requires authentication (`apiKey: env:OLLAMA_LOCAL_API_KEY`). Anything remote is a custom provider with an inline key — see [Generic remote OpenAI-compatible endpoint](#generic-remote-openai-compatible-endpoint) below.

<!-- config-api-minimal: ollama -->
```yaml
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b
```

<!-- config-api-minimal: lm-studio -->
```yaml
implementer:
  kind: api
  provider: lm-studio
  service: lm-studio
  offering: local
  apiBase: http://localhost:1234/v1
  model: qwen2.5-coder-7b
```

<!-- config-api-minimal: llama-cpp -->
```yaml
implementer:
  kind: api
  provider: llama-cpp
  service: llama-cpp
  offering: local
  apiBase: http://localhost:8080/v1
  model: Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf
```

The `model` is the exact id your server reports at `GET /v1/models` — the alias of a single-model server, or one entry of a router's list. There is no bundled default and `model: auto` is refused by name.

### Generic remote OpenAI-compatible endpoint

Use a custom `provider` string only when you control the endpoint. SPLITBRIEF cannot infer a safe env var name for unknown providers. **Normalized-origin trust** is required: the declared `apiBase` origin must be the only origin that receives the configured credential; redirects to another origin are rejected with `provider-endpoint-invalid` rather than followed (endpoint normalization in `src/core/providers/endpoint-policy.ts`, redirect transport in `src/lib/http/policy-fetch.ts`).

A custom provider must carry an **inline** `apiKey`. `apiKey: env:VAR_NAME` is refused for provider names the catalog does not know (`Custom/unknown provider … cannot use env apiKey reference`), so an unrecognized `apiBase` in a checked-in config can never reach one of your environment credentials. Substitute your own key locally and keep the file out of version control — `.splitbrief/` is gitignored by `splitbrief init`.

<!-- config-api-generic-remote: remote -->
```yaml
implementer:
  kind: api
  provider: custom-openai-compatible
  service: custom-openai-compatible
  offering: payg
  apiBase: https://llm.internal.example/v1
  apiKey: <paste-your-endpoint-key>
  model: hosted-model
```

Loopback-only local stacks (`ollama`, `lm-studio`) use the `loopback` endpoint policy; do not point them at arbitrary remote hosts without treating the run as a custom remote provider with explicit trust.

### Required API identity triple

Every `kind: api` block declares all three of `provider`, `service`, and `offering`. Nothing is inferred at load time:

- A provider-only block fails validation with `implementer.service` / `implementer.offering` named in the error.
- Known catalog IDs must match their `API_PROVIDER_CATALOG` service and offering; a mismatch is a validation error, not a silent rewrite.
- Custom providers declare their own `service` and `offering` alongside an explicit `apiBase`.

Writing the triple explicitly keeps save/load, run metadata, and billing presentation aligned.

### Named implementer profiles

`implementerProfiles` (§3) reuses the same runner schema as top-level `implementer`, including `service`/`offering` on API profiles. Profile names are stable identifiers (`local-qwen`, `cheap-cloud`, …). Task routing picks one capable profile per Task Brief; recovery can target a named profile via `route-bigger-worker`.

### Excluded API offerings

These researched offerings have **dated blocked verdicts** — no first-class provider ID, descriptor, endpoint policy, or picker row. `GENERIC-ONLY` means the endpoint is reachable through the generic remote or loopback configuration above and carries no SPLITBRIEF support claim.

<!-- api-excluded-offerings -->
| offering | verdict | as-of | reason |
|---|---|---|---|
| `minimax-token-plan` | DEFER | 2026-07-31 | The `sk-cp-…` plan key is documented for "any OpenAI-compatible tool", but the plan is also limited to individual interactive development with dynamic throttling. Gate on written or public confirmation that an orchestrated SPLITBRIEF run is permitted interactive use. PAYG `minimax` is unaffected. |
| `kimi-code` | DEFER | 2026-07-31 | Personal-interactive-only guidelines prohibit non-interactive automation and batch use; the supported-tool lists conflict and SPLITBRIEF is unlisted. Gate on explicit vendor support for custom orchestrators. Never spoof another client identity. PAYG `moonshot` is unaffected. |
| `zai-coding-plan` | REJECT | 2026-07-31 | GLM Coding Plan terms restrict quota to officially supported tools and prohibit SDK or custom-app direct calls without a separate written agreement. Falsifier: written Z.AI approval naming SPLITBRIEF. PAYG `zai` is unaffected. |
| `alibaba-coding-plan` | REJECT | 2026-07-31 | Plan terms expressly prohibit automated scripts, application backends, and non-interactive use, and the `sk-sp-…` key is scoped to that route. Falsifier: revised public terms or written approval for human-triggered headless runs. PAYG `dashscope` is unaffected. |
| `siliconflow` | DEFER | 2026-07-31 | `stream_options.include_usage` is undocumented, the extra `eos` finish reason needs mapping, model churn is high, 40K TPM can block a brief, and public terms restrict commercial and third-party use. Personal generic experimentation only. |
| `cloudflare` | GENERIC-ONLY | 2026-07-31 | The account-scoped base (`…/accounts/{account_id}/ai/v1`) needs dynamic-endpoint support, and free neurons are not comparable to tokens. No Cloudflare-specific transport. |
| `github-models` | REJECT | 2026-07-31 | Public preview positioned for experimentation, with a typical 8K input / 4K output account-tier cap far below the practical brief target. Falsifier: GA, materially larger limits, and exact stream compatibility. Experimental generic use only. |
| `huggingface` | GENERIC-ONLY | 2026-07-31 | The USD 0.10/month free credit is negligible and capability plus data policy vary by downstream provider. Reconsider only for a stable pinned coding route with meaningful quota. |
| `vllm` | GENERIC-ONLY | 2026-07-31 | Ports, auth, and models are operator-defined; a per-deployment provider ID adds nothing over the loopback or generic remote block. |
| `localai` | GENERIC-ONLY | 2026-07-31 | Same operator-defined surface as vLLM across a broader backend set; behavior depends on the selected backend, not on a SPLITBRIEF descriptor. |
| `local-openai` | GENERIC-ONLY | 2026-07-31 | A generic local OpenAI-server runner kind requires loopback/LAN trust design and is outside this feature. Configure such servers as a loopback API runner. |
| `sambanova` | DEFER | 2026-07-31 | Official free-tier and onboarding pages conflict, and the documented free rate is only 20 requests/day. Reconsider after the entitlement is consistent and the exact stream payload passes. |
| `nvidia-nim` | DEFER | 2026-07-31 | Hosted free use is explicitly prototyping and development only; production requires NVIDIA AI Enterprise licensing. Not a free production provider. |

---

## 19. See also

- [PRINCIPLES.md](./PRINCIPLES.md) — one-page rule index
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — planner/implementer pipeline and runner matrix
- [TESTING.md](./TESTING.md) — testing contract
- [ARCHITECTURE.md](./ARCHITECTURE.md) — runner contracts, orchestrator loop, event model
- [WORKFLOW.md](./WORKFLOW.md) — mode + approval semantics in depth
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, `HookEntry` schema, trust model
- [REPOMAP.md](./REPOMAP.md) — `codebase.*` semantics, PageRank, cache
- [API-KEYS.md](./API-KEYS.md) — secret handling and redaction
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — runtime overrides and palette commands
- [DEBUGGING.md](./DEBUGGING.md) — diagnosing config load failures
- [ERRORS.md](./ERRORS.md) — `ConfigError` shape and exit codes
- [WORKFLOW.md](./WORKFLOW.md) — workflow modes and approval semantics
