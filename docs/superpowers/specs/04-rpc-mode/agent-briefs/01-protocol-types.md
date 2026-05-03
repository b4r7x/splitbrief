# 01 - RPC Protocol Types + Reader/Writer

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Define RPC command/response types with Zod schemas. Create stdin command reader and stdout response writer.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/api-patterns`

## Write Ownership

```
src/cli/rpc/types.ts         (create)
src/cli/rpc/reader.ts        (create)
src/cli/rpc/reader.test.ts   (create)
src/cli/rpc/writer.ts        (create)
src/cli/rpc/writer.test.ts   (create)
```

## Required Behavior

### types.ts

```typescript
import { z } from 'zod';

export const RpcCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve'), id: z.string().optional() }),
  z.object({ type: z.literal('reject'), comment: z.string().optional() }),
  z.object({ type: z.literal('message'), text: z.string().min(1) }),
  z.object({ type: z.literal('recovery'), action: z.string().min(1) }),
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('slash'), command: z.string().min(1) }),
]);

export type RpcCommand = z.infer<typeof RpcCommandSchema>;

export const RpcResponseSchema = z.object({
  type: z.enum(['ack', 'error', 'status', 'event']),
  command: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export type RpcResponse = z.infer<typeof RpcResponseSchema>;
```

### reader.ts — readline-based stdin parser

```typescript
import { createInterface } from 'node:readline';
import { RpcCommandSchema, type RpcCommand } from './types.js';

export function createCommandReader(
  stream: NodeJS.ReadableStream,
  onCommand: (cmd: RpcCommand) => void,
  onError: (err: string) => void,
): { close: () => void } {
  const rl = createInterface({ input: stream, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { onError(`Invalid JSON: ${trimmed}`); return; }
    const result = RpcCommandSchema.safeParse(parsed);
    if (result.success) { onCommand(result.data); } else { onError(`Invalid command: ${result.error.message}`); }
  });
  return { close: () => rl.close() };
}
```

### writer.ts — NDJSON response writer

```typescript
import type { EngineEvent } from '../../engine/events/types.js';
import type { RpcResponse } from './types.js';

export function createResponseWriter(stream: NodeJS.WritableStream) {
  function write(response: RpcResponse): void {
    stream.write(JSON.stringify(response) + '\n');
  }
  return {
    ack(command: string, data?: unknown) { write({ type: 'ack', command, data }); },
    error(message: string) { write({ type: 'error', error: message }); },
    status(data: unknown) { write({ type: 'status', data }); },
    event(engineEvent: EngineEvent) { write({ type: 'event', data: engineEvent }); },
  };
}
```

## TDD Steps

- [ ] **Write reader test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createCommandReader } from './reader.js';

describe('createCommandReader', () => {
  it('parses valid approve command', async () => {
    const onCommand = vi.fn();
    const onError = vi.fn();
    const stream = Readable.from(['{"type":"approve"}\n']);
    createCommandReader(stream, onCommand, onError);
    await new Promise(r => setTimeout(r, 50));
    expect(onCommand).toHaveBeenCalledWith({ type: 'approve' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports error for invalid JSON', async () => {
    const onCommand = vi.fn();
    const onError = vi.fn();
    const stream = Readable.from(['not json\n']);
    createCommandReader(stream, onCommand, onError);
    await new Promise(r => setTimeout(r, 50));
    expect(onCommand).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('reports error for unknown command type', async () => {
    const onCommand = vi.fn();
    const onError = vi.fn();
    const stream = Readable.from(['{"type":"unknown"}\n']);
    createCommandReader(stream, onCommand, onError);
    await new Promise(r => setTimeout(r, 50));
    expect(onError).toHaveBeenCalled();
  });
});
```

- [ ] **Write writer test**

```typescript
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createResponseWriter } from './writer.js';

describe('createResponseWriter', () => {
  it('writes ack as JSON line', () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _, cb) { chunks.push(chunk.toString()); cb(); } });
    const writer = createResponseWriter(stream);
    writer.ack('approve');
    expect(JSON.parse(chunks[0])).toEqual({ type: 'ack', command: 'approve' });
  });

  it('writes error as JSON line', () => {
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _, cb) { chunks.push(chunk.toString()); cb(); } });
    const writer = createResponseWriter(stream);
    writer.error('bad command');
    expect(JSON.parse(chunks[0]).error).toBe('bad command');
  });
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Run:** `npm run test-ci`

## Verification

- [ ] All 7 RPC command types parse correctly via Zod schema
- [ ] Invalid JSON → onError callback, no crash
- [ ] Unknown command type → Zod validation error → onError
- [ ] Writer outputs single JSON line per call (no multi-line)
- [ ] Each response line is valid JSON with `type` field
- [ ] `npm run test-ci` passes
