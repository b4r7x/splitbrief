import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import type { CliAuthChannelId } from '../../../core/runners/cli-tool-catalog.js';
import {
  OperationEnvelopeSchema,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationOperationIdSchema,
  createTaskCompilationAttemptId,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
} from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
  type TaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { installClaudeNodeShim } from '#testing/helpers/claude-cli-shim.js';
import { runnerCallErrors, runnerCallTerminals } from '#testing/helpers/runner-call-events.js';
import { runClaudePlannerStream } from './invoke.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const CREDENTIAL = 'opaque-claude-envelope-credential-canary-6f2d91a8';

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: 512,
    inputTokensUpperBound: 512,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    ...overrides,
  };
}

function createLedger(dispatchLimit: number): TaskDispatchLedger {
  return createTaskDispatchLedger({
    operation: OperationEnvelopeSchema.parse({
      version: 1,
      dispatchLimit,
      callCount: 0,
      totalPromptBytes: 0,
      totalInputTokensUpperBound: 0,
      totalOutputTokensUpperBound: 0,
      totalNormalizedOutputBytes: 0,
      totalDeclaredArtifactBytes: 0,
      callsDigest: 'calls-digest',
    }),
    operationId: TaskCompilationOperationIdSchema.parse('operation-claude-compiler-envelope'),
    claimPort: createTaskDispatchClaimPort(),
  });
}

function descendantPidShim(opts: { pidFile: string; body: string }): string {
  return [
    "const {spawn}=require('node:child_process')",
    `require('node:fs').writeFileSync(${JSON.stringify(opts.pidFile)},String(spawn(process.execPath,['-e','setInterval(()=>{},5000)'],{stdio:'ignore'}).pid))`,
    opts.body,
    'setInterval(()=>{},5000)',
  ].join(';');
}

let shimDir: string;
let projectDir: string;
let restorePath: () => void;

beforeEach(() => {
  shimDir = createTempDir('claude-compiler-envelope-shim');
  projectDir = createTempDir('claude-compiler-envelope-project');
  restorePath = prependPath(shimDir);
});

afterEach(async () => {
  restorePath();
  await killAllProcesses();
  cleanupTempDir(shimDir);
  cleanupTempDir(projectDir);
});

function trustedClaudeExecutable(): CliExecutableIdentity {
  const path = realpathSync(`${shimDir}/claude`);
  const info = statSync(path);
  return {
    path,
    fingerprint: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    },
  };
}

function runClaude(opts: {
  attemptId: TaskCompilationAttemptId;
  envelope?: TaskCompilationCallEnvelope | undefined;
  ledger?: TaskDispatchLedger | undefined;
  authChannel?: CliAuthChannelId | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  onOutput?: ((text: string) => void) | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}) {
  return runClaudePlannerStream({
    prompt: 'compile batch',
    projectDir,
    sessionId: null,
    executable: trustedClaudeExecutable(),
    attemptId: opts.attemptId,
    ...(opts.envelope !== undefined && { envelope: opts.envelope }),
    ...(opts.ledger !== undefined && { ledger: opts.ledger }),
    ...(opts.authChannel !== undefined && { authChannel: opts.authChannel }),
    ...(opts.env !== undefined && { env: opts.env }),
    onOutput: opts.onOutput ?? (() => {}),
    onCallEvent: opts.onCallEvent,
  });
}

describe('Claude compiler envelope transport', () => {
  itUnix(
    'keeps only the terminal result text when the final response diverges from partials',
    async () => {
      installClaudeNodeShim(
        shimDir,
        [
          `process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'draft text'}]}})+'\\n')`,
          `process.stdout.write(JSON.stringify({type:'result',result:'final text'})+'\\n')`,
        ].join(';'),
      );
      const events: RunnerCallEvent[] = [];
      const chunks: string[] = [];
      const result = await runClaude({
        attemptId: createTaskCompilationAttemptId(),
        envelope: envelope(),
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      });

      expect(result.status).toBe('completed');
      expect(result.text).toBe('final text');
      expect(chunks.join('')).toBe('draft text');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'call_text_delta',
          channel: 'result',
          text: 'final text',
          semantics: 'final',
        }),
      );
      expect(runnerCallTerminals(events)[0]).toMatchObject({
        type: 'call_completed',
        status: 'completed',
      });
    },
  );

  itUnix('fails a missing final response instead of falling back to earlier text', async () => {
    installClaudeNodeShim(
      shimDir,
      [
        `process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'earlier text'}]}})+'\\n')`,
        `process.stdout.write(JSON.stringify({type:'result'})+'\\n')`,
      ].join(';'),
    );
    const events: RunnerCallEvent[] = [];

    await expect(
      runClaude({
        attemptId: createTaskCompilationAttemptId(),
        envelope: envelope(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('no final response text');

    const errors = runnerCallErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: { code: 'task_compiler_final_response_missing' },
      partial: true,
    });
  });

  itUnix('never completes on an is_error terminal record', async () => {
    installClaudeNodeShim(
      shimDir,
      `process.stdout.write(JSON.stringify({type:'result',is_error:true,result:'quota exceeded'})+'\\n')`,
    );
    const events: RunnerCallEvent[] = [];

    await expect(
      runClaude({
        attemptId: createTaskCompilationAttemptId(),
        envelope: envelope(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('quota exceeded');

    const errors = runnerCallErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'failed',
      error: { code: 'runner_result_error' },
    });
  });

  itUnix(
    'reaps the descendant tree on an envelope output breach, stays terminally truncated, and redacts',
    async () => {
      const pidFile = join(shimDir, 'descendant.pid');
      installClaudeNodeShim(
        shimDir,
        descendantPidShim({
          pidFile,
          body: [
            `const text='x'.repeat(100000)+${JSON.stringify(CREDENTIAL)}`,
            `process.stdout.write(JSON.stringify({type:'result',result:text})+'\\n')`,
          ].join(';'),
        }),
      );
      const events: RunnerCallEvent[] = [];

      await expect(
        runClaude({
          attemptId: createTaskCompilationAttemptId(),
          envelope: envelope({ maxNormalizedOutputBytes: 64 * 1024 }),
          authChannel: 'api-key',
          env: { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: CREDENTIAL },
          onCallEvent: (event) => events.push(event),
        }),
      ).rejects.toMatchObject({
        kind: 'process-output',
        message: expect.stringContaining('normalized output exceeded'),
      });

      const descendantPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(descendantPid).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid)).toBe(true);
      const errors = runnerCallErrors(events);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        status: 'truncated',
        error: { code: 'task_compiler_output_limited' },
        partial: true,
      });
      const persisted = JSON.stringify(events);
      expect(persisted).not.toContain(CREDENTIAL);
      expect(persisted).toContain('***REDACTED***');
    },
    30_000,
  );

  itUnix(
    'kills the silent process tree at the envelope deadline and classifies it as a timeout',
    async () => {
      const pidFile = join(shimDir, 'descendant.pid');
      installClaudeNodeShim(shimDir, descendantPidShim({ pidFile, body: '' }));
      const events: RunnerCallEvent[] = [];

      await expect(
        runClaude({
          attemptId: createTaskCompilationAttemptId(),
          envelope: envelope({ deadlineMs: 400 }),
          onCallEvent: (event) => events.push(event),
        }),
      ).rejects.toThrow('envelope deadline');

      const descendantPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(descendantPid).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid)).toBe(true);
      const errors = runnerCallErrors(events);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        status: 'timeout',
        error: { code: 'runner_interrupted' },
      });
    },
    30_000,
  );

  itUnix(
    'claims the shared ledger immediately before the spawn and propagates the attempt',
    async () => {
      const markerPath = join(shimDir, 'spawned');
      installClaudeNodeShim(
        shimDir,
        [
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'spawned')`,
          `process.stdout.write(JSON.stringify({type:'result',result:'ok'})+'\\n')`,
        ].join(';'),
      );
      const ledger = createLedger(4);
      const attemptId = createTaskCompilationAttemptId();
      const events: RunnerCallEvent[] = [];
      const result = await runClaude({
        attemptId,
        ledger,
        envelope: envelope(),
        onCallEvent: (event) => events.push(event),
      });

      expect(result.status).toBe('completed');
      expect(result.text).toBe('ok');
      expect(existsSync(markerPath)).toBe(true);
      expect(ledger.snapshot()).toMatchObject({
        dispatchCount: 1,
        claimedAttemptIds: [attemptId],
      });
      expect(events[0]).toMatchObject({
        type: 'call_started',
        attemptId,
        envelope: envelope(),
      });
    },
  );

  itUnix('refuses at the operation ceiling and invokes the subprocess zero times', async () => {
    const markerPath = join(shimDir, 'spawned');
    installClaudeNodeShim(
      shimDir,
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'spawned')`,
    );
    const ledger = createLedger(1);
    expect(ledger.claimDispatch(createTaskCompilationAttemptId()).kind).toBe('claimed');
    const events: RunnerCallEvent[] = [];

    await expect(
      runClaude({
        attemptId: createTaskCompilationAttemptId(),
        ledger,
        envelope: envelope(),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ kind: 'task_compiler_dispatch_limit' });

    expect(existsSync(markerPath)).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ dispatchCount: 1 });
    expect(runnerCallErrors(events)[0]).toMatchObject({
      status: 'refused',
      error: { code: 'task_compiler_dispatch_limit' },
    });
  });
});
