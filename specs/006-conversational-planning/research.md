# Research: Interactive UX Overhaul & Codebase Cleanup

## 1. Ink Text Input

**Decision**: Use `@inkjs/ui` package's `TextInput` component.
**Rationale**: Ink's official companion library. Provides `onSubmit`, `onChange`, `placeholder`, `suggestions`. Integrates with existing `useInput` hooks without conflict.
**Alternatives considered**: Raw `useInput` keystroke handling (too complex for text editing), `ink-text-input` community package (unmaintained).

**Key findings**:
- `@inkjs/ui` is NOT currently installed — needs `npm install @inkjs/ui`
- `TextInput` handles its own keyboard input internally, leaving `useInput` free for global shortcuts
- Integration pattern: state-based conditional rendering (same as existing `ApprovalPrompt`)
- Component renders inline in the TUI layout, not as a separate screen

## 2. Question Protocol Format

**Decision**: Use `<!-- Q:{...JSON...} -->` HTML comment markers embedded in planner output.
**Rationale**: HTML comments are invisible to markdown renderers, JSON is unambiguous, survives line-by-line streaming, malformed blocks silently ignored.
**Alternatives considered**: XML-like tags (can conflict with code output), special line prefixes like `??:` (fragile), separate JSON output channel (not supported by all backends).

**Format**:
```
<!-- Q:{"id":"q1","type":"choice","text":"Which auth strategy?","options":["JWT","Sessions","OAuth2"],"default":0} -->
```

**Question types**: `choice` (with options), `input` (free text), `confirm` (yes/no).

**Parsing**: Regex `<!-- Q:({.*?}) -->` with accumulator for streaming. Extract questions incrementally as complete markers arrive. Silent fallback if JSON malformed.

## 3. PATH Detection for Planners

**Decision**: Use existing `isAvailable()` methods on each `PlannerBackend` via the factory.
**Rationale**: All 6 backends already implement `isAvailable()` (checks `command --version`). No new dependency needed.
**Alternatives considered**: `which` npm package (unnecessary dependency), manual PATH search (reinventing what `isAvailable()` already does).

**Key findings**:
- All planners use `runCommand(tool, ['--version'])` pattern
- `detectLocalModels()` in `providers.ts` already handles implementer detection via HTTP probes
- New `detectAvailablePlanners()` function iterates all tools via factory + `isAvailable()`

## 4. Shell Implementer Architecture

**Decision**: Mirror the shell planner's subprocess architecture exactly.
**Rationale**: Same stdin/stdout contract, same process lifecycle. Reuses `extractCode()` and `applyCode()` from existing implementer.
**Alternatives considered**: Plugin interface with dynamic import (over-engineered), shared subprocess runner (divergent enough to warrant separate functions).

**Key findings from shell planner** (`planners/shell.ts`):
- Process: `spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd })`
- Input: Write prompt to `proc.stdin`, then `proc.stdin.end()`
- Output: Stream stdout line by line, parse via OutputFormat
- Exit codes: 127 = command not found (permanent error), non-zero = failure (retry eligible)
- Token tracking: Optional `Tokens: Xk sent, Yk received` line in text format

**Config additions to `implementer`**:
- `type?: 'api' | 'shell'` (default `'api'` for backward compat)
- `command?: string` (required when type is shell)
- `args?: string[]`
- `outputFormat?: OutputFormat`

## 5. Multi-Turn Planner Support Matrix

| Backend | Multi-turn | Mechanism | Conversational Mode |
|---------|-----------|-----------|-------------------|
| claude-code | YES | `--session-id` flag | Full support |
| agent-sdk | YES | Async generator, message events | Full support |
| codex | NO | Independent subprocess calls | Batch fallback |
| opencode | NO | Independent subprocess calls | Batch fallback |
| aider | MAYBE | `--chat-mode ask` (limited) | Batch fallback |
| shell | NO | Depends on command | Batch fallback |

**Implication**: Conversational mode (questions during planning) works with claude-code and agent-sdk. All others fall back to batch mode (generate spec without questions, then approve/reject).
