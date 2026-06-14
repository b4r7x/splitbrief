import { afterEach, describe, expect, it } from 'vitest';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { tokensMatch, tryControlDetach } from './control-detach.js';
import type { ServerMessage } from './protocol.js';

type VictimOp = { op: 'write'; msg: ServerMessage } | { op: 'destroy' };

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function connectedPair(): Promise<{ client: Socket; server: Socket }> {
  const dir = mkdtempSync(join(tmpdir(), 'control-detach-'));
  const sockPath = join(dir, 'ipc.sock');
  const listener: Server = createServer();
  const serverSocket = new Promise<Socket>((resolve) => {
    listener.on('connection', (socket) => resolve(socket));
  });
  await new Promise<void>((resolve) => listener.listen(sockPath, resolve));
  const client = createConnection(sockPath);
  const server = await serverSocket;
  cleanups.push(() => {
    client.destroy();
    server.destroy();
    listener.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, server };
}

function makeVictim(ops: VictimOp[]): Socket {
  return {
    destroy() {
      ops.push({ op: 'destroy' });
      return this;
    },
  } as unknown as Socket;
}

describe('tryControlDetach', () => {
  it('writes the terminal frame to the victim before destroying it', async () => {
    const { client, server } = await connectedPair();
    const ops: VictimOp[] = [];
    const victim = makeVictim(ops);

    tryControlDetach({
      socket: server,
      authToken: 'token',
      currentSocket: () => victim,
      rejectAsAlreadyAttached: () => undefined,
      writeMessage: (socket, msg) => {
        if (socket === victim) ops.push({ op: 'write', msg });
        return true;
      },
    });

    client.write(
      `${JSON.stringify({ kind: 'authenticate', token: 'token' })}\n${JSON.stringify({ kind: 'detach' })}\n`,
    );

    await new Promise<void>((resolve) => {
      const check = () => {
        if (ops.some((o) => o.op === 'destroy')) resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    expect(ops).toEqual([
      {
        op: 'write',
        msg: {
          kind: 'error',
          code: 'already_attached',
          message: 'session detached: another client took over this session',
        },
      },
      { op: 'destroy' },
    ]);
  });

  it('rejects a wrong auth token without detaching the attached client', async () => {
    const { client, server } = await connectedPair();
    const ops: VictimOp[] = [];
    const victim = makeVictim(ops);
    const written: ServerMessage[] = [];

    tryControlDetach({
      socket: server,
      authToken: 'correct-token',
      currentSocket: () => victim,
      rejectAsAlreadyAttached: () => undefined,
      writeMessage: (socket, msg) => {
        if (socket === server) written.push(msg);
        return true;
      },
    });

    client.write(
      `${JSON.stringify({ kind: 'authenticate', token: 'wrong-token-different-length' })}\n${JSON.stringify(
        { kind: 'detach' },
      )}\n`,
    );

    await new Promise<void>((resolve) => {
      const check = () => {
        if (written.some((m) => m.kind === 'error' && m.code === 'unauthorized')) resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    expect(written).toEqual([
      { kind: 'error', code: 'unauthorized', message: 'IPC: invalid auth token' },
    ]);
    // The attached victim is never touched when authentication fails.
    expect(ops).toEqual([]);
  });
});

describe('tokensMatch', () => {
  it('returns true only for an exact match', () => {
    expect(tokensMatch('token-abc', 'token-abc')).toBe(true);
    expect(tokensMatch('token-abc', 'token-abd')).toBe(false);
  });

  it('returns false for tokens of different length', () => {
    expect(tokensMatch('short', 'short-but-longer')).toBe(false);
    expect(tokensMatch('', 'nonempty')).toBe(false);
  });

  it('matches multibyte tokens by byte content', () => {
    expect(tokensMatch('トークン', 'トークン')).toBe(true);
    expect(tokensMatch('トークン', 'トークソ')).toBe(false);
  });
});
