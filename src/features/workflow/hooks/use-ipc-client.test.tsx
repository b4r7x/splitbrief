import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server, type Socket } from 'node:net';
import { render } from 'ink-testing-library';
import { useState, useEffect } from 'react';
import { Text } from 'ink';
import { tick } from '#testing/helpers/ink.js';
import { useIpcClient, type IpcClientStatus } from './use-ipc-client.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { IpcPromptRequest, IpcPromptResponse, ServerMessage } from '../../../engine/ipc/protocol.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ipc-client-test-'));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write a ServerMessage line to a socket. */
function send(socket: Socket, msg: ServerMessage): void {
  socket.write(JSON.stringify(msg) + '\n');
}

/** Start a raw net.Server that sends session_meta then stays open. */
function makeServer(sockPath: string, opts?: { readonly?: boolean }): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('connection', (socket: Socket) => {
      const meta: ServerMessage = {
        kind: 'session_meta',
        sessionId: 'test-session-id',
        startedAt: 1000,
        mode: 'standard',
        feature: 'test feature',
        readonly: opts?.readonly ?? false,
      };
      send(socket, meta);
    });
    server.once('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

/** Start a server that immediately destroys every connection (for reconnect tests). */
function makeRejectingServer(sockPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('connection', (socket: Socket) => {
      socket.destroy();
    });
    server.once('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // destroy open connections
    server.emit('close');
  });
}

interface CapturedState {
  status: IpcClientStatus;
  sessionId: string | null;
  readonly: boolean;
  events: EngineEvent[];
  sendUserInput: (text: string) => void;
  detach: () => void;
}

function Harness({
  sockPath,
  capture,
  onPromptRequest,
}: {
  sockPath: string;
  capture: { current: CapturedState | null };
  onPromptRequest?: ((request: IpcPromptRequest) => Promise<IpcPromptResponse>) | undefined;
}) {
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [state, actions] = useIpcClient({
    sockPath,
    onEvent(event) {
      setEvents((prev) => [...prev, event]);
    },
    onPromptRequest,
  });
  useEffect(() => {
    capture.current = { ...state, events, ...actions };
  });
  return <Text>{state.status}</Text>;
}

const tmpDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const srv of servers.splice(0)) {
    await closeServer(srv).catch(() => undefined);
  }
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('useIpcClient', () => {
  it('initial status is connecting', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    // Don't start a server — just observe the initial state
    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    // Check before ticking — first render is synchronous
    expect(capture.current?.status).toBe('connecting');
    ui.unmount();
    await tick(20);
  });

  it('status becomes connected after session_meta (readonly: false)', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');
    const server = await makeServer(sockPath);
    servers.push(server);

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('connected');
    expect(capture.current?.sessionId).toBe('test-session-id');
    expect(capture.current?.readonly).toBe(false);
    ui.unmount();
    await tick(20);
  });

  it('status becomes readonly after session_meta (readonly: true)', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');
    const server = await makeServer(sockPath, { readonly: true });
    servers.push(server);

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('readonly');
    expect(capture.current?.readonly).toBe(true);
    ui.unmount();
    await tick(20);
  });

  it('forwards server events to onEvent callback', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    let connectedSocket: Socket | null = null;
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      connectedSocket = socket;
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    // Send an event from the server
    if (connectedSocket) {
      const msg: ServerMessage = { kind: 'event', payload: { type: 'workflow_started', ts: 42, phase: 'idle', feature: 'test' } };
      send(connectedSocket, msg);
    }
    await tick(50);

    const payloadEvents = capture.current?.events.filter(e => e.type === 'workflow_started') ?? [];
    expect(payloadEvents.length).toBeGreaterThan(0);
    expect(payloadEvents[0]?.type).toBe('workflow_started');
    ui.unmount();
    await tick(20);
  });

  it('handles prompt_request and writes prompt_response', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const received: string[] = [];
    let connectedSocket: Socket | null = null;
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      connectedSocket = socket;
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) received.push(line.trim());
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(
      <Harness
        sockPath={sockPath}
        capture={capture}
        onPromptRequest={async () => ({ kind: 'external_changes', proceed: true })}
      />,
    );
    await tick(100);

    if (connectedSocket) {
      const msg: ServerMessage = {
        kind: 'prompt_request',
        request: { requestId: 'prompt-1', kind: 'external_changes' },
      };
      send(connectedSocket, msg);
    }
    await tick(50);

    const response = received.map(line => JSON.parse(line) as { kind: string; requestId?: string; response?: unknown })
      .find(msg => msg.kind === 'prompt_response');
    expect(response).toMatchObject({
      kind: 'prompt_response',
      requestId: 'prompt-1',
      response: { kind: 'external_changes', proceed: true },
    });

    ui.unmount();
    await tick(20);
  });

  it('writes approval edit action prompt_response from prompt handler', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const received: string[] = [];
    let connectedSocket: Socket | null = null;
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      connectedSocket = socket;
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) received.push(line.trim());
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(
      <Harness
        sockPath={sockPath}
        capture={capture}
        onPromptRequest={async () => ({ kind: 'approval_needed', approved: false, action: 'edit' })}
      />,
    );
    await tick(100);

    if (connectedSocket) {
      const msg: ServerMessage = {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-1',
          kind: 'approval_needed',
          approvalType: 'briefs',
          filePath: '/tmp/tasks.md',
        },
      };
      send(connectedSocket, msg);
    }
    await tick(50);

    const response = received.map(line => JSON.parse(line) as { kind: string; requestId?: string; response?: unknown })
      .find(msg => msg.kind === 'prompt_response');
    expect(response).toMatchObject({
      kind: 'prompt_response',
      requestId: 'prompt-1',
      response: { kind: 'approval_needed', approved: false, action: 'edit' },
    });

    ui.unmount();
    await tick(20);
  });

  it('detach() sends detach command and sets status to detached', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const received: string[] = [];
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) received.push(trimmed);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('connected');
    capture.current?.detach();
    await tick(50);

    expect(capture.current?.status).toBe('detached');
    expect(received.some(line => {
      try { return (JSON.parse(line) as { kind: string }).kind === 'detach'; } catch { return false; }
    })).toBe(true);
    ui.unmount();
    await tick(20);
  });

  it('sendUserInput sends correct JSON line when connected', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const received: string[] = [];
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) received.push(trimmed);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    capture.current?.sendUserInput('hello world');
    await tick(50);

    const userInputMsg = received.find(line => {
      try { return (JSON.parse(line) as { kind: string }).kind === 'user_input'; } catch { return false; }
    });
    expect(userInputMsg).toBeDefined();
    if (userInputMsg) {
      const parsed = JSON.parse(userInputMsg) as { kind: string; text: string };
      expect(parsed.text).toBe('hello world');
    }
    ui.unmount();
    await tick(20);
  });

  it('sendUserInput is silently dropped when status is readonly', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const received: string[] = [];
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: true,
      });
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) received.push(trimmed);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('readonly');
    capture.current?.sendUserInput('should be dropped');
    await tick(50);

    const userInputMsg = received.find(line => {
      try { return (JSON.parse(line) as { kind: string }).kind === 'user_input'; } catch { return false; }
    });
    expect(userInputMsg).toBeUndefined();
    ui.unmount();
    await tick(20);
  });

  it('unexpected server close sets status to reconnecting', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const connectedSockets: Socket[] = [];
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      connectedSockets.push(socket);
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('connected');

    // Destroy the server-side socket to trigger unexpected close
    for (const s of connectedSockets) s.destroy();
    await tick(50);

    expect(capture.current?.status).toBe('reconnecting');
    const attemptEvents = capture.current?.events.filter(e => e.type === 'ipc_reconnect_attempt') ?? [];
    expect(attemptEvents.length).toBeGreaterThan(0);
    ui.unmount();
    await tick(20);
  });

  it('does not let a stale reconnect timer from a previous sockPath open another new socket', async () => {
    const oldDir = makeTmpDir();
    const newDir = makeTmpDir();
    tmpDirs.push(oldDir, newDir);
    const oldSockPath = join(oldDir, 'old.sock');
    const newSockPath = join(newDir, 'new.sock');

    let newConnections = 0;
    const oldServer = await makeRejectingServer(oldSockPath);
    servers.push(oldServer);
    const newServer = createServer();
    servers.push(newServer);
    newServer.on('connection', (socket: Socket) => {
      newConnections += 1;
      send(socket, {
        kind: 'session_meta',
        sessionId: 'new-session-id',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
    });
    await new Promise<void>((resolve) => newServer.listen(newSockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={oldSockPath} capture={capture} />);
    await tick(50);

    ui.rerender(<Harness sockPath={newSockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('connected');
    expect(capture.current?.sessionId).toBe('new-session-id');
    expect(newConnections).toBe(1);

    await waitMs(150);

    expect(capture.current?.status).toBe('connected');
    expect(capture.current?.sessionId).toBe('new-session-id');
    expect(newConnections).toBe(1);
    ui.unmount();
    await tick(20);
  });

  it('after max reconnect attempts status becomes failed and emits ipc_reconnect_failed', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const server = await makeRejectingServer(sockPath);
    servers.push(server);

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);

    // Total backoff: 100 + 200 + 400 + 800 + 1600 = 3100ms; wait with margin
    await waitMs(4500);

    expect(capture.current?.status).toBe('failed');
    const failedEvents = capture.current?.events.filter(e => e.type === 'ipc_reconnect_failed') ?? [];
    expect(failedEvents.length).toBeGreaterThan(0);
    ui.unmount();
    await tick(20);
  }, 15000);

  it('malformed server message emits a warning event', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      send(socket, {
        kind: 'session_meta',
        sessionId: 'sess',
        startedAt: 1,
        mode: 'standard',
        feature: 'f',
        readonly: false,
      });
      // Send malformed JSON after meta
      setTimeout(() => {
        socket.write('not valid json\n');
      }, 20);
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(150);

    const warnings = capture.current?.events.filter(e => e.type === 'warning') ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    // Status should remain connected (not crashed)
    expect(capture.current?.status).toBe('connected');
    ui.unmount();
    await tick(20);
  });

  it('server error message sets status to failed and emits warning event', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');

    const server = createServer();
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      send(socket, {
        kind: 'error',
        code: 'already_attached',
        message: 'session already has an attached client',
      });
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('failed');
    expect(capture.current?.events.some(e => e.type === 'warning')).toBe(true);
    ui.unmount();
    await tick(20);
  });

  it('unmount closes socket without triggering reconnect', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');
    const server = await makeServer(sockPath);
    servers.push(server);

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('connected');
    ui.unmount();
    await tick(200);

    // Status stays at what it was at unmount time (connected), NOT reconnecting/failed
    // (The unmount cleanup fires before any reconnect can be scheduled)
    expect(capture.current?.status).toBe('connected');
    const reconnectAttempts = capture.current?.events.filter(e => e.type === 'ipc_reconnect_attempt') ?? [];
    expect(reconnectAttempts.length).toBe(0);
  });

  it('detach() does not trigger reconnect after socket closes', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const sockPath = join(dir, 'test.sock');
    const server = await makeServer(sockPath);
    servers.push(server);

    const capture: { current: CapturedState | null } = { current: null };
    const ui = render(<Harness sockPath={sockPath} capture={capture} />);
    await tick(100);

    expect(capture.current?.status).toBe('connected');
    capture.current?.detach();
    await tick(200);

    expect(capture.current?.status).toBe('detached');
    const reconnectAttempts = capture.current?.events.filter(e => e.type === 'ipc_reconnect_attempt') ?? [];
    expect(reconnectAttempts.length).toBe(0);
    ui.unmount();
    await tick(20);
  });
});
