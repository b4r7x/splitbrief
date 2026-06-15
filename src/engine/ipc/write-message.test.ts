import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IPC_MAX_FRAME_BYTES, type ServerMessage } from './protocol.js';
import { writeServerMessage } from './write-message.js';

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
  it('drops an oversized event frame and sends a warning frame instead, keeping the socket alive', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    const huge = 'x'.repeat(IPC_MAX_FRAME_BYTES + 1024);
    const oversized: ServerMessage = {
      kind: 'event',
      payload: { type: 'warning', ts: 1, phase: 'idle', message: huge },
    };

    const result = writeServerMessage(server, oversized);
    await new Promise((r) => setTimeout(r, 50));

    expect(result).toBe(true);
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
});
