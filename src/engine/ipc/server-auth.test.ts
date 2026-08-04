import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import type { ServerMessage } from './protocol.js';
import { createIpcServerTestHarness } from '#testing/helpers/ipc-server.js';

describe('startIpcServer — auth', () => {
  let harness: ReturnType<typeof createIpcServerTestHarness>;

  beforeEach(() => {
    harness = createIpcServerTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('sends session_meta after client authentication', async () => {
    const { srv } = await harness.makeServer();
    const socket = await harness.connectClient(srv.sockPath);
    harness.sockets.push(socket);
    socket.write(JSON.stringify({ kind: 'authenticate', token: harness.authToken }) + '\n');
    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;
    expect(msg.kind).toBe('session_meta');
    if (msg.kind === 'session_meta') {
      expect(msg.sessionId).toBe('test-session');
      expect(msg.feature).toBe('test feature');
      expect(msg.mode).toBe('standard');
      expect(msg.startedAt).toBe(1000);
    }
  });

  it('replaces session_meta feature text when transcript persistence is disabled', async () => {
    const { srv } = await harness.makeServer({
      persistTranscript: false,
      feature: 'secret feature prompt',
    });
    const socket = await harness.connectClient(srv.sockPath);
    harness.sockets.push(socket);
    socket.write(JSON.stringify({ kind: 'authenticate', token: harness.authToken }) + '\n');
    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;

    expect(msg.kind).toBe('session_meta');
    if (msg.kind === 'session_meta') {
      expect(msg.feature).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    }
    expect(JSON.stringify(msg)).not.toContain('secret feature prompt');
  });

  it('rejects authentication with a wrong token and closes the socket', async () => {
    const { srv } = await harness.makeServer();
    const socket = await harness.connectClient(srv.sockPath);
    harness.sockets.push(socket);
    socket.write(
      JSON.stringify({ kind: 'authenticate', token: `${harness.authToken}-extra-bytes` }) + '\n',
    );

    const msgs = await harness.readLines(socket, 1);
    const msg = msgs[0]!;
    expect(msg.kind).toBe('error');
    if (msg.kind === 'error') {
      expect(msg.code).toBe('unauthorized');
      expect(msg.message).toBe('IPC: invalid auth token');
    }

    await harness.waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it('accepts the detached parent exactly once with auth and the prepared receipt', async () => {
    const candidate = {
      version: 1 as const,
      sessionId: 'test-session',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    let accepted = false;
    const { srv } = await harness.makeServer({
      onParentAccept: (input) => {
        if (
          accepted ||
          JSON.stringify(input) !== JSON.stringify({ ...candidate, childPid: 4242 })
        ) {
          return false;
        }
        accepted = true;
        return true;
      },
    });
    const first = await harness.connectClient(srv.sockPath);
    harness.sockets.push(first);
    first.write(
      `${JSON.stringify({
        kind: 'parent_accept',
        token: harness.authToken,
        ...candidate,
        childPid: 4242,
      })}\n`,
    );

    expect(await harness.readLines(first, 1)).toEqual([
      { kind: 'parent_accepted', ...candidate, childPid: 4242 },
    ]);

    const repeated = await harness.connectClient(srv.sockPath);
    harness.sockets.push(repeated);
    repeated.write(
      `${JSON.stringify({
        kind: 'parent_accept',
        token: harness.authToken,
        ...candidate,
        childPid: 4242,
      })}\n`,
    );
    const response = await harness.readLines(repeated, 1);
    expect(response[0]).toMatchObject({ kind: 'error', code: 'unauthorized' });
  });

  it('rejects detached parent acceptance with the wrong socket token', async () => {
    const { srv } = await harness.makeServer({ onParentAccept: () => true });
    const socket = await harness.connectClient(srv.sockPath);
    harness.sockets.push(socket);
    socket.write(
      `${JSON.stringify({
        kind: 'parent_accept',
        token: 'wrong-token',
        version: 1,
        sessionId: 'test-session',
        generation: '12345678-1234-4123-8123-123456789abc',
        childPid: 4242,
      })}\n`,
    );

    expect(await harness.readLines(socket, 1)).toEqual([
      {
        kind: 'error',
        code: 'unauthorized',
        message: 'IPC: invalid detached parent acceptance',
      },
    ]);
  });

  it('rejects second connection with already_attached', async () => {
    const { srv } = await harness.makeServer();

    const s1 = await harness.connectAndAuth(srv.sockPath);

    const s2 = await harness.connectClient(srv.sockPath);
    harness.sockets.push(s2);
    const rejectMsgs = await harness.readLines(s2, 1);
    const rejectMsg = rejectMsgs[0]!;
    expect(rejectMsg.kind).toBe('error');
    if (rejectMsg.kind === 'error') {
      expect(rejectMsg.code).toBe('already_attached');
    }

    await harness.waitForClose(s2);
    expect(s2.destroyed).toBe(true);
    expect(s1.destroyed).toBe(false);
  });

  it('rejects unauthenticated detach from a second connection', async () => {
    const { srv } = await harness.makeServer();
    const s1 = await harness.connectAndAuth(srv.sockPath);

    const s2 = await harness.connectClient(srv.sockPath);
    harness.sockets.push(s2);
    s2.write(JSON.stringify({ kind: 'detach' }) + '\n');

    const rejectMsgs = await harness.readLines(s2, 1);
    const rejectMsg = rejectMsgs[0]!;
    expect(rejectMsg.kind).toBe('error');
    if (rejectMsg.kind === 'error') {
      expect(rejectMsg.code).toBe('unauthorized');
    }

    await harness.waitForClose(s2);
    expect(s1.destroyed).toBe(false);
  });

  it('allows authenticated detach from a second connection', async () => {
    const { srv } = await harness.makeServer();
    const s1 = await harness.connectAndAuth(srv.sockPath);

    const victimFrames: ServerMessage[] = [];
    let victimClosed = false;
    let frameArrivedBeforeClose = false;
    let victimBuf = '';
    s1.on('data', (chunk: Buffer) => {
      victimBuf += chunk.toString('utf8');
      const lines = victimBuf.split('\n');
      victimBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const frame = JSON.parse(trimmed) as ServerMessage;
        victimFrames.push(frame);
        if (frame.kind === 'error' && !victimClosed) frameArrivedBeforeClose = true;
      }
    });
    s1.on('close', () => {
      victimClosed = true;
    });

    const s2 = await harness.connectClient(srv.sockPath);
    harness.sockets.push(s2);
    s2.write(
      `${JSON.stringify({ kind: 'authenticate', token: harness.authToken })}\n${JSON.stringify({
        kind: 'detach',
      })}\n`,
    );

    await harness.waitForClose(s1);
    await harness.waitForClose(s2);
    expect(s1.destroyed).toBe(true);

    const terminalFrame = victimFrames.find((f) => f.kind === 'error');
    expect(terminalFrame).toBeDefined();
    if (terminalFrame?.kind === 'error') {
      expect(terminalFrame.code).toBe('already_attached');
    }
    expect(frameArrivedBeforeClose).toBe(true);
  });

  it('reassembles a multibyte auth token split across frames in the detach handshake', async () => {
    const token = 'トークン値';
    const authHarness = createIpcServerTestHarness(token);
    const { srv } = await authHarness.makeServer({ authToken: token });
    const s1 = await authHarness.connectClient(srv.sockPath);
    authHarness.sockets.push(s1);
    s1.write(JSON.stringify({ kind: 'authenticate', token }) + '\n');
    const meta = await authHarness.readLines(s1, 1);
    if (meta[0]!.kind !== 'session_meta') throw new Error('expected session_meta');

    const s2 = await authHarness.connectClient(srv.sockPath);
    authHarness.sockets.push(s2);
    const handshake = Buffer.from(
      `${JSON.stringify({ kind: 'authenticate', token })}\n${JSON.stringify({ kind: 'detach' })}\n`,
      'utf8',
    );
    const at = handshake.indexOf(Buffer.from(token, 'utf8')[0]!) + 1;
    s2.write(handshake.subarray(0, at));
    await authHarness.tick();
    s2.write(handshake.subarray(at));

    await authHarness.waitForClose(s1);
    expect(s1.destroyed).toBe(true);
    await authHarness.cleanup();
  });
});
