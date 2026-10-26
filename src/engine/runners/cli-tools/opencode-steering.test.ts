import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningCall } from '../../calls/steering.js';
import { createOpencodeSteering } from './opencode-steering.js';
import {
  opencodeImplementerAdapter,
  opencodePlannerAdapter,
  opencodeProtocolEvents,
} from './opencode.js';
import { invokeProcessCli } from './process-invoke.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { unregisterProcess } from '../../../lib/process/registry.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

let sidecarOutput: string;
let terminationFails: boolean;
let sidecarChild: ChildProcess | undefined;
let abortStartup: (() => void) | undefined;

beforeEach(() => {
  terminationFails = false;
  sidecarChild = undefined;
  abortStartup = undefined;
  sidecarOutput =
    'server listening on http://127.0.0.1:1234\nserver password password-1234567890\n';
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const isSidecar = Array.isArray(args) && args[0] === 'serve';
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const state: { -readonly [Key in 'exitCode' | 'signalCode']: ChildProcess[Key] } = {
      exitCode: null,
      signalCode: null,
    };
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        if (terminationFails && isSidecar) return false;
        state.signalCode = signal;
        child.emit('exit', null, signal);
        stdout.end();
        stderr.end();
        child.emit('close', null, signal);
        return true;
      },
    });
    Object.defineProperties(child, {
      exitCode: { get: () => state.exitCode },
      signalCode: { get: () => state.signalCode },
    });
    if (Array.isArray(args) && args[0] === 'serve') sidecarChild = child as unknown as ChildProcess;
    if (Array.isArray(args) && args[0] === 'run') {
      // The tool replies once it has read its prompt from stdin.
      stdin.once('data', () =>
        setImmediate(() => {
          stdout.write(
            JSON.stringify({
              type: 'text',
              sessionID: 'ses-1',
              part: { type: 'text', text: 'password-1234567890' },
            }) + '\n',
          );
          stdout.write(JSON.stringify({ type: 'unknown_password-1234567890' }) + '\n');
          stderr.write('password-1234567890');
          state.exitCode = 0;
          child.emit('exit', 0, null);
          stdout.end();
          stderr.end();
          child.emit('close', 0, null);
        }),
      );
    } else {
      queueMicrotask(() => {
        stdout.write(sidecarOutput);
        abortStartup?.();
      });
    }
    return child as unknown as ChildProcess;
  });
});

afterEach(() => vi.unstubAllGlobals());

async function openSession() {
  const path = realpathSync(process.execPath);
  const info = statSync(path);
  let sender: RunningCall['send'] | undefined;
  const session = await createOpencodeSteering(opencodeProtocolEvents).open({
    invocation: {
      executable: {
        path,
        fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
      },
      args: ['run', '--standalone'],
      promptTransport: { kind: 'stdin' },
      environment: {},
      cwd: process.cwd(),
      signal: undefined,
    },
    prompt: 'initial',
    onReady: (send) => {
      sender = send;
    },
    onAdmissionClosed: () => {},
  });
  const line = JSON.stringify({ type: 'step_start', sessionID: 'ses-1' });
  session.onLine(line, session.parse(line));
  if (sender === undefined) throw new Error('session did not attach');
  return { session, send: sender };
}

describe('OpenCode steering HTTP acknowledgement', () => {
  it.each(['completion', 'startup'] as const)(
    'preserves failed sidecar termination after %s in the call outcome',
    async (mode) => {
      terminationFails = true;
      const controller = new AbortController();
      if (mode === 'startup') {
        sidecarOutput = '';
        abortStartup = () => controller.abort();
      }
      const path = realpathSync(process.execPath);
      const info = statSync(path);
      const adapter = opencodeImplementerAdapter;
      const args = adapter.buildArgs({
        model: undefined,
        projectDir: process.cwd(),
        configuredArgs: [],
        installedVersion: '2.0.26',
      });
      const events: RunnerCallEvent[] = [];
      try {
        const result = await invokeProcessCli(adapter, {
          invocation: {
            executable: {
              path,
              fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
            },
            args,
            baseArgs: args,
            promptTransport: adapter.promptTransport,
            environment: {},
            cwd: process.cwd(),
            signal: controller.signal,
            timeoutMs: 5_000,
          },
          prompt: 'initial',
          installedVersion: '2.0.26',
          steering: { current: () => null, attach: () => () => {} },
          callContext: {
            callId: 'termination',
            role: 'implementer',
            backendKind: 'cli',
            runnerName: 'opencode',
          },
          onEvent: (event) => {
            events.push(event);
          },
        });
        expect(result).toMatchObject({
          status: 'failed',
          error: { code: 'platform-limitation', message: 'Unable to send SIGTERM to process' },
        });
        expect(events.filter((event) => event.type === 'call_completed')).toHaveLength(0);
        expect(events.filter((event) => event.type === 'call_error')).toHaveLength(1);
      } finally {
        terminationFails = false;
        sidecarChild?.kill();
        if (sidecarChild !== undefined) unregisterProcess(sidecarChild);
      }
    },
  );

  it('defers image messages without making an HTTP request', async () => {
    const fetchMock = vi.fn(() => Response.json({ data: { id: 'msg-image' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { session, send } = await openSession();
    try {
      expect(
        await send({
          id: 'image',
          text: 'Use this design',
          images: [
            {
              id: 'design',
              kind: 'image',
              path: '/tmp/design.png',
              mimeType: 'image/png',
              sizeBytes: 1,
            },
          ],
        }),
      ).toBe('deferred');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(session.failureSignal?.aborted).toBe(false);
    } finally {
      await session.close();
    }
  });

  it.each([undefined, []] as const)('delivers a text-only steer with images=%j', async (images) => {
    vi.stubGlobal('fetch', async (url: string, opts: RequestInit) => {
      if (opts.method === 'POST') {
        expect(url).toBe('http://127.0.0.1:1234/api/session/ses-1/prompt');
        expect(JSON.parse(String(opts.body))).toEqual({ text: 'PINEAPPLE', delivery: 'steer' });
        return Response.json({ data: { id: 'msg-stored' } });
      }
      if (url.endsWith('/inbox')) return Response.json({ data: [] });
      if (url.endsWith('/message')) {
        return Response.json({
          data: [{ id: 'msg-newest', type: 'assistant', time: { created: 2 } }],
          cursor: 'msg-newest',
        });
      }
      expect(url).toBe('http://127.0.0.1:1234/api/session/ses-1/message/msg-stored');
      return Response.json({
        data: {
          id: 'msg-stored',
          type: 'user',
          text: 'PINEAPPLE',
          time: { created: 1 },
          files: [],
        },
      });
    });
    const { session, send } = await openSession();
    try {
      expect(await send({ id: 'stored', text: 'PINEAPPLE', images })).toBe('delivered');
      expect(session.failureSignal?.aborted).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('defers a cancelled inbox item when the message lookup returns 404', async () => {
    vi.stubGlobal('fetch', async (url: string, opts: RequestInit) => {
      if (opts.method === 'POST') return Response.json({ data: { id: 'msg-cancelled' } });
      if (url.endsWith('/inbox')) return Response.json({ data: [] });
      expect(url).toBe('http://127.0.0.1:1234/api/session/ses-1/message/msg-cancelled');
      return Response.json(
        {
          _tag: 'MessageNotFoundError',
          sessionID: 'ses-1',
          messageID: 'msg-cancelled',
          message: 'Message not found: msg-cancelled',
        },
        { status: 404 },
      );
    });
    const { session, send } = await openSession();
    try {
      expect(await send({ id: 'cancelled', text: 'correction' })).toBe('deferred');
      expect(session.failureSignal?.aborted).toBe(false);
    } finally {
      await session.close();
    }
  });

  it.each(['other-status', 'mismatched-id', 'wrong-shape', 'invalid-json', 'network-error'])(
    'keeps a consumed steer uncertain after a %s lookup response',
    async (mode) => {
      vi.stubGlobal('fetch', async (url: string, opts: RequestInit) => {
        if (opts.method === 'POST') return Response.json({ data: { id: 'msg-stored' } });
        if (url.endsWith('/inbox')) return Response.json({ data: [] });
        expect(url).toBe('http://127.0.0.1:1234/api/session/ses-1/message/msg-stored');
        if (mode === 'network-error') throw new Error('lost response');
        if (mode === 'invalid-json') return new Response('{');
        if (mode === 'wrong-shape') return Response.json({ data: { info: { id: 'msg-stored' } } });
        return Response.json(
          { data: { id: mode === 'mismatched-id' ? 'msg-other' : 'msg-stored' } },
          { status: mode === 'other-status' ? 500 : 200 },
        );
      });
      const { session, send } = await openSession();
      try {
        expect(await send({ id: 'stored', text: 'correction' })).toBe('uncertain');
      } finally {
        await session.close();
      }
    },
  );

  it('keeps draining sidecar diagnostics after startup without parsing them as startup lines', async () => {
    sidecarOutput += `server listening on http://other-host:1234\n${'diagnostic'.repeat(1_000)}\n`;
    const { session } = await openSession();
    try {
      expect(session.failureSignal?.aborted).toBe(false);
    } finally {
      await session.close();
    }
  });

  it.each(['planner', 'implementer', 'review'] as const)(
    'registers acquired passwords for every recorded channel in a %s call',
    async (role) => {
      const path = realpathSync(process.execPath);
      const info = statSync(path);
      const adapter = role === 'implementer' ? opencodeImplementerAdapter : opencodePlannerAdapter;
      const args = adapter.buildArgs({
        model: undefined,
        projectDir: process.cwd(),
        configuredArgs: [],
        installedVersion: '2.0.26',
        sessionId: null,
        effort: undefined,
      });
      const events: RunnerCallEvent[] = [];
      const result = await invokeProcessCli(adapter, {
        invocation: {
          executable: {
            path,
            fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
          },
          args,
          baseArgs: args,
          promptTransport: adapter.promptTransport,
          environment: {},
          cwd: process.cwd(),
          signal: undefined,
        },
        prompt: 'initial',
        installedVersion: '2.0.26',
        steering: { current: () => null, attach: () => () => {} },
        callContext: { callId: 'redaction', role, backendKind: 'cli', runnerName: 'opencode' },
        onEvent: (event) => {
          events.push(event);
        },
      });
      expect(result.status).toBe('completed');
      expect(result.text).toBe('***REDACTED***');
      expect(JSON.stringify({ result, events })).not.toContain('password-1234567890');
      expect(events.filter((event) => event.type === 'call_started')).toHaveLength(1);
    },
  );

  it('posts repeated text FIFO while earlier input awaits consumption', async () => {
    const admitted: { id: string; text: string; delivery: string }[] = [];
    let consumed = false;
    vi.stubGlobal('fetch', async (url: string, opts: RequestInit) => {
      expect(opts.headers).toMatchObject({
        authorization: `Basic ${Buffer.from('opencode:password-1234567890').toString('base64')}`,
      });
      if (opts.method === 'POST') {
        expect(url).toBe('http://127.0.0.1:1234/api/session/ses-1/prompt');
        const item = { id: `msg-${admitted.length}`, ...JSON.parse(String(opts.body)) };
        admitted.push(item);
        return Response.json({ data: { id: item.id } });
      }
      if (url.includes('/message/')) {
        const item = admitted.find((item) => url.endsWith(`/message/${item.id}`));
        if (item === undefined) throw new Error('unknown message');
        return Response.json({ data: { ...item, type: 'user', time: { created: 1 }, files: [] } });
      }
      expect(url).toBe('http://127.0.0.1:1234/api/session/ses-1/inbox');
      return Response.json({ data: consumed ? [] : admitted.map((item) => ({ id: item.id })) });
    });
    const { session, send } = await openSession();
    try {
      let firstSettled = false;
      const first = send({ id: 'first', text: 'same' });
      void first.then(() => {
        firstSettled = true;
      });
      const second = send({ id: 'second', text: 'same' });
      await vi.waitFor(() =>
        expect(admitted).toEqual([
          { id: 'msg-0', text: 'same', delivery: 'steer' },
          { id: 'msg-1', text: 'same', delivery: 'steer' },
        ]),
      );
      expect(firstSettled).toBe(false);
      consumed = true;
      expect(await Promise.all([first, second])).toEqual(['delivered', 'delivered']);
    } finally {
      await session.close();
    }
  });

  it('keeps admitted input uncertain when inbox emptiness arrives after exit', async () => {
    const inbox = Promise.withResolvers<Response>();
    let polling = false;
    vi.stubGlobal('fetch', (_url: string, opts: RequestInit) => {
      if (opts.method === 'POST') return Promise.resolve(Response.json({ data: { id: 'msg-1' } }));
      polling = true;
      return inbox.promise;
    });
    const { session, send } = await openSession();
    const delivery = send({ id: 'late', text: 'late' });
    await vi.waitFor(() => expect(polling).toBe(true));
    session.onAdmissionClosed?.();
    expect(await delivery).toBe('uncertain');
    expect(await send({ id: 'later', text: 'later' })).toBe('deferred');
    inbox.resolve(Response.json({ data: [] }));
    await session.close();
  });

  it('keeps a stored steer uncertain when its lookup arrives after admission closes', async () => {
    const response = Promise.withResolvers<Response>();
    let lookupStarted = false;
    vi.stubGlobal('fetch', async (url: string, opts: RequestInit) => {
      if (opts.method === 'POST') return Response.json({ data: { id: 'msg-stored' } });
      if (url.endsWith('/inbox')) return Response.json({ data: [] });
      expect(url).toBe('http://127.0.0.1:1234/api/session/ses-1/message/msg-stored');
      lookupStarted = true;
      return response.promise;
    });
    const { session, send } = await openSession();
    const delivery = send({ id: 'late', text: 'correction' });
    try {
      await vi.waitFor(() => expect(lookupStarted).toBe(true));
      session.onAdmissionClosed?.();
      response.resolve(Response.json({ data: { id: 'msg-stored', type: 'user' } }));
      expect(await delivery).toBe('uncertain');
    } finally {
      response.resolve(Response.json({ data: { id: 'msg-stored' } }));
      await session.close();
    }
  });

  it.each(['rejected', 'disconnected'] as const)(
    'settles a %s POST without claiming delivery',
    async (mode) => {
      vi.stubGlobal('fetch', () =>
        mode === 'rejected'
          ? Promise.resolve(Response.json({ error: 'refused' }, { status: 500 }))
          : Promise.reject(new Error('lost response')),
      );
      const { session, send } = await openSession();
      try {
        expect(await send({ id: 'one', text: 'one' })).toBe(
          mode === 'rejected' ? 'deferred' : 'uncertain',
        );
      } finally {
        await session.close();
      }
    },
  );

  it('defers unwritten queued messages when an earlier POST loses its response on close', async () => {
    const response = Promise.withResolvers<Response>();
    let posted = false;
    vi.stubGlobal('fetch', () => {
      posted = true;
      return response.promise;
    });
    const { session, send } = await openSession();
    const first = send({ id: 'first', text: 'one' });
    const second = send({ id: 'second', text: 'two' });
    await vi.waitFor(() => expect(posted).toBe(true));
    session.onAdmissionClosed?.();
    expect(await Promise.all([first, second])).toEqual(['uncertain', 'deferred']);
    response.resolve(Response.json({ data: { id: 'msg-1' } }));
    await session.close();
  });
});
