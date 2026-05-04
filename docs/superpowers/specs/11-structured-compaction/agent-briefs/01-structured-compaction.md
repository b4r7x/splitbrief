# 01 — Structured Compaction

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Add structured compaction mode with Zod schema, incremental merge, auto-detection, `/settings` integration, and freeform fallback. Existing freeform behavior unchanged.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/code-audit`

## Required Reading

- `CLAUDE.md`
- `src/core/sessions/compaction.ts` (current implementation — 59 lines)
- `src/core/schemas/session-log.ts` (SessionLogSummaryEntry — lines 32-39)
- `src/core/sessions/log-reader.ts` (readCompactedMessages)
- `src/engine/planners/base.ts` (SUMMARY_PROMPT line 48, summarize() lines 272-280)
- `src/engine/planners/types.ts` (PlannerCapabilities)
- `src/engine/orchestrator/resume-context.ts` (auto-compaction)
- `src/core/schemas/config.ts` (compactionThreshold)
- `src/core/slash-commands/catalog.ts` (/compact-transcript)
- `src/core/settings/catalog.ts` (settings registration)

## Write Ownership

```
src/core/schemas/compaction.ts                  (create)
src/core/schemas/compaction.test.ts             (create)
src/core/sessions/compaction.ts                 (modify)
src/core/sessions/compaction.test.ts            (modify)
src/core/schemas/config.ts                      (modify — add compactionFormat)
src/core/schemas/session-log.ts                 (modify — extend summary entry)
src/engine/planners/base.ts                     (modify — structured summarize)
src/core/settings/catalog.ts                    (modify — add setting)
```

## Required Behavior

### Part A: Structured summary schema

Create `src/core/schemas/compaction.ts`:

```typescript
import { z } from 'zod/v4';

export const StructuredSummarySchema = z.object({
  goal: z.string(),
  stepsCompleted: z.array(z.string()),
  currentStep: z.string(),
  filesModified: z.array(z.string()),
  constraintsDiscovered: z.array(z.string()),
  remainingWork: z.array(z.string()),
});

export type StructuredSummary = z.infer<typeof StructuredSummarySchema>;

export const CompactionFormatSchema = z.enum(['auto', 'freeform', 'structured']);
export type CompactionFormat = z.infer<typeof CompactionFormatSchema>;

export function resolveCompactionFormat(
  configured: CompactionFormat,
  plannerKind: string,
): 'freeform' | 'structured' {
  if (configured === 'freeform') return 'freeform';
  if (configured === 'structured') return 'structured';
  // auto: API/agent-sdk → structured, others → freeform
  return plannerKind === 'api' || plannerKind === 'agent-sdk' ? 'structured' : 'freeform';
}

export function tryParseStructuredSummary(text: string): StructuredSummary | null {
  try {
    const parsed = JSON.parse(text);
    const result = StructuredSummarySchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
```

### Part B: Extend config schema

In `src/core/schemas/config.ts`, add to the workflow object:

```typescript
compactionFormat: CompactionFormatSchema.default('auto'),
```

Import `CompactionFormatSchema` from `./compaction.js`.

### Part C: Extend session log summary entry

In `src/core/schemas/session-log.ts`, add optional `structured` field to `SessionLogSummaryEntrySchema`:

```typescript
export const SessionLogSummaryEntrySchema = z.object({
  ts: SessionLogTimestampSchema,
  kind: z.literal('summary'),
  text: z.string(),
  summarizedUpTo: SessionLogTimestampSchema,
  tokenEstimate: z.number().optional(),
  structured: StructuredSummarySchema.optional(), // NEW
});
```

Import `StructuredSummarySchema` from `./compaction.js`.

### Part D: Modify summarize in planner base

In `src/engine/planners/base.ts`, add a structured summarize prompt:

```typescript
const STRUCTURED_SUMMARY_PROMPT = `Summarize this conversation as JSON with exactly these fields:
{
  "goal": "what feature is being built",
  "stepsCompleted": ["phase/task completed", ...],
  "currentStep": "what is in progress now",
  "filesModified": ["path/to/file.ts", ...],
  "constraintsDiscovered": ["constraint or pattern found", ...],
  "remainingWork": ["what is left to do", ...]
}
Return ONLY valid JSON, no markdown fences, no explanation.`;

const STRUCTURED_MERGE_PROMPT = `You have a previous structured summary and new conversation messages.
Merge the new information into the existing summary. Extend arrays, update currentStep, add new files/constraints.
Return ONLY valid JSON with the same schema. Do not regenerate — merge incrementally.

Previous summary:
`;
```

Add `summarizeStructured` method alongside existing `summarize`:

```typescript
async summarizeStructured(
  messages: Array<{ role: string; text: string }>,
  previousSummary?: StructuredSummary,
): Promise<{ text: string; structured: StructuredSummary | null }> {
  const transcript = buildSummaryPrompt(messages);
  let prompt: string;
  if (previousSummary) {
    prompt = STRUCTURED_MERGE_PROMPT + JSON.stringify(previousSummary) + '\n\nNew messages:\n' + transcript;
  } else {
    prompt = STRUCTURED_SUMMARY_PROMPT + '\n\nConversation:\n' + transcript;
  }
  const result = await this.invokeEscalate(prompt);
  const text = result.text.trim();
  const structured = tryParseStructuredSummary(text);
  return { text, structured };
}
```

### Part E: Modify compaction logic

In `src/core/sessions/compaction.ts`, the `compactTranscript` function needs a new overload for structured mode:

```typescript
export interface CompactionOptions {
  sessionDir: string;
  planner: TranscriptCompactionPlanner;
  keepRecentCount?: number;
  format: 'freeform' | 'structured';
  previousStructured?: StructuredSummary;
}

export async function compactTranscript(opts: CompactionOptions): Promise<TranscriptCompactionResult> {
  const messages = await readLogMessages(opts.sessionDir);
  const summarizeCount = messages.length - normalizedKeepCount(opts.keepRecentCount);
  if (summarizeCount <= 0) return { summary: '', entriesRemoved: 0 };

  const summarizedMessages = messages.slice(0, summarizeCount);
  const msgArray = summarizedMessages.map(({ role, text }) => ({ role, text }));

  let summaryText: string;
  let structured: StructuredSummary | null = null;

  if (opts.format === 'structured' && opts.planner.summarizeStructured) {
    const result = await opts.planner.summarizeStructured(msgArray, opts.previousStructured);
    summaryText = result.structured ? JSON.stringify(result.structured) : result.text;
    structured = result.structured;
    // Fallback: if structured parse failed, summaryText is the raw response
  } else {
    summaryText = await opts.planner.summarize(msgArray);
  }

  const summarizedUpTo = summarizedMessages.at(-1)?.ts;
  if (summarizedUpTo === undefined) return { summary: '', entriesRemoved: 0 };

  await appendSummary(opts.sessionDir, {
    kind: 'summary',
    ts: String(Date.now()),
    text: summaryText,
    summarizedUpTo,
    ...(structured ? { structured } : {}),
  });

  return { summary: summaryText, entriesRemoved: summarizedMessages.length, structured };
}
```

**Backward compatibility:** The existing callers pass positional args `(sessionDir, planner, keepRecentCount)`. Add an adapter overload or update callers to use the options object. Check `transcript-rebuild.ts` and `catalog.ts`.

### Part F: Resume reads structured summary

In `src/core/sessions/log-reader.ts`, `readCompactedMessages` should prefer `structured` field when present for richer context. The structured JSON is more useful than freeform text for the orchestrator.

### Part G: Settings registration

In `src/core/settings/catalog.ts`, register the new setting:

```typescript
{
  key: 'workflow.compactionFormat',
  label: 'Compaction format',
  type: 'enum',
  options: ['auto', 'freeform', 'structured'],
  default: 'auto',
  description: 'Summary format for transcript compaction. auto picks based on planner kind.',
}
```

## TDD Steps

- [ ] **Write test: structured summary schema**

```typescript
// src/core/schemas/compaction.test.ts
import { describe, it, expect } from 'vitest';
import { StructuredSummarySchema, resolveCompactionFormat, tryParseStructuredSummary } from './compaction.js';

describe('StructuredSummarySchema', () => {
  it('validates correct structured summary', () => {
    const valid = {
      goal: 'add JWT auth',
      stepsCompleted: ['research', 'spec written'],
      currentStep: 'implementing task T003',
      filesModified: ['src/auth/middleware.ts'],
      constraintsDiscovered: ['must use RS256'],
      remainingWork: ['T004', 'T005'],
    };
    expect(StructuredSummarySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(StructuredSummarySchema.safeParse({ goal: 'test' }).success).toBe(false);
  });
});

describe('resolveCompactionFormat', () => {
  it('auto + api → structured', () => {
    expect(resolveCompactionFormat('auto', 'api')).toBe('structured');
  });
  it('auto + agent-sdk → structured', () => {
    expect(resolveCompactionFormat('auto', 'agent-sdk')).toBe('structured');
  });
  it('auto + cli → freeform', () => {
    expect(resolveCompactionFormat('auto', 'cli')).toBe('freeform');
  });
  it('explicit freeform overrides', () => {
    expect(resolveCompactionFormat('freeform', 'api')).toBe('freeform');
  });
  it('explicit structured overrides', () => {
    expect(resolveCompactionFormat('structured', 'cli')).toBe('structured');
  });
});

describe('tryParseStructuredSummary', () => {
  it('parses valid JSON', () => {
    const json = JSON.stringify({
      goal: 'x', stepsCompleted: [], currentStep: 'y',
      filesModified: [], constraintsDiscovered: [], remainingWork: [],
    });
    expect(tryParseStructuredSummary(json)).not.toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseStructuredSummary('not json')).toBeNull();
  });

  it('returns null for JSON missing fields', () => {
    expect(tryParseStructuredSummary('{"goal":"x"}')).toBeNull();
  });
});
```

- [ ] **Write test: structured compaction flow**

```typescript
// src/core/sessions/compaction.test.ts — extend existing tests
it('structured mode appends structured field to summary entry', async () => {
  // Create session with 20 messages
  // Call compactTranscript with format: 'structured'
  // Verify summary entry has .structured field
});

it('structured mode with previous summary uses merge prompt', async () => {
  // Call with previousStructured set
  // Verify planner.summarizeStructured received previousSummary
});

it('falls back to freeform when structured parse fails', async () => {
  // Planner returns invalid JSON
  // Verify summary saved as freeform text, no crash
});

it('freeform mode unchanged behavior', async () => {
  // Existing test: verify freeform produces same result as before
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Update callers** in transcript-rebuild.ts and catalog.ts
- [ ] **Register setting** in settings catalog
- [ ] **Run:** `npm run test-ci`
- [ ] **Update docs:** CONFIGURATION.md, SLASH-COMMANDS-REFERENCE.md, DIRECTION.md (mark AD-12 partial)

## Verification

- [ ] `compactionFormat: 'auto'` picks structured for API planner, freeform for CLI
- [ ] Structured compaction produces valid JSON matching schema
- [ ] Incremental merge: second compaction extends arrays, doesn't regenerate
- [ ] Freeform mode: zero behavior change from current
- [ ] Fallback: invalid planner JSON → saved as freeform text, warning logged
- [ ] `/settings` shows compactionFormat option
- [ ] Existing sessions with old freeform summaries resume correctly
- [ ] `npm run test-ci` passes
