import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { taskId } from '../../core/schemas/task.js';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../runners/types.js';
import { IPC_MAX_FRAME_BYTES, type ServerMessage } from './protocol.js';
import { writeServerMessage } from './write-message.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

function sockPath(): string {
  return join(tmpdir(), `ipc-write-${Math.random().toString(36).slice(2)}.sock`);
}

function connectedPair(): Promise<{ server: Socket; client: Socket }> {
  const path = sockPath();
  return new Promise((resolve, reject) => {
    let serverSocket: Socket | null = null;
    const srv = createServer((socket) => {
      serverSocket = socket;
      sockets.push(socket);
    });
    servers.push(srv);
    srv.once('error', reject);
    srv.listen(path, () => {
      const client = createConnection(path, () => {
        client.setEncoding('utf8');
        const wait = setInterval(() => {
          if (serverSocket) {
            clearInterval(wait);
            resolve({ server: serverSocket, client });
          }
        }, 2);
      });
      sockets.push(client);
    });
  });
}

function collectLines(socket: Socket): { lines: string[] } {
  const out = { lines: [] as string[] };
  let buf = '';
  socket.on('data', (chunk: string) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const part of parts) if (part.trim()) out.lines.push(part.trim());
  });
  return out;
}

describe('writeServerMessage', () => {
  it('protects an oversized event frame before writing, keeping the socket alive', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    const huge = 'x'.repeat(IPC_MAX_FRAME_BYTES + 1024);
    const oversized: ServerMessage = {
      kind: 'event',
      payload: { type: 'warning', ts: 1, phase: 'idle', message: huge },
    };

    writeServerMessage(server, oversized);
    await new Promise((r) => setTimeout(r, 50));

    expect(server.destroyed).toBe(false);
    expect(client.destroyed).toBe(false);

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames.length).toBe(1);
    const only = frames[0];
    expect(only?.kind).toBe('event');
    if (only?.kind === 'event') {
      expect(only.payload.type).toBe('warning');
      const message = (only.payload as { message: string }).message;
      expect(message).toContain('oversized');
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(IPC_MAX_FRAME_BYTES);
    }
  });

  it('writes a normally sized frame verbatim', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    const msg: ServerMessage = {
      kind: 'event',
      payload: { type: 'warning', ts: 1, phase: 'idle', message: 'small' },
    };
    const result = writeServerMessage(server, msg);
    await new Promise((r) => setTimeout(r, 50));

    expect(result).toBe(true);
    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual(msg);
  });

  it('writes an exact-limit immutable artifact review frame without normalization', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);
    const prefix = 'sk-artifact-secret-19827\u001b]0;control\u0007\n';
    const text = `${prefix}${'\u0000'.repeat(
      PLANNER_ARTIFACT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8'),
    )}`;
    const msg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'artifact-review-1',
        kind: 'artifact_review',
        review: { label: 'Custom planner artifact', text },
      },
    };

    const result = writeServerMessage(server, msg, { persistTranscript: false });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(typeof result).toBe('boolean');
    expect(server.destroyed).toBe(false);
    expect(received.lines).toHaveLength(1);
    const line = received.lines[0];
    expect(line).toBeDefined();
    if (line === undefined) throw new Error('missing artifact review frame');
    expect(Buffer.byteLength(`${line}\n`, 'utf8')).toBeLessThanOrEqual(IPC_MAX_FRAME_BYTES);
    expect(JSON.parse(line) as ServerMessage).toEqual(msg);
  });

  it('replaces session metadata feature text when transcript persistence is disabled', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    writeServerMessage(
      server,
      {
        kind: 'session_meta',
        sessionId: 'session-1',
        startedAt: 1,
        mode: 'quick',
        feature: 'secret feature prompt',
      },
      { persistTranscript: false },
    );
    await new Promise((r) => setTimeout(r, 50));

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames).toEqual([
      {
        kind: 'session_meta',
        sessionId: 'session-1',
        startedAt: 1,
        mode: 'quick',
        feature: TRANSCRIPT_OMITTED_MESSAGE,
      },
    ]);
  });

  it('writes a bounded warning for protected IPC messages that still exceed the public limit', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    const expected = Array.from(
      { length: 4_000 },
      (_value, index) => `item-${index}-${'x'.repeat(120)}`,
    );
    const msg: ServerMessage = {
      kind: 'prompt_request',
      request: {
        requestId: 'prompt-1',
        kind: 'task_review',
        request: {
          taskId: taskId('T001'),
          taskTitle: 'Review task',
          status: 'done',
          filesTouched: ['a.ts'],
          validation: { passed: true, summary: 'ok', stages: [] },
          evidence: { summary: 'ok', expected, observed: [] },
          cost: {
            tokenUsage: makeUsage(),
          },
          availableCommands: ['continue'],
        },
      },
    };

    writeServerMessage(server, msg);
    await new Promise((r) => setTimeout(r, 50));

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames).toHaveLength(1);
    const only = frames[0];
    expect(only?.kind).toBe('event');
    if (only?.kind === 'event') {
      expect(only.payload.type).toBe('warning');
      expect((only.payload as { message: string }).message).toContain(
        'dropped oversized prompt_request frame',
      );
      expect(Buffer.byteLength(JSON.stringify(only), 'utf8')).toBeLessThan(IPC_MAX_FRAME_BYTES);
    }
  });
});
