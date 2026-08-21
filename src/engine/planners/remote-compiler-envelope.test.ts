import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationOperationEnvelope,
} from '../../core/schemas/task-compilation.js';
import { getProvider } from '../providers/registry.js';
import { createClientFromProvider } from '../providers/client/connection.js';
import { toStreamClient } from '../providers/openai-stream/client.js';
import type { StreamClient } from '../providers/openai-stream/request.js';
import { invokeApiTransport } from './api.js';
import { createTaskDispatchClaimPort, createTaskDispatchLedger } from '../calls/dispatch-ledger.js';
import type { TaskDispatchLedger } from '../calls/dispatch-ledger.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';

let server: http.Server;
let port: number;
let realFetch: typeof globalThis.fetch;
type RequestBody = { model: string; stream: boolean; max_tokens?: number };
let receivedBodies: RequestBody[];
let openAiCompletionChunks: string[];
let hangCompletionResponse: boolean;
let hungConnections: number;

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
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
    ...overrides,
  };
}

function operationEnvelope(dispatchLimit: number): TaskCompilationOperationEnvelope {
  return {
    version: 1,
    dispatchLimit,
    callCount: 0,
    totalPromptBytes: 0,
    totalInputTokensUpperBound: 0,
    totalOutputTokensUpperBound: 0,
    totalNormalizedOutputBytes: 0,
    totalDeclaredArtifactBytes: 0,
    callsDigest: 'compiler-envelope-test',
  };
}

function makeLedger(dispatchLimit: number): TaskDispatchLedger {
  return createTaskDispatchLedger({
    operation: operationEnvelope(dispatchLimit),
    operationId: TaskCompilationOperationIdSchema.parse('compiler-envelope-operation'),
    claimPort: createTaskDispatchClaimPort(),
  });
}

function proxyFetchToLocalServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const requestUrl =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(requestUrl);
  if (parsed.hostname === '127.0.0.1' && parsed.port === String(port)) {
    return realFetch(input, init);
  }
  const localUrl = `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
  if (input instanceof Request) {
    return realFetch(localUrl, {
      ...init,
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: input.signal ?? init?.signal,
      redirect: init?.redirect ?? 'manual',
    });
  }
  return realFetch(localUrl, init);
}

function streamSseChunks(
  res: http.ServerResponse,
  chunks: string[],
  finalUsage?: { prompt_tokens: number; completion_tokens: number },
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const text of chunks) {
    const event = {
      choices: [{ delta: { content: text }, index: 0, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (finalUsage) {
    const final = {
      choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      usage: finalUsage,
    };
    res.write(`data: ${JSON.stringify(final)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

beforeEach(async () => {
  receivedBodies = [];
  openAiCompletionChunks = ['Hello ', 'world'];
  hangCompletionResponse = false;
  hungConnections = 0;

  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        if (hangCompletionResponse) {
          hangCompletionResponse = false;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(
            'data: {"choices":[{"delta":{"content":"first"},"index":0,"finish_reason":null}]}\n\n',
          );
          res.on('close', () => {
            hungConnections += 1;
          });
          return;
        }
        streamSseChunks(res, openAiCompletionChunks, {
          prompt_tokens: 42,
          completion_tokens: 17,
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', proxyFetchToLocalServer);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function makeTransport(provider: string): {
  client: StreamClient | null;
  apiKey: string;
  apiBase: string;
} {
  const resolved = getProvider(provider, {
    apiBase: `http://127.0.0.1:${port}/v1`,
    apiKey: provider === 'ollama' ? undefined : 'sk-test-key',
  });
  return {
    client: provider === 'anthropic' ? null : toStreamClient(createClientFromProvider(resolved)),
    apiKey: resolved.apiKey(),
    apiBase: resolved.baseURL,
  };
}

let callSequence = 0;

function invokeCompilerCall(opts: {
  provider?: string | undefined;
  env?: TaskCompilationCallEnvelope | undefined;
  ledger?: TaskDispatchLedger | undefined;
  attemptId?: TaskCompilationAttemptId | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<Awaited<ReturnType<typeof invokeApiTransport>>> {
  const provider = opts.provider ?? 'ollama';
  const transport = makeTransport(provider);
  const callContext: RunnerCallContext = {
    callId: `remote-compiler-${++callSequence}`,
    role: 'planner',
    backendKind: 'api',
    runnerName: provider,
    model: 'test-model',
    transport: { kind: 'stdout-final' },
    ...(opts.attemptId !== undefined && { attemptId: opts.attemptId }),
  };
  return invokeApiTransport({
    client: transport.client,
    model: 'test-model',
    contextLength: 8192,
    planner: { provider, apiBase: transport.apiBase, apiKey: transport.apiKey, temperature: 0.3 },
    prompt: 'compile the manifest slice',
    onOutput: () => {},
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.onCallEvent !== undefined && { onCallEvent: opts.onCallEvent }),
    callContext,
    ...(opts.env !== undefined && { envelope: opts.env }),
    ...(opts.ledger !== undefined && { ledger: opts.ledger }),
  });
}

describe('invokeApiTransport — remote compiler envelope', () => {
  it('captures the exact envelope output-token bound of 8,192 in the request and threads the envelope', async () => {
    const env = envelope();
    const attemptId = createTaskCompilationAttemptId();
    const events: RunnerCallEvent[] = [];
    const result = await invokeCompilerCall({
      env,
      attemptId,
      onCallEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]?.max_tokens).toBe(TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens);
    expect(receivedBodies[0]?.max_tokens).toBe(8_192);
    const started = events.find((event) => event.type === 'call_started');
    expect(started).toMatchObject({ attemptId });
    expect(started?.envelope).toEqual(env);
  });

  it('claims the operation ledger immediately before dispatch and refuses claim 2 with zero dispatch', async () => {
    const ledger = makeLedger(1);
    const env = envelope();

    const first = await invokeCompilerCall({ env, ledger });
    expect(first.status).toBe('completed');
    expect(ledger.snapshot().dispatchCount).toBe(1);

    const second = await invokeCompilerCall({ env, ledger });
    expect(second.status).toBe('refused');
    expect(second.error).toMatchObject({ code: 'task_compiler_dispatch_limit' });
    expect(ledger.snapshot().dispatchCount).toBe(1);
    expect(receivedBodies).toHaveLength(1);
  });

  it('aborts the hung request at the envelope deadline with no retry and a timeout terminal', async () => {
    const env = envelope({ deadlineMs: 200 });
    hangCompletionResponse = true;

    let outcome:
      | { kind: 'resolved'; result: Awaited<ReturnType<typeof invokeCompilerCall>> }
      | {
          kind: 'rejected';
          err: Error;
        };
    try {
      outcome = { kind: 'resolved', result: await invokeCompilerCall({ env }) };
    } catch (err) {
      outcome = { kind: 'rejected', err: err as Error };
    }

    expect(receivedBodies).toHaveLength(1);
    await vi.waitFor(() => expect(hungConnections).toBe(1));
    if (outcome.kind === 'resolved') {
      expect(outcome.result.status).toBe('truncated');
      expect(outcome.result.partial).toBe(true);
      expect(outcome.result.error).toMatchObject({ code: 'task_compiler_timeout' });
    } else {
      expect(outcome.err.name).toBe('TimeoutError');
    }
  });

  it('latches normalized overflow as terminal truncated that no later terminal can clear, with no retry', async () => {
    const env = envelope({ maxNormalizedOutputBytes: 128 });
    openAiCompletionChunks = ['x'.repeat(300)];

    const result = await invokeCompilerCall({ env });

    expect(result.status).toBe('truncated');
    expect(result.partial).toBe(true);
    expect(result.error).toMatchObject({ code: 'task_compiler_output_limited' });
    expect(receivedBodies).toHaveLength(1);
  });

  it('refuses an unsupported provider before dispatch without claiming the ledger', async () => {
    const env = envelope();
    const ledger = makeLedger(2);

    const result = await invokeCompilerCall({
      provider: 'custom-unknown-provider',
      env,
      ledger,
    });

    expect(result.status).toBe('refused');
    expect(result.error).toMatchObject({
      code: 'task_compiler_capability_unsupported',
      message: expect.stringContaining('custom-unknown-provider'),
    });
    expect(receivedBodies).toHaveLength(0);
    expect(ledger.snapshot().dispatchCount).toBe(0);
  });
});
