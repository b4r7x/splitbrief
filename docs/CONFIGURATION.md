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
- **Key style:** the loader transforms `snake_case` YAML into `camelCase` before validation (`src/core/config/load/transform.ts`), so both styles work. This document uses `camelCase`.
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
workflow:       { mode, approve, maxRetries, git, isolation, maxBudget, ... }
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
| `model` | string | — | Model identifier, or `auto`. Planner: optional. Implementer: required for `api`, `shell`, and `agent`; optional for `cli`, where omitting `model` and writing `model: auto` are equivalent — both delegate to the tool's own default. The implementer `cli` seat block also accepts `auto:cheapest` — a routing marker rather than a model id: it derives the implementer profile pool from priced discovered rows (§3). Config load rejects it on the `api`, `shell` and `agent` variants, which have no derivation to fall back on and would transmit the marker as a model id, and inside `implementerProfiles.profiles`, where a profile must name a concrete model. |
| `customModels` | string[] | — | Extra model IDs merged into the provider catalog so they appear in pickers. Pricing remains unknown unless models.dev, runtime provider metadata, or the bundled catalog supplies rates. |
| `contextLength` | int > 0 | detected, else `32768` | Override the detected context window. Useful for self-hosted Ollama/LM Studio whose `/api/show` reports the wrong number. When neither configured nor detected, SPLITBRIEF assumes the single documented default `DEFAULT_UNKNOWN_CONTEXT_LENGTH` (32768, `src/core/tokens/context-length.ts`) for routing and budget sizing alike. |
| `temperature` | 0..2 | provider default | Sampling temperature. Honored only by the `api` kind (planner, reviewer, and implementer); the `cli`, `shell`, and `agent` kinds cannot pass it to their backend and drop it with a stderr warning. Implementers usually want `0.2`-`0.4`; planners can run hotter. |
| `timeout` | ms (≤ 600000) | unset → no total-call cap (output silence is guarded separately: the 60s `api` stream-idle guard or `idleWarnMs`/`idleKillMs` below — see Troubleshooting) | Total wall-clock budget for a single planner, reviewer, or implementer call; aborts the call when exceeded. Raise for long planner thinks; lower for cheap probe calls. |
| `idleWarnMs` | ms (≤ 3600000) | `300000` | Inactivity watchdog warn threshold: after this much output silence on a running call, the byline shows a "still working" warning; any stdout/stderr output clears it and resets the timer. |
| `idleKillMs` | ms (≤ 3600000) | `1800000` | Inactivity watchdog kill threshold: at this much output silence the runner's process group is terminated (SIGTERM, then SIGKILL after a grace window) and the call is marked failed. For planner calls a retry prompt is offered; a failed implementer call feeds the task's retry/escalation ladder instead, whose retry prompts rebuild the full Task Brief per attempt. |
| `effort` | `none\|minimal\|low\|medium\|high\|xhigh\|max` | unset | Reasoning-effort hint. The union above is what config accepts; the levels a seat may actually use are the selected model's own ladder, not a fixed list per tool — the seat's tool accepts a subset and reports what it rejects. How a seat's effort intent reaches its tool is the seat's channel — `CliEffortChannel` (`src/core/runners/effort-channel.ts`), resolved by `seatEffortChannel` (`src/core/runners/capabilities.ts`) — and only one of the four channels carries this field. `cli` `claude-code`, `codex`, `copilot` and `command-code` are channel `effort-flag`: they deliver this `EffortLevel` verbatim on the tool's own effort argument, on the planner, reviewer, and implementer seats — `claude-code`, `copilot` and `command-code` emit `--effort <level>`, `codex` emits `-c model_reasoning_effort=<level>`. `cli` `opencode` and `kilo-code` are channel `variant`: they have a real effort channel, but it is a named preset delivered through the separate `variant` field on `--variant`, not through `effort`. `cli` `cursor` is channel `model-id`: effort is encoded in the selected model id's suffix, so there is no separate field to set — choose it in the model picker. Only the `api`, `shell`, and `agent` kinds are channel `none`. `seatSupportsEffort` is now `seatEffortChannel(...) !== 'none'`; a caller that means "takes the `effort` field" tests for `effort-flag`. An undeliverable value is not sent: changing a seat in the TUI clears it and says so (`Effort <level> cleared: <tool> has no effort channel`) on every seat whose channel is not `effort-flag`, and a headless run drops it, with a `planner-effort`/`reviewer-effort: dropped` stderr warning on the planner and review seats, silently on the implementer seat. The same clearing and dropping applies to `variant` on a seat whose channel is not `variant`. |
| `variant` | string | unset | The named execution preset of the `variant` channel — today `cli` `opencode` and `kilo-code`, delivered on `opencode run --variant <name>` and `kilo run --variant <name>`. Free-form and persisted verbatim, because an opencode user can declare custom variants in `opencode.json` that no static enum could know. The presets are per model, not per provider: the picker offers the ladder the model itself publishes (`opencode models --verbose` or `kilo models --verbose` for a detected route), so `openai/gpt-5.6-luna` offers `none\|low\|medium\|high\|xhigh\|max` and a model that publishes none offers no presets, though a hand-written value is still sent. `--variant` is a protected flag: configuring it through `args` is refused before spawn. |

`idleWarnMs` and `idleKillMs` apply to the `cli`, `shell`, and `agent` kinds only — `api` runners keep the 60s stream-idle guard, and their strict schema rejects both fields.

### Pricing metadata

Pricing is resolved from cached `models.dev` metadata first when available, then from runtime provider metadata or the bundled catalog. `models.dev` context pricing tiers are preserved: flat base rates apply below the tier threshold, and the highest matching context tier applies when prompt/cache context reaches that threshold. Local-only unpriced runners are displayed as local/unpriced rather than dollar-priced. Picker lane order is separate from this ladder — a CLI tool renders its own listing with the bundled `KNOWN_MODELS` aliases as the offline fallback, and an `api` runner adds models.dev rows beside its runtime list — and does not reorder pricing or context lookup; see [Model catalog lanes](./PLANNERS-AND-IMPLEMENTERS.md#model-catalog-lanes).

If an API-billed or otherwise paid runner has unknown model pricing and `workflow.maxBudget` is set, runtime budget tracking pauses instead of treating that usage as `$0`. Continue only after acknowledging unknown spend or configuring pricing.

### Compiler capability

Every planner mode crosses one capability boundary. The Task Brief compiler admits a backend only on an exact tuple: runtime identity, effective role vector, declared transport, terminal contract, containment profile, credential channel, envelope version, and a verified conformance proof (`admitCompilerCapability`, `src/engine/runners/compiler-capability.ts`). Standard and speckit run the compiler's detached fresh batches; quick stays single-call but accepts only a current-call result. A missing or unverified property returns the typed zero-dispatch refusal `task_compiler_capability_unsupported`, and no combination is downgraded to a weaker mode.

Planner mode does not grant artifact authority, and no CLI flag proves read-only behavior. The production-factory conformance harness (`src/engine/runners/cli-tools/contract-harness.ts`) is what *can* prove the effective role, containment, and final-response contract, but its verdicts do not reach admission on their own: they are recorded by hand into `COMPILER_SUPPORT_TABLE`, and nothing reads a harness record when a claim is admitted. A run's claim carries that row's recorded vector plus two live host observations — the detected runtime version and containment-launcher availability.

The V1 planner rows:

| Planner backend | Tested runtime | V1 state | Transport | Credential channel |
|---|---|---|---|---|
| `kind: cli` tool `opencode` | 1.18.15 | required-baseline | current final response | session-copy |
| `kind: cli` tool `claude-code` | 2.1.232 | conformance-gated | current final response | api-key, session-copy |
| `kind: cli` tool `codex` | 0.147.0 | conformance-gated | exact declared-file lease | api-key, session-copy |
| `kind: cli` tool `kilo-code` | 7.0.49 | conformance-gated | current final response | session-copy |
| `kind: cli` tool `cursor` | — | unsupported | — | — |
| `kind: cli` tool `command-code` | — | unsupported | — | — |
| `kind: cli` tool `copilot` | — | unsupported | — | — |
| `kind: api` | (versionless) | conformance-gated | current final response | api-key |
| configured custom command | (versionless) | conformance-gated | staged stdout or exact declared-file lease | api-key |
| `kind: shell` / `kind: agent` planner | — | unsupported | — | — |

For supported backends, the tested version yields a full capability receipt, while other detected versions are admitted with runtime-drift evidence and a run warning. Versionless rows admit only an empty version claim, and the verified conformance proof carries the identity evidence. Conformance-gated rows stay inactive until their complete row passes; unsupported rows (Copilot, Cursor, Command Code, shell, agent) refuse with typed fail-closed zero dispatches regardless of what a candidate claims. Runtime guards (envelopes, terminal contract, dispatch ledger, post-run mutation detection) are the enforcement surface. Authority-bearing options are adapter-owned and cannot be overridden.

The two credential channels are `api-key` (the provider env var) and `session-copy` (exactly the tool's allowlisted credential files bridged into the disposable HOME/XDG roots — except for a keychain-backed channel, the Claude Code and Cursor Agent CLI `session` channels on macOS, whose child keeps the host `HOME` and `USER` because the login keychain resolves through them, on compiler calls as much as on any other planner call). See [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) for the full support table, terminal contracts, and role vectors.

### `kind: cli`

Subprocess of a known coding-agent CLI. The wrapper handles auth, model selection, and output parsing.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `tool` | enum | yes | `claude-code` \| `codex` \| `opencode` \| `copilot` \| `kilo-code` \| `cursor` \| `command-code` |
| `model` | string | no | A model ID, or `auto`. Omitting `model` and writing `model: auto` are equivalent: SPLITBRIEF passes no `--model` flag, so the tool uses whatever model its own configuration selects. |
| `args` | string[] | no | Extra argv appended to the tool invocation. Every token is validated against the adapter-owned authority set: a flag that would override role, permissions, sandbox, cwd or added roots, config sources, tools, hooks/plugins/MCP, session selection, prompt transport, output format, terminal protocol, final-output path, updates, or approval behavior is refused before spawn. |
| `outputFormat` | enum | no | `stream-json` \| `jsonl` \| `text` \| `opencode`. Selects the parser for the configured-command and legacy command paths. An admitted CLI's parser and terminal protocol are adapter-owned: the compiler path keeps the backend's native parser, and an implementer `outputFormat` that would replace a structured terminal contract refuses before spawn. |

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

**When to use:** you already pay for a Claude Code / Codex / OpenCode license and want SPLITBRIEF to drive it as a planner without separate API billing. Copilot, Cursor, and Command Code stay implementer-side in V1: their planner rows are compiler-unsupported and refuse with a typed zero-dispatch error (see [Compiler capability](#compiler-capability)).

### `kind: api`

OpenAI-compatible HTTP endpoint.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `provider` | non-empty string | yes | `ollama` \| `lm-studio` \| any custom name |
| `service` | non-empty string | yes | Billing/identity service behind the provider. Never inferred — write it out. For an admitted provider ID it must equal that ID's `API_PROVIDER_CATALOG` service (see the provider matrix in §18); a mismatch is a validation error. |
| `offering` | enum | yes | `payg` \| `free-quota` \| `coding-subscription` \| `local`. Never inferred — write it out. For an admitted provider ID it must equal that ID's catalog offering. |
| `apiBase` | non-empty string | yes | Base URL. For known providers, see "Default API base URLs" below. |
| `apiKey` | string | no | Omit it for the loopback providers, which take no credential — local `ollama` accepts exactly one reference, `apiKey: env:OLLAMA_LOCAL_API_KEY`, when its daemon requires authentication. A custom provider must carry an **inline** key: an `apiKey: env:VAR` reference is refused for a provider the catalog does not know (see [API-KEYS.md](./API-KEYS.md)). |

Both admitted provider IDs (`ollama`, `lm-studio`) are implementer-only local daemons, so an `api` planner or reviewer is always a custom endpoint: pick your own `provider`/`service` name, declare `offering` and `apiBase`, and carry an inline `apiKey` (§18).

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

**Compiler status:** a `shell` planner is compiler-unsupported in V1, because the legacy shell planner lacks compiler containment and final-response conformance. Every planner mode refuses it with `task_compiler_capability_unsupported` and zero dispatches. The implementer role is unaffected.

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

**Compiler status:** a `kind: agent` planner is compiler-unsupported in V1, because its ambient session-file behavior violates exact lease ownership. Every planner mode refuses it with `task_compiler_capability_unsupported` and zero dispatches. The implementer role is unaffected.

### Runner command trust

Every `shell` and `agent` runner named in `.splitbrief/config.yaml` — planner, reviewer, implementer, or implementer profile — needs an explicit grant on the machine that runs it, before the first planner call.

- **Interactive:** SPLITBRIEF prints the resolved executable path, the argv, the working directory, and the fact that the child inherits this process's environment, then asks you to type the confirmation phrase and a reason. Confirming writes an owner-only receipt to `~/.splitbrief/trust/custom-runners.json` (mode `0600`).
- **Headless** (`--json` or `--plain`): there is no prompt. The run is blocked unless a receipt already exists or you pass `--allow-repo-runners`, which grants that run only and persists nothing.

The receipt is keyed to the canonical path of *this* checkout and to a digest of the command tuple, so it never travels inside a clone, never applies to a second checkout of the same repository, and stops applying the moment the command, its argv, its declared environment references, or its watchdog thresholds change. Replacing the executable on disk invalidates it too: the receipt stores the executable's content digest.

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
| `api` | [`kind: api`](#kind-api) | `provider` must be admitted for the planner role. Both catalog IDs (`ollama`, `lm-studio`) are implementer-only, so this seat takes a custom provider. The identity triple `service` / `offering` / `apiBase` is required here too, plus an inline `apiKey`. |
| `shell` | [`kind: shell`](#kind-shell) | Needs the same [runner command trust](#runner-command-trust) grant as a `shell` planner. |
| `agent` | [`kind: agent`](#kind-agent) | Same trust grant. |

The reviewer is a planner-tier seat and shares the planner's admission set, so a provider or tool that the planner may not use is rejected in this block too. The seat is built on the planner backends (`createReviewer`, `src/engine/runners/factory.ts`), so effort follows the same channel matrix as on the planner: `cli` `claude-code`, `codex`, `copilot` and `command-code` take the `effort` field on the tool's own effort argument, `cli` `opencode` and `kilo-code` take a named preset in `variant` instead, `cli` `cursor` reads its effort out of the selected model id, and only the `api`, `shell` and `agent` kinds have no channel at all. An `effort` or `variant` the backend cannot deliver is cleared with a toast when the seat is changed in the TUI and dropped with a stderr warning headless; a `temperature` outside the `api` kind is likewise dropped with a stderr warning headless, but is carried forward untouched in the TUI. With no `reviewer` block the review seat inherits the planner's effort and shows it read-only; make the seat independent before changing it.

### Falling back to the planner

- **No `reviewer` block:** the planner runner performs the review. Review tokens are priced at the planner's rates and folded into the planner line in the summary and the cost drilldown.
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

The implementer is the weaker of the two models. What makes a runner the implementer is the model behind it, not the transport SPLITBRIEF uses to reach it: a coding-agent CLI pointed at a cheaper model and an OpenAI-compatible API endpoint are equally first-class here, and SPLITBRIEF favors neither. They differ mechanically in one place — a `cli` or `agent` implementer writes files itself (`writesFiles: direct`), while an `api` or `shell` implementer returns file contents that SPLITBRIEF writes (`writesFiles: extracted-code`). Where a direct writer works before its changes reach your checkout is set by `workflow.isolation` (§5).

Same discriminated union as `planner`, with two schema differences: `model` is required on the `api`, `shell`, and `agent` implementer variants, and the `shell`/`agent` variants do **not** accept the planner-only `capabilities` field. The `cli` variant leaves `model` optional — omit it or write `model: auto` to delegate to the tool's own configured default; the two spellings behave identically and neither is rewritten on save. On an `api` runner, `auto` resolves to that provider's catalog default model (for example `ollama` → `qwen3-coder:30b`), and a custom provider with no catalog default rejects `auto` — and model absence — at config load. A third spelling, `auto:cheapest`, is implementer-only and names no model: it marks the seat block for auto-routing, and profile derivation (see `implementerProfiles` below) replaces the pool with one profile per priced discovered row. It is valid only on a `cli` seat block — on an `api`, `shell` or `agent` seat, and inside `implementerProfiles.profiles`, config load rejects it, because those seats transmit the model id they are given and a profile must name a concrete model. Implementer write behavior (`extracted-code` vs `direct`) is not a choice: `capabilities.writesFiles` may be declared per profile under `implementerProfiles`, but it must match the runner kind's write mode, and config load rejects a mismatch.

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

YAML — a coding-agent CLI running a cheaper model than the planner:

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

`contextLength` is SPLITBRIEF's assumed input context window, used to size the prompt budget. When neither configured nor detected, every consumer — routing and the prompt and request budgets alike — resolves to the single documented default `DEFAULT_UNKNOWN_CONTEXT_LENGTH` (32768) in `src/core/tokens/context-length.ts`, so an omitted window never means "unlimited" to one consumer and a different number to another. A boot-probed window applies only to the default implementer profile; a sibling profile that declares no `contextLength` routes at the shared default. When no window is known, the model-resolution ladder in `src/engine/providers/model/context-window.ts` answers: for an `api` runner, the models.dev cache when hydrated, else the runtime snapshot, else the bundled catalog row for the pinned model; for a CLI tool, its own listing, else the bundled catalog row — and for a CLI tool under `model: auto`, which resolves to no model id, the smallest window the bundled catalog guarantees for that tool (automatic selection never adds a `--model` flag). It does **not** change a provider's real model context. For Ollama, configure the model/server `num_ctx` first; use `contextLength` or `SPLITBRIEF_CONTEXT_LENGTH` only to match or override SPLITBRIEF's detection. It is also **not** the per-response output cap — SPLITBRIEF clamps `max_tokens` to the model's max-output limit independently, so a large context window never produces an over-large output request.

**When to use:**
- *Coding-agent CLI on a cheaper model* — you already pay for a Claude Code / Codex / Copilot subscription and want the implementer step to run there on a smaller model than the planner uses.
- *Cheap local API* — Ollama or LM Studio for cost-free iteration on small tasks.
- *Mid-tier API* — a cheaper-than-frontier model behind your own custom endpoint.
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
      costTier: local
      capabilities:
        writesFiles: extracted-code
    cheap-cloud:
      kind: api
      provider: custom-endpoint
      service: custom-endpoint
      offering: payg
      apiBase: https://api.example.test/v1
      apiKey: <paste-your-endpoint-key>
      model: your-cheap-cloud-model
      contextLength: 131072
      label: Cheap cloud
      costTier: cheap
      capabilities:
        writesFiles: extracted-code
```

`implementerProfiles.profiles.*` uses the same runner schema as `implementer`, plus:

| Field | Type | Description |
|---|---|---|
| `label` | string | Optional display label for TUI/events. |
| `costTier` | `local\|cheap\|standard\|frontier\|unknown` | Optional routing hint. Defaults to `unknown` in accessors when omitted. |
| `capabilities.writesFiles` | `extracted-code\|direct` | Optional routing metadata. Defaults from runner kind: `api`/`shell` extract one file from stdout; `cli`/`agent` write directly. Explicit values must match the runner kind. |

If `implementerProfiles.default` is omitted, SPLITBRIEF resolves the default profile deterministically from the first profile name in sorted order. If `default` is set, it must name an existing profile.

Setting `model: auto:cheapest` on the implementer seat block swaps the pool above for derived profiles: one per discovered ready model row that lists both an input and an output price — the `cost` prices in the `opencode models --verbose` and `kilo models --verbose` catalogs. Rows without a price are excluded. Derived rows are ranked by the blended price `input + 4×output` per 1M, cheapest first, and the cheapest row becomes the pool's default; each row carries a concrete model under a stable `auto-<tool>-<model>` name, with the blended price on its label, so the routing described below selects among priced concrete profiles as usual.

The marker is a `cli` seat-block spelling only: on an `api`, `shell` or `agent` seat, and inside `implementerProfiles.profiles`, config load rejects `auto:cheapest`. When discovery finds no priced row — a cold or stale detection record included — no pool is derived, the configured profiles above are used unchanged (or, with no `implementerProfiles` block at all, the `implementer` seat block itself remains the only profile), and readiness carries a warning naming that the tool's own default model will run instead of the cheapest priced one. Derived rows are re-admitted like any other profile, and one that fails admission is dropped with a warning as long as another derived row is admitted; the preparation is blocked only when none survives.

Task-start rows show the concrete routing reason when a worker is selected, and the cost drilldown carries richer routing and context data for post-run inspection.

When recovery offers `route-bigger-worker`, the issue names a target profile from this pool. Selecting that action resets only the current task and reruns it once with the named profile instead of the cheapest-capable routing choice.

---

## 4. `validation`

What runs after every implementer task. The three master switches (`typecheck`, `lint`, `test`) are **required** in the schema; the loader fills them from `createDefaultConfig()` if absent. The command overrides are all optional and let you pin exact validation commands per project.

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
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `typecheck` | boolean | `true` | Master switch for the type-checking stage |
| `lint` | boolean | `true` | Master switch for the linting stage |
| `test` | boolean | `true` | Master switch for the test stage |
| `testCommand` | string | — | Argv-style override for the test command. When set, it runs **as-is** (the full suite) — shell operators and environment expansion are not interpreted, and no test-file argument is appended. When omitted, SPLITBRIEF resolves a command from discovered/heuristic project metadata, falling back to the built-in `npm test`; only that built-in fallback is scoped to the affected test (`npm test -- <test-file>`). |
| `typecheckCommand` | string | — | Optional override for the type-checking command (e.g. `cargo check`, `go vet ./...`, `mypy src/`) |
| `lintCommand` | string | — | Optional override for the linting command (e.g. `cargo clippy --no-deps`, `ruff check`) |
| `testPattern` | string | — | Optional glob for finding test files (e.g. `*_test.go`, `test_*.py`). Defaults to TypeScript patterns (`*.test.ts`, `*.test.tsx`) |
| `timeoutMs` | number | `600000` | Per-stage timeout in milliseconds (minimum `1000`) for each validation command, applying to the run-start baseline probe, the `doctor --probe-validation` diagnostic, and per-task validation. One red or slow stage can hold the loop for this long before the probe moves on. |

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

SPLITBRIEF resolves each validation stage through 4 layers, in priority order:

1. **Project config** — `typecheckCommand`, `lintCommand`, `testCommand` override everything.
2. **Planner-discovered** — during the research phase, the planner reads config files and reports the project's validation toolchain. This is persisted to `WorkflowState.discoveredValidation` and used if no project command override exists.
3. **Heuristic fallback** — if no config or discovery exists, SPLITBRIEF looks at marker files (`Cargo.toml`, `go.mod`, `pyproject.toml`, `package.json`) to infer the language and default commands.
4. **Built-in defaults / graceful skip** — typecheck falls back to `npx tsc --noEmit` only on TypeScript projects (a `tsconfig.json` exists or `typescript` is a dependency) and skips otherwise, tests fall back to `npm test`, and lint skips when unresolved. A stage with no resolved command is recorded as skipped, and a run where every enabled stage is skipped emits a warning.

Master switches (`typecheck`, `lint`, `test`) still gate each stage: setting `lint: false` skips lint regardless of whether a command is available.

**When to use the toggles:**
- Disable `test` for repos with no test suite.
- Disable `lint` if your linter is enforced only at PR time (CI) and you want faster local iteration.
- Leave `typecheck: true` for typed languages — it's the cheapest signal that the implementer wrote compilable code.

### Baseline-relative acceptance

A task's validation is judged against the run's baseline, not absolute repository health. Before the first task, SPLITBRIEF probes every enabled stage and records which are already red **and the exact command each probe ran**. When a task's validation then fails, a stage is exempt — and the task may still be accepted — only when all three hold: the stage was already red at baseline, the failing run used the same command the baseline probed, **and** its failure evidence names none of the task's changed files. The command binding matters most for `test`: with the built-in `npm test` fallback, each run is narrowed to the affected test file of the task at hand, so a baseline measured against the first task's test file never exempts a later task's failure in a different file. The exemption is per-stage and per-file: a stage that was green at baseline always blocks, and a new failure in a stage that was red at baseline still blocks when its evidence names a file the task touched. A skipped stage is never exempt and never blocks. The pipeline keeps running past a baseline-red stage instead of stopping, so the stages behind it still get a verdict, and an accepted task produces no retry prompt.

**See also:** [WORKFLOW.md](./WORKFLOW.md) (where validation sits in the loop), `src/engine/orchestrator/validation/run.ts`.

---

## 5. `workflow`

Mode, spec/plan document gates, retries, budget, git strategy, and brief-review style.

### Schema

```ts
workflow: {
  // Spec/plan document gates
  approve?:               'none' | 'spec' | 'plan' | 'all' | 'default';

  // Retries
  maxRetries:             number; // int >= 0 — REQUIRED

  // Git
  git?: {
    commitStrategy?:      'none' | 'checkpoint' | 'per-task';
    createBranch?:        boolean;
  };

  // Where a direct-writing implementer works before promotion
  isolation?:             'worktree' | 'staged-copy';

  // Mode + brief review
  mode?:                  'quick' | 'standard' | 'speckit';
  briefReview?:           'simple';
  taskReview?:            'none' | 'failed' | 'every';

  // Budget
  maxBudget?:             number > 0;
  budgetPauseThreshold?:  0..1;
  driftChainThreshold?:   0..1;
  costGate?:              boolean; // default true

  // Speckit-only
  speckit?:               { minCoverage?: 0..1 };

  // Transcript
  compactionThreshold?:   number;  // int >= 10
  compactionFormat:       'auto' | 'freeform' | 'structured'; // default auto
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | enum | `standard` | `quick` \| `standard` \| `speckit`. The retired `instant` still loads as `quick` with a deprecation warning; any other value fails validation. |
| `approve` | enum | `default` | Spec/plan document gates: `none` (skip spec/plan gates; briefs review still runs in standard/speckit), `spec` (gate spec only), `plan` (gate plan only), `all` (gate both), `default` (per-mode default). |
| `maxRetries` | int >= 0 | `3` | Per-task local retries before escalation kicks in |
| `git.commitStrategy` | enum | `none` | Optional product-level git behavior: `none` (no commits — user reviews everything), `checkpoint` (a session-scoped tagged stash per task — `splitbrief/<sessionId>/<taskId>` — no commits), `per-task` (one commit per task). Checkpoint safety does not require git commits. |
| `git.createBranch` | boolean | `false` | Auto-create `splitbrief/<slug>` branch at workflow start. |
| `isolation` | enum | `worktree` | Where an implementer that writes files itself does its work before changes are promoted into the project: `worktree` (one linked git worktree per run) or `staged-copy` (a temporary copy of the project per task). Unused when the implementer returns file contents (`writesFiles: extracted-code`) — SPLITBRIEF writes those files into the project itself. |
| `briefReview` | enum | `simple` | `simple` is the only accepted value. `Ctrl+E`, `e`, `edit`, `E`, and `edit-file` open the persisted `tasks.md` in the external editor. |
| `taskReview` | enum | `none` | Per-task review gate after implementation: `none` (never pause), `failed` (pause only when a task fails, hits recovery, or its validation fails), `every` (pause after every advancing task). **Requires an interactive TUI run** — any value other than `none` is rejected at startup in headless mode (`src/cli/headless.ts`), so leave it `none` for CI. |
| `maxBudget` | number > 0 | unset | USD ceiling. Workflow warns at 80%, pauses at `budgetPauseThreshold` (default `0.85`), stops at the hard cap, and pauses when paid usage has unknown pricing instead of treating it as `$0`. |
| `budgetPauseThreshold` | 0..1 | `0.85` | Fraction of `maxBudget` at which to pause. e.g. `0.8` pauses at 80%. |
| `driftChainThreshold` | 0..1 | `0.6` | Threshold used when omitted; higher = fewer drift-chain events. |
| `costGate` | boolean | `true` | Pause for cost approval before implementation when a deterministic prompt-input estimate is available. Set `false` to skip the gate. The gate is always skipped in `quick` mode and when no deterministic estimate exists. Output, retries, validation reruns, and escalation are tracked at runtime. |
| `speckit.minCoverage` | 0..1 | `0.9` | Speckit-mode spec/plan→task traceability threshold. The analyze phase emits a `warning` event when measured `specTaskCoverage` or `planTaskCoverage` falls below this value. Not a test-coverage gate. |
| `compactionThreshold` | int >= 10 | unset | On resume, auto-compact persisted transcript context when compacted message count exceeds this threshold and the planner supports self-summarisation. |
| `compactionFormat` | enum | `auto` | Summary format for transcript compaction: `auto` selects structured JSON for `api` planners, freeform text for `cli`, `shell`, and `agent`; `freeform` preserves legacy markdown/text summaries; `structured` requires Zod-validated JSON and falls back to freeform text if validation fails. |

### Per-mode defaults

| Mode | Planner calls | Default `approve` | Default `briefReview` | Best for |
|---|:---:|:---:|:---:|---|
| `quick` | 1 | `none` | `simple` | Trivial edits and small tasks that still want a brief |
| `standard` (default) | 4 | `spec` | `simple` | Ordinary feature work |
| `speckit` | 6–7 | `all` | `simple` | Large, risky, externally visible |

`approve: default` resolves to the table above via `resolveApproveLevel()` (`src/core/config/runtime/resolve.ts`).

**Deprecated: `workflow.mode: instant`.** The `instant` mode was merged into `quick`. The string still parses — `WorkflowModeSchema` (`src/core/schemas/enums.ts`) preprocesses it to `quick` — so an existing config keeps loading unchanged, and `validateConfig` pushes a deprecation warning telling you to update the value. `--mode instant` behaves the same way and warns on stderr. Nothing writes `instant` any more; update the file to `quick` to silence the notice.

`briefReview` has no per-mode default — it falls back to `simple` in every mode unless set explicitly (`config.workflow.briefReview ?? 'simple'`). Use the external editor commands for text edits.

### Implementer isolation

An implementer whose runner writes files itself (`writesFiles: direct` — the `cli` and `agent` kinds) does not edit your checkout while it works. It works in an isolated directory, and SPLITBRIEF promotes the result into the real project directory through the hash-guarded promotion path, which refuses to overwrite a file you changed in the meantime. Isolation moves *where* the writing happens; it never changes *whether* the change reaches you.

| Value | What it does | Cost |
|---|---|---|
| `worktree` (default) | One linked git worktree created for the run. The implementer gets the repository's git history, its own branch, and the project's installed Node dependencies linked in (only Node — virtualenvs, Go module caches, and Rust target directories are not linked), so it can run typecheck, lint, and tests where it is working. | One `git worktree add` per run. |
| `staged-copy` | A temporary copy of the project per task under the system temp directory. Which files are copied comes from git's own list of tracked and untracked files (`.gitignore`, `.git/info/exclude`, and global excludes), so gitignored build and report artifacts never enter the copy; `.git`, `node_modules`, `.splitbrief/`, `.trees/`, and credential files are excluded on top of that. A fixture the repository gitignores is not present in the copy at execution time, so a runner that reads such a fixture while working in the copy will no longer find it. No git history and no installed dependencies, so the implementer cannot run the project's own checks. | A full project copy per task. |

**Worktree isolation is a file boundary, not a security boundary.** The worktree shares your git repository, your hooks, and your configuration, and it runs on the same machine, as the same user, against the same ports, databases, and network. It keeps the implementer from writing into your checkout mid-run; it does not constrain what the implementer's tool can execute. Neither strategy applies a shell or network sandbox. The workspace environment's PATH is widened to the linked `node_modules/.bin`, resolved to its real path inside the project — the widening is visible in the child's environment, not hidden behind the symlink.

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
  maxRetries: 3
```

Speckit with budget and manual commits:

```yaml
workflow:
  mode: speckit
  approve: all
  maxRetries: 3
  briefReview: simple
  maxBudget: 5.00
  budgetPauseThreshold: 0.8
  driftChainThreshold: 0.6
  git:
    commitStrategy: none
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
  git: { commitStrategy: none }
```

**When to use what:**
- `git.createBranch: true` — when running SPLITBRIEF in CI or against `main` and you don't want the changes landing on the current branch.
- `git.commitStrategy: none` — the default and recommended setting for manual review; SPLITBRIEF leaves changes unstaged so you can review and commit them yourself.
- `isolation: worktree` — the default, and the only strategy where the implementer can run the project's own typecheck, lint, and tests before handing work back. Choose `staged-copy` only when a linked git worktree is not workable for your setup.
- `maxBudget` — always set this for API-billed runs. It's your stop-loss.
- `budgetPauseThreshold` — set for unattended runs so you can intervene before the hard ceiling. Unknown paid pricing pauses regardless of the threshold because the runtime cannot prove spend against the cap.
- `briefReview: simple` — the only accepted brief review mode. Use `Ctrl+E`, `e`, `edit`, `E`, or `edit-file` to edit the persisted Task Brief in the external editor.

**See also:** [WORKFLOW.md](./WORKFLOW.md), [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) (`/mode` runtime override). Workflow approval level is set with `--approve` or `workflow.approve`.

---

## 6. `escalation`

When a task fails locally past `maxRetries`, SPLITBRIEF escalates through a tier ladder: **tier 0** retries with the "intermediate" mid-tier model configured here, then **tier 1** has the planner write a hint, then **tier 2** hands the task to the planner ("full escalation"). The intermediate tier runs only when `intermediateProvider` is set.

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
| `enabled` | boolean | on when `intermediateProvider` is set | Toggle for the intermediate tier. The tier is active by default once `intermediateProvider` is configured; set `enabled: false` to disable it (failed tasks then escalate straight to the planner) without removing the provider config. |
| `intermediateProvider` | string | — | Provider id for the mid-tier model (any `ProviderId`). When unset, the intermediate tier never runs. |
| `intermediateModel` | string | — | Model id at that provider. Falls back to the implementer's model when unset. |

YAML:

```yaml
escalation:
  intermediateProvider: ollama
  intermediateModel: qwen3-coder:30b
```

**Editing from the TUI.** The intermediate tier is configured in YAML only. The Crew section of Settings exposes planner, implementer, and reviewer seats; it has no escalation row or picker. Set `enabled: false` in YAML to disable the tier while retaining its provider and model configuration.

**When to use:** you run a cheap implementer (a small local model, or a cheap model behind your own endpoint) and want a "10x cheaper than the planner but smarter than the implementer" stop along the way before paying for an Opus retry. Skip if your implementer is already frontier-class. Setting `intermediateProvider` is enough to turn the tier on; add `enabled: false` only when you want to keep the provider config but bypass the tier.

**Budget knownness.** Escalation and recovery provider calls follow the same knownness rules as every other paid call. Unknown provider cost is not zero. Without `workflow.maxBudget`, a bounded operation with missing pricing is admitted as a provider-dependent reservation: USD stays absent or unknown, never `0`, until the price resolves. With `maxBudget` configured, unknown price or spend refuses before dispatch with `brief_budget_unknown` instead of being guessed at. A pre-acceptance refusal consumes no allowance and makes no provider call.

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
  pre_commit?:      HookEntry[];
  post_commit?:     HookEntry[];
  pre_escalation?:  HookEntry[];
  on_error?:        HookEntry[];
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
    destructive?:         ApprovalTier;
    package_change?:      ApprovalTier;
  };
  feedRejectionsToPlanner:    boolean;        // default true
}

type ApprovalTier = 'auto' | 'sticky' | 'confirm';
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master toggle for file-write tiered approval |
| `tiers.<op>` | enum | per-op default | `auto` (no prompt), `sticky` (prompt once, remember), `confirm` (prompt every time) |
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

**Tier keys:** `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, `package_change` — the five classes the file-write classifier emits. The block is strict: any other key fails the load. There is no tier for validation, shell commands, or network access; SPLITBRIEF does not sandbox those.

YAML — strict:

```yaml
approval:
  enabled: true
  feedRejectionsToPlanner: true
  tiers:
    read: auto
    write_in_scope: sticky
    write_out_of_scope: confirm
    destructive: confirm
    package_change: confirm
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

| Variable | Provider | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `cli` `claude-code` | Feeds the tool's `api-key` auth channel; unset it to run on the tool's own session credentials. |
| `OPENAI_API_KEY` | `cli` `codex` | Feeds the tool's `api-key` auth channel. |
| `GH_TOKEN` / `GITHUB_TOKEN` | `cli` `copilot` | Feeds the tool's `api-key` auth channel. |
| `CURSOR_API_KEY` | `cli` `cursor` | Feeds the tool's `api-key` auth channel. |
| `OLLAMA_LOCAL_API_KEY` | local `ollama` daemon | Optional. Only use it through `apiKey: env:OLLAMA_LOCAL_API_KEY` when your loopback daemon requires authentication. |

Neither admitted `api` provider has a credential env var: both are loopback daemons. A custom provider has no inferable env var name either, so it must set `service`, `offering`, `apiBase`, and an inline `apiKey` in YAML — an `apiKey: env:VAR` reference is refused for a provider the catalog does not know. `cli` `command-code` has no credential environment variable — its published CLI documentation names none, so it authenticates only through its own `cmd login` session, which the sandbox bridges as files.

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
| `--approve <level>` | Spec/plan document gates: `none` \| `spec` \| `plan` \| `all` \| `default` | start, resume, continue |
| `--mode <mode>` | `quick` \| `standard` \| `speckit` | start, spec, resume, continue |
| `--budget <amount>` | Dollar ceiling | start, resume, continue |
| `--model <m>` | Alias for `--implementer-model` | start, resume, continue |
| `--provider <p>` | Alias for `--implementer` | start, resume, continue |
| `--planner <tool>` | Planner tool override | start, resume, continue |
| `--planner-model <m>` | Planner model override | start, resume, continue |
| `--planner-command <cmd>` | Custom planner command (kind=shell) | start, resume, continue |
| `--planner-api-base <url>` | Planner API base URL (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--planner-api-key-env <var>` | Planner API key env var, stored as `env:<var>` (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--planner-args <arg>` | Append a planner CLI/shell arg (repeatable; kind=cli/shell/agent); authority-bearing flags are refused before spawn | start, resume, continue |
| `--planner-output-format <format>` | Planner output format (`stream-json` \| `jsonl` \| `text` \| `opencode`); the compiler path keeps the backend's native parser and terminal protocol | start, resume, continue |
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
| `--yolo` | Skip file-write tiered approval prompts for this session | start, resume, continue |
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

Fields that older shapes used are gone rather than aliased — `workflow.autoApproveSpec` / `workflow.autoApprovePlan` are replaced by `workflow.approve`, top-level `workflow.commitStrategy` by `workflow.git.commitStrategy`, and `workflow.mode: full` by `workflow.mode: speckit`. Configs still carrying the old spellings fail validation with the offending path named.

### Removed identities

Runner identities that a `version: 3` config once accepted are rejected by name, each with its own load error. Migrate as follows.

| You had | Load error | Migration |
|---|---|---|
| `kind: agent-sdk` | `Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.` | `kind: api` against your own endpoint — set `provider`/`service` to your own name, plus `offering`, `apiBase`, and an inline `apiKey`. |
| `provider:` `anthropic`, `deepseek`, `groq`, `ollama-cloud`, `openai`, `openrouter`, `together` | `API provider "<id>" was removed; only "ollama" and "lm-studio" are built in. Configure it as a custom endpoint: set provider/service to your own name plus apiBase and an inline apiKey (docs/CONFIGURATION.md).` | Same custom-endpoint shape as above — see [`kind: api`](#kind-api). The removed id is refused even though custom names are otherwise free, so pick a new one. |
| `tool: aider` | `CLI tool "aider" was removed; supported tools are <the tools that seat accepts>.` | No replacement — choose another `cli` tool, or drive Aider as a `shell` runner. |

### Removed config keys

Fifteen shapes that a `version: 3` config once carried are gone: twelve removed keys, plus three
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
| `workflow.briefReview: rich` | rejected — `Invalid input: expected "simple"` | `briefReview: simple`, the only brief-review shape. |
| `hooks.builtin` | rejected — `hooks.builtin: Unknown config key …` | None. The built-in hook bundle is gone; write the check as an ordinary `kind: command` hook (§8). |
| `hooks.pre_compact` | rejected — `hooks.pre_compact: Unknown config key …` | None. Transcript compaction is automatic and fires no hook; `HOOK_EVENTS` is the ten events in §8. |
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

---

## 17. Full production example

A representative config: Claude Code subscription as planner, a small local LM Studio model as implementer, mid-tier escalation to a larger local Ollama model, budget caps, hooks, and tiered approval. Use it as a starting point, then adjust credentials, budgets, hooks, and approval tiers for your environment.

<!-- config-example: full-production -->
```yaml
version: 3

# ---------- Planner: Claude Code subscription (no API billing) ----------
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

# ---------- Workflow: speckit, all gates, manual commits, budget cap ----------
workflow:
  mode: speckit
  approve: all
  briefReview: simple
  maxRetries: 3
  maxBudget: 5.00
  budgetPauseThreshold: 0.8
  driftChainThreshold: 0.6
  git:
    commitStrategy: none
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
    destructive: confirm
    package_change: confirm

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
- `ANTHROPIC_API_KEY` only if you drive Claude Code through its `api-key` auth channel instead of its own session credentials

Then:

```bash
splitbrief start --allow-hooks "your feature description"
```

In the compiler path, that Claude Code planner yields a full capability receipt on tested version 2.1.232 when its conformance row is verified; other detected versions are admitted with runtime-drift evidence and a run warning. Runtime guards (envelopes, terminal contract, dispatch ledger, post-run mutation detection) are the enforcement surface. Implementer rows are unaffected by compiler gating.

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
| ollama | ollama | local | `http://localhost:11434/v1` | — | — | implementer | local |
| lm-studio | lm-studio | local | `http://localhost:1234/v1` | — | — | implementer | local |

**Role restriction:** both admitted providers are implementer-only. Configuring either as `planner` or `reviewer` fails schema validation; a planner-side `kind: api` seat is a custom endpoint (see below).

Local `ollama` talks only to a loopback daemon and normally omits `apiKey`; if that daemon requires authentication, the only accepted reference is `apiKey: env:OLLAMA_LOCAL_API_KEY`. `OLLAMA_API_KEY` is never resolved or sent to local Ollama.

**Deferred / not admitted:** researched subscription coding plans, retired consumer CLI entitlements, generic self-hosted OpenAI-compatible shims, and every other candidate without a PASS verdict have **no** first-class provider ID, descriptor, or support row here. Verdict-pending offerings remain absent until a credentialed production gate passes. Per-offering verdicts and dates: [Excluded API offerings](#excluded-api-offerings). Excluded CLI candidates: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#excluded-researched-candidates).

**Compiler-path identity.** As a Task Brief planner, a `kind: api` endpoint is versionless and conformance-gated: admission carries no runtime version, and the verified conformance proof is the identity evidence. The credential channel is `api-key` (the endpoint's own inline key), and no capability receipt records a secret. The compiler support table, terminal contracts, and containment profiles live in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

### Bundled model catalog (T-081 runtime state)

`KNOWN_MODELS` (`src/core/providers/known-models.ts`) is the offline picker fallback. Live native CLI rows — or, for an `api` provider, models.dev rows — hide `bundled-suggestion` placements in the picker (`buildRightRows`); `resolveModelCatalog` still emits them. For `api` runners pricing and context stay on models.dev first, as in [Pricing metadata](#pricing-metadata); a CLI tool's context comes from its own listing or this table.

Recommendation labels mirror `src/core/providers/known-models.ts`. A row becomes **`recommended`** only after T-080 records five-scenario evaluation metrics for it. No credentialed evaluation run exists, so every bundled row is **`compatible-only`** — selectable, with no SPLITBRIEF quality claim.

<!-- api-model-catalog -->
| Provider | Model | Recommendation | Notes |
|---|---|---|---|
| ollama | qwen3-coder:30b | compatible-only | Local default; context limit discovered from the daemon — not hard-coded. T-080: OMIT-NOT-APPLICABLE. |
| lm-studio | qwen2.5-coder-7b | compatible-only | Local default; context limit discovered from the daemon. T-080: OMIT-NOT-APPLICABLE. |

### Minimal YAML per admitted provider

Both admitted providers are loopback daemons that take no credential: omit `apiKey` entirely. Local `ollama` accepts exactly one reference when its daemon requires authentication (`apiKey: env:OLLAMA_LOCAL_API_KEY`). Anything remote is a custom provider with an inline key — see [Generic remote OpenAI-compatible endpoint](#generic-remote-openai-compatible-endpoint) below.

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
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — planner/implementer pipeline, compiler capability and conformance
- [TESTING.md](./TESTING.md) — testing contract, compiler conformance rows
- [ARCHITECTURE.md](./ARCHITECTURE.md) — runner contracts, orchestrator loop, event model
- [WORKFLOW.md](./WORKFLOW.md) — mode + approval semantics in depth
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, `HookEntry` schema, trust model
- [REPOMAP.md](./REPOMAP.md) — `codebase.*` semantics, PageRank, cache
- [API-KEYS.md](./API-KEYS.md) — secret handling and redaction
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — runtime overrides and palette commands
- [DEBUGGING.md](./DEBUGGING.md) — diagnosing config load failures
- [ERRORS.md](./ERRORS.md) — `ConfigError` shape and exit codes
- [WORKFLOW.md](./WORKFLOW.md) — workflow modes and approval semantics
