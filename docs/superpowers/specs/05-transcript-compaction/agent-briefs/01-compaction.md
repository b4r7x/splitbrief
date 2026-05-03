# 01 - Transcript Compaction

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Add `summary` entry to session log, planner `summarize()` method, compaction logic, `/compact-transcript` command, auto-compaction trigger, and compaction-aware resume.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/code-audit`

## Write Ownership

```
src/core/schemas/session-log.ts                (modify — add summary kind)
src/core/sessions/log-reader.ts                (modify — add compacted read)
src/core/sessions/compaction.ts                (create)
src/core/sessions/compaction.test.ts           (create)
src/engine/planners/types.ts                   (modify — add capability)
src/engine/planners/base.ts                    (modify — add summarize())
src/core/slash-commands/catalog.ts             (modify — add command)
src/core/schemas/config.ts                     (modify — add compactionThreshold)
```

## Required Behavior

### Summary entry in session log

Add to `SessionLogEntrySchema` discriminated union:
```typescript
z.object({
  ts: z.number(),
  kind: z.literal('summary'),
  text: z.string(),
  summarizedUpTo: z.number(),
  tokenEstimate: z.number().optional(),
})
```

### Planner capability + summarize method

Add `supportsSelfSummarisation: boolean` to `PlannerCapabilities`. Set true for conversational planners (claude-code CLI, api). Set false for shell/agent.

Add `summarize(messages: Array<{role: string; text: string}>): Promise<string>` to planner base. Uses a summary prompt:

```
Summarize this conversation compactly. Preserve: feature goal, key decisions, progress (phases/tasks done), files modified, active constraints, pending items. Output as structured markdown.
```

### Compaction logic

```typescript
// src/core/sessions/compaction.ts
export async function compactTranscript(
  sessionDir: string,
  planner: { summarize: (msgs: Array<{role: string; text: string}>) => Promise<string> },
  keepRecentCount?: number,
): Promise<{ summary: string; entriesRemoved: number }>
```

1. Read all entries from session.jsonl
2. Separate messages from events
3. Keep last N messages (default 10) untouched
4. Pass older messages to planner.summarize()
5. Append `summary` entry with `summarizedUpTo = timestamp of last summarized entry`
6. Return stats. **Do NOT delete old entries** — append-only.

### Compaction-aware resume

Add `readCompactedMessages(sessionDir)`:
1. Read all entries
2. Find latest `summary` entry
3. If found: return [summary-as-user-message, ...entries after summarizedUpTo]
4. If not: return all messages (current behavior)

Wire into planner resume path (base.ts) where transcript is rebuilt.

### Slash command

Register `/compact-transcript` in catalog.ts. Check `planner.capabilities.supportsSelfSummarisation`. If unsupported → show message and return. Otherwise → run compaction → show stats.

### Auto-compaction

Add `compactionThreshold: z.number().int().min(10).optional()` to workflow config. In the resume/drain path, check message count vs threshold. If exceeded and planner supports it → auto-compact.

## TDD Steps

- [ ] **Write test: basic compaction**

```typescript
// src/core/sessions/compaction.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compactTranscript } from './compaction.js';

describe('compactTranscript', () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), 'sess-')); });
  afterEach(() => { rmSync(sessionDir, { recursive: true }); });

  it('appends summary entry and preserves old entries', async () => {
    const logFile = join(sessionDir, 'session.jsonl');
    for (let i = 0; i < 20; i++) {
      appendFileSync(logFile, JSON.stringify({
        ts: 1000 + i, kind: 'message', role: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i}`,
      }) + '\n');
    }

    const fakePlanner = { summarize: async () => '## Summary\nGoal: test\nProgress: done' };
    const result = await compactTranscript(sessionDir, fakePlanner, 10);

    expect(result.entriesRemoved).toBe(10); // 20 - 10 kept
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(21); // 20 original + 1 summary
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    expect(lastEntry.kind).toBe('summary');
  });

  it('resume reads summary + recent entries only', async () => {
    // Write 20 entries + 1 summary entry
    // Call readCompactedMessages
    // Verify: returns summary + entries after summarizedUpTo
  });

  it('handles empty session gracefully', async () => {
    const logFile = join(sessionDir, 'session.jsonl');
    appendFileSync(logFile, '');
    const fakePlanner = { summarize: async () => 'summary' };
    // Should not throw, should return 0 entries removed
  });
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Register slash command, run test-ci**
- [ ] **Update docs:** SLASH-COMMANDS-REFERENCE.md, CONFIGURATION.md, WORKFLOW.md, FUTURE.md

## Verification

- [ ] session.jsonl is append-only — old entries preserved after compaction
- [ ] Resume uses summary instead of old messages
- [ ] Multiple compactions: latest summary supersedes previous
- [ ] Planner without summarize capability → graceful skip
- [ ] Auto-compaction triggers at configured threshold
- [ ] `npm run test-ci` passes
