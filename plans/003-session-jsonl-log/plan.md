# 003 — Session JSONL Log — Plan

## Data model

### Config field

```ts
// src/core/types/schemas/config.ts — inside WorkflowConfigSchema
persistTranscript: z.boolean().default(true),
```

Migration path: configs without this field get `true` on read. No explicit migration code needed — Zod's `.default()` handles it.

### Session log entry shape

No separate Zod schema for entries (they're written only, read only by diptych itself) — TypeScript discriminated union in `src/core/types/events.ts`:

```ts
export type SessionLogEventEntry = {
  ts: string;
  kind: 'event';
  type: OrchestratorEventType;
  // …fields per event type
};

export type SessionLogMessageEntry = {
  ts: string;
  kind: 'message';
  role: 'user' | 'assistant';
  phase?: Phase;
  text: string;
  interrupted?: boolean;
  queuedAt?: string;
  drainedAt?: string;
};

export type SessionLogEntry = SessionLogEventEntry | SessionLogMessageEntry;
```

### Paths

`src/core/paths.ts`:

```ts
export const SESSION_LOG_FILE = 'session.jsonl';
// delete EVENTS_FILE
```

## Writer API

`src/core/state/persistence.ts` gains:

```ts
export function appendEvent<T extends OrchestratorEventType>(
  projectDir: string,
  sessionId: string,
  event: OrchestratorEvent<T>,
): void {
  const entry = { ts: new Date().toISOString(), kind: 'event' as const, ...event };
  appendLine(projectDir, sessionId, entry);
}

export function appendMessage(
  projectDir: string,
  sessionId: string,
  message: Omit<SessionLogMessageEntry, 'ts' | 'kind'>,
  persistTranscript: boolean,
): void {
  if (!persistTranscript) return;
  const entry = { ts: new Date().toISOString(), kind: 'message' as const, ...message };
  appendLine(projectDir, sessionId, entry);
}

function appendLine(projectDir: string, sessionId: string, entry: SessionLogEntry): void {
  const dir = sessionDir(projectDir, sessionId);
  try {
    ensureSecureDir(dir);
    appendFileSync(join(dir, SESSION_LOG_FILE), JSON.stringify(entry) + '\n', { mode: SECURE_FILE_MODE });
  } catch (err) {
    warnStderr(`Warning: failed to persist log entry: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Callers of `appendMessage` must pass the current `persistTranscript` flag — read from config. This keeps the persistence module stateless.

## Chunk batching strategy

Planner text streams arrive as many fine-grained chunks (stream-json deltas, often 5-50 tokens each). We do **not** write one line per chunk — that would produce 10k-entry logs for a 5-minute planner run.

Strategy: accumulate chunks into a buffer keyed by `(role, phase)`. Flush to `appendMessage` when:

1. The current planner call completes (natural boundary — fires in `base.ts` after `invokePlan`/`invokeEscalate` returns).
2. An explicit boundary event occurs (phase transition, approval gate entry, clarification question emitted).
3. The buffer exceeds 16KB (safety net for infinite streams).

Place the buffering in `src/engine/planners/base.ts` inside the shared `createPlannerBase` factory — every backend that goes through base gets it for free.

Shell, agent, agent-sdk, and api planners all currently use `createPlannerBase` or a pattern similar enough that buffering can be extracted into a shared helper. Review during T004.

## Existing callers to migrate

### Event appends (always persist)

Grep: `appendEvent(projectDir, state, ...)` — several sites in `src/engine/orchestrator/events.ts`. Update signature to `appendEvent(projectDir, sessionId, event)`. The `sessionId` threading is already done by spec 002.

### Message appends (new)

- Planner `onOutput` → route through `base.ts` buffer → flush as message on call end.
- Implementer `onOutput` (if any streaming) — same pattern in `src/engine/implementers/base.ts`.
- User prompt at workflow start: `runWorkflow` top-level emits `appendMessage({ role: 'user', text: feature })` once.
- Clarification answer: `src/engine/orchestrator/clarifications.ts` emits one message per answer.
- Approval gate comment: `src/engine/orchestrator/approval.ts` emits one message on comment submission.
- Queue (spec 007) will call `appendMessage` on enqueue.

## Reader API

`src/core/sessions/log-reader.ts`:

```ts
export async function* readSessionLog(projectDir: string, sessionId: string): AsyncIterable<SessionLogEntry> {
  const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip corrupt line */ }
  }
}

export async function* readMessages(projectDir, sessionId): AsyncIterable<SessionLogMessageEntry> {
  for await (const entry of readSessionLog(projectDir, sessionId)) {
    if (entry.kind === 'message') yield entry;
  }
}

export async function* readEvents(projectDir, sessionId): AsyncIterable<SessionLogEventEntry> {
  for await (const entry of readSessionLog(projectDir, sessionId)) {
    if (entry.kind === 'event') yield entry;
  }
}
```

Async iterable keeps memory bounded for large logs.

## Dependencies

**Depends on:** 002 (session folder layout, `sessionId` threaded through persistence).

**Consumed by:** 004 (transcript rebuild reads messages), 005 (abort writes partial message with `interrupted: true`), 007 (queue writes user messages).

## Risk

- **Messages getting out of order.** Writes are synchronous `appendFileSync`; no concurrency. As long as we flush from one sequential `runWorkflow` loop, order follows timestamps exactly.
- **Disk cost.** Transcript-on grows `session.jsonl` by the size of all planner+implementer text. Typical feature: 100KB–1MB. Acceptable.
- **Silent truncation on disk-full.** `appendFileSync` can fail mid-write. Same as today's `events.jsonl` — we log a warning and keep going. Users running out of disk have bigger problems.

## Success verification

1. `npm run typecheck` passes.
2. `npm test` passes.
3. Manual: set `workflow.persistTranscript: false`, run a workflow, `grep '"kind":"message"' .diptych/sessions/<id>/session.jsonl` returns zero.
4. Manual: with transcript on, same grep returns many hits.
5. `grep -rn "EVENTS_FILE\\|events\\.jsonl" src/` returns zero.
