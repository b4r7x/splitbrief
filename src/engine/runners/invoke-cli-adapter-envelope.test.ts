import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import {
  OperationEnvelopeSchema,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
  type TaskDispatchLedger,
} from '../calls/dispatch-ledger.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import { claudeCodeImplementerAdapter } from './cli-tools/claude-code.js';
import type { CliInvocation } from './cli-tools/contract.js';
import { invokeCliAdapter } from './invoke-cli-adapter.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const callContext: RunnerCallContext = {
  callId: 'invoke-cli-adapter-envelope-test',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'claude',
};

const operation = OperationEnvelopeSchema.parse({
  version: 1,
  dispatchLimit: 4,
  callCount: 0,
  totalPromptBytes: 0,
  totalInputTokensUpperBound: 0,
  totalOutputTokensUpperBound: 0,
  totalNormalizedOutputBytes: 0,
  totalDeclaredArtifactBytes: 0,
  callsDigest: 'calls-digest',
});
const operationId = TaskCompilationOperationIdSchema.parse('operation-invoke-cli-envelope');

const envelope: TaskCompilationCallEnvelope = {
  version: 1,
  promptBytes: 512,
  inputTokensUpperBound: 512,
  requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
  outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
  maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
  maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
  maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
  maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
  deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
  idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
};

function createLedger(): TaskDispatchLedger {
  return createTaskDispatchLedger({
    operation,
    operationId,
    claimPort: createTaskDispatchClaimPort(),
  });
}

function executableIdentity(): CliExecutableIdentity {
  const path = realpathSync(process.execPath);
  const info = statSync(path);
  return {
    path,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

function invocation(opts: { script: string; lines: readonly string[] }): CliInvocation {
  return {
    executable: executableIdentity(),
    args: ['-e', opts.script, Buffer.from(JSON.stringify(opts.lines), 'utf8').toString('base64')],
    promptTransport: { kind: 'stdin' },
    environment: {},
    cwd: tmpdir(),
    timeoutMs: 20_000,
    signal: undefined,
  };
}

const EMIT_ALL = `const lines=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));for(const line of lines)process.stdout.write(line+'\\n');`;

function markerScript(markerPath: string): string {
  return `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'spawned');${EMIT_ALL}`;
}

function streamEvent(event: Record<string, unknown>): string {
  return JSON.stringify({ type: 'stream_event', session_id: SESSION_ID, event });
}

function textDelta(text: string): string {
  return streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
}

/** The line shapes of a real `claude -p --include-partial-messages` capture. */
function claudeCapture(deltas: readonly string[]): readonly string[] {
  const message = deltas.join('');
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID }),
    streamEvent({ type: 'message_start' }),
    streamEvent({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
    ...deltas.map(textDelta),
    JSON.stringify({
      type: 'assistant',
      session_id: SESSION_ID,
      message: { content: [{ type: 'text', text: message }] },
    }),
    streamEvent({ type: 'content_block_stop' }),
    streamEvent({ type: 'message_delta', usage: { input_tokens: 4, output_tokens: 2 } }),
    streamEvent({ type: 'message_stop' }),
    JSON.stringify({ type: 'rate_limit_event', session_id: SESSION_ID }),
    JSON.stringify({ type: 'result', session_id: SESSION_ID, result: message }),
  ];
}

async function invoke(opts: {
  ledger?: TaskDispatchLedger | undefined;
  attemptId?: TaskCompilationAttemptId | undefined;
  envelope?: TaskCompilationCallEnvelope | undefined;
  markerPath: string;
}) {
  const events: RunnerCallEvent[] = [];
  const result = await invokeCliAdapter({
    adapter: claudeCodeImplementerAdapter,
    invocation: invocation({
      script: markerScript(opts.markerPath),
      lines: claudeCapture(['final text']),
    }),
    prompt: '',
    callContext,
    ...(opts.ledger !== undefined && { ledger: opts.ledger }),
    ...(opts.attemptId !== undefined && { attemptId: opts.attemptId }),
    ...(opts.envelope !== undefined && { envelope: opts.envelope }),
    onCallEvent: (event) => events.push(event),
  });
  return { result, events };
}

describe('invokeCliAdapter consuming the operation dispatch ledger', () => {
  const dirs: string[] = [];
  function markerDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'splitbrief-envelope-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  itUnix(
    'claims the shared ledger immediately before the physical invoke and propagates the canonical attempt and envelope',
    async () => {
      const ledger = createLedger();
      const attemptId = createTaskCompilationAttemptId();
      const markerPath = join(markerDir(), 'spawned');
      const { result, events } = await invoke({ ledger, attemptId, envelope, markerPath });

      expect(result.status).toBe('completed');
      expect(existsSync(markerPath)).toBe(true);
      expect(ledger.snapshot()).toMatchObject({
        dispatchCount: 1,
        dispatchLimit: operation.dispatchLimit,
        claimedAttemptIds: [attemptId],
      });
      expect(events[0]).toMatchObject({ type: 'call_started', attemptId, envelope });
    },
  );

  itUnix('refuses at the operation ceiling and invokes the subprocess zero times', async () => {
    const ledger = createLedger();
    for (let index = 0; index < operation.dispatchLimit; index += 1) {
      expect(ledger.claimDispatch(createTaskCompilationAttemptId()).kind).toBe('claimed');
    }
    const markerPath = join(markerDir(), 'spawned');
    const { result } = await invoke({
      ledger,
      attemptId: createTaskCompilationAttemptId(),
      markerPath,
    });

    expect(result.status).toBe('refused');
    expect(result.error).toMatchObject({ code: 'task_compiler_dispatch_limit' });
    expect(result.error?.message).toBe(
      `operation dispatch limit reached (${operation.dispatchLimit}/${operation.dispatchLimit})`,
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ dispatchCount: operation.dispatchLimit });
  });

  itUnix('refuses a replayed already-claimed attempt before any invoke', async () => {
    const ledger = createLedger();
    const attemptId = createTaskCompilationAttemptId();
    expect(ledger.claimDispatch(attemptId).kind).toBe('claimed');
    const markerPath = join(markerDir(), 'spawned');
    const { result } = await invoke({ ledger, attemptId, markerPath });

    expect(result.status).toBe('refused');
    expect(result.error).toMatchObject({ code: 'task_compiler_dispatch_limit' });
    expect(result.error?.message).toBe(`attempt ${attemptId} already claimed; refusing replay`);
    expect(existsSync(markerPath)).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ dispatchCount: 1 });
  });

  itUnix('claims exactly once per physical call with no hidden retry', async () => {
    const ledger = createLedger();
    const firstMarker = join(markerDir(), 'first');
    const secondMarker = join(markerDir(), 'second');
    const first = await invoke({
      ledger,
      attemptId: createTaskCompilationAttemptId(),
      markerPath: firstMarker,
    });
    const second = await invoke({
      ledger,
      attemptId: createTaskCompilationAttemptId(),
      markerPath: secondMarker,
    });

    expect(first.result.status).toBe('completed');
    expect(second.result.status).toBe('completed');
    expect(existsSync(firstMarker)).toBe(true);
    expect(existsSync(secondMarker)).toBe(true);
    expect(ledger.snapshot()).toMatchObject({ dispatchCount: 2 });
  });

  itUnix('propagates the envelope into the recorder when no ledger is supplied', async () => {
    const markerPath = join(markerDir(), 'spawned');
    const { result, events } = await invoke({ envelope, markerPath });

    expect(result.status).toBe('completed');
    expect(existsSync(markerPath)).toBe(true);
    expect(events[0]).toMatchObject({ type: 'call_started', envelope });
  });
});
