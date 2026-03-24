# Research: tiny-spec v0.2  -  Critical Fixes, Robustness & Core Value Delivery

**Date**: 2026-03-25
**Agents**: 4 parallel research agents + 21 analysis agents from prior session

## 1. Claude CLI Token Usage Format

### Decision
Extract token usage from the `result` event in Claude CLI `--output-format stream-json` output. The `result` event is the last event emitted and contains authoritative usage data.

### Key Findings

The `result` event structure:
```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "...",
  "total_cost_usd": 0.001234,
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 350,
    "cache_creation_input_tokens": 24036,
    "cache_read_input_tokens": 1000
  }
}
```

Fields available: `usage.input_tokens`, `usage.output_tokens`, `total_cost_usd`. Error variants also include usage.

The `assistant` event also carries per-step `message.usage` but the `result` event is the aggregated total  -  use it exclusively for accounting.

### Implementation Approach
- In the shared `parseStreamLine`, detect `type === 'result'` and return `usage` alongside `text` and `sessionId`
- Thread usage data back to the orchestrator to accumulate into `state.tokenUsage`
- Capture from planner (4 phases), escalator (tier 1 + tier 2), and final review

### Sources
- Claude Code CLI Reference: https://code.claude.com/docs/en/cli-reference
- Agent SDK TypeScript Reference: https://platform.claude.com/docs/en/agent-sdk/typescript
- Cost Tracking: https://platform.claude.com/docs/en/agent-sdk/cost-tracking

---

## 2. OpenAI SDK Streaming Token Usage

### Decision
Pass `stream_options: { include_usage: true }` in the API request. Capture usage from the final chunk where `choices` is empty.

### Key Findings

Final usage chunk structure:
```json
{
  "choices": [],
  "usage": {
    "prompt_tokens": 1500,
    "completion_tokens": 350,
    "total_tokens": 1850
  }
}
```

- Ollama added `stream_options.include_usage` support but it may vary by version  -  handle absent usage gracefully
- LM Studio, DeepSeek, and OpenRouter all support this standard OpenAI extension
- The `usage` field is `null` on all chunks except the final one

### Implementation Approach
- Add `stream_options: { include_usage: true }` to `streamCompletion()` API call
- Check each chunk for non-null `usage` field
- Return `{ text, usage }` from `streamCompletion`
- Map `prompt_tokens` → `implementerInput`, `completion_tokens` → `implementerOutput`

### Sources
- OpenAI Streaming Events: https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
- Ollama issue #4448: stream_options support

---

## 3. SIGINT Cleanup Strategy

### Decision
Use async signal handler with timeout + selective file cleanup via `currentTask.file`.

### Rationale
When Node.js registers a SIGINT listener, the default exit behavior is removed  -  the process stays alive until `process.exit()` is called explicitly. This allows async cleanup to complete before exit.

### Approach
```
onSignal():
  if (shuttingDown) → force exit (second Ctrl+C)
  shuttingDown = true
  killAllProcesses()
  saveState (sync  -  already uses writeFileSync)
  await Promise.race([
    revertCurrentTaskFile(projectDir, trackedState),
    timeout(5000)
  ])
  process.exit(130)
```

Selective cleanup: Revert only `currentTask.file` using `git checkout -- <file>`. If action is `create`, also `git clean -f -- <file>`. This is safe because `applyCode()` and the escalator only ever write to `task.file`.

### Alternatives Rejected
- **`spawnSync` in signal handler**: Works but blocks; chosen approach is cleaner
- **`git clean -f -d`**: Too aggressive  -  deletes ALL untracked files. Replaced with file-scoped cleanup
- **`git stash`**: Awkward with untracked files, conflict-prone
- **`process.on('exit')`**: Only supports sync operations, incompatible with simple-git

### Sources
- Node.js Process docs (signal handling behavior)
- Node.js Child Process docs (spawnSync safety)

---

## 4. Configuration Validation

### Decision
Hand-rolled validation (~70 lines in config.ts, zero new dependencies).

### Rationale
- The schema is small (14 fields, 4 nested objects) and stable
- Validation runs once per CLI invocation  -  no hot path
- Zero unnecessary deps is a core principle (7 deps currently)
- Custom error messages are more useful ("did you mean 'ollama'?")
- If schema grows beyond ~25 fields, migrate to Valibot (~1KB tree-shaken)

### Validation Rules

| Field | Rule |
|-------|------|
| `planner.tool` | Literal `'claude-code'` |
| `implementer.provider` | One of `'ollama' \| 'lm-studio' \| 'deepseek' \| 'openrouter'` |
| `implementer.model` | Non-empty string |
| `implementer.apiBase` | String (URL format) |
| `implementer.contextLength` | Positive integer |
| `implementer.temperature` | Number, 0–2 |
| `validation.typecheck/lint/test` | Boolean |
| `validation.testCommand` | Non-empty string |
| `workflow.autoApproveSpec/Plan` | Boolean |
| `workflow.maxRetries` | Non-negative integer |
| `workflow.commitPerTask` | Boolean |

### Alternatives Rejected
- **Zod/Zod Mini**: Excellent library but adds a dependency for 14 field checks
- **Valibot**: Strong fallback if schema grows; ~1KB after tree-shaking
- **AJV**: Too heavy (120KB, 5 transitive deps), poor TS integration

---

## 5. TypeScript 6.0 Migration

### Decision
Upgrade to TypeScript 6.0 with minimal config changes. Enable stricter checks incrementally.

### Critical Breaking Change
**`types` defaults to `[]`**  -  the build WILL BREAK without adding `"types": ["node", "react"]` to tsconfig.json. This is the only mandatory change.

### Migration Checklist

| Priority | Change | Risk |
|----------|--------|------|
| P0 | Add `"types": ["node", "react"]` | Build breaks without it |
| P1 | Remove unused `import React` from TSX files that only use JSX | Warning under verbatimModuleSyntax |
| P1 | Change `import React, { useState } from 'react'` to `import { useState } from 'react'` | Cleaner imports |
| P2 | Remove redundant `esModuleInterop: true` | Cosmetic (always-on in TS 6) |
| P2 | Replace `isolatedModules` with `verbatimModuleSyntax` | Forward-compatible |
| P3 | Enable `noFallthroughCasesInSwitch` | Safe  -  no errors in current code |
| P3 | Enable `noUncheckedIndexedAccess` | ~20-30 errors to fix (mostly null checks on array/regex indexing) |

### Sources
- TypeScript 6.0 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
- Migration guide: https://gist.github.com/privatenumber/3d2e80da28f84ee30b77d53e1693378f

---

## 6. OpenAI SDK v4 → v6 Migration

### Decision
Upgrade from v4.104.0 to v6.x. Low risk for the limited API surface used.

### Impact
- v5 (2025-05): Migrated from `node-fetch` to built-in `fetch` (needs Node 18+; project requires 22+)
- v6 (2025-09): Type refinements, ResponseFunctionToolCallOutputItem changes

The project uses only `new OpenAI({ baseURL, apiKey })` and `client.chat.completions.create({ stream: true })`  -  the most stable part of the API. No tool calls, no Responses API.

### Approach
- Update `package.json`: `"openai": "^6.0.0"`
- Add `stream_options: { include_usage: true }` (new in usage tracking work)
- Verify streaming chunk types haven't changed
- Run existing tests to confirm no regressions

---

## 7. Escalator Stream Parser Fix

### Decision
Replace the escalator's `parseStreamLine` (which incorrectly parses `content_block_start`/`content_block_delta` Anthropic API format) with the shared implementation that correctly parses `assistant`/`result` Claude CLI format.

### Root Cause
The escalator was apparently written against the Anthropic API streaming format, not the Claude CLI `stream-json` format. The planner and orchestrator correctly parse `assistant`/`result` events. The escalator is the only module with the wrong parser.

### Approach
Consolidate all three `parseStreamLine` implementations into a single shared function in a new `src/orchestrator/claude-stream.ts` module. This function handles `assistant`, `result`, and `session_id` events, and returns text, session ID, usage, and result flag.
