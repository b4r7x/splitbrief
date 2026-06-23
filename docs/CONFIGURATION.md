# diptych Configuration Reference

Complete reference for `.diptych/config.yaml` — the single declarative file that wires diptych to your planner, implementer, validation tools, workflow gates, hooks, snapshots, and observability.

This document is a field-by-field reference. For end-user mode semantics see [WORKFLOW.md](./WORKFLOW.md); for hook plumbing see [HOOKS-CONFIG.md](./HOOKS-CONFIG.md); for repo-map tuning see [REPOMAP.md](./REPOMAP.md); for OpenTelemetry export see [OTEL.md](./OTEL.md).

---

## 1. File location, format, and lifecycle

```
<project-root>/.diptych/config.yaml
```

- The file is created on first `diptych init` (or implicitly on first `diptych start`). Missing file → diptych runs with `createDefaultConfig()` (`src/core/config/load/io.ts`).
- **Schema version:** `version: 3` (current). `version: 2` and older supported config shapes are upgraded in memory through `migrateV1ToV2 → migrateV2ToV3` at load time. `diptych migrate` is for legacy session layout migration, not config rewriting.
- **Key style:** the loader transforms `snake_case` YAML into `camelCase` before validation (`src/core/config/load/transform.ts`), so both styles work. This document uses `camelCase`.
- **Permissions:** the loader warns on stderr if the file is mode `>0600` on POSIX systems. `init` writes it `0600` via `writeSecureFile`.
- **`.gitignore`:** `init` appends `.diptych/` to your `.gitignore` so secrets and per-machine state stay out of source control.

Top-level shape:

```yaml
version: 3
planner:        { kind: cli|api|shell|agent|agent-sdk, ... }
implementer:    { kind: cli|api|shell|agent|agent-sdk, ... }
implementerProfiles:
  default: local-qwen
  profiles: { local-qwen: { kind: api, ... }, cheap-cloud: { kind: api, ... } }
validation:     { typecheck, lint, test, testCommand }
workflow:       { mode, approve, maxRetries, git, maxBudget, ... }
theme:          terminal | mono
sessions:       { scope: project | global }
escalation:     { enabled, intermediateProvider, intermediateModel }
codebase:       { enabled, tokenBudget, cacheDir, include, exclude }
hooks:          { builtin, pre_task, post_task, ... }
otel:           { enabled, serviceName }
snapshots:      { auto: { preTask, postTask, preFinalReview } }
palette:        { customActions: [...] }
trust:          { customRenderers }
approval:       { enabled, headless, tiers, feedRejectionsToPlanner }
plannerEstimateReview: boolean
autoSplitOverflow:     boolean
```

Top-level keys are **not** strict at the root — unknown keys are ignored. Most nested objects (`hooks`, `codebase`, `otel`, every runner config) are `.strict()` and will reject unknown fields.

---

## 2. `planner`

The planner is the expensive model that compiles a Task Brief. It is a discriminated union on `kind` with five variants. The planner accepts an **optional** `model` (because some CLI tools pick their own); the implementer requires `model`.

### Schema

```ts
type PlannerConfig =
  | { kind: 'cli';       tool: CliToolId; args?: string[]; outputFormat?: OutputFormat;
      model?: string; customModels?: string[]; contextLength?: number;
      temperature?: number; timeout?: number; effort?: EffortLevel }
  | { kind: 'api';       provider: string; apiBase: string; apiKey?: string;
      model?: string; ...common }
  | { kind: 'shell';     command: string; args?: string[]; outputFormat?: OutputFormat;
      capabilities?: Partial<PlannerCapabilities>; model?: string; ...common }
  | { kind: 'agent';     command: string; args?: string[]; outputFormat?: OutputFormat;
      capabilities?: Partial<PlannerCapabilities>; model?: string; ...common }
  | { kind: 'agent-sdk'; apiKey?: string; model?: string; ...common };
```

Every variant is `.strict()` — unknown fields fail validation with a `ConfigError`.

### Common generation fields

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | — | Model identifier. Planner: optional. Implementer: required for every runner kind; use `auto` when you want the runner's default model. |
| `customModels` | string[] | — | Extra model IDs merged into the provider catalog so they appear in pickers. Pricing remains unknown unless models.dev, runtime provider metadata, or the bundled catalog supplies rates. |
| `contextLength` | int > 0 | provider default | Override the detected context window. Useful for self-hosted Ollama/LM Studio whose `/api/show` reports the wrong number. |
| `temperature` | 0..2 | provider default | Sampling temperature. Honored only by the `api` kind (planner and implementer); the `cli`, `shell`, `agent`, and `agent-sdk` kinds cannot pass it to their backend and drop it with a stderr warning. Implementers usually want `0.2`-`0.4`; planners can run hotter. |
| `timeout` | ms (≤ 600000) | unset → no total-call cap (only the 60s stream-idle guard, see Troubleshooting) | Total wall-clock budget for a single planner or implementer call; aborts the call when exceeded. Raise for long planner thinks; lower for cheap probe calls. |
| `effort` | `low\|medium\|high\|xhigh` | unset | For the `api` kind (planner and implementer) maps to Anthropic `thinking.budget_tokens` (2k / 8k / 24k / 48k). The `agent-sdk` kind passes it through as the Agent SDK's first-class `effort` option (the levels match diptych's enum); other providers and runner kinds may ignore it. |

### Pricing metadata

Pricing is resolved from cached `models.dev` metadata first when available, then from runtime provider metadata or the bundled catalog. `models.dev` context pricing tiers are preserved: flat base rates apply below the tier threshold, and the highest matching context tier applies when prompt/cache context reaches that threshold. Local-only unpriced runners are displayed as local/unpriced rather than dollar-priced.

If an API-billed or otherwise paid runner has unknown model pricing and `workflow.maxBudget` is set, runtime budget tracking pauses instead of treating that usage as `$0`. Continue only after acknowledging unknown spend or configuring pricing.

### `kind: cli`

Subprocess of a known coding-agent CLI. The wrapper handles auth, model selection, and output parsing.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `tool` | enum | yes | `claude-code` \| `codex` \| `opencode` \| `aider` \| `copilot` \| `kilo-code` |
| `args` | string[] | no | Extra argv appended to the tool invocation |
| `outputFormat` | enum | no | `stream-json` \| `jsonl` \| `text` \| `opencode` (overrides per-tool default) |

YAML — minimal:

```yaml
planner:
  kind: cli
  tool: claude-code
```

YAML — full:

```yaml
planner:
  kind: cli
  tool: claude-code
  model: opus
  args: ["--mcp-config", ".diptych/mcp.json"]
  outputFormat: stream-json
  contextLength: 1000000
  timeout: 600000
  effort: high
```

**When to use:** you already pay for a Claude Code / Codex / Copilot / Aider subscription and want diptych to drive it as a planner without separate API billing.

### `kind: api`

OpenAI-compatible HTTP endpoint.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `provider` | non-empty string | yes | `anthropic` \| `openrouter` \| `deepseek` \| `openai` \| `groq` \| `together` \| `ollama` \| `lm-studio` \| any custom name |
| `apiBase` | non-empty string | yes | Base URL. For known providers, see "Default API base URLs" below. |
| `apiKey` | string | no | Inline key. **Strongly prefer the matching env var** for official provider endpoints (see [API-KEYS.md](./API-KEYS.md)). Use an inline key for known providers with a custom/proxy `apiBase`; env-sourced provider keys are rejected for that case. |

YAML — minimal (Anthropic):

```yaml
planner:
  kind: api
  provider: anthropic
  apiBase: https://api.anthropic.com/v1
  model: claude-opus-4-6
```

YAML — full (OpenRouter with custom catalog):

```yaml
planner:
  kind: api
  provider: openrouter
  apiBase: https://openrouter.ai/api/v1
  model: anthropic/claude-sonnet-4.6
  customModels:
    - z-ai/glm-4.6
    - qwen/qwen3-coder-480b
  contextLength: 200000
  temperature: 0.5
  timeout: 300000
```

**When to use:** you have an API key (OpenRouter aggregator, direct Anthropic/DeepSeek/OpenAI billing) or a self-hosted Ollama/LM Studio endpoint and want raw HTTP access without a CLI wrapper.

### `kind: shell`

Arbitrary `stdin → stdout` command. Diptych writes the prompt to stdin and parses what comes out of stdout, using `outputFormat` to pick a parser. No shell or network sandbox is applied; the command runs as a normal child process under the current user.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `command` | non-empty string | yes | Executable path (relative to project or absolute). Availability is an existence/executability check (`fs.access` with `X_OK`, or a `$PATH` lookup for bare names) — diptych never runs your command with `--version`, so the script is not invoked until planning starts. |
| `args` | string[] | no | Argv |
| `outputFormat` | enum | no | Same values as `cli` |
| `capabilities` | partial object | no | **Planner only.** Declares optional planner features such as `supportsConversationalPlanning`, `supportsHintEscalation`, `supportsSessionResume`, and `supportsSelfSummarisation` so the orchestrator skips features the wrapper cannot provide. `supportsEffort: true` and `supportsImages: true` are rejected on `shell`/`agent` planners — the command-based adapter has no channel to deliver an effort hint or image attachments to the subprocess (use a `cli`/`api`/`agent-sdk` planner instead). Ignored (and rejected) on `implementer` — implementer write behavior is set via profile `capabilities.writesFiles`. |

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

Set `supportsSelfSummarisation: true` only for planner wrappers that can summarize an existing transcript through `planner.summarize()`. It enables `/compact-transcript`; unsupported planners report a clear message and leave the session log untouched.

**When to use:** wrapping a tool diptych doesn't ship adapters for, or piping through your own pre/post-processing layer.

### `kind: agent`

Same shape as `shell`, but the contract is different: the subprocess **writes files directly to the working tree** and we don't extract anything from stdout. Diptych reads the dirty filesystem after the call returns. It runs as a normal child process too; diptych does not sandbox its shell or network access.

```yaml
implementer:
  kind: agent
  command: ./scripts/my-coding-agent.sh
  args: ["--apply"]
  model: auto
```

A `planner` may also be `kind: agent`; only the planner variant accepts `capabilities` (the same planner feature flags as `kind: shell`).

**When to use:** integrating a tool whose contract is "I edit files, you check git diff" rather than "I print a unified diff".

### `kind: agent-sdk`

In-process call into the Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`). No subprocess.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `apiKey` | string | no | Per-call key. Falls back to `ANTHROPIC_API_KEY`. Never mutates global env (`src/engine/runners/agent-sdk-backend.ts`). |
| `model` | string | planner: no; implementer: yes | Planner defaults to `claude-sonnet-4-6` when omitted. Implementer config must include a model; `auto` resolves to the same default. |

```yaml
implementer:
  kind: agent-sdk
  model: claude-sonnet-4-6
  contextLength: 1000000
```

**When to use:** you want the SDK's tool-use orchestration (Edit/Bash/Read tools) without spawning a subprocess and you have `@anthropic-ai/claude-agent-sdk` installed as a peer dependency.

### Default API base URLs (`KNOWN_PROVIDER_BASE_URLS`)

Source: `src/core/providers/catalog.ts`.

| Provider | Default `apiBase` |
|---|---|
| `anthropic` | `https://api.anthropic.com/v1` |
| `openai` | `https://api.openai.com/v1` |
| `openrouter` | `https://openrouter.ai/api/v1` |
| `deepseek` | `https://api.deepseek.com/v1` |
| `groq` | `https://api.groq.com/openai/v1` |
| `together` | `https://api.together.xyz/v1` |
| `ollama` | `http://localhost:11434/v1` |
| `lm-studio` | `http://localhost:1234/v1` |

**See also:** §3 `implementer`, §11 environment variables, [API-KEYS.md](./API-KEYS.md).

Custom OpenAI-compatible API providers are allowed when `apiBase` is set. Because diptych cannot infer a safe environment variable name for unknown providers, custom providers must set `apiKey` explicitly unless a future auth configuration declares otherwise.

---

## 3. `implementer`

Same discriminated union as `planner`, with two schema differences: `model` is required on every implementer variant (including `agent-sdk`), and the `shell`/`agent` variants do **not** accept the planner-only `capabilities` field. Use `model: auto` to ask the runner adapter for its default when supported. Implementer write behavior (`extracted-code` vs `direct`) is configured per profile via `capabilities.writesFiles` under `implementerProfiles`.

YAML — minimal (local Ollama):

```yaml
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
```

YAML — full (Sonnet via direct Anthropic API):

```yaml
implementer:
  kind: api
  provider: anthropic
  apiBase: https://api.anthropic.com/v1
  model: claude-sonnet-4-6
  contextLength: 200000
  temperature: 0.3
  timeout: 240000
```

`contextLength` is the input context window, used to size the prompt budget. It is **not** the per-response output cap — diptych clamps `max_tokens` to the model's max-output limit independently, so a large context window never produces an over-large output request.

**When to use:**
- *Cheap local* — Ollama or LM Studio for cost-free iteration on small tasks.
- *Mid-tier API* — DeepSeek / GLM via OpenRouter for ~10x cheaper-than-frontier execution.
- *Frontier* — Sonnet/Opus when you want the same quality as the planner for the implementer step.

**See also:** §2 `planner`, §6 `escalation` (for mid-tier fallback), [REPOMAP.md](./REPOMAP.md) (codebase context the implementer never sees, only the planner).

### Optional `implementerProfiles`

`implementer` remains required for backwards compatibility and existing configs do not need to change. New configs may also define named implementer profiles so task routing can choose a cheap capable worker per Task Brief.

An implementer pool is still one product role: diptych selects one capable profile per Task Brief. Same-directory parallel writes are out of scope unless a future worktree-isolated design explicitly adds them.

Profile names must be stable event-safe identifiers: lowercase letters, numbers, and hyphens, starting with a letter, up to 64 characters.

```yaml
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b

implementerProfiles:
  default: local-qwen
  profiles:
    local-qwen:
      kind: api
      provider: ollama
      apiBase: http://localhost:11434/v1
      model: qwen2.5-coder:7b
      contextLength: 32768
      label: Local Qwen
      costTier: local
      capabilities:
        writesFiles: extracted-code
    cheap-cloud:
      kind: api
      provider: openrouter
      apiBase: https://openrouter.ai/api/v1
      model: qwen/qwen3-coder
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
| `capabilities.writesFiles` | `extracted-code\|direct` | Optional routing metadata. Defaults from runner kind: `api`/`shell` extract one file from stdout; `cli`/`agent`/`agent-sdk` write directly. Explicit values must match the runner kind. |

If `implementerProfiles.default` is omitted, diptych resolves the default profile deterministically from the first profile name in sorted order. If `default` is set, it must name an existing profile.

Task-start rows show the concrete routing reason when a worker is selected, and cost drilldown / `diptych explain` include richer routing and context data for post-run inspection.

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
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `typecheck` | boolean | `true` | Master switch for the type-checking stage |
| `lint` | boolean | `true` | Master switch for the linting stage |
| `test` | boolean | `true` | Master switch for the test stage |
| `testCommand` | string | — | Argv-style override for the test command. When set, it runs **as-is** (the full suite) — shell operators and environment expansion are not interpreted, and no test-file argument is appended. When omitted, diptych resolves a command from discovered/heuristic project metadata, falling back to the built-in `npm test`; only that built-in fallback is scoped to the affected test (`npm test -- <test-file>`). |
| `typecheckCommand` | string | — | Optional override for the type-checking command (e.g. `cargo check`, `go vet ./...`, `mypy src/`) |
| `lintCommand` | string | — | Optional override for the linting command (e.g. `cargo clippy --no-deps`, `ruff check`) |
| `testPattern` | string | — | Optional glob for finding test files (e.g. `*_test.go`, `test_*.py`). Defaults to TypeScript patterns (`*.test.ts`, `*.test.tsx`) |

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

Diptych resolves each validation stage through 4 layers, in priority order:

1. **Project config** — `typecheckCommand`, `lintCommand`, `testCommand` override everything.
2. **Planner-discovered** — during the research phase, the planner reads config files and reports the project's validation toolchain. This is persisted to `WorkflowState.discoveredValidation` and used if no project command override exists.
3. **Heuristic fallback** — if no config or discovery exists, diptych looks at marker files (`Cargo.toml`, `go.mod`, `pyproject.toml`, `package.json`) to infer the language and default commands.
4. **Built-in defaults / graceful skip** — typecheck falls back to `npx tsc --noEmit` only on TypeScript projects (a `tsconfig.json` exists or `typescript` is a dependency) and skips otherwise, tests fall back to `npm test`, and lint skips when unresolved. A stage with no resolved command is recorded as skipped, and a run where every enabled stage is skipped emits a warning.

Master switches (`typecheck`, `lint`, `test`) still gate each stage: setting `lint: false` skips lint regardless of whether a command is available.

**When to use the toggles:**
- Disable `test` for repos with no test suite.
- Disable `lint` if your linter is enforced only at PR time (CI) and you want faster local iteration.
- Leave `typecheck: true` for typed languages — it's the cheapest signal that the implementer wrote compilable code.

**See also:** [WORKFLOW.md](./WORKFLOW.md) (where validation sits in the loop), `src/engine/orchestrator/validation.ts`.

---

## 5. `workflow`

Mode, spec/plan document gates, retries, budget, git strategy, and brief-review style.

### Schema

```ts
workflow: {
  // Spec/plan document gates
  approve?:               'none' | 'spec' | 'plan' | 'all' | 'default';
  autoApproveSpec?:       boolean;  // deprecated v2 — use approve
  autoApprovePlan?:       boolean;  // deprecated v2 — use approve

  // Retries
  maxRetries:             number; // int >= 0 — REQUIRED

  // Git
  commitStrategy?:        'none' | 'checkpoint' | 'per-task'; // deprecated — use git.commitStrategy
  git?: {
    commitStrategy?:      'none' | 'checkpoint' | 'per-task';
    createBranch?:        boolean;
  };

  // Mode + brief review
  mode?:                  'instant' | 'quick' | 'standard' | 'speckit';
  briefReview?:           'simple' | 'rich'; // 'rich' is deprecated and maps to simple review
  taskReview?:            'none' | 'failed' | 'every';

  // Budget
  maxBudget?:             number > 0;
  budgetPauseThreshold?:  0..1;
  driftChainThreshold?:   0..1;
  costGate?:              boolean; // default true

  // Speckit-only
  speckit?:               { minCoverage?: 0..1 };

  // Transcript
  persistTranscript:      boolean; // default true
  compactionThreshold?:   number;  // int >= 10
  compactionFormat:       'auto' | 'freeform' | 'structured'; // default auto
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | enum | `standard` | `instant` \| `quick` \| `standard` \| `speckit`. Legacy `full` is accepted as a one-time alias for `speckit`. |
| `approve` | enum | `default` | Spec/plan document gates: `none` (skip spec/plan gates; briefs review still runs in standard/speckit), `spec` (gate spec only), `plan` (gate plan only), `all` (gate both), `default` (per-mode default). |
| `autoApproveSpec` | boolean | `false` | **Deprecated v2** — read by legacy code paths only. Use `approve`. |
| `autoApprovePlan` | boolean | `false` | **Deprecated v2** — read by legacy code paths only. Use `approve`. |
| `maxRetries` | int >= 0 | `3` | Per-task local retries before escalation kicks in |
| `commitStrategy` | enum | — | **Deprecated v2** — use `git.commitStrategy`. |
| `git.commitStrategy` | enum | `none` | Optional product-level git behavior: `none` (no commits — user reviews everything), `checkpoint` (a session-scoped tagged stash per task — `diptych/<sessionId>/<taskId>` — no commits), `per-task` (one commit per task). Checkpoint safety does not require git commits. |
| `git.createBranch` | boolean | `false` | Auto-create `diptych/<slug>` branch at workflow start. |
| `briefReview` | enum | `simple` | `simple` review. `rich` is deprecated, accepted for compatibility, and treated as `simple`. `Ctrl+E`, `e`, `edit`, `E`, and `edit-file` open the persisted `tasks.md` in the external editor resolved as `VISUAL`, then `EDITOR`, then `vi`. |
| `taskReview` | enum | `none` | Per-task review gate after implementation: `none` (never pause), `failed` (pause only when a task fails, hits recovery, or its validation fails), `every` (pause after every advancing task). **Requires an interactive TUI run** — any value other than `none` is rejected at startup in headless mode (`src/cli/headless.ts`), so leave it `none` for CI. |
| `maxBudget` | number > 0 | unset | USD ceiling. Workflow warns at 80%, pauses at `budgetPauseThreshold` (default `0.85`), stops at the hard cap, and pauses when paid usage has unknown pricing instead of treating it as `$0`. |
| `budgetPauseThreshold` | 0..1 | `0.85` | Fraction of `maxBudget` at which to pause. e.g. `0.8` pauses at 80%. |
| `driftChainThreshold` | 0..1 | `0.6` | Threshold used when omitted; higher = fewer drift-chain events. |
| `costGate` | boolean | `true` | Pause for cost approval before implementation when a deterministic prompt-input estimate is available. Set `false` to skip the gate. The gate is always skipped in `instant`/`quick` modes and when no deterministic estimate exists. Output, retries, validation reruns, and escalation are tracked at runtime. |
| `speckit.minCoverage` | 0..1 | `0.9` | Speckit-mode spec/plan→task traceability threshold. The analyze phase emits a `warning` event when measured `specTaskCoverage` or `planTaskCoverage` falls below this value. Not a test-coverage gate. |
| `persistTranscript` | boolean | `true` | Persist planner/user transcript text to `session.jsonl` for replay/audit, stateless resume context, and `/compact-transcript`. Set `false` to protect external consumer surfaces from prompt, answer, task prose, comments, retry errors, and feature text; see the transcript policy notes below. |
| `compactionThreshold` | int >= 10 | unset | On resume, auto-compact persisted transcript context when compacted message count exceeds this threshold and the planner supports self-summarisation. |
| `compactionFormat` | enum | `auto` | Summary format for transcript compaction: `auto` selects structured JSON for `api` and `agent-sdk` planners, freeform text for `cli`, `shell`, and `agent`; `freeform` preserves legacy markdown/text summaries; `structured` requires Zod-validated JSON and falls back to freeform text if validation fails. |

### Per-mode defaults

| Mode | Planner calls | Default `approve` | Default `briefReview` | Auto snapshots | Best for |
|---|:---:|:---:|:---:|:---:|---|
| `instant` | 1 | `none` | `simple` | off | Trivial edits, no ceremony |
| `quick` | 1 | `none` | `simple` | off | Small task, still want a brief |
| `standard` (default) | 4 | `spec` | `simple` | off | Ordinary feature work |
| `speckit` | 6–7 | `all` | `simple` | off | Large, risky, externally visible |

`approve: default` resolves to the table above via `resolveApproveLevel()` (`src/core/config/runtime/resolve.ts`).

`briefReview` has no per-mode default — it falls back to `simple` in every mode unless set explicitly (`config.workflow.briefReview ?? 'simple'`). `rich` is deprecated and ignored/mapped to `simple`; keep or set `simple` and use the external editor commands for text edits.

### Transcript persistence policy

`persistTranscript: false` is a consumer-boundary policy, not a sandbox. Protected surfaces omit or replace prompt/answer text in `session.jsonl`, `--json` stdout, IPC live/replay traffic, RPC status/events, headless recovery output, summary JSON, summary UI data, exported HTML, recent-session/active-session metadata, `ps`, generated session ids, generated branch names, OpenTelemetry attributes, task tree rows, input history, and `git_commit` event messages. Per-task git commit subjects also use task ids and control metadata only.

The UI and machine consumers still receive safe control data: phase, task ids/status, queue depth, cost/usage numbers, allowed recovery actions, approval tiers, runner/model identifiers, safe runner activity labels, compact runner status, and bounded operational warnings/errors. Runner-call warning/error text, approval or revision comments, retry errors, task titles/reasons, task-review prose, queue previews, and cost-prediction task prose are replaced with `[transcript omitted]` or removed. Raw runner expansion is disabled: protected runner activity forces `rawAvailable:false` and omits `expandId`, so `raw` markers disappear instead of pointing at hidden payloads.

The workflow still writes product artifacts such as `research.md`, `spec.md`, `plan.md`, `tasks.md`, `brief-quality.json`, validation outputs, changed source files, and evidence files when those phases produce them. Those files are intentionally review artifacts and can contain the requested work; `persistTranscript:false` does not redact project outputs or make the working tree private.

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
  persistTranscript: true
```

Headless CI:

```yaml
workflow:
  mode: quick
  approve: none
  maxRetries: 2
  git: { commitStrategy: none }
  persistTranscript: false
```

**When to use what:**
- `git.createBranch: true` — when running diptych in CI or against `main` and you don't want the changes landing on the current branch.
- `git.commitStrategy: none` — the default and recommended setting for manual review; diptych leaves changes unstaged so you can review and commit them yourself.
- `maxBudget` — always set this for API-billed runs. It's your stop-loss.
- `budgetPauseThreshold` — set for unattended runs so you can intervene before the hard ceiling. Unknown paid pricing pauses regardless of the threshold because the runtime cannot prove spend against the cap.
- `briefReview: simple` — the supported brief review mode. Legacy `briefReview: rich` configs are accepted but mapped to `simple`. Use `Ctrl+E`, `e`, `edit`, `E`, or `edit-file` to edit the persisted Task Brief in the external editor.
- `persistTranscript: true` — keep this enabled if you want stateless resume reconstruction and manual transcript compaction. `/compact-transcript` appends a summary entry and keeps recent turns verbatim; it does not delete old log lines.
- `persistTranscript: false` — use when logs, machine-readable output, attach/RPC replay, summaries, telemetry, diptych input history, session names, generated commit messages, and raw runner expansion targets must not expose prompt or answer text. Pending queue state is still stored in `state.json`, but queue previews are stripped from protected consumers and stateless resume cannot rebuild transcript context if native session resume is unavailable.

**See also:** [WORKFLOW.md](./WORKFLOW.md), [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) (`/mode`, `/effort` runtime overrides). Workflow approval level is set with `--approve` or `workflow.approve`.

---

## 6. `escalation`

When a task fails locally past `maxRetries`, diptych escalates through a tier ladder: **tier 0** retries with the "intermediate" mid-tier model configured here, then **tier 1** has the planner write a hint, then **tier 2** hands the task to the planner ("full escalation"). The intermediate tier runs only when `intermediateProvider` is set.

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
  intermediateProvider: openrouter
  intermediateModel: z-ai/glm-4.6
```

**When to use:** you run a cheap implementer (Ollama / DeepSeek) and want a "10x cheaper than the planner but smarter than the implementer" stop along the way before paying for an Opus retry. Skip if your implementer is already frontier-class. Setting `intermediateProvider` is enough to turn the tier on; add `enabled: false` only when you want to keep the provider config but bypass the tier.

---

## 7. `codebase`

Repo-map context block injected into planner prompts. Detailed semantics: [REPOMAP.md](./REPOMAP.md).

### Schema

```ts
codebase: {
  enabled:     boolean;            // default true
  tokenBudget: int 1..50000;       // default 4000
  cacheDir:    string;             // default ".diptych"
  include?:    string[];           // glob patterns
  exclude?:    string[];           // regex strings
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Emit `<repo-map>` block to planner |
| `tokenBudget` | int 1..50000 | `4000` | Tokens reserved for the block. PageRank picks the top N symbols that fit. |
| `cacheDir` | string | `.diptych` | Where to put `repomap.sqlite` |
| `include` | string[] | walks `.ts`/`.tsx` | Glob patterns relative to project root |
| `exclude` | string[] | test files + `dist/` + `node_modules/` | **Regex strings** (note: not globs) |

YAML:

```yaml
codebase:
  enabled: true
  tokenBudget: 6000
  cacheDir: .diptych
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
  builtin?:         Record<string, boolean>;
  pre_planning?:    HookEntry[];
  pre_task?:        HookEntry[];
  post_task?:       HookEntry[];
  pre_validation?:  HookEntry[];
  post_validation?: HookEntry[];
  pre_commit?:      HookEntry[];
  post_commit?:     HookEntry[];
  pre_escalation?:  HookEntry[];
  pre_compact?:     HookEntry[];   // reserved
  on_error?:        HookEntry[];
  on_complete?:     HookEntry[];
}

type HookEntry =
  | { kind?: 'command'; name?: string; command: string; args?: string[];
      timeout_ms?: number; on_failure?: 'block' | 'warn' | 'ignore' }
  | { kind: 'module'; name?: string; path: string;
      timeout_ms?: number; on_failure?: 'block' | 'warn' | 'ignore' };
```

`HookEntry` is preprocessed: a bare object without `kind` is treated as `kind: 'command'`. `command` rejects bare `sh` / `bash` / `/bin/sh` / `/bin/bash` — use a script file.

### Built-in toggles

| Built-in | Default | Description |
|---|---|---|
| `prettier-on-change` | off | Run `prettier --write` on touched files in `post_task` |
| `block-secrets` | off | Reject commits/diffs containing common secret patterns in `pre_commit`; warns (rather than silently passing) when a listed file cannot be scanned |

YAML — minimal:

```yaml
hooks:
  builtin:
    prettier-on-change: true
    block-secrets: true
```

YAML — custom commands:

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

## 9. `otel`

OpenTelemetry span sink. Full details: [OTEL.md](./OTEL.md).

### Schema

```ts
otel: {
  enabled:     boolean; // default false
  serviceName: string;  // default "diptych"
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Install the OTel span sink. Requires bootstrapping an exporter (see env vars). |
| `serviceName` | string | `diptych` | Tracer/instrumentation scope name used when creating spans |

YAML:

```yaml
otel:
  enabled: true
  serviceName: diptych-prod
```

Exporter selection — set **one** of:
- `OTEL_TRACES_EXPORTER=console` — built-in console span exporter (debugging).
- `DIPTYCH_OTEL_EXPORTER=console` — alias for the same.
- `--otel-exporter console` — CLI flag, same effect.

For OTLP HTTP/gRPC exporters, provide your own in-process provider bootstrap or add support to `src/lib/otel.ts`; only `console` is built in.

**When to use:** wire diptych into your existing observability stack to track per-task duration, planner vs implementer cost, escalation rates.

**See also:** [OTEL.md](./OTEL.md).

---

## 10. `snapshots`

Automatic git/working-tree snapshots before/after key transitions. All triggers default off; failures emit a warning event and never abort the run.

### Schema

```ts
snapshots: {
  auto?: {
    preTask?:        boolean;
    postTask?:       boolean;
    preFinalReview?: boolean;
  };
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `auto.preTask` | boolean | `false` | Snapshot immediately before each task starts |
| `auto.postTask` | boolean | `false` | Snapshot immediately after each task completes successfully |
| `auto.preFinalReview` | boolean | `false` | Snapshot before the final planner review runs |

YAML:

```yaml
snapshots:
  auto:
    preTask: true
    postTask: true
    preFinalReview: false
```

Manual snapshots are always available via `diptych snapshot create`.

**When to use:** running unattended jobs where you want a rollback point at every checkpoint, independent of `git.commitStrategy`.

---

## 11. `trust`

Repo-local extension trust.

### Schema

```ts
trust: {
  customRenderers?: boolean;   // default false
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `customRenderers` | boolean | `false` | Allow `diptych handoff <custom-target>` to import `.diptych/handoff-renderers/<target>.ts` or `.js`. |

YAML:

```yaml
trust:
  customRenderers: true
```

Leave this off unless you trust the repository. `diptych handoff --list` can discover custom targets without this setting. Executing a custom target requires either this setting or the per-command `--allow-custom-renderer` flag.

---

## 12. `approval`

Tiered approval system for declared file writes. It sits orthogonal to `workflow.approve`, which controls spec/plan gates.

### Schema

```ts
approval: {
  enabled:                    boolean;        // default true
  headless?:                  boolean;
  tiers?: {
    read?:                ApprovalTier;
    write_in_scope?:      ApprovalTier;
    validation?:          ApprovalTier;
    write_out_of_scope?:  ApprovalTier;
    destructive?:         ApprovalTier;
    network?:             ApprovalTier;
    package_change?:      ApprovalTier;
  };
  feedRejectionsToPlanner:    boolean;        // default true
}

type ApprovalTier = 'auto' | 'sticky' | 'confirm';
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master toggle for file-write tiered approval |
| `headless` | boolean | unset | Force `confirm` tiers to default-deny rather than block. Use in CI. |
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

**Tier keys:** `read`, `write_in_scope`, `validation`, `write_out_of_scope`, `destructive`, `network`, `package_change`. The current file-write classifier emits `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, and `package_change`. `validation` and `network` remain accepted config keys for compatibility; they do not sandbox validation, shell commands, or network access.

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

## 13. `palette`

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
      command: /accept-run
    - id: handoff-claude
      label: "Write Claude handoff"
      command: /handoff claude-code
```

**When to use:** surfacing project-specific runbook actions inside diptych's TUI without leaving the session.

**See also:** [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

---

## 14. `theme`, `sessions`, `plannerEstimateReview`, `autoSplitOverflow`

These are top-level fields (siblings of `workflow`, not nested under it).

| Field | Type | Default | Description |
|---|---|---|---|
| `theme` | enum | `terminal` | `terminal` (uses your terminal's color scheme) \| `mono` (no color) |
| `sessions.scope` | enum | `project` | Accepted by the schema for future session backends. Current workflow commands write session state under `<projectDir>/.diptych`. |
| `plannerEstimateReview` | boolean | `false` | Spend one extra planner call to sanity-check the deterministic per-task prompt-input estimate before implementation. The planner classifies it (`ok` / `split-suggested` / `risk` / `needs-user-decision`), flags affected task ids, and the verdict is surfaced in the cost-prediction chrome. Skipped on resume; requires a deterministic estimate. |
| `autoSplitOverflow` | boolean | `false` | After the cost gate, automatically split tasks that overflow the implementer's context budget (or that the planner review flags as too large) into smaller child tasks before implementation. Splits that would drop acceptance criteria, dependencies, or produce too many children are skipped with a warning. |

```yaml
theme: mono
sessions:
  scope: global
plannerEstimateReview: true
autoSplitOverflow: true
```

---

## 15. Environment variables

Source: `src/core/providers/catalog.ts`, `src/cli/setup.ts`, `src/lib/otel.ts`, `src/engine/runners/agent-sdk-backend.ts`, `src/engine/providers/registry.ts`, `src/engine/providers/client.ts`, `src/features/workflow/review-parser.ts`.

### Provider authentication

| Variable | Provider | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic`, `agent-sdk` | Required for Anthropic API and Agent SDK. The loader warns if the key doesn't start with `sk-ant-`. |
| `OPENAI_API_KEY` | `openai` | |
| `OPENROUTER_API_KEY` | `openrouter` | |
| `DEEPSEEK_API_KEY` | `deepseek` | |
| `GROQ_API_KEY` | `groq` | |
| `TOGETHER_API_KEY` | `together` | |
| `OLLAMA_API_KEY` | `ollama` | Optional; usually unset. |

Inline `apiKey` in YAML works. For official provider endpoints, it triggers a stderr warning recommending the env var. For known providers with a custom/proxy `apiBase`, keep the key inline because env-sourced provider keys are not sent to custom endpoints. Unknown providers without a built-in catalog entry must set both `apiBase` and `apiKey` in YAML.

### Runtime overrides

| Variable | Purpose |
|---|---|
| `DIPTYCH_CONTEXT_LENGTH` | Override detected implementer context length (`src/engine/providers/registry.ts`). Useful when the provider misreports. |
| `DIPTYCH_QUIET` | Suppress legacy-mode deprecation notice (set to `1`) (`src/cli/init-stores.ts`). |

### Observability

| Variable | Purpose |
|---|---|
| `OTEL_TRACES_EXPORTER` | Standard OTel — set to `console` to bootstrap the built-in `ConsoleSpanExporter`. |
| `DIPTYCH_OTEL_EXPORTER` | Alias for the above (same values). |
| Other `OTEL_*` | Read by your own OTel bootstrap/provider; diptych's built-in bootstrap only handles console exporter selection. |

### TUI / process

| Variable | Purpose |
|---|---|
| `CI` | If truthy, suppress fullscreen/alternate-screen rendering. Use `--json` or `--rpc` when stdout must be machine-readable. |
| `SHELL` | Shell detection for spawn fallback (`src/lib/process/spawn.ts`). |
| `TERM_PROGRAM` | Kitty keyboard-protocol detection for advanced key bindings. |
| `VISUAL` | Preferred external editor for spec/plan/brief review. Takes precedence over `EDITOR`. |
| `EDITOR` | External editor fallback when `VISUAL` is unset or empty. `vi` is used when both are unset or empty. |

---

## 16. CLI flags

Declared in `src/cli/options.ts` for workflow commands (`start`, `resume`, `continue`, `last`) plus command-specific registrations. These flags **override** the matching config field for the current invocation only. [`CLI-REFERENCE.md`](./CLI-REFERENCE.md) is the canonical flag matrix.

| Flag | Purpose | Commands |
|---|---|---|
| `--auto` | Alias for `--approve none` on spec/plan document gates | start, resume, continue, last |
| `--approve <level>` | Spec/plan document gates: `none` \| `spec` \| `plan` \| `all` \| `default` | start, resume, continue, last |
| `--mode <mode>` | `instant` \| `quick` \| `standard` \| `speckit` (`full` legacy alias) | start, resume, continue, last |
| `--budget <amount>` | Dollar ceiling | start, resume, continue, last |
| `--model <m>` | Alias for `--implementer-model` | start, resume, continue, last |
| `--provider <p>` | Alias for `--implementer` | start, resume, continue, last |
| `--planner <tool>` | Planner tool override | start, resume, continue, last |
| `--planner-model <m>` | Planner model override | start, resume, continue, last |
| `--planner-command <cmd>` | Custom planner command (kind=shell) | start, resume, continue, last |
| `--planner-api-base <url>` | Planner API base URL (kind=api only; warns + ignored otherwise) | start, resume, continue, last |
| `--planner-api-key-env <var>` | Planner API key env var, stored as `env:<var>` (kind=api/agent-sdk only; warns + ignored otherwise) | start, resume, continue, last |
| `--planner-args <arg>` | Append a planner CLI/shell arg (repeatable; kind=cli/shell/agent) | start, resume, continue, last |
| `--planner-output-format <format>` | Planner output format (`stream-json` \| `jsonl` \| `text` \| `opencode`) | start, resume, continue, last |
| `--planner-context-length <tokens>` | Planner context length in tokens (kind=api only; sizes the request `max_tokens`, ignored by other kinds) | start, resume, continue, last |
| `--planner-effort <level>` | Planner effort hint (`low` \| `medium` \| `high` \| `xhigh`) | start, resume, continue, last |
| `--implementer <p>` | Implementer provider override | start, resume, continue, last |
| `--implementer-model <m>` | Implementer model override | start, resume, continue, last |
| `--implementer-command <cmd>` | Custom implementer command (kind=shell) | start, resume, continue, last |
| `--implementer-api-base <url>` | Implementer API base URL (kind=api only; warns + ignored otherwise) | start, resume, continue, last |
| `--implementer-api-key-env <var>` | Implementer API key env var, stored as `env:<var>` (kind=api/agent-sdk only; warns + ignored otherwise) | start, resume, continue, last |
| `--implementer-args <arg>` | Append an implementer CLI/shell arg (repeatable; kind=cli/shell/agent) | start, resume, continue, last |
| `--implementer-output-format <format>` | Implementer output format (`stream-json` \| `jsonl` \| `text` \| `opencode`) | start, resume, continue, last |
| `--implementer-context-length <tokens>` | Implementer context length (tokens) | start, resume, continue, last |
| `--project <dir>` | Project directory (default cwd) | most commands |
| `--no-fullscreen` | Disable alt-screen buffer | start, resume, continue, last |
| `--no-mouse` | Disable mouse tracking | start, resume, continue, last |
| `--allow-hooks` | Trust hook config without prompting (CI) | start, resume, continue, last, spec |
| `--allow-custom-renderer` | Trust repo-local handoff renderer for this invocation | handoff |
| `--json` | Headless: NDJSON `EngineEvent`s to stdout, no TUI | start, resume, continue, last |
| `--rpc` | Bidirectional NDJSON over stdin/stdout | start, resume, continue, last |
| `--otel-exporter <name>` | Bootstrap built-in exporter (`console` only) | start, resume, continue, last |
| `--worktree [name]` | Run in a linked git worktree | start |
| `--yolo` | Skip file-write tiered approval prompts for this session | start, resume, continue, last |
| `--detach` | Spawn workflow as background IPC server | start |
| `--reconfigure` | Overwrite existing config | init |
| `--history` | Show cost history across sessions | status |
| `-p, --project <dir>` | Project directory | `migrate`, `export` |

---

## 17. Validation behavior

Config is validated on every load (`src/core/config/load/io.ts:loadConfig`).

- Errors → `ConfigError` (`src/core/config/errors.ts`) → top-level catch in `src/cli/setup.ts` → exit code 1.
- Non-fatal warnings on stderr (`warnStderr` in `src/lib/warn.ts`):
  - Config file with permissions looser than `0600` on POSIX.
  - `apiKey` detected inline in config (recommends env var).
  - Anthropic key not starting with `sk-ant-`, etc.
  - `version: 2` accepted but deprecated → upgrade prompt.

Unknown top-level keys are tolerated; unknown nested keys in `.strict()` blocks (`hooks`, `codebase`, `otel`, every runner config, `PlannerCapabilities`) fail validation.

---

## 18. Migration

Config migration happens during load: supported older shapes are normalized in memory by `migrateV1ToV2 → migrateV2ToV3` (`src/core/config/load/migrate.ts`). Subsequent config writes use the current v3 shape.

`diptych migrate -p <dir>` is separate: it migrates pre-v3 `.diptych/current/` session state into the session-folder layout.

**v2 → v3 changes:**
- `version: 2` → `version: 3`.
- `workflow.autoApproveSpec` / `workflow.autoApprovePlan` → derived `workflow.approve` (kept dual for backward read compat).
- `workflow.commitStrategy` → `workflow.git.commitStrategy` (kept dual).
- `workflow.mode: full` → `workflow.mode: speckit`.

**v1 → v2 changes:**
- `commitPerTask: true|false` → `commitStrategy: 'per-task' | 'none'`.
- Runner kind inference: legacy `kind: claude-code` (etc.) → `kind: cli, tool: claude-code`. Legacy `apiBase` without `kind` → `kind: api`. Legacy `command` without `kind` → `kind: shell`.

The loader runs `migrateConfig` automatically on load, so even if you forget to invoke `migrate`, your config still works — but you'll see deprecation warnings until you upgrade in place.

---

## 19. Full production example

A representative config: Claude Code subscription as planner, Sonnet via direct Anthropic API as implementer, mid-tier escalation through OpenRouter, budget caps, snapshots, hooks, OTel, and tiered approval. Use it as a starting point, then adjust credentials, budgets, hooks, and approval tiers for your environment.

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

# ---------- Implementer: Sonnet via direct Anthropic API ----------
# contextLength is the input window, not the output cap; max_tokens is clamped to
# the model's max-output limit independently.
implementer:
  kind: api
  provider: anthropic
  apiBase: https://api.anthropic.com/v1
  model: claude-sonnet-4-6
  contextLength: 200000
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
  persistTranscript: true
  git:
    commitStrategy: none
    createBranch: false
  speckit:
    minCoverage: 0.8

# ---------- Mid-tier escalation through OpenRouter (cheap stop before Opus) ----------
escalation:
  enabled: true
  intermediateProvider: openrouter
  intermediateModel: z-ai/glm-4.6

# ---------- Repo-map: 6k tokens, src + lib only ----------
codebase:
  enabled: true
  tokenBudget: 6000
  cacheDir: .diptych
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
  builtin:
    prettier-on-change: true
    block-secrets: true
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

# ---------- Auto snapshots at every checkpoint ----------
snapshots:
  auto:
    preTask: true
    postTask: true
    preFinalReview: true

# ---------- OpenTelemetry span sink ----------
otel:
  enabled: true
  serviceName: diptych-prod

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
    - id: handoff-claude
      label: "Write Claude handoff"
      command: /handoff claude-code
    - id: accept-run
      label: "Accept current run"
      command: /accept-run

# ---------- Theme + sessions ----------
theme: terminal
sessions:
  scope: project
```

Required env vars to make this run:
- `ANTHROPIC_API_KEY=sk-ant-...` (implementer)
- `OPENROUTER_API_KEY=sk-or-...` (escalation)
- `OTEL_TRACES_EXPORTER=console` for the built-in shortcut, or an in-process provider bootstrap for non-console exporters; standard `OTEL_*` alone is not enough

Then:

```bash
diptych start --allow-hooks "your feature description"
```

---

## 20. See also

- [PRINCIPLES.md](./PRINCIPLES.md) — one-page rule index
- [ARCHITECTURE.md](./ARCHITECTURE.md) — runner contracts, orchestrator loop, event model
- [WORKFLOW.md](./WORKFLOW.md) — mode + approval semantics in depth
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, `HookEntry` schema, trust model
- [REPOMAP.md](./REPOMAP.md) — `codebase.*` semantics, PageRank, cache
- [OTEL.md](./OTEL.md) — span hierarchy, exporter setup
- [API-KEYS.md](./API-KEYS.md) — secret handling and redaction
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — runtime overrides and palette commands
- [DEBUGGING.md](./DEBUGGING.md) — diagnosing config load failures
- [ERRORS.md](./ERRORS.md) — `ConfigError` shape and exit codes
- [WORKFLOW.md](./WORKFLOW.md) — workflow modes and approval semantics
