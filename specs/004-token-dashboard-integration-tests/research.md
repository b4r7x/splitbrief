# Research: Pluggable Orchestrator, Token Dashboard & Integration Tests

**Date**: 2026-03-26
**Agents**: 8 parallel research agents

## 1. Planner Backend Interfaces

### Claude Code CLI (current — subprocess)
- **Command**: `claude -p "prompt" --output-format stream-json --session-id <id>`
- **Output**: NDJSON with `assistant` (text), `result` (usage, costUsd), session events
- **Token usage**: In `result` event: `{ inputTokens, outputTokens }` + `costUsd`
- **Session**: `--session-id` for multi-turn, `--resume` for continuation
- **Auth**: OAuth (Max subscription) or API key — subprocess uses whichever is configured
- **Permissions**: `-p` mode is non-interactive; use `--allowedTools` for scoped access
- **Decision**: Keep as primary backend. Validated by Anthropic's own GitHub Actions usage.

### Codex CLI (subprocess)
- **Command**: `codex exec --json --full-auto "prompt" --cd /path`
- **Output**: JSONL with event types: `thread.started`, `turn.completed`, `item.completed`
- **Token usage**: In `turn.completed`: `{ input_tokens, cached_input_tokens, output_tokens }`
- **Session**: `thread_id` from `thread.started`, resume via `codex exec resume <id>`
- **Auth**: `CODEX_API_KEY` or `~/.codex/auth.json`
- **Key flags**: `--model <model>`, `--sandbox <mode>`, `--output-schema <file>`, `--oss` for local
- **Decision**: Good fit. JSONL format similar to Claude Code. Full non-interactive support.

### Aider (subprocess)
- **Command**: `aider --architect --model <m> --editor-model <m> --yes-always --no-stream --no-pretty --message "prompt" files...`
- **Output**: Plain text only — NO JSON/structured output
- **Token usage**: Text line: `Tokens: 12.3k sent, 1.2k received. Cost: $0.04 message`
- **Session**: No session continuity in subprocess mode
- **Limitations**: No plan-approval workflow, no task decomposition, no structured output
- **Decision**: Supported but with caveats. Output must be parsed from plain text. No native planning workflow — best used as architect+editor for single tasks, not multi-phase planning.

### OpenCode (subprocess)
- **Command**: `opencode run --format json --agent plan "prompt"`
- **Output**: NDJSON with event types: `tool_use`, `step_start`, `step_finish`, `text`, `reasoning`
- **Token usage**: In `step_finish`: `{ tokens: { input, output, reasoning, cache }, cost }`
- **Session**: Continue with `-c` flag
- **Key features**: Separate `--agent plan` (read-only) and `--agent build` modes
- **Auth**: Provider-specific API keys
- **Decision**: Excellent fit. Native plan/build split matches our architecture perfectly. JSON output with full token data.

### Anthropic Agent SDK (programmatic)
- **Package**: `@anthropic-ai/claude-agent-sdk` (v0.2.84)
- **API**: `query({ prompt, options })` returns `AsyncGenerator<SDKMessage>`
- **Token usage**: Per-message `BetaMessage.usage` + aggregate `SDKResultMessage.total_cost_usd` and `modelUsage`
- **Session**: `resume: sessionId`, `continue: true`, `forkSession: true`
- **Auth**: **API key only** — cannot use OAuth/Max subscription
- **Permissions**: `allowedTools`, `permissionMode`, `canUseTool` callback
- **Decision**: Best programmatic API, but requires API key ($$). Useful as premium option for users who have API access.

### Comparison Matrix

| Feature | Claude Code | Codex CLI | Aider | OpenCode | Agent SDK |
|---------|-------------|-----------|-------|----------|-----------|
| Non-interactive | ✅ `-p` | ✅ `exec` | ✅ `--message` | ✅ `run` | ✅ `query()` |
| JSON output | ✅ stream-json | ✅ JSONL | ❌ text only | ✅ NDJSON | ✅ typed msgs |
| Token usage | ✅ result event | ✅ turn.completed | ⚠️ text parse | ✅ step_finish | ✅ per-message |
| Session resume | ✅ --session-id | ✅ thread_id | ❌ | ✅ -c flag | ✅ resume |
| Plan/build split | ❌ single mode | ❌ single mode | ⚠️ architect only | ✅ --agent plan/build | ❌ single mode |
| Auth cost | $0 (subscription) | API key | API key | API key | API key |
| Structured output | ❌ | ✅ --output-schema | ❌ | ❌ | ✅ outputFormat |

## 2. Pricing Table (March 2026)

### Cloud Providers

| Provider/Model | Input / 1M tokens | Output / 1M tokens |
|----------------|-------------------|---------------------|
| **Claude Opus 4.6** | $5.00 | $25.00 |
| **Claude Sonnet 4.6** | $3.00 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $5.00 |
| GPT-4o | $2.50 | $10.00 |
| o3 | $2.00 | $8.00 |
| o4-mini | $1.10 | $4.40 |
| **DeepSeek V3/R1** | $0.28 | $0.42 |
| Gemini 2.5 Pro (≤200K) | $1.25 | $10.00 |
| Gemini 2.5 Flash | $0.30 | $2.50 |

### Local Providers

| Provider | Cost |
|----------|------|
| Ollama | $0.00 (local inference) |
| LM Studio | $0.00 (local inference) |

### Subscriptions

| Plan | Price | Note |
|------|-------|------|
| Claude Max 5x | $100/mo | `claude -p` subprocess counts against limits |
| Claude Max 20x | $200/mo | Same |
| OpenRouter | 0% markup + 5.5% credit fee | Pass-through pricing |

**CRITICAL FINDING**: Current code hardcodes Opus at $15/$75 per MTok. Actual Opus 4.6 pricing is $5/$25. Must update `OPUS_INPUT_PRICE` and `OPUS_OUTPUT_PRICE` constants.

**CRITICAL WARNING**: If user has `ANTHROPIC_API_KEY` set, `claude -p` bills to API account (not subscription). Documented incident of $1,800+ unexpected charges.

## 3. Ink TUI Patterns

- **Screen switching**: React state (`useState<'workflow' | 'summary'>`) with conditional rendering
- **Tables**: Build with `Box` + `Text` with fixed widths — `@inkjs/ui` has NO Table component
- **Useful @inkjs/ui**: `ProgressBar` (value 0-100), `Badge` (colored label), `StatusMessage` (variant)
- **Terminal size**: `useStdout().stdout.columns/rows`
- **Exit pattern**: `useInput` + `useApp().exit()` on q/Enter/Esc keypress
- **Number formatting**: Pure function `formatTokens(n)` with K/M suffixes

## 4. Integration Test Patterns

- **Skip pattern**: `describe('suite', { skip: !available && 'reason' })` on `node:test`
- **Connectivity check**: Top-level `await` with `fetch()` before describe blocks
- **Fixture project**: String constants for package.json/tsconfig/source, written to `mkdtemp()` per test
- **Subprocess testing**: `execFile` with timeout + promise wrapper
- **Separation**: `tests/*.test.ts` (unit) vs `tests/integration/*.integration.test.ts`
- **Opt-in**: `INTEGRATION=true` env var + service connectivity guard
- **Timeouts**: Per-test `{ timeout: 60_000 }` + AbortController on fetches

## 5. Current Architecture Analysis

### What's Hardcoded to Claude Code
1. `planner.ts`: `spawnClaude()` directly spawns `claude` binary
2. `escalator.ts`: Same `spawnClaude()` for hints and full escalation
3. `config.ts`: Validates `planner.tool === 'claude-code'` only
4. `orchestrator.ts`: `OPUS_INPUT_PRICE = 15`, `OPUS_OUTPUT_PRICE = 75` (OUTDATED)
5. `templates.ts`: Escalation prompts mention "Opus" and "local AI model"

### What's Already Generic
1. `providers.ts`: Implementer abstraction (baseURL swap)
2. `state.ts`: Phase transitions are provider-agnostic
3. `validator.ts`: Agnostic to what produced the code
4. `types.ts`: `TokenUsage` type is generic (6 dimensions)
5. `PlanResult` type: Just spec/plan/tasks/usage — no Claude specifics

### Files Requiring Modification
1. `src/types.ts` — Expand Config.planner, add PlannerProvider type
2. `src/config.ts` — Accept multiple planner tools, add pricing config
3. `src/orchestrator/planner.ts` — Refactor into interface + Claude Code backend
4. `src/orchestrator/escalator.ts` — Route through planner interface
5. `src/orchestrator/orchestrator.ts` — Dynamic pricing, token display callbacks
6. `src/tui/status-bar.tsx` — Show planner name + live token count
7. `src/app.tsx` — Add summary screen with screen switching

### Files to Create
1. `src/orchestrator/planners/types.ts` — PlannerBackend interface
2. `src/orchestrator/planners/claude-code.ts` — Current impl extracted
3. `src/orchestrator/planners/codex.ts` — Codex CLI backend
4. `src/orchestrator/planners/opencode.ts` — OpenCode backend
5. `src/orchestrator/planners/aider.ts` — Aider backend
6. `src/orchestrator/planners/agent-sdk.ts` — Agent SDK backend
7. `src/orchestrator/planners/factory.ts` — Factory function
8. `src/orchestrator/pricing.ts` — Pricing table lookup
9. `src/tui/summary.tsx` — Full-screen completion dashboard
10. `tests/integration/` — Integration test suite

## 6. Architecture Decision: Functions vs Classes

Constitution requires "Zero classes." The planner abstraction uses **discriminated unions + factory functions**:

```typescript
// NOT this (class):
class ClaudeCodePlanner implements PlannerBackend { ... }

// THIS (function module):
export function createClaudeCodePlanner(): PlannerBackend { ... }

// Where PlannerBackend is an interface with function properties:
export interface PlannerBackend {
  readonly name: string;
  plan: (feature: string, ...) => Promise<PlanResult>;
  escalateHint: (task: Task, ...) => Promise<EscalationResult>;
  escalateFull: (task: Task, ...) => Promise<EscalationResult>;
  isAvailable: () => Promise<boolean>;
  getPricing: () => PricingInfo;
}
```

This satisfies both the interface need and the "no classes" constraint.
