# Configuration Reference

Single source of truth for the diptych configuration file. Every field, default, and validation rule below is derived from the zod schemas in `src/core/schemas/` and the loader in `src/core/config/load/`.

## File location

```
<project-root>/.diptych/config.yaml
```

The bootstrap creates it on first `diptych start` / `diptych init`. Missing file is equivalent to the default config (see `createDefaultConfig()` in `src/core/config/load/load.ts`). Schema version is `version: 2`.

Keys accept **both** `snake_case` and `camelCase` — the loader transforms `snake_case` YAML into `camelCase` before validation (`src/core/config/load/transform.ts`). Examples in this doc use `camelCase` to match the rest of the docs set.

## Top-level structure

```yaml
version: 2
planner:
  kind: cli | api | shell | agent | agent-sdk
  # + kind-specific fields (see below)
implementer:
  kind: cli | api | shell | agent | agent-sdk
  # + kind-specific fields
validation:
  typecheck: true
  lint: true
  test: true
  testCommand: "npm test"
workflow:
  mode: quick | standard | full
  approve: none | spec | plan | all | default
  autoApproveSpec: false   # deprecated; prefer approve
  autoApprovePlan: false   # deprecated; prefer approve
  maxRetries: 3
  commitStrategy: none | checkpoint | per-task  # deprecated; use workflow.git.commitStrategy
  git:
    commitStrategy: none | checkpoint | per-task
    createBranch: false     # auto-create diptych/<slug> branch at workflow start
  maxBudget: 2.0          # optional
  persistTranscript: true
theme: terminal | mono               # optional
shikiTheme: github-dark | github-light  # optional
sessions:
  scope: project | global            # optional
escalation:
  enabled: true
  intermediateProvider: openrouter
  intermediateModel: z-ai/glm-4.6
codebase:
  enabled: true
  tokenBudget: 4000
  cacheDir: ".diptych"
  include: ["src/**/*.ts"]
  exclude: ["\\.test\\.tsx?$"]
hooks:
  builtin: {}
  pre_task: [...]
  # ... per-event lists
otel:
  enabled: false
  serviceName: diptych
```

Schema: `src/core/schemas/config.ts`. Top-level unknown keys are **not** rejected (non-strict at the root); nested sections are mostly `.strict()` — see each section.

## `planner`

Discriminated union by `kind`. Schema: `src/core/schemas/planner-config.ts` + `src/core/schemas/runner-fields.ts`.

### Common generation fields (all kinds except `agent-sdk` require `model` as noted)

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `kind` | enum | yes | — | One of `cli`, `api`, `shell`, `agent`, `agent-sdk` |
| `model` | string | planner: optional; implementer: yes | — | Model identifier (provider-specific). Planner may omit for CLI tools that pick their own. |
| `customModels` | string[] | no | — | Extra model IDs merged into provider catalog |
| `contextLength` | integer > 0 | no | — | Context-window override |
| `temperature` | 0..2 | no | — | Sampling temperature |
| `timeout` | number, max 600000 | no | — | Per-call timeout ms |

### `kind: cli`

Known CLI tool subprocess. Fields from `CliRunnerFields`:

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `tool` | enum | yes | — | `claude-code` \| `codex` \| `opencode` \| `aider` \| `copilot` \| `kilo-code` |
| `args` | string[] | no | — | Extra argv passed to the tool |
| `outputFormat` | enum | no | — | `stream-json` \| `jsonl` \| `text` \| `opencode` |

### `kind: api`

OpenAI-compatible HTTP endpoint. Fields from `ApiRunnerFields`:

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `provider` | non-empty string | yes | — | Provider id (`anthropic`, `openrouter`, `deepseek`, `openai`, `groq`, `together`, `ollama`, `lm-studio`, or a custom name) |
| `apiBase` | non-empty string | yes | — | Base URL (e.g. `http://localhost:11434/v1`) |
| `apiKey` | string | no | — | Inline key. Prefer env var — see [API-KEYS.md](./API-KEYS.md). |

### `kind: shell`

Arbitrary stdin→stdout command. Fields from `ShellRunnerFields`:

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `command` | non-empty string | yes | — | Executable path |
| `args` | string[] | no | — | Argv |
| `outputFormat` | enum | no | — | Same values as `cli` |
| `capabilities` | partial object | no | — | `{ supportsConversationalPlanning?, supportsHintEscalation?, supportsSessionResume? }` |

### `kind: agent`

Subprocess that writes files directly (no stdout extraction). Same field shape as `shell` (`command`, `args`, `outputFormat`, `capabilities`).

### `kind: agent-sdk`

Anthropic Agent SDK library call. Fields from `AgentSdkRunnerFields`:

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `apiKey` | string | no | `ANTHROPIC_API_KEY` | Scoped per-call; never mutates global env. |

Each object is `.strict()` — unknown fields fail validation.

## `implementer`

Same discriminated union as `planner` (`src/core/schemas/implementer-config.ts`). The only difference: `model` is **required** on every kind except `agent-sdk` (planner treats `model` as optional).

## `validation`

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `typecheck` | boolean | yes | — | Run `tsc --noEmit` after each task |
| `lint` | boolean | yes | — | Run Biome check after each task |
| `test` | boolean | yes | — | Run tests after each task |
| `testCommand` | non-empty string | yes | `npm test` | Test runner command |

## `workflow`

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `approve` | enum | no | `default` | `none` \| `spec` \| `plan` \| `all` \| `default`. Controls which approval gates block the workflow. `default` follows the per-mode default (instant/quick → `none`, standard → `spec`, speckit → `all`). |
| `autoApproveSpec` | boolean | no | `false` | **Deprecated** — read by legacy code paths only. Use `approve` instead. |
| `autoApprovePlan` | boolean | no | `false` | **Deprecated** — read by legacy code paths only. Use `approve` instead. |
| `maxRetries` | integer >= 0 | yes | `3` | Max per-task local retries before escalation |
| `commitStrategy` | enum | no | `none` | **Deprecated** — use `git.commitStrategy` instead. `none` \| `checkpoint` \| `per-task` |
| `git.commitStrategy` | enum | yes | `none` | `none` \| `checkpoint` \| `per-task` |
| `git.createBranch` | boolean | no | `false` | Auto-create a `diptych/<slug>` branch at workflow start |
| `mode` | enum | no | `standard` | `instant` \| `quick` \| `standard` \| `speckit`. Legacy `full` accepted on input and silently migrated to `speckit` with a one-time deprecation notice. |
| `maxBudget` | number > 0 | no | — | Dollar ceiling; workflow prompts on exceed |
| `persistTranscript` | boolean | no | `true` | Persist planner/user text chunks to `session.jsonl` |

## `theme` / `shikiTheme`

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `theme` | enum | no | `terminal` | `terminal` \| `mono` |
| `shikiTheme` | enum | no | `github-dark` | `github-dark` \| `github-light` |

## `sessions`

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `scope` | enum | no | `project` | `project` writes under `<projectDir>/.diptych`; `global` writes under `~/.diptych` |

## `escalation`

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `enabled` | boolean | no | — | Toggle intermediate-provider escalation tier |
| `intermediateProvider` | string | no | — | Provider id for the mid-tier fallback |
| `intermediateModel` | string | no | — | Model id for the mid-tier fallback |

Schema: `EscalationConfigSchema` in `src/core/schemas/config.ts`.

## `codebase`

Repo-map context for the planner. Full details: [REPOMAP.md](./REPOMAP.md).

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `enabled` | boolean | no | `true` | Emit `<repo-map>` block to planner |
| `tokenBudget` | integer 1..50000 | no | `4000` | Tokens reserved for the block |
| `cacheDir` | string | no | `.diptych` | Location of `repomap.sqlite` |
| `include` | string[] | no | — | Glob patterns (default: walks `.ts`/`.tsx`) |
| `exclude` | string[] | no | — | Regex strings (default: test files + `dist/` + `node_modules/`) |

Schema: `src/core/schemas/codebase.ts` (`.strict()`).

## `hooks`

Lifecycle hook system. Full details: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `builtin` | `Record<string, boolean>` | no | — | Toggle built-ins: `prettier-on-change`, `block-secrets` |
| `pre_planning` | HookEntry[] | no | — | Before planner phase |
| `post_planning` | HookEntry[] | no | — | After `tasks.md` written |
| `pre_task` | HookEntry[] | no | — | Before each implementer task |
| `post_task` | HookEntry[] | no | — | After successful task |
| `pre_validation` | HookEntry[] | no | — | Before tsc/lint/test |
| `post_validation` | HookEntry[] | no | — | After validation |
| `pre_commit` | HookEntry[] | no | — | Before per-task commit |
| `post_commit` | HookEntry[] | no | — | After per-task commit |
| `pre_escalation` | HookEntry[] | no | — | Before planner escalation |
| `pre_compact` | HookEntry[] | no | — | Reserved (FUTURE) |
| `on_error` | HookEntry[] | no | — | Unrecoverable engine error |
| `on_complete` | HookEntry[] | no | — | `workflow_complete` event |

Each `HookEntry` is a discriminated union on `kind` (`command` default, or `module`). Strict — unknown top-level keys rejected.

Schema: `src/core/schemas/hooks.ts`.

## `otel`

OpenTelemetry sink. Full details: [OTEL.md](./OTEL.md).

| Field | Type | Required | Default | Description |
|---|---|:---:|---|---|
| `enabled` | boolean | no | `false` | Install the OTel span sink |
| `serviceName` | string | no | `diptych` | `service.name` resource attribute |

Schema: `src/core/schemas/otel.ts` (`.strict()`).

## Environment variables

Every env var read by non-test code:

| Variable | Purpose | Consumed by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Code planner + Agent SDK auth | `src/engine/providers/anthropic/adapter.ts`, `src/engine/agent-sdk.ts`, config validation |
| `OPENROUTER_API_KEY` | OpenRouter auth | `src/engine/providers/openrouter.ts` |
| `OPENAI_API_KEY` | OpenAI provider | `src/core/providers/catalog.ts` |
| `DEEPSEEK_API_KEY` | DeepSeek | catalog |
| `GROQ_API_KEY` | Groq | `src/engine/providers/groq.ts` |
| `OLLAMA_API_KEY` | Ollama (optional; usually unset) | `src/engine/providers/ollama.ts` |
| `<PROVIDER>_API_KEY` | Custom provider auth; derived from provider name | `src/engine/providers/client.ts` |
| `DIPTYCH_CONTEXT_LENGTH` | Override detected implementer context length | `src/engine/providers/registry.ts` |
| `OTEL_TRACES_EXPORTER` | Standard OTel — set to `console` to bootstrap the built-in ConsoleSpanExporter | `src/cli/otel-bootstrap.ts` |
| `DIPTYCH_OTEL_EXPORTER` | Alias for the above (same values) | `src/cli/otel-bootstrap.ts` |
| `CI` | Suppresses fullscreen TUI if truthy | `src/cli/setup.ts` |
| `SHELL` | User shell detection in spawn fallback | `src/lib/process/spawn.ts` |
| `TERM_PROGRAM` | Kitty keyboard protocol detection | `src/lib/terminal/kitty-keyboard.ts` |
| `EDITOR` | Review editor launch | `src/features/workflow/review-parser.ts` |
| `NODE_ENV` | Dev-mode store logging | `src/stores/create-store.ts` |

## CLI flags

Declared in `src/cli/options.ts` (shared by `start` + `resume`) and per-command files:

| Flag | Purpose | Commands |
|---|---|---|
| `--auto` | Alias for `--approve none` (auto-approve spec and plan) | start, resume, spec |
| `--approve <level>` | Approval gates: `none`, `spec`, `plan`, `all`, `default` | start, resume |
| `--model <model>` | Alias for `--implementer-model` | start, resume |
| `--provider <p>` | Alias for `--implementer` | start, resume |
| `--planner <tool>` | Planner tool override | start, resume |
| `--planner-model <m>` | Planner model override | start, resume |
| `--planner-command <cmd>` | Custom planner command (kind=shell) | start, resume |
| `--implementer <p>` | Implementer provider override | start, resume |
| `--implementer-model <m>` | Implementer model override | start, resume |
| `--implementer-command <cmd>` | Custom implementer command (kind=shell) | start, resume |
| `--project <dir>` | Project directory (default: cwd) | start, resume, spec, status |
| `--no-fullscreen` | Disable fullscreen alt-screen buffer | start, resume |
| `--no-mouse` | Disable mouse tracking | start, resume |
| `--mode <mode>` | `quick` / `standard` / `full` | start, resume |
| `--budget <amount>` | Dollar ceiling | start, resume |
| `--allow-hooks` | Trust hook config without prompting (CI) | start, resume, spec |
| `--json` | Headless — NDJSON EngineEvents to stdout, no TUI | start, resume |
| `--otel-exporter <name>` | Bootstrap built-in exporter (only `console` supported) | start, resume |
| `--reconfigure` | Overwrite existing config | init |
| `--history` | Show cost history across sessions | status |
| `-p, --project <dir>` | Project dir (migrate only) | migrate |

## Validation

Validation runs at config load. Errors surface as a `ConfigError` (`src/core/config/errors.ts`) that the CLI's top-level catch maps to exit code 2 (`src/cli/setup.ts` — `loadConfigOrExit`). See [ERRORS.md](./ERRORS.md) for the error-bag pattern.

Non-fatal conditions emit warnings on stderr (`warnStderr` in `src/lib/warn.ts`):

- Config file with permissions looser than `0600` on non-Windows.
- API key detected inline in config (recommends env var).
- Provider-specific key-format mismatches (e.g. Anthropic key not starting with `sk-ant-`).

## Examples

### Local Ollama only (zero cost)

```yaml
version: 2
planner:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:32b
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
  contextLength: 32768
  temperature: 0.3
validation:
  typecheck: true
  lint: true
  test: true
  testCommand: npm test
workflow:
  approve: default
  maxRetries: 3
  commitStrategy: none
  mode: standard
```

### Hybrid — Claude Code planner + Ollama implementer (default after `diptych init`)

```yaml
version: 2
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
  contextLength: 32768
  temperature: 0.3
validation: { typecheck: true, lint: true, test: true, testCommand: npm test }
workflow:
  approve: default
  maxRetries: 3
  commitStrategy: none
  mode: standard
codebase:
  enabled: true
  tokenBudget: 4000
```

### Full Claude + Codex with hooks + OTel

```yaml
version: 2
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: cli
  tool: codex
  model: gpt-5-codex
validation: { typecheck: true, lint: true, test: true, testCommand: npm test }
workflow:
  approve: default
  maxRetries: 3
  commitStrategy: per-task
  mode: full
  maxBudget: 5.00
hooks:
  builtin:
    prettier-on-change: true
    block-secrets: true
  post_task:
    - command: ./scripts/notify-slack.sh
      on_failure: warn
otel:
  enabled: true
  serviceName: diptych
```

### Headless CI (batch `spec` generation)

```yaml
version: 2
planner:
  kind: api
  provider: anthropic
  apiBase: https://api.anthropic.com/v1
  model: claude-opus-4-5
implementer:
  kind: api
  provider: deepseek
  apiBase: https://api.deepseek.com/v1
  model: deepseek-coder
validation: { typecheck: true, lint: true, test: true, testCommand: npm test }
workflow:
  approve: none
  maxRetries: 2
  commitStrategy: none
  mode: quick
```

Run with `diptych start --json --allow-hooks "feature description"`.

## See also

- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — hook events, `HookEntry` schema, trust model
- [REPOMAP.md](./REPOMAP.md) — `codebase.*` semantics, PageRank, cache
- [OTEL.md](./OTEL.md) — span hierarchy, exporter setup, `otel.*` semantics
- [API-KEYS.md](./API-KEYS.md) — secret handling and redaction
- [WORKFLOW.md](./WORKFLOW.md) — `workflow.mode` / approval-gate semantics
- [ERRORS.md](./ERRORS.md) — `ConfigError` shape and exit codes
- [DEBUGGING.md](./DEBUGGING.md) — diagnosing config load failures
