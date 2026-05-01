# 02 - Branch Summarization

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.
> Depends on: brief 01 (tree data model) must be implemented first.

## Goal

When recovery creates a branch (retry after failure), summarize the failed branch using a planner LLM call and inject the summary into the new branch's context. The retry gets structured knowledge of what was tried without paying for full context replay.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Zod 4.x for all schemas.
- Tests must verify behavior, artifacts, or filesystem effects.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/core/sessions/tree/schemas.ts` — tree entry envelope (from brief 01)
- `src/core/sessions/tree/store.ts` — `pathToRoot`, `branchFrom` (from brief 01)
- `src/engine/orchestrator/recovery/actions.ts` — recovery flow
- `src/core/schemas/recovery.ts` — `RecoveryIssue` schema
- `src/engine/events/types.ts` — event patterns
- `docs/superpowers/specs/2026-05-01-session-tree/decisions.md` — ADR-004

## Write Ownership

Primary files:

```text
src/core/sessions/tree/branch-summary.ts
src/core/sessions/tree/branch-summary.test.ts
src/core/sessions/tree/summary-prompt.ts
src/core/sessions/tree/summary-prompt.test.ts
```

Do not edit tree store or I/O files beyond imports. Do not edit recovery action files. Do not edit TUI files.

## Branch Summary Schema

```typescript
// src/core/sessions/tree/branch-summary.ts
import { z } from 'zod';

export const BranchSummarySchema = z.object({
  goal: z.string(),
  progress: z.array(z.string()),
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  nextSteps: z.array(z.string()),
  failureReason: z.string(),
  entryCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type BranchSummary = z.infer<typeof BranchSummarySchema>;
```

## Summary Prompt Builder

Build a prompt that asks the planner to summarize a failed branch. Input: the entries on the failed path. Output: structured summary.

```typescript
// src/core/sessions/tree/summary-prompt.ts
import type { TreeEntryEnvelope } from './schemas.js';
import type { BranchSummary } from './branch-summary.js';

export interface BranchContext {
  entries: TreeEntryEnvelope[];
  recoveryReason: string;
  taskTitle?: string;
}

export function buildBranchSummaryPrompt(ctx: BranchContext): string {
  const entryDescriptions = ctx.entries
    .filter(e => e.type !== 'session-start')
    .map(e => `- [${e.type}] ${summarizePayload(e)}`)
    .join('\n');

  return `You are summarizing a failed execution branch for a task retry.

The branch attempted: ${ctx.taskTitle ?? 'unknown task'}
Recovery reason: ${ctx.recoveryReason}
Branch had ${ctx.entries.length} entries.

Entries (newest first):
${entryDescriptions}

Produce a JSON summary with exactly these fields:
{
  "goal": "What the branch was trying to accomplish (1 sentence)",
  "progress": ["What was completed successfully (bullet points)"],
  "decisions": ["Key decisions made during execution"],
  "constraints": ["Constraints discovered or confirmed"],
  "nextSteps": ["What should be tried differently"],
  "failureReason": "Why the branch failed (1 sentence)"
}

Be concise. Each array should have 1-5 items. Total response under 300 tokens.`;
}

function summarizePayload(entry: TreeEntryEnvelope): string {
  if (entry.payload === null || entry.payload === undefined) {
    return `(${entry.type} at ${new Date(entry.timestamp).toISOString()})`;
  }
  if (typeof entry.payload === 'object' && entry.payload !== null) {
    const obj = entry.payload as Record<string, unknown>;
    if ('message' in obj && typeof obj.message === 'string') {
      return obj.message.slice(0, 120);
    }
    if ('title' in obj && typeof obj.title === 'string') {
      return obj.title;
    }
  }
  return String(entry.payload).slice(0, 80);
}
```

## Summary Extraction

Parse the LLM response into a validated `BranchSummary`:

```typescript
// src/core/sessions/tree/branch-summary.ts (continued)

export function parseBranchSummaryResponse(raw: string): BranchSummary | null {
  // Extract JSON from response (may be wrapped in markdown code blocks)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    const result = BranchSummarySchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
```

## Mechanical Fallback

If the LLM call fails or returns unparseable output, produce a mechanical summary from the entries themselves:

```typescript
export function mechanicalBranchSummary(ctx: BranchContext): BranchSummary {
  const firstEntry = ctx.entries[ctx.entries.length - 1];
  const lastEntry = ctx.entries[0];
  const durationMs = lastEntry && firstEntry
    ? lastEntry.timestamp - firstEntry.timestamp
    : 0;

  const typeBreakdown = new Map<string, number>();
  for (const entry of ctx.entries) {
    typeBreakdown.set(entry.type, (typeBreakdown.get(entry.type) ?? 0) + 1);
  }

  const progress = [...typeBreakdown.entries()]
    .map(([type, count]) => `${count}x ${type}`)
    .slice(0, 5);

  return {
    goal: ctx.taskTitle ?? 'Unknown task execution',
    progress,
    decisions: [],
    constraints: [],
    nextSteps: [`Retry with different approach (previous attempt: ${ctx.recoveryReason})`],
    failureReason: ctx.recoveryReason,
    entryCount: ctx.entries.length,
    durationMs,
  };
}
```

## Summarize-and-Branch Orchestrator

Ties the pieces together: extract failed branch entries, call LLM (or fallback), create branch with summary entry.

```typescript
import type { SessionTree } from './store.js';
import { pathToRoot, branchFrom } from './store.js';
import type { EntryId } from './schemas.js';

export interface SummarizeBranchOptions {
  tree: SessionTree;
  failedLeafId: EntryId;
  branchPointId: EntryId;
  recoveryReason: string;
  taskTitle?: string;
  timestamp: number;
  /** If provided, calls LLM. If null, uses mechanical fallback. */
  callLlm: ((prompt: string) => Promise<string>) | null;
}

export async function summarizeAndBranch(opts: SummarizeBranchOptions): Promise<{
  tree: SessionTree;
  summary: BranchSummary;
  entry: TreeEntryEnvelope;
}> {
  const failedPath = pathToRoot(opts.tree, opts.failedLeafId);

  const ctx: BranchContext = {
    entries: failedPath,
    recoveryReason: opts.recoveryReason,
    taskTitle: opts.taskTitle,
  };

  let summary: BranchSummary;

  if (opts.callLlm) {
    const prompt = buildBranchSummaryPrompt(ctx);
    try {
      const response = await opts.callLlm(prompt);
      const parsed = parseBranchSummaryResponse(response);
      summary = parsed ?? mechanicalBranchSummary(ctx);
    } catch {
      summary = mechanicalBranchSummary(ctx);
    }
  } else {
    summary = mechanicalBranchSummary(ctx);
  }

  // Add duration info
  summary = {
    ...summary,
    entryCount: failedPath.length,
    durationMs: failedPath.length > 1
      ? failedPath[0]!.timestamp - failedPath[failedPath.length - 1]!.timestamp
      : 0,
  };

  const { tree: newTree, entry } = branchFrom(opts.tree, {
    fromId: opts.branchPointId,
    type: 'branch-summary',
    payload: summary,
    timestamp: opts.timestamp,
    display: true,
  });

  return { tree: newTree, summary, entry };
}
```

## Tests

### Summary prompt tests (`summary-prompt.test.ts`)

- `buildBranchSummaryPrompt` includes recovery reason and task title.
- `buildBranchSummaryPrompt` handles entries with various payload shapes.
- `buildBranchSummaryPrompt` limits entry descriptions to prevent unbounded output.
- `summarizePayload` extracts `message` field from object payloads.
- `summarizePayload` truncates long strings.
- `summarizePayload` handles null/undefined payloads.

### Branch summary tests (`branch-summary.test.ts`)

- `parseBranchSummaryResponse` extracts JSON from clean response.
- `parseBranchSummaryResponse` extracts JSON from markdown-wrapped response.
- `parseBranchSummaryResponse` returns null for non-JSON response.
- `parseBranchSummaryResponse` returns null for malformed JSON.
- `parseBranchSummaryResponse` returns null for JSON missing required fields.
- `mechanicalBranchSummary` produces valid summary from entries.
- `mechanicalBranchSummary` calculates duration from timestamps.
- `mechanicalBranchSummary` handles empty entries gracefully.
- `summarizeAndBranch` with null LLM uses mechanical fallback.
- `summarizeAndBranch` with LLM that returns valid JSON uses parsed summary.
- `summarizeAndBranch` with LLM that throws uses mechanical fallback.
- `summarizeAndBranch` creates branch-summary entry in tree.
- `summarizeAndBranch` branch-summary payload is valid `BranchSummary`.

## Validation Commands

```bash
npm test -- src/core/sessions/tree/branch-summary.test.ts
npm test -- src/core/sessions/tree/summary-prompt.test.ts
npm run typecheck
npm run lint
```

## Non-Goals

- No actual LLM integration (the `callLlm` parameter is a dependency-injected function).
- No retry logic for LLM calls (caller's responsibility).
- No cost tracking for summary calls (handled by existing cost infrastructure).
- No TUI rendering of summaries in this brief.
- No integration with recovery action dispatch (that's plumbing, not this brief's scope).

## Expected Final Report

Report:

- files changed
- schema shapes implemented
- prompt builder coverage
- fallback behavior verified
- round-trip summary + branch operation tested
- validation commands run and results
- risks or follow-ups for downstream briefs
