import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  OperationEnvelopeSchema,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  createTaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
} from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
  type TaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { claudeCodeImplementerAdapter } from './claude-code.js';
import type { CliInvocation, CliImplementerAdapter } from './contract.js';
import { invokeProcessCli } from './process-invoke.js';
import { invokeCliAdapter } from '../invoke-cli-adapter.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>>,
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

function contextWith(env: TaskCompilationCallEnvelope): RunnerCallContext {
  return {
    callId: 'process-invoke-envelope',
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'fixture',
    envelope: env,
  };
}

function executableIdentity(): CliExecutableIdentity {
  const path = realpathSync(process.execPath);
  const info = statSync(path);
  return {
    path,
    fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

function invocation(script: string, timeoutMs = 5_000): CliInvocation {
  return {
    executable: executableIdentity(),
    args: ['-e', script],
    promptTransport: { kind: 'stdin' },
    environment: {},
    cwd: tmpdir(),
    timeoutMs,
    signal: undefined,
  };
}

function fixtureAdapter(descendantPid: { current: number }): CliImplementerAdapter {
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'implementer',
    promptTransport: { kind: 'stdin' },
    baseArgs: () => [],
    buildArgs: () => [],
    validateArgs: () => ({ valid: true }),
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: (line) => {
      if (line.startsWith('PID:')) {
        descendantPid.current = Number.parseInt(line.slice(4), 10);
        return [];
      }
      if (line.startsWith('TEXT:')) {
        return [
          {
            type: 'text',
            channel: 'assistant',
            text: Buffer.from(line.slice(5), 'base64').toString('utf8'),
          },
        ];
      }
      throw new Error('invalid fixture protocol');
    },
    terminal: ({ events }) => {
      const terminal = events.findLast((event) => event.type === 'result');
      if (terminal === undefined || terminal.type !== 'result') {
        throw new Error('missing terminal');
      }
      return terminal;
    },
    probe: {
      version: {
        command: ['fixture', '--version'],
        cwd: 'neutral',
        timeoutMs: 100,
        maxOutputBytes: 1024,
      },
      auth: { command: ['fixture', 'auth'], cwd: 'neutral', timeoutMs: 100, maxOutputBytes: 1024 },
    },
  };
}

const overflowScript = [
  "const {spawn}=require('node:child_process')",
  "const child=spawn(process.execPath,['-e','setInterval(()=>{},5000)'],{stdio:'ignore'})",
  "process.stdout.write('PID:'+child.pid+'\\n')",
  "const line='TEXT:'+Buffer.from('x'.repeat(16384)).toString('base64')+'\\n'",
  'setTimeout(()=>{for(let i=0;i<20;i++)process.stdout.write(line)},10)',
  'setInterval(()=>{},5000)',
].join(';');

const silentWithDescendantScript = [
  "const {spawn}=require('node:child_process')",
  "const child=spawn(process.execPath,['-e','setInterval(()=>{},5000)'],{stdio:'ignore'})",
  "process.stdout.write('PID:'+child.pid+'\\n')",
  'setInterval(()=>{},5000)',
].join(';');

const chattyWithDescendantScript = [
  "const {spawn}=require('node:child_process')",
  "const child=spawn(process.execPath,['-e','setInterval(()=>{},5000)'],{stdio:'ignore'})",
  "process.stdout.write('PID:'+child.pid+'\\n')",
  "const line='TEXT:'+Buffer.from('tick').toString('base64')+'\\n'",
  'setInterval(()=>process.stdout.write(line),10)',
].join(';');

function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('process-invoke envelope enforcement', () => {
  const dirs: string[] = [];
  function markerDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'splitbrief-envelope-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await killAllProcesses();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  itUnix(
    'reaps the process tree when the raw protocol bound is breached and stays terminally truncated',
    async () => {
      const descendantPid = { current: 0 };
      const env = envelope({ maxRawProtocolBytes: 128 * 1024 });
      const result = await invokeProcessCli(fixtureAdapter(descendantPid), {
        invocation: invocation(overflowScript),
        prompt: '',
        callContext: contextWith(env),
      });

      expect(result).toMatchObject({
        status: 'truncated',
        partial: true,
        error: { code: 'task_compiler_output_limited' },
      });
      expect(descendantPid.current).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid.current)).toBe(true);
    },
    30_000,
  );

  itUnix(
    'kills the silent process tree at the envelope deadline and classifies it as a timeout',
    async () => {
      const descendantPid = { current: 0 };
      const env = envelope({ deadlineMs: 5_000 });
      const startedAt = Date.now();
      const result = await invokeProcessCli(fixtureAdapter(descendantPid), {
        invocation: invocation(silentWithDescendantScript, 20_000),
        prompt: '',
        callContext: contextWith(env),
      });
      const elapsedMs = Date.now() - startedAt;

      expect(result).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
      expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(elapsedMs).toBeLessThan(20_000);
      expect(descendantPid.current).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid.current)).toBe(true);
    },
    30_000,
  );

  itUnix(
    'classifies a chatty process tree at the envelope deadline as a timeout, not an output limit',
    async () => {
      const descendantPid = { current: 0 };
      const events: RunnerCallEvent[] = [];
      const env = envelope({ deadlineMs: 1_000 });
      const adapter: CliImplementerAdapter = {
        ...fixtureAdapter(descendantPid),
        // Pre-launch work runs after the recorder starts the envelope clock and
        // before the invocation timer is armed, so the child's post-deadline
        // lines reach the recorder's deadline latch this many ms before the
        // abort — the window a chatty runner hits and a silent one cannot.
        validateArgs: () => {
          blockEventLoop(500);
          return { valid: true };
        },
      };
      const startedAt = Date.now();
      const result = await invokeProcessCli(adapter, {
        invocation: invocation(chattyWithDescendantScript, 20_000),
        prompt: '',
        callContext: contextWith(env),
        onEvent: (event) => {
          events.push(event);
        },
      });
      const elapsedMs = Date.now() - startedAt;

      expect(
        events.some(
          (event) =>
            event.type === 'call_warning' && event.warning.code === 'task_compiler_timeout',
        ),
      ).toBe(true);
      expect(result).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
      expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
      expect(elapsedMs).toBeLessThan(20_000);
      expect(descendantPid.current).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid.current)).toBe(true);
    },
    30_000,
  );

  itUnix(
    'one envelope-torn-down spawn consumes exactly one dispatch claim',
    async () => {
      const operation = OperationEnvelopeSchema.parse({
        version: 1,
        dispatchLimit: 1,
        callCount: 0,
        totalPromptBytes: 0,
        totalInputTokensUpperBound: 0,
        totalOutputTokensUpperBound: 0,
        totalNormalizedOutputBytes: 0,
        totalDeclaredArtifactBytes: 0,
        callsDigest: 'calls-digest',
      });
      const operationId = TaskCompilationOperationIdSchema.parse(
        'operation-process-invoke-envelope',
      );
      const ledger: TaskDispatchLedger = createTaskDispatchLedger({
        operation,
        operationId,
        claimPort: createTaskDispatchClaimPort(),
      });
      const firstAttemptId = createTaskCompilationAttemptId();
      const markerPath = join(markerDir(), 'spawned');
      const floodFrame = JSON.stringify({
        type: 'stream_event',
        session_id: SESSION_ID,
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'x'.repeat(16384) },
        },
      });
      const floodScript = [
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'spawned')`,
        `const frame=${JSON.stringify(floodFrame)}`,
        "setTimeout(()=>{for(let i=0;i<20;i++)process.stdout.write(frame+'\\n')},10)",
        'setInterval(()=>{},5000)',
      ].join(';');
      const env = envelope({ maxRawProtocolBytes: 128 * 1024 });

      const first = await invokeCliAdapter({
        adapter: claudeCodeImplementerAdapter,
        invocation: invocation(floodScript),
        prompt: '',
        callContext: { ...contextWith(env), callId: 'process-invoke-claim-1' },
        ledger,
        attemptId: firstAttemptId,
        envelope: env,
      });
      const second = await invokeCliAdapter({
        adapter: claudeCodeImplementerAdapter,
        invocation: invocation('setInterval(()=>{},5000)'),
        prompt: '',
        callContext: { ...contextWith(env), callId: 'process-invoke-claim-2' },
        ledger,
        attemptId: createTaskCompilationAttemptId(),
        envelope: env,
      });

      expect(first).toMatchObject({
        status: 'truncated',
        error: { code: 'task_compiler_output_limited' },
      });
      expect(ledger.snapshot()).toMatchObject({
        dispatchCount: 1,
        dispatchLimit: 1,
        claimedAttemptIds: [firstAttemptId],
      });
      expect(second).toMatchObject({
        status: 'refused',
        error: { code: 'task_compiler_dispatch_limit' },
      });
      expect(existsSync(markerPath)).toBe(true);
      expect(ledger.snapshot()).toMatchObject({ dispatchCount: 1 });
    },
    30_000,
  );
});
