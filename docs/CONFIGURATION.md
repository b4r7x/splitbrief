# diptych Configuration Reference

Complete reference for `.diptych/config.yaml` — the single declarative file that wires diptych to your planner, implementer, validation tools, workflow gates, hooks, snapshots, and observability.

This document is a comprehensive, field-by-field reference. For end-user mode semantics see [WORKFLOW.md](./WORKFLOW.md); for hook plumbing see [HOOKS-CONFIG.md](./HOOKS-CONFIG.md); for repo-map tuning see [REPOMAP.md](./REPOMAP.md); for OpenTelemetry export see [OTEL.md](./OTEL.md). For a one-screen lookup table see [CONFIG.md](./CONFIG.md) — this document supersedes and extends it with worked examples and "when to use" guidance.

---

## 1. File location, format, and lifecycle

```
<project-root>/.diptych/config.yaml
```

- The file is created on first `diptych init` (or implicitly on first `diptych start`). Missing file → diptych runs with `createDefaultConfig()` (`src/core/config/load/load.ts`).
- **Schema version:** `version: 3` (current). `version: 2` is still accepted on input — `diptych migrate` upgrades it in place. Pre-v2 configs are auto-migrated through `migrateV1ToV2 → migrateV2ToV3` at load time.
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
shikiTheme:     github-dark | github-light
sessions:       { scope: project | global }
escalation:     { enabled, intermediateProvider, intermediateModel }
codebase:       { enabled, tokenBudget, cacheDir, include, exclude }
hooks:          { builtin, pre_task, post_task, ... }
otel:           { enabled, serviceName }
snapshots:      { auto: { preTask, postTask, preFinalReview } }
palette:        { customActions: [...] }
approval:       { enabled, headless, tiers, feedRejectionsToPlanner }
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
| `model` | string | — | Model identifier. Planner: optional. Implementer: required (except `agent-sdk` which falls back to `claude-sonnet-4-6`). |
| `customModels` | string[] | — | Extra model IDs merged into the provider catalog so they appear in pickers and pricing tables. |
| `contextLength` | int > 0 | provider default | Override the detected context window. Useful for self-hosted Ollama/LM Studio whose `/api/show` reports the wrong number. |
| `temperature` | 0..2 | provider default | Sampling temperature. Implementers usually want `0.2`-`0.4`; planners can run hotter. |
| `timeout` | ms (≤ 600000) | unset → provider default | Per-call timeout. Raise for long planner thinks; lower for cheap probe calls. |
| `effort` | `low\|medium\|high\|xhigh` | unset | Maps to `thinking.budget_tokens` for Anthropic (2k / 8k / 24k / 48k). Other providers may ignore. |

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
  temperature: 0.7
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
| `apiKey` | string | no | Inline key. **Strongly prefer the matching env var** (see [API-KEYS.md](./API-KEYS.md)). The loader warns on inline keys and on provider/key-format mismatch. |

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

Arbitrary `stdin → stdout` command. Diptych writes the prompt to stdin and parses what comes out of stdout, using `outputFormat` to pick a parser.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `command` | non-empty string | yes | Executable path (relative to project or absolute) |
| `args` | string[] | no | Argv |
| `outputFormat` | enum | no | Same values as `cli` |
| `capabilities` | partial object | no | Declares optional planner features such as `supportsConversationalPlanning`, `supportsHintEscalation`, `supportsSessionResume`, `supportsEffort`, `supportsImages`, and `supportsSelfSummarisation` so the orchestrator skips features the wrapper cannot provide. |

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

Same shape as `shell`, but the contract is different: the subprocess **writes files directly to the working tree** and we don't extract anything from stdout. Diptych reads the dirty filesystem after the call returns.

```yaml
implementer:
  kind: agent
  command: ./scripts/my-coding-agent.sh
  args: ["--apply"]
  capabilities:
    supportsSessionResume: true
```

**When to use:** integrating a tool whose contract is "I edit files, you check git diff" rather than "I print a unified diff".

### `kind: agent-sdk`

In-process call into the Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`). No subprocess.

| Field | Type | Required | Description |
|---|---|:---:|---|
| `apiKey` | string | no | Per-call key. Falls back to `ANTHROPIC_API_KEY`. Never mutates global env (`src/engine/agent-sdk-backend.ts`). |
| `model` | string | no | Defaults to `claude-sonnet-4-6` (`DEFAULT_AGENT_SDK_MODEL`). |

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

Same discriminated union as `planner`. The only schema difference: `model` is required on every variant **except** `agent-sdk` (which defaults to `claude-sonnet-4-6`). For an Anthropic-CLI implementer (`kind: cli, tool: claude-code`), the wrapper picks the model itself when `model` is omitted, but other CLIs may reject an empty model.

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
  contextLength: 1000000
  temperature: 0.3
  timeout: 240000
```

**When to use:**
- *Cheap local* — Ollama or LM Studio for cost-free iteration on small tasks.
- *Mid-tier API* — DeepSeek / GLM via OpenRouter for ~10x cheaper-than-frontier execution.
- *Frontier* — Sonnet/Opus when you want the same quality as the planner for the implementer step.

**See also:** §2 `planner`, §6 `escalation` (for mid-tier fallback), [REPOMAP.md](./REPOMAP.md) (codebase context the implementer never sees, only the planner).

### Optional `implementerProfiles`

`implementer` remains required for backwards compatibility and existing configs do not need to change. New configs may also define named implementer profiles so task routing can choose a cheap capable worker per Task Brief.

An implementer pool is still one product role. Diptych selects one capable profile for a Task Brief; it does not run a swarm, race workers against each other, or parallel-write the same checkout. Same-directory parallel writes are out of scope unless a future worktree-isolated design explicitly adds them.

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

When recovery offers `route-bigger-worker`, the issue names a target profile from this pool. Selecting that action resets only the current task and reruns it once with the named profile instead of the cheapest-capable routing choice.

---

## 4. `validation`

What runs after every implementer task. The four base fields are **required** in the schema; the loader fills them from `createDefaultConfig()` if absent. Three optional command overrides let you pin exact validation commands per project.

### Schema

```ts
validation: {
  typecheck:    boolean;
  lint:         boolean;
  test:         boolean;
  testCommand:  string; // non-empty
  typecheckCommand?: string; // optional
  lintCommand?:      string; // optional
  testPattern?:      string; // optional
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `typecheck` | boolean | `true` | Master switch for the type-checking stage |
| `lint` | boolean | `true` | Master switch for the linting stage |
| `test` | boolean | `true` | Master switch for the test stage |
| `testCommand` | string | `npm test` | Argv-style test runner command. Diptych appends `-- <test-file>` for the affected test, so shell operators and environment expansion are not interpreted here. |
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

1. **User config** — `typecheckCommand`, `lintCommand`, `testCommand` override everything.
2. **Planner-discovered** — during the research phase, the planner reads config files and reports the project's validation toolchain. This is persisted to `WorkflowState.discoveredValidation` and used if no user config exists.
3. **Heuristic fallback** — if no config or discovery exists, diptych looks at marker files (`Cargo.toml`, `go.mod`, `pyproject.toml`, `package.json`) to infer the language and default commands.
4. **Graceful skip** — if no layer provides a command, the stage is silently skipped (no error).

Master switches (`typecheck`, `lint`, `test`) still gate each stage: setting `lint: false` skips lint regardless of whether a command is available.

**When to use the toggles:**
- Disable `test` for repos with no test suite.
- Disable `lint` if your linter is enforced only at PR time (CI) and you want faster local iteration.
- Leave `typecheck: true` for typed languages — it's the cheapest signal that the implementer wrote compilable code.

**See also:** [WORKFLOW.md](./WORKFLOW.md) (where validation sits in the loop), `src/engine/orchestrator/validation.ts`.

---

## 5. `workflow`

Mode, approval gates, retries, budget, git strategy, and brief-review style.

### Schema

```ts
workflow: {
  // Approval gates
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
  briefReview?:           'simple' | 'rich';

  // Budget
  maxBudget?:             number > 0;
  budgetPauseThreshold?:  0..1;
  driftChainThreshold?:   0..1;

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
| `approve` | enum | `default` | Approval gates: `none` (full auto), `spec` (gate spec only), `plan` (gate plan only), `all` (gate both), `default` (per-mode default). |
| `autoApproveSpec` | boolean | `false` | **Deprecated v2** — read by legacy code paths only. Use `approve`. |
| `autoApprovePlan` | boolean | `false` | **Deprecated v2** — read by legacy code paths only. Use `approve`. |
| `maxRetries` | int >= 0 | `3` | Per-task local retries before escalation kicks in |
| `commitStrategy` | enum | — | **Deprecated v2** — use `git.commitStrategy`. |
| `git.commitStrategy` | enum | `none` | Optional product-level git behavior: `none` (no commits — user reviews everything), `checkpoint` (one commit at end), `per-task` (one commit per task). Checkpoint safety does not require git commits. |
| `git.createBranch` | boolean | `false` | Auto-create `diptych/<slug>` branch at workflow start. |
| `briefReview` | enum | `simple` | `simple` (read-only review) \| `rich` (interactive plan editor). Press `e` from the simple view to opt into rich for the current session. |
| `maxBudget` | number > 0 | unset | USD ceiling. Workflow prompts when exceeded; if `budgetPauseThreshold` is set, also pauses earlier. |
| `budgetPauseThreshold` | 0..1 | unset | Fraction of `maxBudget` at which to pause. e.g. `0.8` pauses at 80%. |
| `driftChainThreshold` | 0..1 | unset | Drift-detection threshold for repeated escalation cycles. Higher = more tolerance. |
| `speckit.minCoverage` | 0..1 | unset | Speckit-mode minimum test-coverage gate. |
| `persistTranscript` | boolean | `true` | Persist planner/user text chunks to `session.jsonl` for replay/audit and `/compact-transcript`. |
| `compactionThreshold` | int >= 10 | unset | On resume, auto-compact persisted transcript context when compacted message count exceeds this threshold and the planner supports self-summarisation. |
| `compactionFormat` | enum | `auto` | Summary format for transcript compaction: `auto` selects structured JSON for `api` and `agent-sdk` planners, freeform text for `cli`, `shell`, and `agent`; `freeform` preserves legacy markdown/text summaries; `structured` requires Zod-validated JSON and falls back to freeform text if validation fails. |

### Per-mode defaults

| Mode | Planner calls | Default `approve` | Default `briefReview` | Auto snapshots | Best for |
|---|:---:|:---:|:---:|:---:|---|
| `instant` | 1 | `none` | `simple` | off | Trivial edits, no ceremony |
| `quick` | 1 | `none` | `simple` | off | Small task, still want a brief |
| `standard` (default) | 4 | `spec` | `simple` | off | Ordinary feature work |
| `speckit` | 6–7 | `all` | `rich` | off | Large, risky, externally visible |

`approve: default` resolves to the table above via `resolveApproveLevel()` (`src/core/config/runtime/resolve.ts`).

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
  briefReview: rich
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
- `git.commitStrategy: none` — the default and recommended setting for manual review. In this repository, implementation agents must keep this behavior and must never stage or commit.
- `maxBudget` — always set this for API-billed runs. It's your stop-loss.
- `budgetPauseThreshold` — set for unattended runs so you can intervene before the hard ceiling.
- `briefReview: rich` — when you want to edit the brief in-place before implementation; otherwise stick with `simple` for speed.
- `persistTranscript: true` — keep this enabled if you want resume reconstruction and manual transcript compaction. `/compact-transcript` appends a summary entry and keeps recent turns verbatim; it does not delete old log lines.

**See also:** [WORKFLOW.md](./WORKFLOW.md), [SLASH-COMMANDS.md](./SLASH-COMMANDS.md) (`/mode`, `/approve` runtime overrides).

---

## 6. `escalation`

When a task fails locally past `maxRetries`, diptych can re-route to a stronger model — either an "intermediate" tier configured here or back to the planner ("full escalation").

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
| `enabled` | boolean | `false` | Toggle the intermediate tier. If `false`, failed tasks escalate straight to the planner. |
| `intermediateProvider` | string | — | Provider id for the mid-tier model (any `ProviderId`). |
| `intermediateModel` | string | — | Model id at that provider. |

YAML:

```yaml
escalation:
  enabled: true
  intermediateProvider: openrouter
  intermediateModel: z-ai/glm-4.6
```

**When to use:** you run a cheap implementer (Ollama / DeepSeek) and want a "10x cheaper than the planner but smarter than the implementer" stop along the way before paying for an Opus retry. Skip if your implementer is already frontier-class.

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
  post_planning?:   HookEntry[];
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
| `block-secrets` | off | Reject commits/diffs containing common secret patterns in `pre_commit` |

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
| `serviceName` | string | `diptych` | `service.name` resource attribute on every span |

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

For OTLP HTTP/gRPC exporters, follow the standard [OTel SDK env var contract](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/).

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

## 11. `approval`

Tiered approval system for fine-grained operation gating. Sits orthogonal to `workflow.approve` (which controls spec/plan gates).

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
| `enabled` | boolean | `true` | Master toggle for tiered approval |
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

**Operation tiers:** `read`, `write_in_scope` (writing files inside the brief's scope), `validation` (running tsc/lint/test), `write_out_of_scope`, `destructive` (rm/git reset), `network` (curl/fetch), `package_change` (npm install / package.json edits).

YAML — strict:

```yaml
approval:
  enabled: true
  feedRejectionsToPlanner: true
  tiers:
    read: auto
    write_in_scope: sticky
    validation: auto
    write_out_of_scope: confirm
    destructive: confirm
    network: confirm
    package_change: confirm
```

**When to use:** untrusted projects, demoing diptych on production code, or onboarding where you want explicit visibility into every dangerous op.

---

## 12. `palette`

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

**See also:** [SLASH-COMMANDS.md](./SLASH-COMMANDS.md).

---

## 13. `theme`, `shikiTheme`, `sessions`

| Field | Type | Default | Description |
|---|---|---|---|
| `theme` | enum | `terminal` | `terminal` (uses your terminal's color scheme) \| `mono` (no color) |
| `shikiTheme` | enum | `github-dark` | `github-dark` \| `github-light` (Shiki syntax-highlighting theme) |
| `sessions.scope` | enum | `project` | `project` writes session state under `<projectDir>/.diptych`; `global` writes under `~/.diptych` (handy for one-off jobs you don't want polluting the repo). |

```yaml
theme: mono
shikiTheme: github-light
sessions:
  scope: global
```

---

## 14. Environment variables

Source: `src/core/providers/catalog.ts`, `src/cli/setup.ts`, `src/cli/otel-bootstrap.ts`, `src/engine/agent-sdk-backend.ts`, `src/engine/providers/registry.ts`, `src/engine/providers/client.ts`, `src/features/workflow/review-parser.ts`.

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
| `<PROVIDER>_API_KEY` | custom | For any custom `provider` name on `kind: api`, derived as `<UPPERCASE_PROVIDER>_API_KEY`. |

Inline `apiKey` in YAML works but triggers a stderr warning recommending the env var.

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
| Other `OTEL_*` | Standard OTel SDK env vars (endpoint, headers, etc.) when you wire an OTLP exporter. |

### TUI / process

| Variable | Purpose |
|---|---|
| `CI` | If truthy, suppress fullscreen TUI — diptych falls back to plain stdout (`src/cli/setup.ts`). |
| `SHELL` | Shell detection for spawn fallback (`src/lib/process/spawn.ts`). |
| `TERM_PROGRAM` | Kitty keyboard-protocol detection for advanced key bindings. |
| `EDITOR` | External editor for spec/plan/brief review (`vi` fallback). |
| `NODE_ENV` | `development` enables verbose store logs. |

---

## 15. CLI flags

Declared in `src/cli/options.ts` (shared by `start` + `resume`). These flags **override** the matching config field for the current invocation only.

| Flag | Purpose | Commands |
|---|---|---|
| `--auto` | Alias for `--approve none` | start, resume, spec |
| `--approve <level>` | `none` \| `spec` \| `plan` \| `all` \| `default` | start, resume |
| `--mode <mode>` | `instant` \| `quick` \| `standard` \| `speckit` (`full` legacy alias) | start, resume |
| `--budget <amount>` | Dollar ceiling | start, resume |
| `--model <m>` | Alias for `--implementer-model` | start, resume |
| `--provider <p>` | Alias for `--implementer` | start, resume |
| `--planner <tool>` | Planner tool override | start, resume |
| `--planner-model <m>` | Planner model override | start, resume |
| `--planner-command <cmd>` | Custom planner command (kind=shell) | start, resume |
| `--implementer <p>` | Implementer provider override | start, resume |
| `--implementer-model <m>` | Implementer model override | start, resume |
| `--implementer-command <cmd>` | Custom implementer command (kind=shell) | start, resume |
| `--project <dir>` | Project directory (default cwd) | start, resume, spec, status |
| `--no-fullscreen` | Disable alt-screen buffer | start, resume |
| `--no-mouse` | Disable mouse tracking | start, resume |
| `--allow-hooks` | Trust hook config without prompting (CI) | start, resume, spec |
| `--json` | Headless: NDJSON `EngineEvent`s to stdout, no TUI | start, resume |
| `--otel-exporter <name>` | Bootstrap built-in exporter (`console` only) | start, resume |
| `--reconfigure` | Overwrite existing config | init |
| `--history` | Show cost history across sessions | status |
| `-p, --project <dir>` | Project dir (migrate only) | migrate |

---

## 16. Validation behavior

Config is validated on every load (`src/core/config/load/load.ts:loadConfig`).

- Errors → `ConfigError` (`src/core/config/errors.ts`) → top-level catch in `src/cli/setup.ts` → exit code 2.
- Non-fatal warnings on stderr (`warnStderr` in `src/lib/warn.ts`):
  - Config file with permissions looser than `0600` on POSIX.
  - `apiKey` detected inline in config (recommends env var).
  - Anthropic key not starting with `sk-ant-`, etc.
  - `version: 2` accepted but deprecated → upgrade prompt.

Unknown top-level keys are tolerated; unknown nested keys in `.strict()` blocks (`hooks`, `codebase`, `otel`, every runner config, `PlannerCapabilities`) fail validation.

---

## 17. Migration (`diptych migrate`)

`diptych migrate -p <dir>` rewrites your config to the latest version in place. The migrator chains `migrateV1ToV2 → migrateV2ToV3` (`src/core/config/load/migrate.ts`).

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

## 18. Full production example

A representative config: Claude Code subscription as planner, Sonnet via direct Anthropic API as implementer, mid-tier escalation through OpenRouter, budget caps, snapshots, hooks, OTel, and tiered approval. Drop into `.diptych/config.yaml`, `chmod 600`, and you're production-ready.

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
implementer:
  kind: api
  provider: anthropic
  apiBase: https://api.anthropic.com/v1
  model: claude-sonnet-4-6
  contextLength: 1000000
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
  briefReview: rich
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

# ---------- Tiered approval: prompt on dangerous ops ----------
approval:
  enabled: true
  feedRejectionsToPlanner: true
  tiers:
    read: auto
    write_in_scope: sticky
    validation: auto
    write_out_of_scope: confirm
    destructive: confirm
    network: confirm
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
shikiTheme: github-dark
sessions:
  scope: project
```

Required env vars to make this run:
- `ANTHROPIC_API_KEY=sk-ant-...` (implementer)
- `OPENROUTER_API_KEY=sk-or-...` (escalation)
- `OTEL_TRACES_EXPORTER=console` *or* a full OTel exporter env block (observability)

Then:

```bash
diptych start --allow-hooks "your feature description"
```

---

## 19. See also

- [PRINCIPLES.md](./PRINCIPLES.md) — one-page rule index
- [ARCHITECTURE.md](./ARCHITECTURE.md) — runner contracts, orchestrator loop, event model
- [WORKFLOW.md](./WORKFLOW.md) — mode + approval semantics in depth
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, `HookEntry` schema, trust model
- [REPOMAP.md](./REPOMAP.md) — `codebase.*` semantics, PageRank, cache
- [OTEL.md](./OTEL.md) — span hierarchy, exporter setup
- [API-KEYS.md](./API-KEYS.md) — secret handling and redaction
- [SLASH-COMMANDS.md](./SLASH-COMMANDS.md) — runtime overrides and palette commands
- [DEBUGGING.md](./DEBUGGING.md) — diagnosing config load failures
- [ERRORS.md](./ERRORS.md) — `ConfigError` shape and exit codes
- [CONFIG.md](./CONFIG.md) — quick lookup table (this doc supersedes with examples)
