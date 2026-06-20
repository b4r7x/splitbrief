import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../events/protection.js';
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

  it('redacts secrets and strips terminal controls before writing event frames', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    const msg: ServerMessage = {
      kind: 'event',
      payload: {
        type: 'warning',
        ts: 1,
        phase: 'idle',
        message: 'token sk-abcdefghijklmnopqrst \u001b]0;owned\u0007done',
      },
    };
    writeServerMessage(server, msg);
    await new Promise((r) => setTimeout(r, 50));

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames[0]).toEqual({
      kind: 'event',
      payload: {
        type: 'warning',
        ts: 1,
        phase: 'idle',
        message: 'token sk-***REDACTED*** done',
      },
    });
  });

  it('drops transcript-only runner frames when transcript persistence is disabled', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    writeServerMessage(
      server,
      {
        kind: 'event',
        payload: {
          type: 'runner_call_text_delta',
          ts: 1,
          phase: 'planning',
          callId: 'call-1',
          role: 'planner',
          backendKind: 'cli',
          sequence: 1,
          channel: 'assistant',
          text: 'hidden transcript',
        },
      },
      { persistTranscript: false },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(received.lines).toEqual([]);
  });

  it('keeps safe runner activity frames when transcript persistence is disabled', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    writeServerMessage(
      server,
      {
        kind: 'event',
        payload: {
          type: 'runner_call_activity',
          ts: 2,
          phase: 'planning',
          callId: 'call-1',
          role: 'planner',
          backendKind: 'cli',
          sequence: 2,
          activityId: 'call-1:tool:tool-1',
          stage: 'completed',
          kind: 'command',
          label: 'running echo sk-***REDACTED***',
          target: 'echo sk-***REDACTED***',
          redacted: true,
        },
      },
      { persistTranscript: false },
    );
    await new Promise((r) => setTimeout(r, 50));

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames).toEqual([
      {
        kind: 'event',
        payload: expect.objectContaining({
          type: 'runner_call_activity',
          label: TRANSCRIPT_OMITTED_MESSAGE,
          target: TRANSCRIPT_OMITTED_MESSAGE,
        }),
      },
    ]);
  });

  it('projects prompt requests when transcript persistence is disabled', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    writeServerMessage(
      server,
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-question-1',
          kind: 'question_asked',
          question: {
            id: 'question-1',
            type: 'choice',
            text: 'ipc-question-secret-41802',
            options: ['ipc-choice-secret-41802'],
            default: 'ipc-default-secret-41802',
          },
          num: 1,
          total: 1,
        },
      },
      { persistTranscript: false },
    );
    writeServerMessage(
      server,
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-recovery-1',
          kind: 'recovery_needed',
          issue: {
            id: 'recovery-1',
            reason: 'retry-exhausted',
            phase: 'implementing',
            taskId: taskId('T001'),
            taskTitle: 'ipc-recovery-task-context',
            files: ['src/task.ts'],
            affectedTaskIds: [taskId('T001')],
            selectedImplementerProfile: 'small-worker',
            availableActions: ['retry-same-worker', 'abort-workflow'],
            recommendedAction: 'retry-same-worker',
            workerProfile: 'large-worker',
            facts: { safeToContinue: false },
          },
        },
      },
      { persistTranscript: false },
    );
    await new Promise((r) => setTimeout(r, 50));

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames).toEqual([
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-question-1',
          kind: 'question_asked',
          question: {
            id: 'question-1',
            type: 'choice',
            text: TRANSCRIPT_OMITTED_MESSAGE,
            options: [TRANSCRIPT_OMITTED_MESSAGE],
            default: TRANSCRIPT_OMITTED_MESSAGE,
          },
          num: 1,
          total: 1,
        },
      },
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-recovery-1',
          kind: 'recovery_needed',
          issue: {
            id: 'recovery-1',
            reason: 'retry-exhausted',
            phase: 'implementing',
            taskId: taskId('T001'),
            taskTitle: 'ipc-recovery-task-context',
            files: ['src/task.ts'],
            affectedTaskIds: [taskId('T001')],
            selectedImplementerProfile: 'small-worker',
            availableActions: ['retry-same-worker', 'abort-workflow'],
            recommendedAction: 'retry-same-worker',
            workerProfile: 'large-worker',
            facts: { safeToContinue: false },
          },
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain('ipc-question-secret-41802');
    expect(JSON.stringify(frames)).not.toContain('ipc-choice-secret-41802');
    expect(JSON.stringify(frames)).not.toContain('ipc-recovery-secret-41802');
    expect(JSON.stringify(frames)).not.toContain('message');
    expect(JSON.stringify(frames)).not.toContain('details');
  });

  it('uses the central event projection for task review prompt requests', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    writeServerMessage(
      server,
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-review-1',
          kind: 'task_review',
          request: {
            taskId: taskId('T001'),
            taskTitle: 'ipc-task-review-title-secret-79231',
            status: 'recovery-required',
            filesTouched: ['src/secret.ts'],
            validation: {
              passed: false,
              summary: 'ipc-validation-secret-79231',
              stages: [{ stage: 'test', passed: false, errorSummary: 'ipc-stage-secret-79231' }],
            },
            evidence: {
              path: 'src/evidence-secret.ts',
              summary: 'ipc-evidence-secret-79231',
              expected: ['ipc-expected-secret-79231'],
              observed: ['ipc-observed-secret-79231'],
            },
            cost: {
              tokenUsage: {
                plannerInput: 1,
                plannerOutput: 2,
                implementerInput: 3,
                implementerOutput: 4,
                escalationInput: 5,
                escalationOutput: 6,
              },
            },
            recovery: {
              reason: 'retry-exhausted',
              message: 'ipc-review-recovery-secret-79231',
              availableActions: ['retry-same-worker', 'abort-workflow'],
              recommendedAction: 'retry-same-worker',
            },
            availableCommands: ['continue', 'abort'],
          },
        },
      },
      { persistTranscript: false },
    );
    await new Promise((r) => setTimeout(r, 50));

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames).toEqual([
      {
        kind: 'prompt_request',
        request: {
          requestId: 'prompt-review-1',
          kind: 'task_review',
          request: expect.objectContaining({
            taskId: 'T001',
            taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
            status: 'recovery-required',
            filesTouched: [TRANSCRIPT_OMITTED_MESSAGE],
            validation: expect.objectContaining({
              summary: TRANSCRIPT_OMITTED_MESSAGE,
              stages: [
                expect.objectContaining({
                  errorSummary: TRANSCRIPT_OMITTED_MESSAGE,
                }),
              ],
            }),
            evidence: expect.objectContaining({
              path: TRANSCRIPT_OMITTED_MESSAGE,
              summary: TRANSCRIPT_OMITTED_MESSAGE,
              expected: [TRANSCRIPT_OMITTED_MESSAGE],
              observed: [TRANSCRIPT_OMITTED_MESSAGE],
            }),
            recovery: {
              reason: 'retry-exhausted',
              message: TRANSCRIPT_OMITTED_MESSAGE,
              availableActions: ['retry-same-worker', 'abort-workflow'],
              recommendedAction: 'retry-same-worker',
            },
            availableCommands: ['continue', 'abort'],
          }),
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain('ipc-task-review-title-secret-79231');
    expect(JSON.stringify(frames)).not.toContain('ipc-validation-secret-79231');
    expect(JSON.stringify(frames)).not.toContain('ipc-review-recovery-secret-79231');
  });

  it('bounds oversized warning events before frame-size handling when transcript persistence is disabled', async () => {
    const { server, client } = await connectedPair();
    const received = collectLines(client);

    const oversizedWarning: ServerMessage = {
      kind: 'event',
      payload: {
        type: 'warning',
        ts: 1,
        phase: 'idle',
        message: 'x'.repeat(IPC_MAX_FRAME_BYTES + 1024),
      },
    };

    writeServerMessage(server, oversizedWarning, { persistTranscript: false });
    await new Promise((r) => setTimeout(r, 50));

    const frames = received.lines.map((l) => JSON.parse(l) as ServerMessage);
    expect(frames).toHaveLength(1);
    const only = frames[0];
    expect(only?.kind).toBe('event');
    if (only?.kind === 'event') {
      expect(only.payload.type).toBe('warning');
      const message = (only.payload as { message: string }).message;
      expect(message).toBe(TRANSCRIPT_OMITTED_MESSAGE);
      expect(JSON.stringify(only)).not.toContain('dropped oversized warning frame');
      expect(Buffer.byteLength(JSON.stringify(only), 'utf8')).toBeLessThan(IPC_MAX_FRAME_BYTES);
    }
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
            tokenUsage: {
              plannerInput: 0,
              plannerOutput: 0,
              implementerInput: 0,
              implementerOutput: 0,
              escalationInput: 0,
              escalationOutput: 0,
            },
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
