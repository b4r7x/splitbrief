import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BriefRecoveryProjectionV1Schema } from '../../core/schemas/brief-recovery.js';
import { createCommandReader, createRpcOperationDeduper, type RpcEnvelopeError } from './reader.js';
import { RPC_MAX_FRAME_BYTES, type RpcCommand } from './types.js';

type BriefReviewRpcCommand = Extract<RpcCommand, { type: 'brief_review' }>;

const validCommands: RpcCommand[] = [
  { type: 'approve' },
  { type: 'reject' },
  { type: 'regenerate', comment: 'needs changes' },
  { type: 'message', text: 'continue with the task' },
  { type: 'recovery', action: 'retry-same-worker' },
  { type: 'status' },
  { type: 'abort' },
  { type: 'slash', command: '/mode quick' },
  {
    type: 'brief_review',
    id: 'cmd-1',
    operationId: 'operation-1',
    promptId: 'approval-1',
    command: {
      version: 1,
      sessionId: 'session-1',
      epochId: 'epoch-1',
      operationId: 'operation-1',
      expectedBriefRevision: 1,
      expectedReportRevision: null,
      intentHash: 'intent-1',
      base: { revision: 1, hash: 'brief-hash', path: 'brief.md' },
      action: 'comment',
      comment: 'split T001',
    },
  },
];

const authoritativeProjection = BriefRecoveryProjectionV1Schema.parse({
  version: 1,
  sessionId: 'session-1',
  stateRevision: 4,
  recoveryRevision: 2,
  epochId: 'epoch-1',
  status: 'blocked',
  origin: { mode: 'standard', entry: 'initial' },
  continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
  activeBrief: { revision: 1, hash: 'brief-hash', path: 'brief.md' },
  matchingReport: {
    briefHash: 'brief-hash',
    report: { revision: 1, hash: 'report-hash', path: 'report.json' },
    ruleVersion: 'brief-quality-v1',
    issues: [],
  },
  blocker: null,
  allowedActions: ['retry', 'edit', 'reject'],
  activeOperation: null,
  latestAttempt: null,
  queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
});

const authoritativeState = { stateVersion: 4, projection: authoritativeProjection };

function briefReviewComment(
  options: { operationId?: string; epochId?: string; comment?: string } = {},
): BriefReviewRpcCommand {
  const operationId = options.operationId ?? 'operation-review';
  return {
    type: 'brief_review',
    id: `command-${operationId}`,
    operationId,
    command: {
      version: 1,
      sessionId: 'session-1',
      epochId: options.epochId ?? 'epoch-1',
      operationId,
      expectedBriefRevision: 1,
      expectedReportRevision: null,
      intentHash: 'intent-review',
      base: { revision: 1, hash: 'brief-hash', path: 'brief.md' },
      action: 'comment',
      comment: options.comment ?? 'review the Brief',
    },
  };
}

function briefReviewApprove(operationId = 'operation-approve'): BriefReviewRpcCommand {
  return {
    type: 'brief_review',
    id: `command-${operationId}`,
    operationId,
    command: {
      version: 1,
      sessionId: 'session-1',
      epochId: 'epoch-1',
      operationId,
      expectedBriefRevision: 1,
      expectedReportRevision: 1,
      intentHash: 'intent-approve',
      base: { revision: 1, hash: 'brief-hash', path: 'brief.md' },
      baseReport: { revision: 1, hash: 'report-hash', path: 'report.json' },
      action: 'approve',
    },
  };
}

function briefReviewStatus(): BriefReviewRpcCommand {
  return {
    type: 'brief_review',
    id: 'command-status',
    command: { version: 1, sessionId: 'session-1', epochId: 'epoch-1', action: 'status' },
  };
}

function createReadableInput(): PassThrough {
  return new PassThrough();
}

async function waitForReader(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('createCommandReader', () => {
  it('parses non-empty JSON lines into commands', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      requireCurrentV4: false,
      onCommand: (command) => commands.push(command),
      onError: (error) => errors.push(error),
    });

    stream.end(`\n${validCommands.map((command) => JSON.stringify(command)).join('\n')}\n\n`);
    await waitForReader();

    expect(commands).toEqual(validCommands);
    expect(errors).toEqual([]);
  });

  it('reports invalid JSON without emitting a command', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      onCommand: (command) => commands.push(command),
      onError: (error) => errors.push(error),
    });

    stream.end('not json\n');
    await waitForReader();

    expect(commands).toEqual([]);
    expect(errors).toEqual(['Invalid JSON: not json']);
  });

  it('signals close when stdin ends', async () => {
    let closed = false;
    const stream = createReadableInput();

    createCommandReader({
      stream,
      onCommand: () => {},
      onError: () => {},
      onClose: () => {
        closed = true;
      },
    });

    stream.end();
    await waitForReader();

    expect(closed).toBe(true);
  });

  it('reports validation errors for unsupported commands and empty payloads', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      onCommand: (command) => commands.push(command),
      onError: (error) => errors.push(error),
    });

    stream.end(
      [
        '{"type":"unknown"}',
        '{"type":"message","text":""}',
        '{"type":"recovery","action":""}',
        '{"type":"slash","command":""}',
      ].join('\n') + '\n',
    );
    await waitForReader();

    expect(commands).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors.every((error) => error.startsWith('Invalid command:'))).toBe(true);
  });

  it('rejects an oversized frame and closes before later commands are parsed', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    let closed = false;
    const stream = createReadableInput();

    createCommandReader({
      stream,
      onCommand: (command) => commands.push(command),
      onError: (error) => errors.push(error),
      onClose: () => {
        closed = true;
      },
    });

    const oversized = `{"type":"message","text":"${'x'.repeat(RPC_MAX_FRAME_BYTES)}"}`;
    stream.write(`${oversized}\n`);
    stream.end(`${JSON.stringify({ type: 'approve' })}\n`);
    await waitForReader();

    expect(commands).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^RPC frame too large: \d+ bytes$/);
    expect(closed).toBe(true);
    expect(stream.destroyed).toBe(true);
  });

  it('rejects a bounded unterminated frame at end of input', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const typedErrors: RpcEnvelopeError[] = [];
    let closed = false;
    const stream = createReadableInput();

    createCommandReader({
      stream,
      onCommand: (command) => commands.push(command),
      onError: (error) => errors.push(error),
      onTypedError: (error) => typedErrors.push(error),
      onClose: () => {
        closed = true;
      },
    });

    stream.end(JSON.stringify({ type: 'approve' }));
    await waitForReader();

    expect(commands).toEqual([]);
    expect(errors).toEqual([expect.stringMatching(/^RPC frame is unterminated: \d+ bytes$/)]);
    expect(typedErrors).toMatchObject([{ code: 'unterminated-frame' }]);
    expect(closed).toBe(true);
  });

  it('rejects an unterminated frame when the input closes without end', async () => {
    const typedErrors: RpcEnvelopeError[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      onCommand: () => {},
      onError: () => {},
      onTypedError: (error) => typedErrors.push(error),
    });

    stream.write('{"type":"approve"}');
    stream.destroy();
    await waitForReader();

    expect(typedErrors.map((error) => error.code)).toEqual(['unterminated-frame']);
  });

  it('deduplicates a replayed operation and reports conflicting reuse', async () => {
    const command = briefReviewComment({ operationId: 'operation-dedupe' });
    const replay = { ...command, id: 'command-from-another-client', promptId: 'prompt-2' };
    const conflicting = briefReviewComment({
      operationId: 'operation-dedupe',
      comment: 'a different command',
    });
    const commands: RpcCommand[] = [];
    const replays: RpcCommand[] = [];
    const errors: string[] = [];
    const typedErrors: RpcEnvelopeError[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      requireCurrentV4: false,
      operationDedupe: createRpcOperationDeduper(),
      onCommand: (received) => commands.push(received),
      onReplay: (received) => replays.push(received),
      onError: (error) => errors.push(error),
      onTypedError: (error) => typedErrors.push(error),
    });

    stream.end(
      `${[JSON.stringify(command), JSON.stringify(replay), JSON.stringify(conflicting)].join('\n')}\n`,
    );
    await waitForReader();

    expect(commands).toEqual([command]);
    expect(replays).toEqual([replay]);
    expect(errors).toHaveLength(1);
    expect(typedErrors.map((error) => error.code)).toEqual(['operation-conflict']);
  });

  it('refuses a stale epoch before dispatching a Brief Review operation', async () => {
    const commands: RpcCommand[] = [];
    const typedErrors: RpcEnvelopeError[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      getAuthoritativeState: () => authoritativeState,
      requireCurrentV4: true,
      onCommand: (command) => commands.push(command),
      onError: () => {},
      onTypedError: (error) => typedErrors.push(error),
    });

    stream.end(`${JSON.stringify(briefReviewComment({ epochId: 'stale-epoch' }))}\n`);
    await waitForReader();

    expect(commands).toEqual([]);
    expect(typedErrors.map((error) => error.code)).toEqual(['stale-epoch']);
  });

  it('refuses a Brief Review command when the owner has not supplied current-v4 state', async () => {
    const commands: RpcCommand[] = [];
    const typedErrors: RpcEnvelopeError[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      onCommand: (command) => commands.push(command),
      onError: () => {},
      onTypedError: (error) => typedErrors.push(error),
    });

    stream.end(
      `${JSON.stringify(briefReviewComment({ operationId: 'operation-no-authority' }))}\n`,
    );
    await waitForReader();

    expect(commands).toEqual([]);
    expect(typedErrors.map((error) => error.code)).toEqual(['authority-unavailable']);
  });

  it('reports malformed, legacy, and future authority states as typed errors', async () => {
    const states: ReadonlyArray<{ state: unknown; code: RpcEnvelopeError['code'] }> = [
      { state: { stateVersion: 3 }, code: 'legacy-state' },
      { state: { stateVersion: 5 }, code: 'future-state' },
      { state: { stateVersion: 4, projection: { status: 'blocked' } }, code: 'malformed-state' },
    ];

    for (const [index, fixture] of states.entries()) {
      const commands: RpcCommand[] = [];
      const typedErrors: RpcEnvelopeError[] = [];
      const stream = createReadableInput();

      createCommandReader({
        stream,
        operationDedupe: createRpcOperationDeduper(),
        getAuthoritativeState: () => fixture.state,
        requireCurrentV4: true,
        onCommand: (command) => commands.push(command),
        onError: () => {},
        onTypedError: (error) => typedErrors.push(error),
      });

      stream.end(
        `${JSON.stringify(briefReviewComment({ operationId: `operation-state-${index}` }))}\n`,
      );
      await waitForReader();

      expect(commands).toEqual([]);
      expect(typedErrors.map((error) => error.code)).toEqual([fixture.code]);
    }
  });

  it('refuses approve while the authoritative projection is blocked', async () => {
    const commands: RpcCommand[] = [];
    const typedErrors: RpcEnvelopeError[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      getAuthoritativeState: () => authoritativeState,
      requireCurrentV4: true,
      onCommand: (command) => commands.push(command),
      onError: () => {},
      onTypedError: (error) => typedErrors.push(error),
    });

    stream.end(`${JSON.stringify(briefReviewApprove())}\n`);
    await waitForReader();

    expect(commands).toEqual([]);
    expect(typedErrors.map((error) => error.code)).toEqual(['brief-contract-blocked']);
  });

  it('allows status-only observation without a provider-facing operation', async () => {
    const commands: RpcCommand[] = [];
    const typedErrors: RpcEnvelopeError[] = [];
    const stream = createReadableInput();

    createCommandReader({
      stream,
      getAuthoritativeState: () => authoritativeState,
      requireCurrentV4: true,
      onCommand: (command) => commands.push(command),
      onError: () => {},
      onTypedError: (error) => typedErrors.push(error),
    });

    stream.end(`${JSON.stringify(briefReviewStatus())}\n`);
    await waitForReader();

    expect(commands).toEqual([briefReviewStatus()]);
    expect(typedErrors).toEqual([]);
  });

  it('returns typed errors for unsupported command versions and operation envelope conflicts', async () => {
    const typedErrors: RpcEnvelopeError[] = [];
    const stream = createReadableInput();
    const command = briefReviewComment({ operationId: 'operation-envelope' });
    const unsupported = {
      ...command,
      command: { ...command.command, version: 2 },
    };
    const conflicting = { ...command, operationId: 'different-operation' };

    createCommandReader({
      stream,
      operationDedupe: createRpcOperationDeduper(),
      onCommand: () => {},
      onError: () => {},
      onTypedError: (error) => typedErrors.push(error),
    });

    stream.end(`${JSON.stringify(unsupported)}\n${JSON.stringify(conflicting)}\n`);
    await waitForReader();

    expect(typedErrors.map((error) => error.code)).toEqual([
      'invalid-command',
      'operation-envelope-conflict',
    ]);
  });
});
