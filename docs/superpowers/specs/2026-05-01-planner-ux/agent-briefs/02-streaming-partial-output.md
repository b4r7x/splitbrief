# 02 - Streaming Partial Output

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Show the last 5 lines of implementer output in real-time during API implementer generation. Users should see code being written without waiting for full task completion.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, rendered output, or public state.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- kebab-case file names.

## Required Reading

- `CLAUDE.md`
- `docs/STORES.md`
- `src/engine/streaming/spawn-collect.ts`
- `src/engine/streaming/output-parsers.ts`
- `src/engine/streaming/transcript-buffer.ts`
- `src/engine/orchestrator/task/step.ts` (the `runSingleTask` function — integration target)
- `src/engine/implementers/base.ts` (the `createImplementerBase` — `wrappedOnOutput` pattern)
- `src/engine/implementers/api.ts` (confirms api-kind uses `onProgress`/`onOutput`)
- `src/features/workflow/components/event-cards/implementer-card.tsx`
- `src/engine/events/types.ts`
- `src/stores/workflow/events.ts`

## Write Ownership

Primary files:

```text
src/engine/streaming/ring-buffer.ts (new)
src/engine/streaming/ring-buffer.test.ts (new)
src/stores/workflow/streaming-output.ts (new)
src/stores/workflow/streaming-output.test.ts (new)
src/engine/orchestrator/task/streaming-feed.ts (new)
src/engine/orchestrator/task/streaming-feed.test.ts (new)
src/engine/orchestrator/task/step.ts (modify — add import, create feed, wire onText, call stop)
src/features/workflow/components/event-cards/streaming-lines.tsx (new)
src/features/workflow/components/event-cards/implementer-card.tsx (modify)
```

Do not edit plan editor files. Do not edit planner status files.

## Design

### Ring Buffer (Engine Layer)

Create `src/engine/streaming/ring-buffer.ts`:

```typescript
const DEFAULT_CAPACITY = 5;

interface RingBuffer {
  push(line: string): void;
  lines(): string[];
  clear(): void;
}

export function createRingBuffer(capacity: number = DEFAULT_CAPACITY): RingBuffer {
  const buffer: string[] = [];
  let writeIndex = 0;
  let count = 0;

  return {
    push(line: string): void {
      if (buffer.length < capacity) {
        buffer.push(line);
      } else {
        buffer[writeIndex] = line;
      }
      writeIndex = (writeIndex + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },
    lines(): string[] {
      if (buffer.length < capacity) return buffer.slice();
      const start = writeIndex;
      const result: string[] = [];
      for (let i = 0; i < count; i++) {
        result.push(buffer[(start + i) % capacity]!);
      }
      return result;
    },
    clear(): void {
      buffer.length = 0;
      writeIndex = 0;
      count = 0;
    },
  };
}
```

### Streaming Output Store

Create `src/stores/workflow/streaming-output.ts`:

```typescript
import { createStore, storeBase } from '../create-store.js';
import type { TaskId } from '../../core/schemas/task.js';

export interface StreamingOutputState {
  taskId: TaskId | null;
  lines: string[];
  active: boolean;
}

const initial: StreamingOutputState = {
  taskId: null,
  lines: [],
  active: false,
};

const store = createStore<StreamingOutputState>(initial);

function __testReset(next?: Partial<StreamingOutputState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

function startStreaming(taskId: TaskId): void {
  store.set({ taskId, lines: [], active: true });
}

function pushLines(lines: string[]): void {
  store.set(s => {
    if (!s.active) return s;
    return { ...s, lines };
  });
}

function stopStreaming(): void {
  store.set(s => {
    if (!s.active) return s;
    return { ...s, active: false };
  });
}

function reset(): void {
  store.set(initial);
}

export const streamingOutputStore = {
  ...storeBase(store),
  __testReset,
  startStreaming,
  pushLines,
  stopStreaming,
  reset,
};
```

### Integration: Feed Ring Buffer Into Store

The integration hooks into `src/engine/orchestrator/task/step.ts` in the `runSingleTask` function. This is where the implementer is called with an `onOutput` callback (line ~234):

```typescript
onOutput: (text) => { recordOutput(text); textHandler(text); },
```

Create a new file `src/engine/orchestrator/task/streaming-feed.ts` that wraps the onOutput with ring buffer logic:

```typescript
import type { TaskId } from '../../../core/schemas/task.js';
import { createRingBuffer } from '../../streaming/ring-buffer.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';

interface StreamingFeed {
  onText(text: string): void;
  stop(): void;
}

export function createStreamingFeed(taskId: TaskId, isApiRunner: boolean): StreamingFeed {
  if (!isApiRunner) {
    return { onText() {}, stop() {} };
  }

  const ringBuffer = createRingBuffer(5);
  let remainder = '';

  streamingOutputStore.startStreaming(taskId);

  return {
    onText(text: string): void {
      remainder += text;
      const parts = remainder.split('\n');
      // Last element is incomplete (no trailing newline yet)
      remainder = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim().length > 0) {
          ringBuffer.push(line);
        }
      }
      // Also push remainder if it looks substantial (>20 chars)
      if (remainder.trim().length > 20) {
        ringBuffer.push(remainder.trim());
      }
      streamingOutputStore.pushLines(ringBuffer.lines());
    },
    stop(): void {
      streamingOutputStore.stopStreaming();
    },
  };
}
```

**Integration in `src/engine/orchestrator/task/step.ts`:**

Add import at the top:

```typescript
import { createStreamingFeed } from './streaming-feed.js';
```

Inside `runSingleTask`, after `publishTaskStart` (line ~200) and before the implementer call, determine if the runner is API-kind and create the feed:

```typescript
const isApiRunner = config.implementer.kind === 'api';
const streamingFeed = createStreamingFeed(task.id, isApiRunner);
```

Modify the `onOutput` in the `wctx.implementer.implement` call (line ~234):

```typescript
onOutput: (text) => {
  recordOutput(text);
  textHandler(text);
  streamingFeed.onText(text);
},
```

After the implementer call completes (after the continuation loop resolves, or in the finally/catch blocks), call:

```typescript
streamingFeed.stop();
```

This stop call must happen in the same scope where the implementer result is received, around line ~260 in `step.ts`.

**Write ownership for this integration file:**

```text
src/engine/orchestrator/task/streaming-feed.ts (new)
src/engine/orchestrator/task/streaming-feed.test.ts (new)
src/engine/orchestrator/task/step.ts (modify — 3 lines: import + create feed + wire onText + stop)
```

### Streaming Lines Component

Create `src/features/workflow/components/event-cards/streaming-lines.tsx`:

```tsx
import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';

export function StreamingLines() {
  const t = useTheme();
  const { lines, active } = streamingOutputStore.use(s => s);

  if (!active || lines.length === 0) return null;

  return (
    <Box flexDirection="column" paddingLeft={2} height={Math.min(lines.length, 5)}>
      {lines.map((line, i) => (
        <Text key={i} color={t.textDim} wrap="truncate" dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}
```

### Modified Implementer Card

In `src/features/workflow/components/event-cards/implementer-card.tsx`, add the streaming lines below the spinner when the implementer is running:

```tsx
import { StreamingLines } from './streaming-lines.js';

// Inside the `implementer_generate_running` branch:
if (event.type === 'implementer_generate_running') {
  const fileHint = event.file ? `generating ${event.file}...` : 'generating...';
  return (
    <Box flexDirection="column">
      <Spinner label={fileHint} color={t.implementer} startTime={event.ts} />
      <StreamingLines />
    </Box>
  );
}
```

## Required Behavior

1. During `api`-kind implementer generation, the last 5 lines of output are shown below the spinner.
2. Lines update in real-time as text chunks arrive via `onText`.
3. When the task completes or fails, streaming output stops and clears on next task start.
4. For non-`api` runner kinds (cli, shell, agent, agent-sdk), no streaming lines are shown.
5. The ring buffer has bounded memory (max 5 lines regardless of total output volume).

## Non-Goals

- No full scrollback during streaming.
- No syntax highlighting of streaming output.
- No streaming for planner output (that is covered by the heartbeat brief).
- No changes to the transcript buffer or session persistence.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- Engine code (`ring-buffer.ts`) must not import React/Ink.
- Store code must follow existing `createStore` + `storeBase` pattern.
- Tests for ring buffer should cover: push beyond capacity wraps, lines() returns correct order, clear resets.
- Tests for store should cover: startStreaming sets active, pushLines updates, stopStreaming deactivates.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/engine/streaming/ring-buffer.test.ts
npm test -- src/stores/workflow/streaming-output.test.ts
```

Then run:

```bash
npm run typecheck
npm run lint
```

## Expected Final Report

Report:

- files changed
- ring buffer behavior verified
- store integration points
- component rendering approach
- runner-kind gating logic
- validation commands run and results
- risks or follow-ups
