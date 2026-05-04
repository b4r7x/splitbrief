# Decisions

## ADR-001 — Compaction Stays Threshold-Triggered, Never Main Path

**Status:** accepted

### Context

User concern: "nie mozemy tez zrobic tak, zeby to byl main thing, bo tak to context moze sie szybko robic blurry." Compaction summarizes — summaries are lossy. Making it automatic or aggressive would degrade context quality.

### Decision

Compaction triggers remain exactly as today:
- Manual: `/compact-transcript` slash command.
- Auto: only when `workflow.compactionThreshold` is set AND message count exceeds it.
- Default: no auto-compaction (threshold is optional, unset by default).

Summary **augments** recent messages, **never replaces** them. Resume always produces `[summary] + [last N raw messages]`.

### Consequences

- No behavior change for users who don't configure threshold.
- Context quality preserved — raw messages are the ground truth, summary is supplementary.
- No surprise compaction during active planner turns.

## ADR-002 — Two Modes: `freeform` and `structured`

**Status:** accepted

### Context

Current compaction produces freeform text. Structured format with Zod validation gives better guarantees but requires JSON-capable planners.

### Decision

Two compaction formats:
- `freeform` — existing behavior, unchanged. Planner writes whatever it wants.
- `structured` — planner must return JSON matching a Zod schema. Enables incremental merge.

Config: `workflow.compactionFormat: 'auto' | 'freeform' | 'structured'` (default: `auto`).

### Consequences

- Zero breaking changes — `freeform` is the implicit default for CLI planners.
- `structured` is opt-in or auto-selected for capable planners.
- Both modes use the same trigger, storage, and resume paths.

## ADR-003 — Auto-Detection Based on Planner Kind

**Status:** accepted

### Context

Not all planners produce reliable JSON. CLI planners (Claude Code, Codex) are subprocesses — we don't control their output format. API/agent-sdk planners receive our prompt directly and can follow JSON instructions.

### Decision

When `compactionFormat: 'auto'` (default):
- `kind: api` or `kind: agent-sdk` → `structured`
- `kind: cli`, `kind: shell`, `kind: agent` → `freeform`

User can always override via config or `/settings`.

### Consequences

- API users get structured compaction automatically.
- CLI users get the safe default (freeform) with option to upgrade.
- `/settings` overlay exposes the choice for runtime changes.

## ADR-004 — Structured Schema Shape

**Status:** accepted

### Context

Need to decide what fields the structured summary carries.

### Decision

```typescript
{
  goal: string;             // feature being built
  stepsCompleted: string[]; // phases/tasks done
  currentStep: string;      // what's in progress now
  filesModified: string[];  // paths touched so far
  constraintsDiscovered: string[]; // rules/patterns found during work
  remainingWork: string[];  // what's left to do
}
```

### Consequences

- Covers the 6 dimensions the orchestrator needs for context rebuild.
- Array fields allow incremental append during merge.
- All fields are strings/string arrays — no nested objects, simple to merge.

## ADR-005 — Incremental Merge for Structured Mode

**Status:** accepted

### Context

Current compaction regenerates from scratch every time. With structured format, we can pass the previous summary to the planner and ask it to merge rather than regenerate.

### Decision

When structured summary exists AND a new compaction is triggered:
1. Pass previous structured summary + new messages to planner.
2. Prompt asks to **merge** new info into existing summary, not regenerate.
3. Arrays are extended, not replaced (e.g., `filesModified` grows).

### Consequences

- Cheaper: planner processes only new messages + short summary, not entire history.
- Preserves information: earlier compaction rounds' data survives in the merged summary.
- On first compaction (no previous summary), behaves like a fresh generation.

## ADR-006 — Fallback to Freeform on Validation Failure

**Status:** accepted

### Context

Structured mode expects valid JSON from the planner. Planners sometimes produce malformed output.

### Decision

If structured compaction output fails Zod validation:
1. Log a warning event (`compaction_fallback`).
2. Store the raw text as a freeform summary (current `SessionLogSummaryEntry.text`).
3. Do not retry, do not error, do not block the workflow.

### Consequences

- Compaction never crashes the session.
- User sees a warning but the session continues.
- Next compaction attempt can still try structured (previous freeform summary won't have merge data, so it generates fresh).
