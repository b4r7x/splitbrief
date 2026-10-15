# SPLITBRIEF Configuration Reference

Complete reference for `.splitbrief/config.yaml` — the single declarative file that wires SPLITBRIEF to your planner, reviewer, implementer, validation tools, workflow gates, and hooks.

This document is a field-by-field reference. For the planning session and plan approval see [WORKFLOW.md](./WORKFLOW.md); for hook plumbing see [HOOKS-CONFIG.md](./HOOKS-CONFIG.md); for repo-map tuning see [REPOMAP.md](./REPOMAP.md).

---

## 1. File location, format, and lifecycle

```
<project-root>/.splitbrief/config.yaml
```

- The file is created on first `splitbrief init` (or implicitly on first `splitbrief start`). Missing file → SPLITBRIEF runs with `createDefaultConfig()` (`src/core/config/load/defaults.ts`).
- **Schema version:** `version: 3`, required and exact. Any other value (or a missing one) fails the load with `config-unsupported-version`; run `splitbrief init --reconfigure` to write a current config.
- **Defaults filled at load:** `mergeWithDefaults` (`src/core/config/load/defaults.ts`) fills these values before validation, and only these:
  - no `planner` block: `kind: cli`, `tool: claude-code`.
  - no `implementer` block: the local Ollama implementer (`kind: api`, `provider: ollama`, `service: ollama`, `offering: local`, `apiBase: http://localhost:11434/v1`, `model: qwen3-coder:30b`, `temperature: 0.3`).
  - a top-level `implementer` whose `kind` is `api` or omitted and whose `provider` is `ollama` or omitted: each of those Ollama fields that the block omits.
  - `validation.endChecks: true`, `workflow.approve: plan`, `workflow.review: end`, `workflow.compactionFormat: auto`, when the file omits them.

  The loader fills no field in a `planner` or `reviewer` block, in an `implementerProfiles` profile, or in an `implementer` with another `kind` or `provider`.
- **Key style:** the loader transforms `snake_case` YAML into `camelCase` before validation (`src/core/config/load/transform.ts`), so both styles work. This document uses `camelCase`. Where one map spells a key both ways, the later line wins. A save from the TUI edits the key in the spelling your file already uses, removes an earlier twin spelling of it, and writes a key the file does not carry yet in `snake_case` (`src/core/config/load/document.ts`).
- **Permissions:** Configuration files with group- or other-writable bits (mode & 0o022) trigger a security warning. On POSIX, the loader emits this via `warnStderr` when `checkConfigPermissions` fails (`src/lib/fs.ts`). `init` writes the file at `0600` via `writeSecureFile`.
- **`.gitignore`:** CLI init/setup and the first successful interactive Setup save initialize the ignore rule for `.splitbrief/`. Worktree initialization adds this rule inside the worktree. When git already ignores `.splitbrief/`, through the project's `.gitignore` or one in a parent directory, `.git/info/exclude` or your global excludes file, `.gitignore` stays unchanged, so a clean checkout stays clean. Existing directory-content rules and config exceptions stay intact. Ordinary config saves, including Settings and seat switches, leave `.gitignore` unchanged.

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
validation:     { end_checks, approve_checks, test_command, render, ... }
workflow:       { approve, git, isolation, ... }
sessions:       { scope: project }
# escalation:   retired; loads with one notice and is ignored (§16)
codebase:       { enabled, tokenBudget, include, exclude }
hooks:          { pre_task, post_task, ... }
palette:        { customActions: [...] }
approval:       { feedRejectionsToPlanner, allowedPaths }
customCommands: { <id>: { label, contract, executable, argv, ... } }
```

Top-level keys are **not** strict at the root — an unknown key is ignored — except the removed root keys (`otel`, `snapshots`, `trust`, `plannerEstimateReview`, `autoSplitOverflow`, `compiler`), which are named as load errors like any other removed key (§16). Most nested objects (`workflow` and its `git` block, `hooks`, `codebase`, `approval`, every runner config) are strict and will reject unknown fields. The retired keys `workflow.mode`, `workflow.speckit`, `workflow.brief_review`, `workflow.task_review`, `workflow.max_retries`, the `escalation` block, `approval.tiers` and `validation.typecheck`, `lint`, `test`, `typecheck_command`, `lint_command` still load, with one notice each, and are ignored (§16).

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
| `contextLength` | int > 0 | kind-dependent | Application budget override. Every kind keeps the value. A planner or reviewer uses it only on the `api` kind, as the application context that its PLAN or REVIEW packet is measured against. An implementer of any kind uses it to route a Task Brief. Readiness reports the planner value on every kind. Built-in local API calls use configured context, observed active context, then 8192; maximum model capacity is separate. CLI/legacy routing can use the 32768 conservative fallback. This field never changes the server. |
| `temperature` | 0..2 | unset (`0.3` on a filled Ollama implementer, §1) | Sampling temperature. Every kind accepts the field, but SPLITBRIEF does not send it. The `api` kind omits it from every request for every provider (`resolveOpenAICompatPolicy`, `src/engine/providers/openai-compat-policy.ts`), so the server's own default applies. The `cli`, `shell` and `agent` kinds drop it with a stderr warning. |
| `timeout` | ms | API BUILD: 20 min; API PLAN/REVIEW: 10 min. `cli`, `shell` and `agent`: none. | Total wall-clock budget for a call. On an `api` seat, the first-response and stream-idle deadlines also apply, and this total bounds each of them; the API defaults come from `TIMEOUTS.implementerMs` / `TIMEOUTS.reviewerMs` (`src/core/pipeline-spec/timeouts.ts`). A subprocess seat call (`cli`, `shell`, `agent`; planner, implementer and reviewer) has no default total, interactive or headless. A set `timeout` is an opt-in limit, and it applies on every subprocess path. Two timeouts or idle cuts in a row halt the run as `runner-timeout-repeated` (*Seat down*). Readiness warns about the `timeout` / `idleKillMs` pair only when both are set. |
| `idleWarnMs` | ms | `300000` | Inactivity watchdog warn threshold: after this much output silence on a running call, the byline shows a "still working" warning; any stdout/stderr output clears it and resets the timer. The warn never ends the call. From 60 s of silence, the build block's freshness line reads `No output for m:ss · running <command>` when the tool stream reports an open tool, `No output for m:ss · tools report when done` for `opencode` and `kilo-code`, and `No output for m:ss` otherwise. The clock continues to count until output arrives. Press Esc to stop the call resumably; Resume runs the seat again. A lone `idleWarnMs` of any size is valid. |
| `idleKillMs` | ms | none | Opt-in watchdog cut: at this much output silence, SPLITBRIEF stops the runner's process group (SIGTERM, then SIGKILL after a grace window) and marks the call failed. It applies on every subprocess path, `shell` and `agent` planners and reviewers included. Only byte silence counts: a running child process (a test, a build or another command) is not progress. The transcript shows one error row, for example `<tool> sent no output for 30:00; SPLITBRIEF stopped it`, and the retry ladder continues. Two cuts or timeouts in a row halt the run as `runner-timeout-repeated` (*Seat down*). A lone `idleKillMs` must be at least the effective warn: `idleWarnMs` when set, else `300000`. Set `idleKillMs` or `timeout` for an unattended run. |
| `effort` | `none\|minimal\|low\|medium\|high\|xhigh\|max` | unset | Reasoning-effort hint. The union above is what config accepts; the levels a seat may actually use are the selected model's own ladder, not a fixed list per tool — the seat's tool accepts a subset and reports what it rejects. How a seat's effort intent reaches its tool is the seat's channel — `CliEffortChannel` (`src/core/runners/effort-channel.ts`), resolved by `seatEffortChannel` (`src/core/runners/capabilities.ts`) — and only one of the four channels carries this field. `cli` `claude-code`, `codex`, `copilot` and `command-code` are channel `effort-flag`: they deliver this `EffortLevel` verbatim on the tool's own effort argument, on the planner, reviewer, and implementer seats — `claude-code`, `copilot` and `command-code` emit `--effort <level>`, `codex` emits `-c model_reasoning_effort=<level>`. `cli` `opencode` and `kilo-code` are channel `variant`: they have a real effort channel, but it is a named preset delivered through the separate `variant` field — kilo's `--variant`, opencode's model suffix from 2.0.0 on — not through `effort`. `cli` `cursor` and `antigravity` are channel `model-id`: effort is encoded in the selected model id's suffix (`gemini-3.8-flash-low`), so there is no separate field to set — choose it in the model picker. Only the `api`, `shell`, and `agent` kinds are channel `none`. An undeliverable value is not sent: changing a seat in the TUI clears it and says so (`Effort <level> cleared: <tool> has no effort channel`) on every seat whose channel is not `effort-flag`, and a headless run drops it, with a `planner-effort`/`reviewer-effort: dropped` stderr warning on the planner and review seats, silently on the implementer seat. The same clearing and dropping applies to `variant` on a seat whose channel is not `variant`. |
| `variant` | string | unset | The named execution preset of the `variant` channel — today `cli` `opencode` and `kilo-code`, delivered on `kilo run --variant <name>` and, for opencode, on the model itself: `opencode run --model <provider/model>#<name>` from 2.0.0 on, which rejects `--variant`, and `opencode run --variant <name>` below 2.0.0. The release the start gate admitted picks the form, and the arg-vector preflight checks the same one. Free-form and persisted verbatim, because an opencode user can declare custom variants in `opencode.json` that no static enum could know. The presets are per model, not per provider: the picker offers the ladder the model itself publishes (`opencode api GET /api/model`, or `opencode models --verbose` below 2.0.0, and `kilo models --verbose` for a detected route), so `openai/gpt-5.6-luna` offers `none\|low\|medium\|high\|xhigh\|max` and a model that publishes none offers no presets, though a hand-written value is still sent. `--variant` is a protected flag: configuring it through `args` is refused before spawn. |

`idleWarnMs` and `idleKillMs` apply to the `cli`, `shell`, and `agent` kinds only — `api` runners keep the 60s stream-idle guard, and their strict schema rejects both fields. An `api` seat keeps its own deadlines: 120 s to the first response, 60 s of stream idle, and the role total (BUILD 20 min, PLAN and REVIEW 10 min). The Settings label of an `api` seat shows that total, not an idle cut. The watchdog never touches the commands SPLITBRIEF runs itself (plan checks, reviewer checks, renders and base re-runs): only `validation.timeoutMs` limits them.

### `fallback`

A seat names the CLI runner it uses after an automatic switch.
Set it in Settings › Fallback, or write `fallback` under `planner`, `implementer`, or `reviewer` in `.splitbrief/config.yaml`.

The Fallback section is directly below Crew. It has one row per seat: PLAN, BUILD, REVIEW.
Each row shows the fallback as a seat identity, or `none · pause and ask`.
A REVIEW that follows PLAN shows `= PLAN · …` and uses PLAN's fallback.
A note names why the halt cannot offer it: ` · not installed`, a readiness state, or ` · same as the seat`.
The BUILD row edits the default implementer profile's fallback.
Setup shows no fallback. Crew rows show no fallback line.

Press ⏎ on a Fallback row to open the tool/model picker in its fallback slot.
Its title is `<SEAT> fallback · tool, model, effort`.
The first row, None, clears the fallback. The other rows offer only CLI tools that the seat can host.
Model, effort and variant choices work as they do for the seat. Model-id axes stay in `fallback.model`.
The fallback slot has no auth-method row.
Choosing an automatic model saves no `fallback.model` field.
The picker refuses the seat's own identity and stays open with `<SEAT> runs <identity> now · choose another tool or model`.
On the same tool, no model or the seat's resolved model counts as the same identity. Changing only `effort` or `variant` keeps the same identity. Changing an effort token inside the model ID changes the identity.
A typed custom model saves `fallback.model` only. It does not add to the seat's `customModels`.
The entry screen is titled `Custom fallback model · <SEAT>`.

When REVIEW follows PLAN, the picker and custom-model entry screen show `REVIEW = PLAN · saving here gives REVIEW its own seat`.
Saving copies PLAN's runner into a new `reviewer` block with the new fallback.
Clearing it from REVIEW when PLAN has a fallback does the same, with no fallback in the new block. PLAN stays unchanged.
Choosing None when PLAN has no fallback keeps REVIEW inherited.
An explicit `reviewer` block uses only its own fallback, even when that block has none.
Presets keep each seat's fallback. A preset with no reviewer makes REVIEW follow PLAN, fallback and all.

Merge this fragment into your existing `version: 3` config:

```yaml
version: 3
implementer:
  kind: cli
  tool: codex
  model: gpt-5.6-sol
  fallback:
    tool: opencode
    model: openai/gpt-5.6-luna
    variant: high
```

| Field | Type | Description |
|---|---|---|
| `tool` | CLI tool id | Required. The tool the seat moves to. |
| `model` | non-empty string | Optional. The model the tool runs. |
| `effort` | `EffortLevel` | Optional. For a tool whose effort channel is `effort-flag`. |
| `variant` | non-empty string | Optional. For a tool whose effort channel is `variant` (`opencode`, `kilo-code`). |

Use `effort` instead of `variant` for an `effort-flag` tool, such as `codex`; for example, `effort: high`.

A fallback always uses a `cli` runner and accepts only the fields above.
Every runner `kind` accepts `fallback` on its seat block.
The loader validates the fallback against that seat's CLI schema (`validateFallback`, `src/core/schemas/runner-fields.ts`).
The loader rejects `fallback.effort` for a `variant` tool.
No seat has a default fallback.
The review seat uses `reviewer.fallback` when a `reviewer` block exists; otherwise, it uses `planner.fallback`.

Declaring a fallback authorizes one automatic switch per run and seat.
SPLITBRIEF switches only for an account refusal or a rate limit with a reset beyond the run's wait limit.
The fallback must pass admission checks, and the halt must carry the config revision.
SPLITBRIEF records each switch in `seatSwitches`.
An automatic switch makes the old CLI seat the fallback, preserving its tool and model.
It preserves `effort` only for an `effort-flag` channel, or `variant` only for a `variant` channel.
Model-ID axes remain in `model`; unused level fields are omitted.
An old `api`, `shell` or `agent` runner cannot be a fallback, so the new seat has none.
A manual switch keeps the seat's fallback.
Switching an inherited REVIEW writes a `reviewer` block and leaves `planner` unchanged.

At each halt, SPLITBRIEF reads the fallback from the config of record with its `configRevision`.
A fallback saved during a run applies at the next halt in that run, in any phase.
With no `config.yaml`, the prepared config is the record.
If an existing `config.yaml` does not load, the halt offers no configured fallback and shows `fallback: not read · config.yaml does not load`.
See [Seat down](./APPROVAL-AND-RECOVERY.md#seat-down) for the switch conditions and recovery actions.

Use `--on-seat-down halt` to disable automatic switching for headless `start`, `resume`, or `continue`.
`--on-seat-down switch` and an unset policy apply the declared fallback when the switch conditions hold.
`--on-seat-down switch` exits `2` if the config declares no fallback.

### Pricing metadata

Pricing is resolved from cached `models.dev` metadata first when available, then from runtime provider metadata or the bundled catalog. `models.dev` context pricing tiers are preserved: flat base rates apply below the tier threshold, and the highest matching context tier applies when prompt/cache context reaches that threshold. Local-only unpriced runners are displayed as local/unpriced rather than dollar-priced. Picker lane order is separate from this ladder — a CLI tool renders its own listing with the bundled `KNOWN_MODELS` aliases as the offline fallback, and an `api` runner adds models.dev rows beside its runtime list — and does not reorder pricing or context lookup; see [Model catalog lanes](./PLANNERS-AND-IMPLEMENTERS.md#model-catalog-lanes).

### `kind: cli`

Subprocess of a known coding-agent CLI. The wrapper handles auth, model selection, and output parsing.

CLI model pickers can show stale cached rows after a shorter successful read. The [CLI catalog cache rules](./SUBSYSTEMS.md#5-detection) define retention, removal, freshness, and failed reads.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `tool` | enum | yes | `claude-code` \| `codex` \| `opencode` \| `copilot` \| `kilo-code` \| `cursor` \| `command-code` \| `antigravity` |
| `model` | string | no | A model ID, or `auto`. Omitting `model` and writing `model: auto` are equivalent: both mean the model the tool itself has selected on this machine, which SPLITBRIEF reads at preparation and passes as `--model`. |
| `args` | string[] | no | Extra argv appended to the tool invocation. Every token is validated against the adapter-owned authority set: a flag that would override role, permissions, sandbox, cwd or added roots, config sources, tools, hooks/plugins/MCP, session selection, prompt transport, output format, terminal protocol, final-output path, updates, or approval behavior is refused before spawn. |
| `authChannel` | enum | no | `api-key` \| `session` \| `provider-dependent`. The value must be a channel the tool declares, else the load fails: `claude-code`, `codex` and `cursor` declare `session` and `api-key`; `copilot`, `command-code` and `antigravity` declare `session`; `opencode` and `kilo-code` declare `provider-dependent` (`CLI_TOOL_CATALOG`, `src/core/runners/cli-tool-catalog.ts`). Omitted or `provider-dependent`: the host CLI's own configuration and login decide. An explicit `session` or `api-key` is refused before dispatch, because no tool has enforcement evidence for a method choice. Omit the field and the host CLI's own login decides. See [Provider authentication](#provider-authentication) and [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md#per-channel-facts). |
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

**When to use:** you already pay for a Claude Code / Codex / OpenCode license and want SPLITBRIEF to drive it as a planner without separate API billing. Copilot, Cursor, Command Code and Antigravity plan with their own read-only plan recipes like every other CLI planner.

### `kind: api`

OpenAI-compatible HTTP endpoint.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `provider` | non-empty string | yes | `ollama` \| `lm-studio` \| `llama-cpp` \| any custom name |
| `service` | non-empty string | yes | Billing/identity service behind the provider. The loader fills it only on a top-level Ollama `implementer` (§1); write it out in every other block. For an admitted provider ID it must equal that ID's `API_PROVIDER_CATALOG` service (see the provider matrix in §18); a mismatch is a validation error. |
| `offering` | enum | yes | `payg` \| `free-quota` \| `coding-subscription` \| `local`. The loader fills it only on a top-level Ollama `implementer` (§1); write it out in every other block. For an admitted provider ID it must equal that ID's catalog offering. |
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
  temperature: 0.5   # accepted, but SPLITBRIEF does not send it
  timeout: 300000
```

**When to use:** you run an OpenAI-compatible endpoint of your own — a hosted account, a gateway, or a self-hosted Ollama/LM Studio daemon — and want raw HTTP access without a CLI wrapper.

### `kind: shell`

Arbitrary `stdin → stdout` command. SPLITBRIEF writes the prompt to stdin and parses what comes out of stdout, using `outputFormat` to pick a parser. No shell or network sandbox is applied; the command runs as a normal child process under the current user.

**A `shell` or `agent` command is not trusted because it is in the config.** `.splitbrief/config.yaml` travels with `git clone`, so the command a project declares is the repository author's proposal until you accept it on *this machine*. See [Runner command trust](#runner-command-trust).

| Field | Type | Required | Description |
|---|---|:---:|---|
| `command` | non-empty string | yes | Executable path (relative to project or absolute). Availability is an existence/executability check (`fs.access` with `X_OK`, or a `$PATH` lookup for bare names) — SPLITBRIEF never runs your command with `--version`, so the script is not invoked until planning starts. |
| `args` | string[] | no | Argv |
| `outputFormat` | enum | no | Same values as `cli` |
| `env` | string[] | no | Uppercase names of the environment variables the command needs, for example `['MY_AGENT_TOKEN']`. The command runs in its staged runner environment: a private `HOME` and `TMPDIR`, your `PATH` without the project's own directories, the locale and terminal keys, and these names. No other variable of your shell reaches it ([AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md#child-environment)). |
| `capabilities` | partial object | no | **Planner and reviewer only.** Declares optional planner features such as `supportsConversationalPlanning`, `supportsSessionResume`, and `supportsSelfSummarisation` so the orchestrator skips features the wrapper cannot provide. `supportsSessionResume: true`, `supportsEffort: true` and `supportsImages: true` are rejected on `shell`/`agent` planners and reviewers — the command-based adapter has no session-handle contract and no channel to deliver an effort hint or image attachments to the subprocess (use a `cli`/`api` planner or reviewer instead). The value `false` is accepted for each of them. Ignored (and rejected) on `implementer` — implementer write behavior is set via profile `capabilities.writesFiles`. |

```yaml
planner:
  kind: shell
  command: ./scripts/my-planner.sh
  args: ["--model", "custom"]
  outputFormat: text
  capabilities:
    supportsConversationalPlanning: false
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

In `splitbrief doctor`, each seat with a `shell` or `agent` runner shows a warning, for example `PLAN runs a command you declared, with your permissions on this machine.`, at every approval level. One `Command:` line under it shows the configured `command` and `args` (control-stripped and credential-redacted), so you can read them before starting anything. Only the prompt resolves the command to an absolute executable path, because readiness never touches the filesystem for this. A `cli` seat shows no command line. When any seat can run local commands, doctor also shows one info line: `Your coding tools run commands on this machine with your permissions.` Check ids appear only in `splitbrief doctor --json`: `runners.trust-boundary` for the info line, and `runners.planner.trust-boundary`, `runners.implementer.trust-boundary` and `runners.reviewer.trust-boundary` (only when a `reviewer` block is configured) for the warnings.

### Default API base URLs (`KNOWN_PROVIDER_BASE_URLS`)

Source: `src/core/providers/catalog.ts`.

| Provider | Default `apiBase` |
|---|---|
| `ollama` | `http://localhost:11434/v1` |
| `lm-studio` | `http://localhost:1234/v1` |
| `llama-cpp` | `http://localhost:8080/v1` |

**See also:** §3 `implementer`, §13 environment variables, [API-KEYS.md](./API-KEYS.md).

Custom OpenAI-compatible API providers are allowed when `service`, `offering`, and `apiBase` are all set. The loader fills no field of a custom provider block (§1). Because SPLITBRIEF cannot infer a safe environment variable name for unknown providers, custom providers must set `apiKey` explicitly and inline: an `apiKey: env:VAR` reference is refused for a provider the catalog does not know, so a config cannot point an unrecognized endpoint at one of your environment credentials.

---

## 2a. `reviewer`

Optional. `reviewer` names the runner that performs the final review of the run diff. Leave it out and the planner holds that seat, exactly as it did before the seat became assignable (`resolveReviewerRunner`, `src/core/config/accessors/reviewer-runner.ts`). Set it when you want the diff read by a model other than the one that planned it.

The reviewer only reviews. Planning, Task Brief compilation, the consult and summarization stay on the planner whatever this block says.

### Schema

Same discriminated union as `planner` — the four kinds, the same [common generation fields](#common-generation-fields), an optional `model`, and `.strict()` on every variant, so an unknown field fails the load with a `ConfigError` (`ReviewerConfigSchema`, `src/core/schemas/reviewer-config.ts`).

| `kind` | Write the same fields as | Notes |
|---|---|---|
| `cli` | [`kind: cli`](#kind-cli) | `tool` must be a planner-side CLI: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity`. |
| `api` | [`kind: api`](#kind-api) | Built-in local providers support the review seat through the planner role. Declare `service`, `offering`, `apiBase` and the exact model independently for this seat. Custom remote providers require their own inline credential. |
| `shell` | [`kind: shell`](#kind-shell) | Needs the same [runner command trust](#runner-command-trust) grant as a `shell` planner. |
| `agent` | [`kind: agent`](#kind-agent) | Same trust grant. |

The reviewer is a planner-tier seat and shares the planner's admission set, so a provider or tool that the planner may not use is rejected in this block too. The seat is built on the planner backends (`createReviewer`, `src/engine/runners/factory.ts`), so effort follows the same channel matrix as on the planner: `cli` `claude-code`, `codex`, `copilot` and `command-code` take the `effort` field on the tool's own effort argument, `cli` `opencode` and `kilo-code` take a named preset in `variant` instead, `cli` `cursor` and `antigravity` read their effort out of the selected model id, and only the `api`, `shell` and `agent` kinds have no channel at all. An `effort` or `variant` the backend cannot deliver is cleared with a toast when the seat is changed in the TUI and dropped with a stderr warning headless; a `temperature` outside the `api` kind is likewise dropped with a stderr warning headless, but is carried forward untouched in the TUI. With no `reviewer` block the review seat inherits the planner's effort and shows it read-only; make the seat independent before changing it.

### Falling back to the planner

- **No `reviewer` block:** the planner runner performs the review. Review tokens are priced at the planner's rates and folded into the planner line in the run summary.
- **A `reviewer` block:** the reviewer performs the review and gets its own priced line in both.
- **The review seat's fallback:** `reviewer.fallback` when a `reviewer` block exists, else `planner.fallback`. See [`fallback`](#fallback).
- **A configured reviewer that fails admission** blocks the run before it starts, with a readiness blocker naming the reviewer seat. A mid-call account refusal or long-reset limit raises a Seat down halt and can apply the review seat's configured fallback under the [switch conditions](./APPROVAL-AND-RECOVERY.md#seat-down). A review that ends as failed records `finalReviewStatus: "failed"` in the run summary and `finalReview.status` in the review packet, with the reviewer's identity in the error and the final-review evidence. SPLITBRIEF never silently hands the review back to the planner.

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

The implementer is the weaker model. Model strength determines that role; transport does not. A `cli` or `agent` runner writes directly with `writesFiles: direct`. An `api` or `shell` runner returns code that SPLITBRIEF writes with `writesFiles: extracted-code`. Every writer uses the run workspace selected by `workflow.isolation` (§5).

Same discriminated union as `planner`, with two schema differences: `model` is required on the `api`, `shell`, and `agent` implementer variants, and the `shell`/`agent` variants do **not** accept the planner-only `capabilities` field. The `cli` variant leaves `model` optional — omit it or write `model: auto` to follow the tool's own selection, which preparation reads from the tool's own config or state and passes as `--model`; the two spellings behave identically and neither is rewritten on save. On an `api` runner, `auto` resolves to that provider's catalog default model (for example `ollama` → `qwen3-coder:30b`), and a custom provider with no catalog default rejects `auto` — and model absence — at config load. Implementer write behavior (`extracted-code` vs `direct`) is not a choice: `capabilities.writesFiles` may be declared per profile under `implementerProfiles`, but it must match the runner kind's write mode, and config load rejects a mismatch.

The implementer block takes `fallback` the same way as the other seats. See [`fallback`](#fallback).

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

That is the `direct` path. The tool edits files inside the run workspace. The same Task Brief, validation, retry ladder, consult and drift accounting apply to an `api` implementer. [Apply](./WORKFLOW.md#apply) writes the assessed result into the checkout.

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
  temperature: 0.3   # accepted, but SPLITBRIEF does not send it
  timeout: 240000
```

`contextLength` is an application budgeting input, not a server setting. The application context budget does not reconfigure the server or prove its active context capacity. For built-in local API seats, `resolveApplicationContextTokens` selects configured context, otherwise observed active context, otherwise the application default of 8192 tokens, then clamps that result to observed active and maximum context when known. The model's maximum context is a separate architectural ceiling and never substitutes for unknown active capacity. CLI and legacy routing metadata have their own conservative fallback (`DEFAULT_UNKNOWN_CONTEXT_LENGTH`); that does not replace the API dispatch budget.

For PLAN and REVIEW, reserve 2048 output tokens and add an input-estimation margin of ceil(inputEstimate * 0.15). `measureApiBudget` includes message/request overhead, requires input plus the 15% margin plus output reserve to fit, and refuses before dispatch if it does not. BUILD reserves output for the complete declared text bundle, including modify baselines and new targets. The output cap is independently bounded; an absent maximum-output report uses the 8192-token application fallback. Each dispatch rechecks the seat's own endpoint and exact model.

The first-response deadline defaults to 120000 ms and stream-idle to 60000 ms. `resolveApiDeadlinePolicy` clamps each to the total role timeout, which remains authoritative. First response means the first stream chunk; subsequent chunks reset idle timing. Cancellation closes the application request, but does not prove remote generation has stopped. SPLITBRIEF never reconfigures or unloads the server in response.

`resolveEffectiveRequestOptions` records whether controls were sent, not configured, or omitted as unsupported. Current OpenAI-compatible policy sends the budgeted `max_tokens` but omits temperature, effort/reasoning controls and stream-usage requests. A configured value or retry temperature increment is not evidence that the server received it.

**When to use:**
- *Coding-agent CLI on a smaller model* — you already pay for a Claude Code / Codex / Copilot subscription and want the implementer step to run there on a smaller model than the planner uses.
- *Cheap local API* — Ollama, LM Studio or llama.cpp for cost-free iteration on small tasks.
- *Mid-tier API* — a below-frontier model behind your own custom endpoint.
- *Frontier* — the same model class as the planner when you want its quality for the implementer step too.

**See also:** §2 `planner`, §16 (retired keys), [REPOMAP.md](./REPOMAP.md) (codebase context the implementer never sees, only the planner).

### Optional `implementerProfiles`

`implementer` remains required for backwards compatibility and existing configs do not need to change. New configs may also define named implementer profiles so task routing can choose a cheap capable worker per Task Brief.

An implementer pool is still one product role: SPLITBRIEF selects one capable profile per Task Brief. Parallel implementer writes are out of scope. A worktree or staged copy (`workflow.isolation`) separates one implementer's work from your checkout, not two implementers from each other.

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

---

## 4. `validation`

What SPLITBRIEF runs to verify the change. One switch, `end_checks` (Settings label **End-of-run checks**), turns the reviewer checks on or off. It defaults to `true`. With it on, before each review the reviewer reads the project and chooses the reviewer checks that verify the change. The reviewer reads the manifests and scripts, a `Makefile` or `justfile`, the CI configuration and the README. SPLITBRIEF runs the reviewer checks in the run workspace under the reviewer command policy (see [Reviewer checks](#reviewer-checks)). A second switch, `approve_checks` (Settings label **Approve checks**), decides whether the reviewer checks run at once (`auto`, the default) or wait for you on one card (`ask`). Every check runs the project's own code with your permissions; [What a check can reach](#what-a-check-can-reach) says what SPLITBRIEF isolates and what it does not. The other fields are optional and feed the planner's `test` and `render` checks; `timeout_ms` bounds every command. After each hand-back, SPLITBRIEF formats the brief's own changed files with the project's own formatter. It uses `npx biome format --write` when a Biome config file is present, `npx prettier --write` when a Prettier config is present, and nothing when neither is present. A formatter that exits non-zero gives one warning (`validation_format_failed`), and the checks run regardless. The brief's changed files are every file it changed since its task-start snapshot, across its attempts; a pass that rewrote files records one `validation_formatted` warning that names them.

### Schema

```ts
validation: {
  endChecks?:        boolean; // optional, default true
  approveChecks?:    'ask' | 'auto'; // optional, default 'auto'
  testCommand?:      string; // optional, non-empty
  testPattern?:      string; // optional, non-empty
  timeoutMs?:        number; // optional, int >= 1000, milliseconds
  stack?: 'typescript' | 'javascript' | 'python' | 'go' | 'rust'; // optional
  render?:           string; // optional, non-empty

  // Retired: each loads with one notice and is ignored (§16)
  typecheck?:        unknown;
  lint?:             unknown;
  test?:             unknown;
  typecheckCommand?: unknown;
  lintCommand?:      unknown;
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `endChecks` (`end_checks`) | boolean | `true` | **End-of-run checks.** `true`: before the final review, the reviewer chooses the reviewer checks that verify the change, and SPLITBRIEF runs them. With `workflow.review: task`, the same happens before each task review. `false`: no reviewer check runs, and one row reads `End-of-run checks · off · no reviewer check ran`. Plan and task checks still run in both cases. `resolveEndChecks()` (`src/core/config/runtime/resolve.ts`) reads it. |
| `approveChecks` (`approve_checks`) | enum | `auto` | **Approve checks.** `auto`: the reviewer checks run as soon as the reviewer chooses them. `ask`: after the plan call, one card per review shows the chosen commands and their reasons, and none runs until you choose **Run all** or **Skip all**. A headless run (`--json`, `--plain`) has no card, so with `ask` it runs none of the reviewer checks and one row says why. A skipped check is never a pass (see [Reviewer checks](#reviewer-checks)). It has no effect while `end_checks` is `false`. `resolveApproveChecks()` (`src/core/config/runtime/resolve.ts`) reads it. |
| `testCommand` (`test_command`) | string | — | The command a planner `test` check runs: an argv-style command that runs **as-is** — shell operators and environment expansion are not interpreted, and no test-file argument is appended. When omitted, the check resolves its command through the ladder below and narrows it to the tests its file affects. |
| `testPattern` (`test_pattern`) | string | — | Optional file name pattern with one `*`, such as `*_test.go` or `test_*.py`. No directory part (`/` or `\`) and no `..`. SPLITBRIEF searches beside the changed file and in the stack's test folders. Overrides the stack's patterns when a `test` check narrows to its affected tests. SPLITBRIEF emits `discovered_validation_refused` when it refuses a discovered pattern. It uses the configured pattern, if present. Otherwise, it uses the stack's patterns. |
| `timeoutMs` (`timeout_ms`) | number | `3600000` | Milliseconds allowed per command (minimum `1000`): every plan check, every reviewer check and every base re-run. The default is one hour. A timeout is never pre-existing: when the base re-run is red too, the timeout is *not verified at the run base*, and the reviewer decides. |
| `stack` | enum | detected | Pin the stack a `test` check resolves and narrows through instead of detecting it: `typescript`, `javascript`, `python`, `go`, or `rust`. Use it when a repo carries more than one marker file and the detection order picks the wrong one, or when the markers are missing entirely. |
| `render` | string | — | The command a `render` check runs. `{id}` (the check value, one argv element) is substituted into the parsed argv, and `{out}` becomes a fresh directory under `<workspace>/.test-artifacts/ui/`; the command runs with cwd = the workspace and is not filtered by the planner command policy. Every `.png` under `{out}` is copied to `.splitbrief/sessions/<id>/renders/<check-id>/` and logged with its sha256. A `render` check whose value is not a `[a-z0-9-]` slug is refused; with no `render` command the check is `not-runnable`. |
| `typecheck`, `lint`, `test`, `typecheckCommand` (`typecheck_command`), `lintCommand` (`lint_command`) | retired | absent | Each loads with one notice and changes nothing: `validation.<key> was retired and is ignored: the reviewer chooses the commands that verify the change, and validation.end_checks turns them on or off. Delete validation.<key>.` |

YAML — the defaults (reviewer checks on):

```yaml
validation:
  end_checks: true
```

YAML — Rust project with a pinned test command for the planner's `test` checks:

```yaml
validation:
  test_command: cargo test
  test_pattern: "*_test.rs"
```

YAML — a `render` check with `{id}` and `{out}` placeholders:

```yaml
validation:
  render: npm run tui-shots -- --scenario {id} --output {out}
```

YAML — no reviewer check before a review:

```yaml
validation:
  end_checks: false
```

YAML — show the reviewer checks on one card before any of them runs:

```yaml
validation:
  approve_checks: ask
```

### Reviewer checks

Check selection receives the task briefs, acceptance criteria, plan decisions and your later task instructions. Task reviews receive their own briefs and applicable decisions; final review receives every brief and decision.

With `end_checks: true`, the review starts with one read-only call to the review seat: the plan call. Every reviewer kind except `api` reads the run workspace itself. An `api` reviewer gets trimmed copies of the root manifests, task files, CI files and README. Each copy holds at most 8,000 characters, and all copies together hold at most 40,000. The CI files are the YAML files in `.github/workflows` and `.gitlab-ci.yml`. The reviewer answers `commands` (at most 6, ids `V1`, `V2`, … in run order, each with its reason), `declined` (each related test or check it does not run, with the reason) and `reason` (required when it chose no command). SPLITBRIEF records the answer in `state.json` (`reviewChecks`) and on the transcript, then runs each command as a `cmd` check in the run workspace:

- **Policy.** A reviewer check runs under the reviewer command policy (`reviewerCommandRefusal`, `src/engine/orchestrator/validation/reviewer-command-policy.ts`). This policy has no program allowlist: any installed program of any language can run, for example `mvn test`, `gradle test`, `composer test`, `bundle exec rspec`, `make check`, `dotnet test` or `mix test`. The policy refuses only a command that breaks one of its danger rules. The plan call states the same rules to the reviewer (`REVIEWER_COMMAND_RULES`):
  1. A command is one program and its arguments: no shell operator, substitution or redirect (`| & ; < > $ ( ) { }` or backticks), no control character (a line break or a tab), no environment variable before the program, no `cd`, no URL and no path outside the run workspace, also not after `KEY=` or attached to an option (`DESTDIR=/`, `-o/tmp/x`).
  2. Run an installed program by its name, never by path: `bin/test` and `sub/gradlew` are refused. The project's own `./gradlew` and `./mvnw` are the exception: they run as `gradle` and `mvn` under the same rules, and only when this run changed none of their wrapper files (`gradlew` and `gradle/wrapper/`, `mvnw` and `.mvn/wrapper/`). A nested wrapper stays refused. Select the subproject through the root wrapper instead: `./gradlew -p sub test`, `./gradlew :sub:test`, `./mvnw -f sub/pom.xml verify` or `./mvnw -pl sub verify`. An older run without a workspace record has no run base, so SPLITBRIEF refuses a wrapper there (`runs ./gradlew, and this run has no run base to compare its wrapper files with`). `./gradlew wrapper` is refused as `gradle wrapper`, a setup command.
  3. Shells and command wrappers are refused. These include `bash`, `env`, `sudo`, `busybox`, `toybox`, `nix-shell`, `nix` and `npm explore`. The same rule applies through `npx --no-install` and `pnpm exec`. `pnpm exec`, `yarn exec`, `bundle exec`, `uv run`, `poetry run`, `pipenv run`, `pdm run`, `hatch run`, `conda run`, `pixi run`, `rye run`, `mise exec`, `composer exec` and `python -m` are checked by the program they run.

     Forwarders may take options. The program is the first word after the subcommand that does not follow an option. A word after an option can be that option's value, so the policy checks it as a possible program start too. Thus `uv run pytest tests/test_a.py`, `bundle exec rspec spec/a_spec.rb` and `uv run --python 3.12 pytest tests/` can run, and `uv run --python 3.12 sh -c x` is refused. Write a path value as `--option=value`: `conda run -p ./env pytest` is refused as `runs a program by path`, and `conda run --prefix=./env pytest` can run. The policy refuses `--with`, `--with-editable`, `--with-requirements` and `-w` anywhere after `uv run`, including attached values and program arguments. It cannot distinguish these flags from program arguments, and they can download a package. Thus `uv run grep -w expected README.md` is refused as `has -w after uv run, where it can download a package`. Run `grep -w expected README.md` directly instead. `mise exec` runs only as `mise exec -- <program>`. An unknown first command of `pnpm` or `yarn` names a script or program, which the policy also checks.
  4. Interpreters run project scripts or modules, never inline code. Refused forms include `node -e`, `python -c`, `deno eval`, `elixir -e`, `elixir --erl`, `iex -e`, `groovy -e`, `scala -e` and `kotlin -e`. They also include `erl -eval`, `erl -s`, `erl -run`, `php -r`, `php -B`, `php -R`, `php -F` and `php -E`. Versioned interpreter names follow the same rule. Option values are not code: `perl -Mstrict t/x.t` and `php -c php.ini artisan test` can run. `php -dmemory_limit=1G artisan test` can run too. Build and task runners also refuse inline code: `make --eval`, `rake -e`, `rake --require`, `gradle --init-script`, `just --command`, `mvn exec:*`, `mvn antrun:*` (also by plugin coordinate, `mvn org.codehaus.mojo:exec-maven-plugin:*`), `rails runner`, `rails r`, `mix run -e`, `mix run --eval` and `mix eval`. `mix do` checks each task it chains as its own `mix` command. A `make` operand cannot set `SHELL`, `.SHELLFLAGS`, `MAKEFILES`, `MAKEFLAGS` or `GNUMAKEFLAGS`, or assign with `!=`.
  5. `npx` runs only as `npx --no-install <tool>`, and `npm exec` only with `--no-install`. Neither takes `--yes` or `-y`. Refused download launchers include `bunx`, `uvx`, `pnpx`, `pipx run`, `pnpm dlx`, `yarn dlx`, `bun x`, `uv tool run` and `go run <package>@<version>`. Every `corepack` command is refused. `pnpm env` and `yarn set` are refused too.
  6. Setup subcommands and goals are refused. Examples include `npm ci`, `pip install`, `go generate`, `go get`, `go mod tidy`, `mvn install`, `bundle install`, `composer install` and `cargo install`. The policy also refuses `pnpm up`, `yarn up`, `poetry lock`, `uv lock`, `bundle lock`, `cargo generate-lockfile` and `gradle wrapper`. It refuses `npm dedupe`, `pnpm dedupe`, `yarn dedupe`, `npm prune`, `pnpm prune`, `npm shrinkwrap` and `pnpm shrinkwrap`. These added verbs apply only to their named tools. Verification targets such as `make lock` can run. `npm run <script>` names a package script, so its name is not a setup verb. A bare `yarn`, `bundle` or `composer` installs, so it is refused too. The policy finds the subcommand after the tool's own options. It checks every operand up to and including the first operand that does not follow an option, because an operand after an option can be the option's value. Write the subcommand or target before the options: `cargo --locked test sync` and `pytest -v tests/ -k install` are refused, and `cargo test --locked sync` and `pytest tests/ -k install -v` can run. An option written as `--option=value` holds its own value. Thus `go -C . generate ./...`, `uv --directory . sync`, `poetry -C . install`, `composer -d . install`, `bun --cwd . install` and `pip --python .venv/bin/python install x` are refused. The check stops before `run`, `run-script` and a forwarder subcommand such as `exec`. Thus `npm --silent run update` names a package script and can run. For `npx`, the check stops before the tool, and the policy checks the tool and its arguments as one command (`runs a setup command (vitest sync)`).
  7. The policy refuses every `config`, `pkg` or `version` subcommand of `npm`, `pnpm` and `yarn`. This includes `config get` and `config list`. An `audit` with `fix` or `--fix` is refused for these tools. An audit without a fix can run.
  8. Programs that do not verify a change are refused. These include `git`, `rm`, `mv`, `cp`, `osascript`, `sed`, `tar`, `docker`, `kubectl` and system package managers. Refused network tools include `curl`, `wget`, `ssh`, `scp`, `nc`, `ncat`, `socat`, `telnet`, `ftp` and `sftp`. The policy refuses `find` with `-delete`, `-exec`, `-execdir`, `-ok` or `-okdir`. Other `find` checks can run. Only `make`, `just` and `rake` must use the project's own task file, in its directory. Options such as `make -C`, `make -f`, `make -I`, `just -d`, `just -f`, `just -g`, `rake -f`, `rake -C` and `rake -R` are refused. For `rake`, this also includes `--rakefile`, `--directory`, `--rakelibdir`, `--rakelib`, `-g` and `--system`. The row names the option, for example `uses the definition-changing option rake -f`.
  9. A package script in any `package.json` or `composer.json` of the workspace, a `Makefile`, `justfile`, `Rakefile` or `rakelib` task, a build wrapper, or an interpreter script that this run changed or created is refused (see **Changed scripts**). A test file is not a check definition: a test this run wrote or changed runs (`node --test test/new.test.js`). `deno task` tasks and `mix.exs` aliases are not compared. A `package.json` script named `start`, `stop` or `restart` is refused in every form, for example `npm start`, `pnpm --filter x start` and `yarn workspace x run start`. Such a script starts or stops the application and does not verify a change (`runs the package script start, which starts or stops the application and does not verify a change`). `bun test` and `bun build` are bun's own test runner and bundler, so they name no script. `bun run build` names the `build` script.

  SPLITBRIEF gives every refused command a `refused` row that names the rule it broke, for example `runs a program by path` or `runs a setup command (pip install)`. A plan `cmd` check keeps the plan command policy (`checkCommandRefusal`, `src/engine/orchestrator/planning/sanitize-discovered-validation.ts`). The plan command policy starts only programs on its allowlist: the package managers, `make`, `just` and every stack's `allowedCommands`. It refuses a program run by path, inline code and an interpreter script. There, a package manager runs only its bare `test` (`npm run test`, `pnpm run test` and `yarn run test` count as the bare `test`, since they run the same scripts), `npx` runs only `npx --no-install <tool>`, and `make` or `just` runs only a bare `typecheck`, `lint` or `test` target. A package script (`npm run <script>`) in a plan check needs an approved plan and a script that the project defines. The plan approval is your consent to run that script. With `workflow.approve: none` no one approves the plan, so the policy refuses `npm run lint` and the planner is told this rule. A plan whose `cmd` check the policy refuses from its text goes back to the planner once (`refused-check-command`). A refused plan check is recorded as `refused`, not as a failed check: the reviewer sees it as refused, and it is neither a pass nor a failure. A required refused check halts the run before the review (`Required checks cannot run`). A command the planner discovers passes the safety check of rung 3 in [How a `test` check resolves its command](#how-a-test-check-resolves-its-command).
- **Changed scripts.** SPLITBRIEF refuses a reviewer check whose package script, task file, build wrapper or interpreter script this run changed. It compares each definition with the run base:
  - **Package scripts.** SPLITBRIEF resolves the script name with the policy's own option tables. It compares that script in every `package.json` of the workspace, at the root and nested. A gitignored `package.json`, a `package.json` in `node_modules` and a `package.json` under a stack test directory (a fixture) are not compared. With `--prefix`, `-C`, `--dir`, `--cwd`, `-d` or `--working-dir`, SPLITBRIEF also compares the manifest in that directory, also when it is a fixture or gitignored. Thus `pnpm --filter x test`, `npm -w pkg run test`, `yarn workspace x test` and `pnpm -r test` are covered. For every `package.json` runner (`npm`, `pnpm`, `yarn` and `bun`), SPLITBRIEF also compares the `pre` and `post` scripts of the script. A runner that does not run them gets a refusal only when this run changed them. The comparison does not know which package a filter selects. When this run changed `scripts.test` in one nested `package.json`, SPLITBRIEF refuses every `test` script command, also `pnpm --filter <other> test`. The row names the nested file: `runs the package script test, which this run changed in packages/x/package.json`.
  - **Composer scripts.** SPLITBRIEF compares the `scripts` of `composer.json` as JSON values, so an array value works too. It follows `@<name>` references (`"check": ["@lint", "@test"]`), but not `@php`, `@composer` or `@putenv`. A changed `scripts-aliases` refuses every composer script command. A dependency change (`require`) stays admitted.
  - **Task files.** Changed `Makefile`, `justfile` or `Rakefile` content refuses the corresponding `make`, `just` or `rake` target. A `Rakefile` is `Rakefile`, `rakefile`, `Rakefile.rb` or `rakefile.rb`, and every file in `rakelib/` counts too. The comparison also applies through a forwarder: `uv run make test` and `bundle exec rake test`.
  - **Build wrappers.** `./gradlew` compares `gradlew` and every file of `gradle/wrapper/`. `./mvnw` compares `mvnw` and every file of `.mvn/wrapper/`, also a gitignored one. A symbolic link in the wrapper directory or in `rakelib/` is compared by the file it names. When the wrapper directory, `rakelib/` or one of their parent directories is a symbolic link, SPLITBRIEF refuses the check (`runs ./gradlew on gradle/wrapper, which is a symbolic link`). A project that gitignores `.mvn/wrapper/maven-wrapper.jar` has every `./mvnw` check refused while that jar is present, because the run base does not hold it. Use `mvn` there. In worktree mode, the first `./mvnw` check downloads that jar, so a later `./mvnw` check in the same run is refused.
  - **Interpreter scripts.** These include `python manage.py test`, `bun x.ts` and `deno run x.ts`, also through `npx`, `bundle exec` or `uv run`. SPLITBRIEF refuses a changed interpreter script, or a script outside the run workspace.

  A file that this run created, or a file that the run base does not hold, is refused with the reason `which the run base does not hold`. The run base snapshot holds no gitignored file. Thus in checkout mode, `php vendor/bin/phpunit` is refused (`runs vendor/bin/phpunit, which the run base does not hold`). In worktree mode, `vendor/` is absent anyway. Run `composer test` (a composer script) or `composer exec phpunit` instead.

  SPLITBRIEF does not compare these definitions:
  - `deno task` tasks. Run `deno test`, `deno lint`, `deno check` or `deno fmt --check` directly.
  - `mix.exs` aliases. A changed alias can redefine `mix test` without this refusal.
  - Rails `lib/tasks`, and the files that a `Rakefile` or `Makefile` loads with `require`, `import` or `include`.
  - A script that a package script calls in its text. For `"test": "npm run lint && vitest"`, SPLITBRIEF compares `test`, not `lint`.
  - `turbo`, `nx` or `lerna` called directly. Through a root package script, SPLITBRIEF compares them.

  Stack test patterns and test directories identify test files, which SPLITBRIEF never compares. This refusal applies only to reviewer checks. Plan and task checks may run a script that the plan adds.

  SPLITBRIEF does not compare build manifests (`pom.xml`, `build.gradle`, `Gemfile`, `mix.exs`, `build.rs`) with the run base. It also does not compare `composer.json` as a dependency manifest: only its `scripts` and `scripts-aliases` are compared. A dependency change edits these files, and a refusal would block the check that verifies it. The refusal guards against a swapped check definition. It does not establish trusted execution.
- **Base re-run.** A red reviewer check runs again at the run base with the same command text. A failure key red there too is pre-existing. Failure keys include both failing test names and diagnostic lines, with repeats removed. An output that lists only whole paths is keyed by those paths. Keys come from the full process capture. An incomplete capture gives one placeholder key. A fix command must pass when its capture is incomplete. A timeout has no failure key, and a red with no test name and no diagnostic line has none either. Two such reds do not prove the same failure, even with the same exit code. When the run base re-run is red and either run has no failure key, no failure is pre-existing: the Checks Log line reads `failed (<keys>), not verified at the run base (<reason>); the reviewer decides`. The reason is, for example, `both runs timed out`, `both runs exited with code 1 without diagnostics` or `the workspace run timed out`. When the output prints an error line, the reason quotes the first one: `both runs exited with code 1: Error: Cannot find module 'src'`. Such a red keeps its keys new: it stops the list, and it becomes a pending input that says SPLITBRIEF could not verify the same failure. The reviewer decides from the output: such an input that it rejects with a reason no longer blocks the review, and one that it does not reject still does. A reviewer check with new failures blocks the review even when the reviewer rejects it. The `Base re-run` row counts the failures in three parts: `1 new, 2 pre-existing`, or `1 not verified at the run base · both runs timed out`. An older run without a workspace record has no run base, so every failure is new.
- **Approval.** With `approve_checks: ask`, the plan call and its `Reviewer checks · chose …` row come first. Then one card shows the chosen commands, each with its reason: `Reviewer checks · chose 2 · none has run yet`, with **Run all** and **Skip all**. Only `⏎` answers the card; `Tab` moves focus to the composer. **Run all** runs the reviewer checks as with `auto`. **Skip all** runs none of them. A card closed without an answer also runs none; a stop during the card stops the review instead. A headless run with `ask` opens no card and runs none of them. In each case one warning row names the commands and the reason: `Reviewer checks · not run V1, V2 · Skip all was chosen on the card`, `… · the reviewer checks card closed without an answer` or `… · validation.approve_checks is ask and this run has no screen to ask on`. `state.reviewChecks.skipped` records the reason. The verdict call is told that none of the commands ran and that none is a pass: it marks a criterion that only these commands verify as unverified. A skipped command never becomes a registered check, so a fix task's gate does not run it. With `workflow.review: task`, each task review shows its own card.
- **Stop rule.** The first reviewer check with new failures stops the list. Each later one gets a `not run · <id> failed` row.
- **Verdict.** Every result goes to the reviewer's verdict call in a `## Reviewer checks` section, and each new or not verified failure becomes a pending input (`V1.1`, …). A failed plan call (a transport error or a protocol error) halts the review the same way a failed verdict call does; it is never a pass.

With `workflow.review: task`, the same plan call is scoped to the task's changed files: the reviewer chooses the reviewer checks that run the related tests, not the whole suite, and names each related test it does not run in `declined`.

### How a `test` check resolves its command

A planner `test` check resolves its command through one ladder — `config → manifest → discovered → stack default → none` — and takes the first rung that yields a command:

1. **Project config** — `test_command` overrides everything.
2. **Manifest** — a `package.json` `test` script (`npm test`), a `Makefile` or `justfile` `test` target, or the `[tool.pytest.ini_options]` section of `pyproject.toml` (`pytest`). Deterministic, and read before any model output.
3. **Planner-discovered** — in the planning session, the planner reports the project's test toolchain in the `validation` block of `plan.json` (`language`, `test`, `testPattern`). `testPattern` is a file name pattern with one `*`, such as `*.test.js` or `test_*.py`. It has no directory part (`/` or `\`) and no `..`. SPLITBRIEF searches beside the changed file and in the stack's test folders. SPLITBRIEF emits `discovered_validation_refused` when it refuses a discovered pattern. It uses the configured pattern, if present. Otherwise, it uses the stack's patterns. `sanitizeDiscoveredValidation` (`src/engine/orchestrator/planning/sanitize-discovered-validation.ts`) checks it, and the result is persisted to `WorkflowState.discoveredValidation`. A discovered command passes a safety check first. Among its rules, a package manager passes only as `<manager> test` with no path after it, `make` and `just` only as `<runner> test`, `uv run` and `poetry run` only before a Python stack tool, and `node` or `python` only without a script, a module other than a Python stack tool, or inline code. A refused command becomes a warning (code `discovered_validation_refused`) that names the reason; the transcript shows it as one dim `Validation` row, a note on the plan rather than a fault. The check uses config, the manifest or the stack default.
4. **Stack default** — the row `detectStack` picked from `src/core/validation/stacks/` (`validation.stack` pins it): rust, go, python, typescript or javascript, in that marker order. Per-stack test commands are tabulated in [FEATURES.md §Validation pipeline](./FEATURES.md#validation-pipeline--checkpoints).
5. **None** — SPLITBRIEF records the check as `not-runnable` with the reason `no test command for an unrecognised stack`, never as passed. A required check that is `not-runnable` halts the run with `required-checks-unrunnable`. SPLITBRIEF never guesses `npm test` on a project that is neither JavaScript nor TypeScript. The reviewer checks do not use this ladder. The reviewer names their commands, and the reviewer command policy admits any installed program of any language.

A command from rung 4, or from rung 2 on a recognised stack, is narrowed to the tests the check's file affects (`npm test -- <file>`, `pytest <file>`, `go test ./<pkg>/`, `cargo test -- <name>`). An explicit `test_command` from rung 1 and a discovered command from rung 3 run as written. To run a test through another script, name it as a `cmd` check (`npm run test:integration -- <file>`).

### Pre-existing failures

No check runs before the first task. Only a red reviewer check asks the run base about its failure. Plan checks, task checks and the Apply re-check do not re-run at the run base. SPLITBRIEF builds the run base copy outside the checkout the way it builds the run workspace (`withRunBaseTree`, `src/engine/orchestrator/isolation/base-tree.ts`): a detached Git worktree at the commit the run started from, then the recorded snapshot on top, which includes the uncommitted files the run started with. The checkout supplies that commit's Git history, nested `.splitbrief/` files, file modes and symlinks. Snapshot reconciliation preserves the checked-out mode when replacing an existing regular file's contents. The snapshot records contents only; it does not reproduce uncommitted mode changes or recreate symlinks, and new regular files get default permissions. The base tree adds no Git ref and is removed after the re-run.

Any failure preparing the base tree settles the base re-run row as *not verified at the run base* with the error as its detail. Preparation includes directory creation, listing stale trees, Git checkout, submodule initialization, snapshot reconciliation and linking `node_modules`. The reviewer decides, no base command runs and the check gets no `base` field. If cleanup also fails, the row's detail includes both errors. A cleanup failure after a completed base command settles the row as *not verified at the run base*, with the cleanup error visible. The review continues; its failure keys stay unverified and the check has no `base` field, even though the command completed. A callback error propagates unchanged, with any cleanup failure reported as a warning that names the tree.

Each base tree is a `base-<pid>-XXXXXX` directory under `$XDG_STATE_HOME/splitbrief/bases/` (`~/.local/state/splitbrief/bases/` by default, `runBaseTreesRoot`). Every base re-run, including staged-copy and unborn runs with no base commit, first removes trees whose PID belongs to no live process. A recycled PID keeps its tree until that process ends too. For a registered worktree, SPLITBRIEF resolves its owning repository through the tree's `.git` file and runs `git worktree remove --force <dir>` there. This removes both the directory and its registration, even when it belongs to another project. If the gitdir named in `.git` no longer exists, SPLITBRIEF removes the tree from disk because its registration is gone. Snapshot-only copies and directories where worktree creation never ran are also removed from disk. There is no repository-wide prune; unrelated registrations remain. A stale tree that cannot be removed, such as a locked worktree, is reported as a warning that names the tree. The sweep continues with the other stale trees, and the current base re-run runs and compares its keys as usual, so one broken leftover cannot block later base re-runs. Older `base-*` directories without a PID stay untouched and need one-time manual removal; see [Troubleshooting](./TROUBLESHOOTING.md#symptom-the-base-re-run-is-red-although-the-same-commit-passes-in-your-checkout).

A run that recorded no base commit (a staged-copy run, or a repository with no commit) gets only the snapshot copy, without Git history or the committed file modes and symlinks. A red base re-run in such a copy is *not verified at the run base*; its keys are not compared. SPLITBRIEF records the base re-run output, bounded like the workspace output, in the check's `base` field in `evidence.json`. A reviewer check re-runs with the same command text and compares failure keys: both the failing test names and the diagnostic lines, with repeats removed. Diagnostic keys keep the path, position and message. SPLITBRIEF reads the keys from the whole captured output of each run, not from the bounded output tail it records, so a failure list at the end of a long run is not lost. An incomplete capture gives one placeholder key and requires a passing fix command. A timeout, or a red with no failure key, is never pre-existing; output such as an `npm` script banner or a `make` error summary names no file and gives no key: when the base re-run is red too, the failure is *not verified at the run base*, and the reviewer decides (see **Base re-run** above).

The result carries its matching keys in `preExisting`. Only new failures become review defects. The Checks Log names the pre-existing keys, and the reviewer reports them without raising a finding against the run.

### What a check can reach

A check runs the project's own code. Plan checks, reviewer checks, base re-runs, the checks of a fix task, `render` checks and the formatter start the project's tests, build scripts, `Makefile` recipes and package scripts. These commands run with your user's permissions, in the run workspace. SPLITBRIEF has no OS sandbox for them.

SPLITBRIEF isolates these things for every command it runs itself (`runCommand`, `src/lib/process/spawn/run-command.ts`):

- **Working directory.** A check runs in the run workspace. In worktree and staged-copy mode, the run workspace is not your checkout. In checkout mode (`workflow.isolation: none`), the run workspace is your checkout. A base re-run runs in a disposable run base copy outside the checkout.
- **Environment.** Each check inherits all defined environment variables through `createCommandEnv` (`src/lib/process/spawn/child-env.ts`). SPLITBRIEF drops credential names, credential selectors and helpers. The filter removes provider keys, cloud credentials, tokens, AWS profiles, credential files, SSH sockets, askpass helpers and npm userconfig selectors. The same rule applies to every command SPLITBRIEF runs itself, including the `--version` probe. The real `HOME` and `USERPROFILE` stay; `PATH` keeps only absolute entries. Secrets under ordinary names still reach checks, including passwords in `DATABASE_URL`, proxy URLs with user:password, and freely named variables.
- **Time.** Each command stops at `timeout_ms`.
- **Output.** SPLITBRIEF keeps a bounded part of the output of each command.
- **Process group.** Each command starts in its own process group. At a timeout or a stop, SPLITBRIEF kills the whole group.

SPLITBRIEF does not isolate these things:

- **File system.** A check can read and write every file your user can, also under your real `HOME`: `~/.ssh`, `~/.npmrc`, cloud credential files and your other projects. An admitted `./gradlew` or `./mvnw` downloads the distribution that its properties file names into `~/.gradle/wrapper/dists` or `~/.m2/wrapper/dists`, as `gradle` already writes under the real `HOME`. With no `distributionSha256Sum`, the integrity of that download rests on TLS to its URL. The first download can reach `validation.timeout_ms`: run `./gradlew --version` once yourself, or raise `timeout_ms`.
- **Network.** A check can open any connection.
- **Other processes.** A check can see and signal the other processes of your user.

The seats are a different case. The `claude-code` implementer runs its shell commands in Claude Code's own sandbox, and the seat stops when that sandbox cannot start. [PLANNERS-AND-IMPLEMENTERS.md §Posture, trust, and auth](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth) gives the isolation of each seat. With `approve_checks: ask` you see each reviewer check before it runs. The card shows the command, not the code it runs: an unchanged `npm test` still runs the test files this run wrote.

**See also:** [WORKFLOW.md](./WORKFLOW.md) (where validation sits in the loop), `src/engine/orchestrator/review-checks.ts`, `src/engine/orchestrator/validation/run-checks.ts`.

---

## 5. `workflow`

Automatic staging, commits, and index checkpoints are not supported; commit changes manually.

Plan approval, review cadence, retries, git, isolation and transcript compaction. Every run plans in one session ([WORKFLOW.md](./WORKFLOW.md#3-the-planning-session)); there are no workflow modes.

### Schema

```ts
workflow: {
  // Plan approval
  approve?:               'plan' | 'none'; // default plan

  // Review cadence
  review?:                'end' | 'task'; // default end

  // Git
  git?: {
    commitStrategy?:      'none'; // retired input, removed on load with no notice
    createBranch?:        boolean;
  };

  // The workspace used by every writer and validation
  isolation?:             'worktree' | 'staged-copy' | 'none'; // default worktree

  // Transcript
  compactionThreshold?:   number;  // int >= 10
  compactionFormat:       'auto' | 'freeform' | 'structured'; // default auto

  // Compatibility only; no rendered effect
  showSpend?:             boolean; // default true

  // Retired: each loads with one notice and is ignored (§16)
  mode?:                  unknown;
  speckit?:               unknown;
  briefReview?:           unknown;
  taskReview?:            unknown;
  maxRetries?:            unknown;
  driftChainThreshold?:   unknown;
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `approve` | enum | `plan` | `plan`: the plan card waits for your approval before the build starts. `none`: the plan goes straight to the build. The retired values `all`, `spec` and `default` load as `plan` with one notice (§16). Approving the plan never overrides a failed plan check, and a write to a protected path still asks during the build under either value. |
| `review` | `end` \| `task` | `end` | `end`: an ordinary brief runs no check. It runs only the checks a caller names, such as a consult `verify`. The final review runs the reviewer checks (`validation.end_checks`). The first reviewer check with new failures stops the list, and the reviewer turns its failures into fix work. `task`: each task runs its own checks and its due checks, then its review. That review runs the reviewer checks scoped to the related tests of the task's changed files. The final review then runs the reviewer checks for the whole run. |
| `maxRetries` (`max_retries`) | retired | absent | Loads with one notice and changes nothing: `workflow.max_retries was retired and is ignored: the lineage attempt allowance bounds the ladder now. Delete workflow.max_retries.` The ladder is one local retry then the planner's consult; the lineage's bounds and grant live in `BOUNDS` (`src/core/pipeline-spec/bounds.ts`). |
| `git.commitStrategy` | retired | absent | Legacy `none` loads with no notice and is removed from the loaded config; `checkpoint` and `per-task` are rejected. Omit the field. |
| `git.createBranch` | boolean | `false` | Auto-create `splitbrief/<slug>` branch at workflow start. |
| `isolation` | enum | `worktree` | Where every writer works: one linked git `worktree` or one `staged-copy` per run, used by tasks, retries, validation and code review until [Apply](./WORKFLOW.md#apply); or `none`, your checkout itself, with no Apply. Unset reads `worktree`. `splitbrief init` does not write this key. |
| `driftChainThreshold` (`drift_chain_threshold`) | retired | absent | Loads with one notice and changes nothing: SPLITBRIEF no longer scores drift chains. Delete it. |
| `compactionThreshold` | int >= 10 | unset | On resume, auto-compact persisted transcript context when compacted message count exceeds this threshold and the planner supports self-summarisation. |
| `compactionFormat` | enum | `auto` | Summary format for transcript compaction: `auto` selects structured JSON for `api` planners, freeform text for `cli`, `shell`, and `agent`; `freeform` preserves legacy markdown/text summaries; `structured` requires Zod-validated JSON and falls back to freeform text if validation fails. |
| `showSpend` (`show_spend`) | compatibility boolean | `true` | Accepted in config and changes nothing: no screen reads it. `/copy cost` copies the same spend text `/usage` reads rather than answering a switched-off display. Open `/usage` for usage details; there is no Show spend setting. |
| `mode`, `speckit`, `brief_review`, `task_review`, `max_retries` | retired | absent | Each loads with one notice and changes nothing (§16). Delete them. |

`resolveApproveLevel()` (`src/core/config/runtime/resolve.ts`) picks the level from the config, else `plan`; a run saves the level it ran with in `state.approve` only as a record. There is no CLI flag for it: `--approve` was removed. A headless run (`--json`, `--plain`) approves the plan card unattended; set `approve: none` to skip the card.

### Implementer isolation

Every writer uses one run workspace. `cli` and `agent` write there directly; SPLITBRIEF writes extracted `api` and `shell` code there too. `workflow.isolation` chooses that workspace. In Settings, Space cycles Isolation through worktree, staged copy and your checkout, saving `worktree`, `staged-copy` and `none`. The deterministic validation pipeline runs in that directory. The implementer's own checks do not replace it. See [workspace data flow](./HOW-IT-WORKS.md#run-workspace-and-apply).

| Value | What it does | Cost |
|---|---|---|
| `worktree` (default) | One linked git worktree with its own branch and history. Installed Node dependencies are linked. Python virtualenvs, Go caches and Rust target directories are not linked. | One worktree creation per run. |
| `staged-copy` | One project copy per run, reused by tasks, retries and continuation. It excludes `.git`, `node_modules`, `.splitbrief/`, `.trees/` and credential files. It has no git history or installed dependencies. | One full project copy per run. |
| `none` (shown as "your checkout") | The implementer of every transport works in your checkout itself. SPLITBRIEF writes an extracted-code implementer's code there. Validation, checks and review run there. There is no worktree, no workspace record and no Apply: a passing review closes the run. | No setup. Your checkout holds the run's edits as they happen. |

The fallback also creates one staged copy per run. SPLITBRIEF uses it when the project has no git repository or commit, or when worktree creation fails. The worktree never switches to the checkout automatically. In a git project, the copy uses git's tracked and untracked file list with its ignore rules. A fixture excluded by those rules is absent from the copy. The no-git fallback copies ordinary project files with the same internal exclusions.

A staged copy captures its task-start and attempt snapshots entry by entry, without git. A snapshot holds each file's hash and mode. The bytes go once into a content-addressed store at `.splitbrief/sessions/<id>/entries/`. A no-git project therefore runs past its first brief, and a restart restores from that store. A no-git checkout in `none` uses the same snapshots.

**Checkout mode (`none`).** The run records its mode once in `state.json` (`workspace.kind: 'checkout'`). A later config change does not move a recorded run. Do not edit the checkout while a brief runs. An edit or a commit between two implementer calls publishes a warning, and the next checks read the checkout as it is. A git write during a call halts ([Isolation checks](./APPROVAL-AND-RECOVERY.md#isolation-checks)). The implementer sees your `.env` and your gitignored files, because it works in the checkout. Every revert SPLITBRIEF makes in the checkout first saves the bytes it replaces under `.splitbrief/sessions/<id>/reverted/<stamp>/`.

Readiness checks for stacks the worktree cannot serve. These include linked Node workspace packages (`package.json` workspaces or `pnpm-workspace.yaml`), a Python editable install in a virtualenv under the project, `go.work`, and a Cargo workspace with a checkout `target/` directory. Links can resolve to checkout sources instead of workspace changes. With `workflow.isolation` unset, each one is a blocker that recommends the checkout: set `workflow.isolation: none` (recommended) or `workflow.isolation: worktree` to keep the worktree. Writing the key is the one-time confirmation. An explicit `worktree` or `staged-copy` keeps these as warnings, and `none` silences them. Readiness never selects another mode automatically. Verify that configured checks assess the workspace candidate. The staged-copy fallback does not supply missing dependencies.

The workspace survives while the run stays open. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) owns its worktree location and persistence. [Apply](./WORKFLOW.md#apply) owns checkout integration and closure. [Isolation checks](./APPROVAL-AND-RECOVERY.md#isolation-checks) describe writes that halt and reads that are logged. No strategy provides shell or network confinement.

The worktree PATH includes the linked `node_modules/.bin`, resolved to its real path in the project. When the repository already ignores `node_modules`, SPLITBRIEF adds a rooted `/node_modules` line to the shared `.git/info/exclude`. This keeps the dependency symlink out of change detection. The entry uses a `# splitbrief run isolation <session id>` marker for cleanup. A repository that does not ignore `node_modules` falls back to `staged-copy`. If dependency linking fails during workspace acquisition, acquisition keeps the workspace usable and reports the error as a warning. During a base re-run, that error instead settles the row as *not verified at the run base*.

```yaml
workflow:
  isolation: worktree
```

### YAML examples

Minimal (the plan waits for your approval):

```yaml
workflow:
  approve: plan
```

Run due checks after each task, then review that task. The task review runs the reviewer checks for the related tests of its changed files. The final review runs the reviewer checks for the whole run:

```yaml
workflow:
  approve: plan
  review: task
```

Both cadences use `runFinalReviewPhase`, which publishes `review_started` and one `review_completed` per start. The events name the review seat's tool, optional model, and nonempty effort axes. Task reviews carry `afterTaskId`; final reviews omit it. The completion records the verdict, available `blocking`, `minor`, and `outOfScope` counts, and duration. A failed call records `no-verdict`; a stop records `stopped`; neither carries findings. A `preReview` halt publishes neither event.

Review events never fire hooks. `workflow_complete` fires `on_complete`. The review seat publishes no `planner_status`, even when the planner holds it. See [the review event fields](./ENGINE.md#key-event-shapes).

Plan approval on the current branch:

```yaml
workflow:
  approve: plan
  git:
    createBranch: false
```

Headless CI:

```yaml
workflow:
  approve: none
```

**When to use what:**
- `git.createBranch: true` — when running SPLITBRIEF in CI or against `main` and you don't want the changes landing on the current branch.
- `isolation: worktree` (the default) creates a run workspace with installed Node dependencies linked, and your checkout receives the result at Apply. Choose `staged-copy` when a linked worktree cannot serve the project and a copy can. Both strategies need checks that can run inside the workspace.
- `isolation: none` when the stack only works in the checkout (linked workspaces, editable installs, a shared build cache), or when you want the edits in your project as they happen. Do not edit the checkout while a brief runs.

**See also:** [WORKFLOW.md](./WORKFLOW.md), [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#the-plan-card). The plan approval level is set with `workflow.approve`, the review cadence with `workflow.review`.

---

## 6. `escalation` (retired)

The `escalation` block is retired. The planner's consult replaces the intermediate tier: when a brief fails after its one local retry, reports `blocked`, or is stale, SPLITBRIEF asks the planner for one typed answer — `guidance`, `rewrite-task`, `split-task`, `verify` or `ask-user` — instead of running a fixed tier chain. The lineage's 2 consults and 8 attempts and the run's 10 planner calls bound the ladder; `continue` on a spent bound grants the extra allowance ([APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#escalation)).

A config that still carries the block loads with one notice and changes nothing: `escalation was retired and is ignored: the planner's consult replaces the intermediate tier. Delete escalation.` Delete the block. There is no intermediate provider or model to configure, and the Crew section of Settings never had a row for it.

**Pricing knownness.** Provider calls follow the same knownness rules as every other call. Unknown provider cost is not zero. A call whose price does not resolve leaves the run's USD figure absent or unknown, never `0`, and SPLITBRIEF never invents a rate to fill the gap.

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
| `include` | string[] | every TypeScript, JavaScript, Python, Go and Rust file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`; `ALL_KNOWN_EXTENSIONS`, `src/engine/codebase/languages.ts`) | Glob patterns relative to project root |
| `exclude` | string[] | the directories `.git`, `.splitbrief`, `node_modules`, `.trees` and `dist` at any depth, and files that match `\.test\.tsx?$` | **Regex strings** (note: not globs), matched against project-relative file and directory paths. Your patterns add to the defaults; they do not replace them (`src/engine/codebase/discover-files.ts`). |

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

Protected-path confirmation for file writes during the build. It is separate from `workflow.approve`, which controls the plan card. The block is strict: an unknown key fails the load.

### Schema

```ts
approval: {
  feedRejectionsToPlanner:    boolean;        // default true
  allowedPaths?:              string[];
  enabled?:                   unknown;        // retired: one notice, ignored (§16)
  tiers?:                     unknown;        // retired: one notice, ignored (§16)
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | retired | absent | Loads with one notice and changes nothing: a write to a protected path asks whatever it says, and no other write asks. Delete it. |
| `feedRejectionsToPlanner` | boolean | `true` | When the user rejects an op, send the rejection back to the planner so it can adapt. |

### approval.allowedPaths

Type: `string[]` (optional)
Default: not set (no paths pre-approved)

Glob patterns for paths that are always treated as in-scope for writes. Writes to matching files are classified as `write_in_scope` regardless of the current task's `inBounds`.

```yaml
approval:
  allowedPaths:
    - 'src/**'        # all files under src/
    - 'tests/**'      # all files under tests/
    - '*.md'          # all markdown files at any depth
```

This is a **union** with task-level `scope.inBounds` — either match is sufficient for in-scope classification. `allowedPaths` widens scope, never narrows it.

Supported glob patterns: exact match (`src/config.ts`), recursive directory (`src/**`), single-level directory (`src/*`), extension wildcard (`*.ts`), and simple star (`src/utils/*`).

Note: `allowedPaths` only affects the action *class* (`write_in_scope` vs `write_out_of_scope`). Neither class asks.

**The rule is fixed.** A write to a protected path — `destructive` (`.git`, `.splitbrief`), `sensitive_change` (CI configuration, env and key files) or `package_change` (manifests and lockfiles) — asks, and no other write does. `approval.enabled` is a retired key that loads with one notice and is ignored. `--yolo` is a removed flag. A confirmation holds for the same path for the rest of the run, and approving a plan that lists the write under its protected operations confirms it in advance. There are no sticky grants and no tier overrides: `approval.tiers` is a retired key that loads with one notice and is ignored. There is no tier for validation, shell commands, or network access; SPLITBRIEF does not sandbox those. See [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation).

YAML — strict:

```yaml
approval:
  feedRejectionsToPlanner: true
```

**When to use:** set `feedRejectionsToPlanner: false` when a rejected protected write should not reach the planner's next prompt.

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
    - id: usage
      label: "Show token usage"
      command: /usage
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
| `idleKillMs` | number | none | Opt-in: stop the process after this much silence. A lone value must be at least the effective warn (`idleWarnMs` when set, else `300000`) |
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

### What checks receive

The commands SPLITBRIEF runs itself get a sanitized environment. [§4 What a check can reach](#what-a-check-can-reach) is its one home: the kept variables, the dropped ones, and what to do when a test needs a variable from your shell.

### What SPLITBRIEF's git calls receive

SPLITBRIEF runs its own git calls through simple-git 4 (`src/lib/git/client.ts`). simple-git removes every `GIT_*` variable and `EDITOR`, `VISUAL`, `PAGER` and `PREFIX` from the environment of each call. It also sets `GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS=true`.

SPLITBRIEF keeps the variables that reach a remote or a checkout filter:

- Protocol: `GIT_ALLOW_PROTOCOL`, `GIT_PROTOCOL_FROM_USER`.
- SSH and prompts: `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_TERMINAL_PROMPT`.
- Proxy: `GIT_PROXY_COMMAND`, `GIT_PROXY_SSL_CAINFO`, `GIT_PROXY_SSL_CERT`, `GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED`, `GIT_PROXY_SSL_KEY`.
- SSL: `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `GIT_SSL_CERT`, `GIT_SSL_CERT_PASSWORD_PROTECTED`, `GIT_SSL_CIPHER_LIST`, `GIT_SSL_KEY`, `GIT_SSL_NO_VERIFY`, `GIT_SSL_VERSION`.
- HTTP: `GIT_HTTP_LOW_SPEED_LIMIT`, `GIT_HTTP_LOW_SPEED_TIME`, `GIT_HTTP_MAX_REQUESTS`, `GIT_HTTP_PROXY_AUTHMETHOD`, `GIT_HTTP_USER_AGENT`, `GIT_CURL_FTP_NO_EPSV`.
- Git LFS checkout: `GIT_LFS_SKIP_SMUDGE`, `GIT_LFS_SKIP_DOWNLOAD_ERRORS`.

Every other `GIT_*` variable does not reach git, for example `GIT_CONFIG_GLOBAL`, `GIT_TRACE` or `GIT_EDITOR`. Put a setting that SPLITBRIEF's git calls need in `~/.gitconfig`, `~/.config/git/config` or the repository config.

### Runtime overrides

| Variable | Purpose |
|---|---|
| `SPLITBRIEF_CONTEXT_LENGTH` | Override SPLITBRIEF's detected implementer context length (`src/engine/providers/capabilities.ts`). Applies only to the default implementer profile; profiles that declare no window otherwise route at the shared default. This sizes prompt budgets only; it does not change Ollama `num_ctx` or any provider-side model limit. |

### TUI / process

| Variable | Purpose |
|---|---|
| `CI` | If truthy, suppress fullscreen/alternate-screen rendering. Use `--json` or `--plain` when stdout must be machine-readable. |
| `TERM_PROGRAM` | Kitty keyboard-protocol detection for advanced key bindings. |
| `FORCE_HYPERLINK` | `1` (or any non-empty value other than `0`/`false`) forces OSC 8 hyperlink emission for markdown links; `0`/`false` forces plain styled labels; otherwise SPLITBRIEF sniffs `TERM_PROGRAM`/`VTE_VERSION`/`KITTY_WINDOW_ID`/`WT_SESSION`/`TERM` (Apple Terminal is excluded from auto-detection). The only configuration-surface change of the file-link feature — no YAML key (`src/lib/terminal/hyperlinks.ts`). |
| `SPLITBRIEF_REDUCE_MOTION` / `REDUCE_MOTION` | Set to `1` to pin TUI spinner frames and slow status ticks to 1s (`src/lib/terminal/reduce-motion.ts`). |
| `VISUAL` | Explicit external editor for the plan card's `plan.json` (`Ctrl+O`) and for **Show diff**. Takes precedence over every other editor source, including detected GUI editors. |
| `EDITOR` | External editor fallback when `VISUAL` is unset or empty. For `plan.json`, non-terminal values are used before auto-detected GUI editors; terminal editors such as `vim` or `nano` are used only after GUI detection and macOS `open -W -t` fail. Implicit GUI detection probes only safe absolute `PATH` segments and honors Windows `PATHEXT` plus `.cmd`, `.exe`, and `.bat` shims. **Show diff** uses `EDITOR` as it is and never detects a GUI editor. |
| `PAGER` | The pager for **Show diff** when `VISUAL` and `EDITOR` are both unset or empty. When `PAGER` is unset too, Show diff uses `less`. Show diff keeps `less` open on a short patch, even when `LESS` contains `F`, and the `less` prompt reads `Press q to return.` |

---

## 14. CLI flags

Declared in `src/cli/options.ts` for workflow commands (`start`, `resume`, `continue`) plus command-specific registrations. These flags **override** the matching config field for the current invocation only. [`CLI-REFERENCE.md`](./CLI-REFERENCE.md) is the canonical flag matrix.

| Flag | Purpose | Commands |
|---|---|---|
| `--model <m>` | Alias for `--implementer-model` | start, resume, continue |
| `--provider <p>` | Alias for `--implementer` | start, resume, continue |
| `--planner <tool>` | Planner tool override | start, resume, continue |
| `--planner-model <m>` | Planner model override | start, resume, continue |
| `--planner-command <cmd>` | Custom planner command (kind=shell) | start, resume, continue |
| `--planner-api-base <url>` | Planner API base URL (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--planner-api-key-env <var>` | Planner API key env var, stored as `env:<var>` (kind=api only; warns + ignored otherwise) | start, resume, continue |
| `--planner-args <arg>` | Append a planner CLI/shell arg (repeatable; kind=cli/shell/agent); authority-bearing flags are refused before spawn | start, resume, continue |
| `--planner-output-format <format>` | Planner output format (`stream-json` \| `jsonl` \| `text` \| `opencode`); an admitted CLI keeps its own native parser and terminal protocol | start, resume, continue |
| `--planner-context-length <tokens>` | Planner context length in tokens. Every kind keeps the value; only the `api` kind uses it, as the application context its PLAN packet is measured against | start, resume, continue |
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
| `--reviewer-context-length <tokens>` | Reviewer context length in tokens. Every kind keeps the value; only the `api` kind uses it, as the application context its REVIEW packet is measured against | start, resume, continue |
| `--reviewer-effort <level>` | Reviewer effort hint (`none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`). The seat's tool accepts a subset and reports what it rejects; dropped with a warning on seats that cannot send it. | start, resume, continue |
| `--project <dir>` | Project directory (default cwd) | most commands |
| `--no-fullscreen` | Disable alt-screen buffer | start, resume, continue |
| `--no-mouse` | Disable mouse tracking | start, resume, continue |
| `--hover` | Opt in to hover highlighting (requires mouse + fullscreen) | start, resume, continue |
| `--allow-hooks` | Trust hook config without prompting (CI) | start, resume, continue, spec |
| `--allow-repo-runners` | Trust repo-local shell/agent runner execution from project config, including profiles and project-local PATH/script resolution | start, resume, continue, spec |
| `--allow-unverified-auth` | Let a headless run proceed with unverified CLI authentication (no effect interactively) | start, resume, continue |
| `--json` | Headless: NDJSON `EngineEvent`s to stdout, no TUI | start, resume, continue |
| `--plain` | Headless: plain lines instead of NDJSON, no TUI; the line shapes are in [CLI-REFERENCE.md §Plain output stream](./CLI-REFERENCE.md#plain-output-stream---plain). Refuses to run alongside `--json` (exit `2`) | start, resume, continue |
| `--yolo` | Removed; passing it fails with a removed-flag error | none |
| `--skills <ids>` | Comma-separated skill ids to attach to every seat (unknown id → exit `2`); on resume and continue, for that continue only | start (headless), resume, continue |
| `--action <action>` | Apply an action to the pending recovery before continuing: `skip`, `retry`, or `switch-seat:<tool>[:<model>][@<word>]`, where `@<word>` is the variant on opencode or kilo-code and the effort on other tools | continue |
| `--on-seat-down <policy>` | Headless: `halt` stops on a seat-down halt; `switch` applies the seat's declared `fallback`. Unset applies a declared fallback too. See [Seat down](./APPROVAL-AND-RECOVERY.md#seat-down) | start, resume, continue |
| `--reconfigure` | Overwrite existing config | init |

`--mode` and `--approve` were removed. Passing either fails with exit code 1 before any work starts: `--mode was removed: every run plans in one session`, `--approve was removed: set workflow.approve (plan or none) in the config` (`RETIRED_FLAGS`, `src/cli/unknown-command.ts`).

---

## 15. Validation behavior

Config is validated on every load (`src/core/config/load/io.ts:loadConfig`).

- Errors → `ConfigError` (`src/core/config/errors.ts`) → top-level catch in `src/cli/setup.ts` → exit code 1.
- Non-fatal warnings on stderr (`warnStderr` in `src/lib/warn.ts`):
  - Config file permission warning on POSIX (`config-file-permissions`; see §1 **Permissions**).
  - A `shell` or `agent` runner passing `{prompt}` through argv instead of stdin (`securityWarnings`, `src/core/config/load/validation/warnings.ts`).

Unknown top-level keys are tolerated, apart from the removed root keys named in §16, which fail the load; unknown nested keys in strict blocks (`workflow` and its `git` block, `hooks`, `codebase`, `approval`, every runner config, `PlannerCapabilities`) fail validation. The retired keys of §16 are not unknown: each loads with one notice. Each unrecognized key is reported at its own dotted path — `workflow.autoApproveSpec: Unknown config key …`, not just `workflow` — and every error found in one load is reported together, one line per path, so a config with several problems is not corrected one attempt at a time.

---

## 16. Config version

`version: 3` is the only accepted schema version. A config carrying any other version — or none at all — is rejected at load with `Unsupported config version: <value>. Supported: 3.` Run `splitbrief init --reconfigure` to write a current config; there is no in-memory upgrade path.

Fields that older shapes used are gone rather than aliased — `workflow.autoApproveSpec` / `workflow.autoApprovePlan` are replaced by `workflow.approve`, and `workflow.commitStrategy` and `workflow.git.commitStrategy` by manual commits. These old fields and values fail validation with the offending path named, except `workflow.git.commitStrategy: none`: it loads with no notice and is removed from the resolved config. Delete the retired field when updating your config.

### Retired keys that still load

The one-planning-session release retired the workflow modes, the extra gates and the tier overrides. The reviewer-checks release retired the validation stage keys. Their keys do not fail the load: each one loads with exactly one notice and is ignored, so an existing config keeps working until you delete the key (`RETIRED_CONFIG_VALUES`, `src/core/config/load/validation/config.ts`). A config that carries several prints one notice per key. The readiness report that `splitbrief start` and `splitbrief doctor` print lists every load-time notice.

| You had | Notice | What to do |
|---|---|---|
| `workflow.mode` (any value, including the older `instant` and `full`) | `workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.` | Delete the key. |
| `workflow.approve: all`, `spec` or `default` | `workflow.approve "<value>" was retired; using "plan": the plan waits for your approval before the build. Set approve to plan or none.` | Set `approve: plan`, or delete the key: `plan` is the default. |
| `workflow.task_review` (`taskReview`) | `workflow.task_review was retired and is ignored: the build no longer stops for your review after each brief. Delete workflow.task_review.` | Delete the key. |
| `workflow.brief_review` (`briefReview`, any value, including `rich`) | `workflow.brief_review was retired and is ignored: you review the briefs on the plan card. Delete workflow.brief_review.` | Delete the key. |
| `workflow.speckit` (the whole block) | `workflow.speckit was retired and is ignored: every run plans in one session. Delete workflow.speckit.` | Delete the block. |
| `approval.tiers` (the whole block, any key) | `approval.tiers was retired and is ignored: a write to a protected path always asks, and no other write does. Delete approval.tiers.` | Delete the block. |
| `approval.enabled` (any value) | `approval.enabled was retired and is ignored: a write to a protected path always asks, and no other write does. Delete approval.enabled.` | Delete the key. |
| `workflow.drift_chain_threshold` (`driftChainThreshold`) | `workflow.drift_chain_threshold was retired and is ignored: SPLITBRIEF no longer scores drift chains; the reviewer reads the files a brief touched but did not suggest. Delete workflow.drift_chain_threshold.` | Delete the key. |
| `workflow.max_retries` (`maxRetries`) | `workflow.max_retries was retired and is ignored: the lineage attempt allowance bounds the ladder now. Delete workflow.max_retries.` | Delete the key. The ladder is one local retry then the planner's consult, bounded per lineage. |
| `escalation` (the whole block, any key) | `escalation was retired and is ignored: the planner's consult replaces the intermediate tier. Delete escalation.` | Delete the block. |
| `validation.typecheck`, `validation.lint`, `validation.test` (any value) | `validation.<key> was retired and is ignored: the reviewer chooses the commands that verify the change, and validation.end_checks turns them on or off. Delete validation.<key>.` | Delete the keys. Set `validation.end_checks: false` to run no reviewer check. Plan and task checks still run. |
| `validation.typecheck_command`, `validation.lint_command` (`typecheckCommand`, `lintCommand`) | `validation.<key> was retired and is ignored: the reviewer chooses the commands that verify the change, and validation.end_checks turns them on or off. Delete validation.<key>.` | Delete the keys. The reviewer chooses the type check and the linter from the project's own scripts and CI. |

The readiness report shows the plan approval level in its **Workflow** section, as the check `workflow.plan-approval` (`Plan approval: plan.`). Readiness checks one context floor for every run: 32,000 tokens.

### Removed identities

Runner identities that a `version: 3` config once accepted are rejected by name, each with its own load error. Migrate as follows.

| You had | Load error | Migration |
|---|---|---|
| `kind: agent-sdk` | `Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.` | `kind: api` against your own endpoint — set `provider`/`service` to your own name, plus `offering`, `apiBase`, and an inline `apiKey`. |
| `provider:` `anthropic`, `deepseek`, `groq`, `ollama-cloud`, `openai`, `openrouter`, `together` | `API provider "<id>" was removed; only "ollama", "lm-studio", "llama-cpp" are built in. Configure it as a custom endpoint: set provider/service to your own name plus apiBase and an inline apiKey (docs/CONFIGURATION.md).` | Same custom-endpoint shape as above — see [`kind: api`](#kind-api). The removed id is refused even though custom names are otherwise free, so pick a new one. |
| `tool: aider` | `CLI tool "aider" was removed; supported tools are <the tools that seat accepts>.` | No replacement — choose another `cli` tool, or drive Aider as a `shell` runner. |

### Removed config keys

The keys in the table below, and two removed **values** of keys that still exist (a hook entry's
`kind: module`, `sessions.scope: global`), are gone from a `version: 3` config. There is no version
bump and no migration pass — every one of them fails the load. One load names them all: `validateConfig`
(`src/core/config/load/validation/config.ts`) collects every error and the thrown message carries one
`  <path>: <message>` line per offending path, so a config carrying several is told about all of them
in a single run rather than one per attempt. That holds for a removed **top-level** key as well: the
root object is not strict (§15), so an unrelated stale root key is still tolerated, but the removed
root keys are named explicitly (`REMOVED_TOP_LEVEL_KEYS`), so a stale `otel:` block has to be
deleted rather than left in place. Every replacement below is the whole migration; nothing reads the old
key.

| You had | On load | Replacement |
|---|---|---|
| `workflow.persistTranscript` | rejected — `workflow.persistTranscript: Unknown config key …` | None. The transcript and `session.jsonl` are always written; persistence is no longer a policy. |
| `hooks.builtin` | rejected — `hooks.builtin: Unknown config key …` | None. The built-in hook bundle is gone; write the check as an ordinary `kind: command` hook (§8). |
| `hooks.pre_compact` | rejected — `hooks.pre_compact: Unknown config key …` | None. Transcript compaction is automatic and fires no hook; `HOOK_EVENTS` is the eleven events in §8. |
| hook entry `kind: module` | rejected — `Invalid input: expected "command"` | `kind: command` — an executable and argv, the only hook kind. |
| `approval.headless` | rejected — `approval.headless: Unknown config key …` | None, and this is a **behaviour change**: a run with no reply channel (`--json`, `--plain`) already fails closed on its own, and a run that has one is now always prompted. See §9. |
| `codebase.cacheDir` | rejected — `codebase.cacheDir: Unknown config key …` | None. The repo-map cache is always `.splitbrief/`. |
| `sessions.scope: global` | rejected — `Invalid input: expected "project"` | `scope: project` — sessions live under the project's `.splitbrief/`. |
| `trust` (the whole block, `trust.customRenderers`) | rejected — `trust: Unknown config key …` | None. Custom renderers are gone; nothing reads the flag. |
| `otel` (the whole block) | rejected — `otel: Unknown config key …` | None. The OpenTelemetry sink, its packages and `--otel-exporter` are gone; use the JSON event stream (`--json`) or a `post_task` hook. |
| `snapshots` (the whole block, including `snapshots.auto.*`) | rejected — `snapshots: Unknown config key …` | None. Snapshots are still taken as the baseline for change detection and for `/run reject`; the trigger points are fixed, not configurable, and there is no `splitbrief snapshot` command. Checkout rejection compares the baseline, the recorded run snapshot and the current files. It restores only recorded run changes that still match the run snapshot and leaves later user edits intact (see [`SLASH-COMMANDS-REFERENCE.md`](./SLASH-COMMANDS-REFERENCE.md)). |
| `plannerEstimateReview` | rejected — `plannerEstimateReview: Unknown config key …` | None. The estimate-review gate is gone; the plan card (§5 `approve`) is the remaining stop before implementation. |
| `autoSplitOverflow` | rejected — `autoSplitOverflow: Unknown config key …` | None. An overflowing task is reported rather than split automatically; re-plan or narrow the feature description. |
| `compiler` (the whole block) | rejected — `compiler: Unknown key "compiler" — briefs compile from the plan directly; remove the "compiler" block.` | None. Briefs compile from the plan directly. |
| `workflow.maxBudget` (`max_budget`) | rejected — `workflow.maxBudget: Unknown config key …` | None. Budget gates are gone; a run reports what it spent and stops when you stop it. |
| `workflow.budgetPauseThreshold` (`budget_pause_threshold`) | rejected — `workflow.budgetPauseThreshold: Unknown config key …` | None. There is no budget pause to threshold. |
| `workflow.costGate` (`cost_gate`) | rejected — `workflow.costGate: Unknown config key …` | None. The cost-approval gate is gone; the plan card (§5 `approve`) is the remaining stop before implementation. |
| `implementerProfiles.profiles.*.costTier` (`cost_tier`) | rejected — `cost_tier: Unknown config key …` | None. Routing is by capability — context window, then name — never by price. |
| `implementerProfiles.profiles.*.pricePer1M` (`price_per1_m`) | rejected — `price_per1_m: Unknown config key …` | None. Profiles carry no price. |

`implementer.model: auto:cheapest` does not fail the load. Nothing parses the marker any more, so the loader keeps `auto:cheapest` as a literal model id. The run then asks the tool or the endpoint for a model with that id. Name a concrete model, or write `auto` to use the tool's own selection.

---

## 17. Full production example

A representative config: Claude Code subscription as planner, a small local LM Studio model as implementer, hooks, and plan approval. Use it as a starting point, then adjust credentials, hooks, and approval for your environment.

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
  # Moves the planner to Codex when Claude Code hits a spent account or a long limit.
  fallback:
    tool: codex
    model: gpt-5-codex

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
  temperature: 0.3   # accepted, but SPLITBRIEF does not send it
  timeout: 240000

# ---------- Validation: reviewer checks on, pinned test command ----------
validation:
  end_checks: true
  test_command: npm test -- --run --reporter=dot

# ---------- Workflow: plan approval, manual commits ----------
workflow:
  approve: plan
  git:
    createBranch: false
  isolation: worktree

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

# ---------- Approval: a write to a protected path asks ----------
approval:
  feedRejectionsToPlanner: true

# ---------- Custom palette actions ----------
palette:
  customActions:
    - id: usage
      label: "Show token usage"
      command: /usage
    - id: accept-run
      label: "Accept current run"
      command: /run accept

# ---------- Sessions ----------
sessions:
  scope: project
```

What this run needs locally (never commit credential values):
- A running LM Studio daemon on `localhost:1234` for the implementer — it takes no credential
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

`asOf`: **2026-07-31** for `ollama` and `lm-studio`, **2026-09-16** for `llama-cpp` (`src/core/providers/api-provider-catalog.ts`). SPLITBRIEF does not fetch terms or pricing pages at runtime.

<!-- api-provider-matrix -->
| Provider | Service | Offering | Normalized endpoint | Credential env | Prefix validation | Roles | Billing |
|---|---|---|---|---|---|---|---|
| ollama | ollama | local | `http://localhost:11434/v1` | — | — | planner, implementer | local |
| lm-studio | lm-studio | local | `http://localhost:1234/v1` | — | — | planner, implementer | local |
| llama-cpp | llama-cpp | local | `http://localhost:8080/v1` | — | — | planner, implementer | local |

**Roles:** every admitted provider is available to PLAN, BUILD and REVIEW (the reviewer is a planner-tier seat), each seat keeping its own `apiBase` and exact model. `llama-cpp` is a **beta** connection profile on the shared OpenAI-compatible transport: it reads the catalog your `llama-server` already serves and ships no bundled model row, so its `model` is always explicit.

Local `ollama` talks only to a loopback daemon and normally omits `apiKey`; if that daemon requires authentication, the only accepted reference is `apiKey: env:OLLAMA_LOCAL_API_KEY`. `OLLAMA_API_KEY` is never resolved or sent to local Ollama.

**Not supported as providers:** subscription coding plans, retired consumer CLI entitlements, generic self-hosted OpenAI-compatible shims, and every other offering this table does not list have **no** first-class provider ID, descriptor, or support row. Per-offering verdicts and dates: [Excluded API offerings](#excluded-api-offerings). Excluded CLI candidates: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#excluded-researched-candidates).

### Bundled model catalog

`KNOWN_MODELS` (`src/core/providers/known-models.ts`) is the offline picker fallback. Live native CLI rows — or, for an `api` provider, models.dev rows — hide `bundled-suggestion` placements in the picker (`buildRightRows`); `resolveModelCatalog` still emits them. For `api` runners pricing and context stay on models.dev first, as in [Pricing metadata](#pricing-metadata); a CLI tool's context comes from its own listing or this table.

Recommendation labels mirror `src/core/providers/known-models.ts`. No bundled row is **`recommended`**: every row is **`compatible-only`** — selectable, with no SPLITBRIEF quality claim.

<!-- api-model-catalog -->
| Provider | Model | Recommendation | Notes |
|---|---|---|---|
| ollama | qwen3-coder:30b | compatible-only | Local default; context limit discovered from the daemon — not hard-coded. |
| lm-studio | qwen2.5-coder-7b | compatible-only | Local default; context limit discovered from the daemon. |

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

Loopback-only local stacks (`ollama`, `lm-studio`, `llama-cpp`) use the `loopback` endpoint policy; do not point them at arbitrary remote hosts without treating the run as a custom remote provider with explicit trust.

### Required API identity triple

Every `kind: api` block declares all three of `provider`, `service`, and `offering`. The loader fills `service` and `offering` only on a top-level `implementer` with `provider: ollama` or no `provider` (§1):

- Any other provider-only block fails validation with the missing `service` / `offering` path named in the error, for example `planner.service`.
- Known catalog IDs must match their `API_PROVIDER_CATALOG` service and offering; a mismatch is a validation error, not a silent rewrite.
- Custom providers declare their own `service` and `offering` alongside an explicit `apiBase`.

Writing the triple explicitly keeps save/load, run metadata, and billing presentation aligned.

### Named implementer profiles

`implementerProfiles` (§3) reuses the same runner schema as top-level `implementer`, including `service`/`offering` on API profiles. Profile names are stable identifiers (`local-qwen`, `cheap-cloud`, …). Task routing picks one capable profile per Task Brief.

### Excluded API offerings

These offerings have no built-in provider ID, descriptor, endpoint policy or picker row. **Generic endpoint only** means you can reach the endpoint through the generic remote or loopback configuration above, without SPLITBRIEF support.

<!-- api-excluded-offerings -->
| offering | support | reason |
|---|---|---|
| `minimax-token-plan` | Not supported | The `sk-cp-…` plan key is documented for "any OpenAI-compatible tool", but the plan is limited to individual interactive development with dynamic throttling, and an orchestrated SPLITBRIEF run is not confirmed as interactive use. PAYG `minimax` is unaffected. |
| `kimi-code` | Not supported | Personal-interactive-only guidelines prohibit non-interactive automation and batch use, and SPLITBRIEF is not on the supported-tool lists. Never spoof another client identity. PAYG `moonshot` is unaffected. |
| `zai-coding-plan` | Not supported | GLM Coding Plan terms restrict quota to officially supported tools and prohibit SDK or custom-app direct calls without a separate written agreement. PAYG `zai` is unaffected. |
| `alibaba-coding-plan` | Not supported | Plan terms expressly prohibit automated scripts, application backends and non-interactive use, and the `sk-sp-…` key is scoped to that route. PAYG `dashscope` is unaffected. |
| `siliconflow` | Not supported | `stream_options.include_usage` is undocumented, the extra `eos` finish reason has no mapping, model churn is high, 40K TPM can block a brief, and public terms restrict commercial and third-party use. |
| `cloudflare` | Generic endpoint only | The account-scoped base (`…/accounts/{account_id}/ai/v1`) needs a dynamic endpoint, and free neurons are not comparable to tokens. There is no Cloudflare-specific transport. |
| `github-models` | Not supported | A public preview for experimentation, with a typical 8K input / 4K output account-tier cap far below the practical brief size. |
| `huggingface` | Generic endpoint only | The USD 0.10/month free credit is negligible, and capability and data policy vary by downstream provider. |
| `vllm` | Generic endpoint only | Ports, auth and models are operator-defined; a per-deployment provider ID adds nothing over the loopback or generic remote block. |
| `localai` | Generic endpoint only | The same operator-defined surface as vLLM across a broader backend set; behaviour depends on the selected backend, not on a SPLITBRIEF descriptor. |
| `local-openai` | Generic endpoint only | Configure a generic local OpenAI-compatible server as a loopback API runner. |
| `sambanova` | Not supported | The official free-tier and onboarding pages conflict, and the documented free rate is only 20 requests/day. |
| `nvidia-nim` | Not supported | Hosted free use is for prototyping and development only; production use requires NVIDIA AI Enterprise licensing. |

---

## 19. See also

- [PRINCIPLES.md](./PRINCIPLES.md) — one-page rule index
- [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) — planner/implementer pipeline and runner matrix
- [TESTING.md](./TESTING.md) — testing contract
- [ARCHITECTURE.md](./ARCHITECTURE.md) — runner contracts, orchestrator loop, event model
- [WORKFLOW.md](./WORKFLOW.md) — the planning session and plan approval in depth
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, `HookEntry` schema, trust model
- [REPOMAP.md](./REPOMAP.md) — `codebase.*` semantics, PageRank, cache
- [API-KEYS.md](./API-KEYS.md) — secret handling and redaction
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — runtime overrides and palette commands
- [DEBUGGING.md](./DEBUGGING.md) — diagnosing config load failures
- [ERRORS.md](./ERRORS.md) — `ConfigError` shape and exit codes
