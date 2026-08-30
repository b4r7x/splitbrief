import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { runnerCallErrors } from '#testing/helpers/runner-call-events.js';
import { invokeCommandBasedRunner } from './command-based.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

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
    callId: 'command-based-envelope',
    role: 'planner',
    backendKind: 'shell',
    runnerName: 'fixture',
    envelope: env,
  };
}

// A teardown pauses stdout before the pipe drains, so a pid written there can be lost;
// the wall-clock teardown tests publish it to a file, and their bound has to clear this
// script's own node boot to reach that write.
const descendantScript = (body: string) =>
  [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });",
    body,
    'setInterval(() => {}, 60_000);',
  ].join('');

let pidDir: string;

describe('command-based envelope enforcement', () => {
  beforeEach(() => {
    pidDir = createTempDir('command-based-envelope');
  });

  afterEach(async () => {
    await killAllProcesses();
    cleanupTempDir(pidDir);
  });

  itUnix(
    'reaps the tree on a plain-path normalized breach and stays terminally truncated',
    async () => {
      const descendantPid = { current: 0 };
      const program = descendantScript(
        `process.stdout.write('descendant:' + child.pid + '\\n');process.stdout.write('x'.repeat(12 * 1024) + '\\n');`,
      );
      const env = envelope({ maxNormalizedOutputBytes: 8 * 1024 });

      const result = await invokeCommandBasedRunner({
        command: process.execPath,
        args: ['-e', program],
        prompt: '',
        projectDir: process.cwd(),
        callContext: contextWith(env),
        onOutput: (text) => {
          const match = /descendant:(\d+)/.exec(text);
          if (match?.[1] !== undefined) descendantPid.current = Number.parseInt(match[1], 10);
        },
      });

      expect(result.callResult).toMatchObject({
        status: 'truncated',
        partial: true,
        error: { code: 'task_compiler_output_limited' },
      });
      expect(result.callResult.warnings).toContainEqual(
        expect.objectContaining({ code: 'task_compiler_output_limited' }),
      );
      expect(descendantPid.current).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid.current)).toBe(true);
    },
    30_000,
  );

  itUnix(
    'reaps the tree on a structured-path normalized breach and stays terminally truncated',
    async () => {
      const descendantPid = { current: 0 };
      const program = descendantScript(
        [
          "const emit = (text) => process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\\n');",
          "emit('descendant:' + child.pid);",
          "for (let i = 0; i < 60; i += 1) emit('frame-' + i + '-y'.repeat(180));",
        ].join(''),
      );
      const env = envelope({ maxNormalizedOutputBytes: 8 * 1024 });

      const result = await invokeCommandBasedRunner({
        command: process.execPath,
        args: ['-e', program],
        prompt: '',
        projectDir: process.cwd(),
        callContext: contextWith(env),
        outputFormat: 'stream-json',
        onOutput: (text) => {
          const match = /descendant:(\d+)/.exec(text);
          if (match?.[1] !== undefined) descendantPid.current = Number.parseInt(match[1], 10);
        },
      });

      expect(result.callResult).toMatchObject({
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
    'latches the raw bound from stderr while normalized output stays under its own bound',
    async () => {
      const descendantPid = { current: 0 };
      const program = descendantScript(
        `process.stdout.write('descendant:' + child.pid + '\\n');for (let i = 0; i < 100; i += 1) process.stderr.write('d'.repeat(100) + '\\n');`,
      );
      const env = envelope({
        maxRawProtocolBytes: 8 * 1024,
        maxStderrBytes: 64 * 1024,
        maxNormalizedOutputBytes: 96 * 1024,
      });

      const result = await invokeCommandBasedRunner({
        command: process.execPath,
        args: ['-e', program],
        prompt: '',
        projectDir: process.cwd(),
        callContext: contextWith(env),
        onOutput: (text) => {
          const match = /descendant:(\d+)/.exec(text);
          if (match?.[1] !== undefined) descendantPid.current = Number.parseInt(match[1], 10);
        },
      });

      expect(result.callResult).toMatchObject({
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
    'clamps the hard deadline to the envelope and reaps the tree',
    async () => {
      const pidFile = join(pidDir, 'deadline-descendant.pid');
      const events: RunnerCallEvent[] = [];
      const program = descendantScript(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));setInterval(() => process.stdout.write('chatty\\n'), 2);`,
      );
      const env = envelope({ deadlineMs: 2_000 });
      const startedAt = Date.now();

      await expect(
        invokeCommandBasedRunner({
          command: process.execPath,
          args: ['-e', program],
          prompt: '',
          projectDir: process.cwd(),
          callContext: contextWith(env),
          onCallEvent: (event) => events.push(event),
        }),
      ).rejects.toMatchObject({ kind: 'command-timeout' });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
      expect(runnerCallErrors(events)).toEqual([expect.objectContaining({ status: 'timeout' })]);
      const descendantPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(descendantPid).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid)).toBe(true);
    },
    30_000,
  );

  itUnix(
    'clamps the idle watchdog to the envelope idle bound and reaps the tree',
    async () => {
      const pidFile = join(pidDir, 'descendant.pid');
      const events: RunnerCallEvent[] = [];
      const program = descendantScript(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      );
      const env = envelope({ idleTimeoutMs: 2_000 });
      const startedAt = Date.now();

      await expect(
        invokeCommandBasedRunner({
          command: process.execPath,
          args: ['-e', program],
          prompt: '',
          projectDir: process.cwd(),
          callContext: contextWith(env),
          onCallEvent: (event) => events.push(event),
        }),
      ).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
      expect(runnerCallErrors(events)).toEqual([
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ code: 'runner_idle_timeout' }),
        }),
      ]);
      const descendantPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(descendantPid).toBeGreaterThan(1);
      expect(processIsAbsent(descendantPid)).toBe(true);
    },
    30_000,
  );

  itUnix(
    'never lets a later clean exit clear a latched envelope breach',
    async () => {
      const env = envelope({ maxNormalizedOutputBytes: 8 * 1024 });

      const result = await invokeCommandBasedRunner({
        command: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(12 * 1024));"],
        prompt: '',
        projectDir: process.cwd(),
        callContext: contextWith(env),
      });

      expect(result.callResult).toMatchObject({
        status: 'truncated',
        partial: true,
        error: { code: 'task_compiler_output_limited' },
      });
      expect(result.callResult.warnings).toContainEqual(
        expect.objectContaining({ code: 'task_compiler_output_limited' }),
      );
    },
    30_000,
  );
});
