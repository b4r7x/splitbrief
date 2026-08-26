import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { runClaudeOneShot as runClaudeOneShotImpl } from './invoke.js';
import { DEFAULT_PROCESS_LINE_MAX_BYTES } from '../../../lib/process/spawn/lifecycle.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallEvent } from '../../calls/types.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import {
  replayRunnerCallEventsIntoOperations,
  runnerCallErrors,
  runnerCallTerminals,
} from '#testing/helpers/runner-call-events.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import {
  installClaudeNodeShim,
  installClaudeRecordingShim,
  installClaudeShim,
} from '#testing/helpers/claude-cli-shim.js';

let shimDir: string;
let projectDir: string;
let restorePath: () => void;
let originalAnthropicApiKey: string | undefined;
let originalOpenAiApiKey: string | undefined;

beforeEach(() => {
  shimDir = createTempDir('claude-runner-shim');
  projectDir = createTempDir('claude-runner-project');
  restorePath = prependPath(shimDir);
  originalAnthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  originalOpenAiApiKey = process.env['OPENAI_API_KEY'];
});

afterEach(() => {
  restorePath();
  if (originalAnthropicApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = originalAnthropicApiKey;
  if (originalOpenAiApiKey === undefined) delete process.env['OPENAI_API_KEY'];
  else process.env['OPENAI_API_KEY'] = originalOpenAiApiKey;
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

function runClaudeOneShot(
  opts: Parameters<typeof runClaudeOneShotImpl>[0],
): ReturnType<typeof runClaudeOneShotImpl> {
  return runClaudeOneShotImpl({ ...opts, executable: trustedClaudeExecutable() });
}

describe('runClaudeOneShot', () => {
  it('does not inherit ambient credentials when no spawn environment is supplied', async () => {
    const envFile = `${shimDir}/auth-env.txt`;
    installClaudeNodeShim(
      shimDir,
      `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(envFile)}, [process.env.ANTHROPIC_API_KEY ?? '', process.env.OPENAI_API_KEY ?? ''].join('|'));
process.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\\n');`,
    );
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-canary';
    process.env['OPENAI_API_KEY'] = 'openai-canary';

    await runClaudeOneShot({
      prompt: 'p',
      projectDir,
      authChannel: 'session',
      onOutput: () => {},
    });

    expect(readFileSync(envFile, 'utf8')).toBe('|');
  });

  it('returns text and usage from the result event', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"reply"}]}}',
      '{"type":"result","result":"reply","usage":{"input_tokens":3,"output_tokens":1}}',
    ]);

    const result = await runClaudeOneShot({
      prompt: 'hi',
      projectDir,
      onOutput: () => {},
    });

    expect(result.text).toBe('reply');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it('streams text chunks to onOutput in order they arrive', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"one "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"two "}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"three"}]}}',
      '{"type":"result","result":"one two three"}',
    ]);

    const chunks: string[] = [];
    await runClaudeOneShot({
      prompt: 'p',
      projectDir,
      onOutput: (text) => chunks.push(text),
    });

    const streamed = chunks.join('');
    expect(streamed).toContain('one ');
    expect(streamed).toContain('two ');
    expect(streamed).toContain('three');
    expect(streamed.indexOf('one')).toBeLessThan(streamed.indexOf('two'));
    expect(streamed.indexOf('two')).toBeLessThan(streamed.indexOf('three'));
  });

  it('rejects before spawning when no trusted executable identity is supplied', async () => {
    const markerFile = `${shimDir}/started`;
    installClaudeNodeShim(
      shimDir,
      `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'started');
process.stdout.write(JSON.stringify({ type: 'result', result: 'unexpected' }) + '\\n');`,
    );
    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudeOneShotImpl({
        prompt: 'p',
        projectDir,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ kind: 'cli-executable-untrusted' });
    expect(existsSync(markerFile)).toBe(false);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(runnerCallErrors(events)).toHaveLength(1);
    expect(replayRunnerCallEventsIntoOperations(events).active).toBeNull();
  });

  it('rejects without spawning when the signal is already aborted', async () => {
    installClaudeShim(shimDir, ['{"type":"result","result":"should not run"}']);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir,
        onOutput: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });

  it('passes effort as an --effort argv flag and leaves stdin as the raw prompt', async () => {
    const { argvFile, stdinFile } = installClaudeRecordingShim(shimDir);

    await runClaudeOneShot({
      prompt: 'escalate me',
      projectDir,
      onOutput: () => {},
      effort: 'xhigh',
    });

    const argv = readFileSync(argvFile, 'utf8').split('\n');
    const stdin = readFileSync(stdinFile, 'utf8');

    const effortIdx = argv.indexOf('--effort');
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(argv[effortIdx + 1]).toBe('xhigh');
    expect(stdin).not.toContain('/effort');
    expect(stdin.startsWith('escalate me')).toBe(true);
  });

  it('surfaces an is_error result as a failure even when claude exits 0', async () => {
    installClaudeShim(shimDir, [
      '{"type":"result","is_error":true,"result":"Credit balance is too low"}',
    ]);

    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir,
        onOutput: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      message: expect.stringContaining('Credit balance is too low'),
    });
  });

  it('emits one call_error when the stream contains no result event', async () => {
    installClaudeShim(shimDir, [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);

    const chunks: string[] = [];
    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir,
        onOutput: (text) => chunks.push(text),
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      message: expect.stringContaining('without a terminal event'),
    });
    expect(chunks.join('')).toContain('partial');
    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'incomplete',
      error: { code: 'missing_terminal_event' },
      partial: true,
    });
    const operations = replayRunnerCallEventsIntoOperations(events);
    expect(operations.active).toBeNull();
    expect(operations.last).toMatchObject({
      callId: errors[0]?.callId,
      status: 'incomplete',
      reason: 'Runner call ended without a terminal event',
      partial: true,
    });
  });

  it('reports an oversized terminal result line as an output-budget breach', async () => {
    installClaudeNodeShim(
      shimDir,
      `
const result = "x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100});
process.stdout.write(JSON.stringify({ type: "result", result }) + "\\n");
`,
    );

    const events: RunnerCallEvent[] = [];
    await expect(
      runClaudeOneShot({
        prompt: 'p',
        projectDir,
        onOutput: () => {},
        onCallEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({
      state: 'output-budget-breach',
      remediation: expect.stringContaining('output budget'),
    });

    const errors = runnerCallErrors(events);
    expect(runnerCallTerminals(events)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: 'truncated',
      error: { code: 'stdout_line_overflow' },
    });
  });
});
