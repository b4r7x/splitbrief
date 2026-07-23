import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import { startIpcServer } from './server.js';
import type { ServerMessage } from './protocol.js';
import {
  createIpcServerTestHarness,
  ipcSocketExists,
  IPC_TEST_AUTH_TOKEN,
} from '#testing/helpers/ipc-server.js';

describe('startIpcServer — lifecycle', () => {
  let harness: ReturnType<typeof createIpcServerTestHarness>;

  beforeEach(() => {
    harness = createIpcServerTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('rejects bind when the socket parent path is not a directory', async () => {
    const parent = createTempDir('ipc-test');
    harness.tmpDirs.push(parent);
    const sessionDir = join(parent, 'not-a-directory');
    writeFileSync(sessionDir, 'blocked');
    const bus = createEventBus();
    await expect(
      startIpcServer({
        sessionId: 'bind-fail',
        sessionDir,
        startedAt: 1000,
        mode: 'standard',
        feature: 'feat',
        authToken: IPC_TEST_AUTH_TOKEN,
        bus,
        onUserInput: () => undefined,
      }),
    ).rejects.toMatchObject({
      kind: 'ipc-server-bind-failed',
      message: expect.stringContaining('IPC server failed to bind:'),
      data: { reason: expect.any(String) },
    });
  });

  it('creates socket file after bind', async () => {
    const { srv } = await harness.makeServer();
    expect(ipcSocketExists(srv.sockPath)).toBe(true);
  });

  it('publishes ipc_server_started after bind', async () => {
    const events: EngineEvent[] = [];
    const tmpDir = createTempDir('ipc-test');
    harness.tmpDirs.push(tmpDir);
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const srv = await startIpcServer({
      sessionId: 'sess1',
      sessionDir: tmpDir,
      startedAt: 1000,
      mode: 'quick',
      feature: 'feat',
      authToken: IPC_TEST_AUTH_TOKEN,
      bus,
      onUserInput: () => undefined,
    });
    harness.servers.push(srv);
    const started = events.find((e) => e.type === 'ipc_server_started');
    expect(started).toBeDefined();
    expect((started as Extract<EngineEvent, { type: 'ipc_server_started' }>).sockPath).toBe(
      srv.sockPath,
    );
  });

  it('publishes ipc_client_attached when client connects', async () => {
    const { srv, bus } = await harness.makeServer();
    const attachedPromise = harness.waitForEvent(bus, 'ipc_client_attached');
    await harness.connectAndAuth(srv.sockPath);
    await attachedPromise;
  });

  it('forwards bus events as { kind: event, payload } messages', async () => {
    const { srv, bus } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);

    const linesPromise = harness.readLines(socket, 1);
    bus.publish({ type: 'workflow_started', ts: 123, phase: 'idle', feature: 'x' });
    const eventMsgs = await linesPromise;
    const msg = eventMsgs[0]!;

    expect(msg.kind).toBe('event');
    if (msg.kind === 'event') {
      expect(msg.payload.type).toBe('workflow_started');
    }
  });

  it('handles detach: closes client socket, server stays up', async () => {
    const { srv, bus } = await harness.makeServer();

    const s1 = await harness.connectAndAuth(srv.sockPath);

    const detachedPromise = harness.waitForEvent(bus, 'ipc_client_detached');
    s1.write(JSON.stringify({ kind: 'detach' }) + '\n');
    await detachedPromise;
    await harness.waitForClose(s1);
    expect(s1.destroyed).toBe(true);

    const s2 = await harness.connectClient(srv.sockPath);
    harness.sockets.push(s2);
    s2.write(JSON.stringify({ kind: 'authenticate', token: IPC_TEST_AUTH_TOKEN }) + '\n');
    const afterDetachMsgs = await harness.readLines(s2, 1);
    expect(afterDetachMsgs[0]!.kind).toBe('session_meta');
  });

  it('publishes ipc_client_detached on client disconnect', async () => {
    const { srv, bus } = await harness.makeServer();

    const socket = await harness.connectAndAuth(srv.sockPath);
    await harness.tick();

    const detachedPromise = harness.waitForEvent(bus, 'ipc_client_detached');
    socket.destroy();
    await detachedPromise;
  });

  it('does not publish ipc_client_detached for a client that never attached', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus } = await harness.makeServer();
    bus.subscribe((e) => events.push(e));

    const badAuth = await harness.connectClient(srv.sockPath);
    harness.sockets.push(badAuth);
    badAuth.write(JSON.stringify({ kind: 'authenticate', token: 'wrong-token' }) + '\n');
    const badAuthMsgs = await harness.readLines(badAuth, 1);
    expect(badAuthMsgs[0]!.kind).toBe('error');
    await harness.waitForClose(badAuth);

    const preAuth = await harness.connectClient(srv.sockPath);
    harness.sockets.push(preAuth);
    preAuth.write(JSON.stringify({ kind: 'user_input', text: 'hi' }) + '\n');
    const preAuthMsgs = await harness.readLines(preAuth, 1);
    expect(preAuthMsgs[0]!.kind).toBe('error');
    await harness.waitForClose(preAuth);

    const probe = await harness.connectClient(srv.sockPath);
    harness.sockets.push(probe);
    probe.destroy();
    await harness.waitForClose(probe);
    await harness.tick();

    expect(events.some((e) => e.type === 'ipc_client_attached')).toBe(false);
    expect(events.some((e) => e.type === 'ipc_client_detached')).toBe(false);
  });

  it('publishes warning on malformed JSON, does not crash', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus } = await harness.makeServer();
    bus.subscribe((e) => events.push(e));

    const socket = await harness.connectClient(srv.sockPath);
    harness.sockets.push(socket);

    socket.write('not valid json with secret feature prompt\n');
    await harness.tick();
    await harness.tick();

    const warning = events.find((e) => e.type === 'warning');
    expect(warning?.type).toBe('warning');
    if (warning?.type === 'warning') {
      expect(warning.category).toBe('ipc');
      expect(warning.code).toBe('malformed_json');
      expect(warning.transcriptSafe).toBe(true);
      expect(warning.message).toContain('malformed JSON');
      expect(warning.message).toContain('bytes');
      expect(warning.message).not.toContain('secret feature prompt');
    }
    expect(srv.sockPath).toBeTruthy();
    expect(ipcSocketExists(srv.sockPath)).toBe(true);
  });

  it('close() removes socket file', async () => {
    const { srv } = await harness.makeServer();
    expect(ipcSocketExists(srv.sockPath)).toBe(true);
    await srv.close();
    expect(ipcSocketExists(srv.sockPath)).toBe(false);
    const idx = harness.servers.indexOf(srv);
    if (idx !== -1) harness.servers.splice(idx, 1);
  });

  it('close() sends server_complete to the attached client', async () => {
    const { srv } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);
    const closePromise = srv.close();
    const messages: ServerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for server_complete')),
        1000,
      );
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          messages.push(JSON.parse(trimmed) as ServerMessage);
        }
        if (messages.some((msg) => msg.kind === 'server_complete')) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          resolve();
        }
      };
      socket.on('data', onData);
    });
    await closePromise;
    expect(messages.some((msg) => msg.kind === 'server_complete')).toBe(true);
    const idx = harness.servers.indexOf(srv);
    if (idx !== -1) harness.servers.splice(idx, 1);
  });

  it('close() rejects a pending prompt with the cancellation domain error', async () => {
    const { srv } = await harness.makeServer();
    const pending = srv.requestClientPrompt({
      kind: 'approval_needed',
      approvalType: 'spec',
      filePath: '/tmp/spec.md',
    });
    await srv.close();
    await expect(pending).rejects.toMatchObject({
      kind: 'ipc-prompt-cancelled-closing',
      message: 'IPC prompt cancelled while closing server: approval_needed',
      data: { promptKind: 'approval_needed' },
    });
    const idx = harness.servers.indexOf(srv);
    if (idx !== -1) harness.servers.splice(idx, 1);
  });
});
