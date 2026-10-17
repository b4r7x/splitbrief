import { taskId } from '../../../core/schemas/task.js';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import {
  createSteeringPort,
  deliverToRunningCall,
  type RunningCall,
  type SteerOutcome,
  type SteerMessage,
} from '../../calls/steering.js';
import { formatMessageInput } from '../../orchestrator/queue/prompt.js';
import { installClaudeSteeringShim } from '#testing/helpers/claude-steering-shim.js';
import { prependPath, writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installOpencodeSteeringShim,
  type OpencodeSteeringShimMode,
} from '#testing/helpers/opencode-steering-shim.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { RUNNER_CALL_STDERR_MAX_BYTES } from '../../calls/output-limit.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPromptTransport,
  CliProtocolEvent,
} from './contract.js';
import { CLI_RAW_OUTPUT_MAX_BYTES, invokeProcessCli } from './process-invoke.js';
import { runnerCallOutcome, runnerOwnWords } from '../../implementers/pipeline/call-result.js';
import { requireCompletedCall } from '../../planners/require-completed-call.js';
import { antigravityImplementerAdapter } from './antigravity.js';
import { claudeCodeImplementerAdapter, claudeCodePlannerAdapter } from './claude-code.js';
import { codexImplementerAdapter } from './codex.js';
import {
  opencodeImplementerAdapter,
  opencodePlannerAdapter,
  opencodeProtocolEvents,
} from './opencode.js';
import { invokeCliAdapter, toCliEnvironment } from '../invoke-cli-adapter.js';
import {
  resolveCliExecutable,
  revalidateCliExecutableIdentity,
} from '../resolve-cli-executable.js';
import { createRunnerSandboxEnv } from '../sandbox-env.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const callContext = {
  callId: 'process-invoke-test',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'fixture',
} satisfies RunnerCallContext;

const completed = {
  type: 'result',
  status: 'completed',
  text: '',
  usage: null,
  nativeSessionId: null,
  error: null,
  partial: false,
} as const satisfies CliProtocolEvent;

const failed = {
  type: 'result',
  status: 'refused',
  text: 'partial answer',
  usage: null,
  nativeSessionId: null,
  error: { code: 'fixture-refusal', message: 'fixture refused' },
  partial: true,
} as const satisfies CliProtocolEvent;

function adapter(
  promptTransport: CliPromptTransport,
  opts: {
    output?: 'structured' | 'text';
    conflicts?: readonly string[];
    validateArgs?:
      | ((input: {
          invocationArgs: readonly string[];
          baseArgs: readonly string[];
        }) => Readonly<{ valid: true }> | Readonly<{ valid: false; conflicts: readonly string[] }>)
      | undefined;
  } = {},
): CliImplementerAdapter {
  const outputContract =
    opts.output === 'text'
      ? ({ kind: 'text-exit', successfulExitCodes: [0, 7] } as const)
      : ({ kind: 'structured-terminal', terminalEvent: 'required' } as const);
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'implementer',
    promptTransport,
    baseArgs: () => [],
    buildArgs: () => [],
    validateArgs:
      opts.validateArgs ??
      (() =>
        opts.conflicts === undefined
          ? { valid: true }
          : { valid: false, conflicts: opts.conflicts }),
    environment: {},
    outputContract,
    parse: (line) => {
      if (opts.output === 'text')
        return line === '' ? [] : [{ type: 'text', channel: 'assistant', text: line } as const];
      if (line === 'RESULT') return [completed];
      if (line === 'ERROR') return [failed];
      // Envelope frames a verbose protocol emits without producing recorded output.
      if (line.startsWith('NOISE:')) return [];
      if (line.startsWith('RESULT:')) {
        return [{ ...completed, text: Buffer.from(line.slice(7), 'base64').toString('utf8') }];
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
      if (opts.output === 'text') {
        const text = events.flatMap((event) => (event.type === 'text' ? [event.text] : []));
        return { ...completed, text: text.join('\n') };
      }
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

function invocation(opts: {
  args?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  promptTransport?: CliPromptTransport;
  script: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  executable?: CliExecutableIdentity;
}): CliInvocation {
  return {
    executable: opts.executable ?? executableIdentity(process.execPath),
    args: ['-e', opts.script, ...(opts.args ?? [])],
    promptTransport: opts.promptTransport ?? { kind: 'stdin' },
    environment: opts.environment ?? {},
    cwd: tmpdir(),
    timeoutMs: opts.timeoutMs ?? 5_000,
    signal: opts.signal,
  };
}

function executableIdentity(candidate: string): CliExecutableIdentity {
  const path = realpathSync(candidate);
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

function missingExecutableIdentity(): CliExecutableIdentity {
  return {
    path: join(tmpdir(), 'splitbrief-fixture-that-does-not-exist'),
    fingerprint: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
  };
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function run(
  selectedAdapter: CliImplementerAdapter,
  selectedInvocation: CliInvocation,
  prompt = '',
  onEvent?: (event: RunnerCallEvent) => void,
  onSpawned?: (process: ChildProcess) => void,
) {
  return invokeProcessCli(selectedAdapter, {
    invocation: selectedInvocation,
    prompt,
    callContext,
    onEvent,
    onSpawned,
  });
}

const emitPromptScript = (source: string) =>
  `const emit=v=>process.stdout.write('TEXT:'+Buffer.from(v).toString('base64')+'\\nRESULT\\n');${source};`;

describe('process steering lifecycle boundary', () => {
  itUnix.each(['timeout', 'abort'] as const)('covers %s during transport startup', async (mode) => {
    const controller = new AbortController();
    let startupSignal: AbortSignal | undefined;
    const selected = adapter({ kind: 'stdin' });
    const result = await invokeProcessCli(
      {
        ...selected,
        steering: {
          supportsVersion: () => true,
          open: async (input) => {
            startupSignal = input.invocation.signal;
            if (mode === 'abort') setTimeout(() => controller.abort(), 10);
            await delay(100, undefined, { signal: startupSignal });
            throw new Error('startup exceeded the call deadline');
          },
        },
      },
      {
        invocation: invocation({
          script: '',
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 10 : 1_000,
        }),
        prompt: 'initial',
        steering: createSteeringPort(),
        callContext,
      },
    );
    expect(result).toMatchObject({ status: mode === 'timeout' ? 'timeout' : 'aborted' });
    expect(startupSignal).not.toBe(controller.signal);
    expect(startupSignal?.aborted).toBe(true);
  });

  itUnix.each(['completion', 'setup'] as const)(
    'records rejected cleanup after %s as one failure',
    async (mode) => {
      const selected = adapter({ kind: 'file', mode: 0o600 });
      const events: RunnerCallEvent[] = [];
      const port = createSteeringPort();
      let promptPath: string | undefined;
      let closed = false;
      const result = await invokeProcessCli(
        {
          ...selected,
          steering: {
            supportsVersion: () => true,
            open: async (input) => {
              input.onReady(async () => 'delivered');
              return {
                invocation: {
                  ...input.invocation,
                  promptTransport: mode === 'setup' ? { kind: 'stdin' } : selected.promptTransport,
                },
                prompt: input.prompt,
                parse: selected.parse,
                onLine: () => false,
                close: async () => {
                  expect(
                    events.some(
                      (event) => event.type === 'call_completed' || event.type === 'call_error',
                    ),
                  ).toBe(false);
                  closed = true;
                  throw new Error('cleanup failed');
                },
              };
            },
          },
        },
        {
          invocation: invocation({
            script: "console.log('RESULT')",
            args: ['<PROMPT>'],
            promptTransport: selected.promptTransport,
          }),
          prompt: 'initial',
          steering: port,
          callContext,
          onSpawned: (proc) => {
            promptPath = proc.spawnargs.at(-1);
          },
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      expect(closed).toBe(true);
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'steering-transport-error', message: 'cleanup failed' },
      });
      expect(events.filter((event) => event.type === 'call_error')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'call_completed')).toHaveLength(0);
      expect(port.current()).toBeNull();
      if (mode === 'completion') {
        expect(promptPath).toBeDefined();
        expect(existsSync(promptPath ?? '')).toBe(false);
      }
    },
  );

  itUnix('keeps the call timeout active during cleanup', async () => {
    const selected = adapter({ kind: 'stdin' });
    let cleanupStarted = false;
    const result = await invokeProcessCli(
      {
        ...selected,
        steering: {
          supportsVersion: () => true,
          open: async (input) => ({
            invocation: input.invocation,
            prompt: input.prompt,
            parse: selected.parse,
            onLine: () => false,
            close: async () => {
              cleanupStarted = true;
              await delay(1_200);
            },
          }),
        },
      },
      {
        invocation: invocation({
          script: "process.stdin.resume(); process.stdin.on('end',()=>console.log('RESULT'))",
          timeoutMs: 1_000,
        }),
        prompt: 'initial',
        steering: createSteeringPort(),
        callContext,
      },
    );
    expect(cleanupStarted).toBe(true);
    expect(result).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
  });
});

function o4DirectEnvelopeExitScript(envelope: string): string {
  const encoded = Buffer.from(envelope, 'utf8').toString('base64');
  return `process.stdout.write(Buffer.from('${encoded}','base64').toString('utf8')+'\\n');process.exitCode=1;`;
}

function opencodeEnvelopeInvocation(envelope: string) {
  return invocation({
    script: o4DirectEnvelopeExitScript(envelope),
    args: ['<PROMPT>'],
    promptTransport: opencodeImplementerAdapter.promptTransport,
  });
}

describe('invokeProcessCli', () => {
  it('transports multibyte prompts losslessly through stdin, argv, and private files', async () => {
    const prompt = `${'🙂漢字'.repeat(12_000)}\nFINAL-SENTINEL-Ω`;
    const stdinResult = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: emitPromptScript(
          "let v='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>emit(v))",
        ),
      }),
      prompt,
    );
    const fileResult = await run(
      adapter({ kind: 'file', mode: 0o600 }),
      invocation({
        promptTransport: { kind: 'file', mode: 0o600 },
        args: ['<PROMPT>'],
        script: emitPromptScript(
          "const fs=require('node:fs');const p=process.argv[1];if((fs.statSync(p).mode&0o777)!==0o600)process.exit(9);const v=fs.readFileSync(p,'utf8');emit(v)",
        ),
      }),
      prompt,
    );
    const argvPrompt = `${'é'.repeat(40_000)}FINAL-SENTINEL`;
    const argvResult = await run(
      adapter({ kind: 'argv', maxBytes: 120_000, placement: 'positional' }),
      invocation({
        promptTransport: { kind: 'argv', maxBytes: 120_000, placement: 'positional' },
        args: ['<PROMPT>'],
        script: emitPromptScript('const v=process.argv[1];emit(v)'),
      }),
      argvPrompt,
    );

    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(120_000);
    expect(stdinResult).toMatchObject({ status: 'completed', text: prompt });
    expect(fileResult).toMatchObject({ status: 'completed', text: prompt });
    expect(argvResult).toMatchObject({ status: 'completed', text: argvPrompt });
  });

  it('fails when a non-reading child closes before a large stdin prompt is delivered', async () => {
    const promptMarker = 'PROMPT-MUST-NOT-APPEAR-IN-DIAGNOSTICS';
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script:
          "require('node:fs').closeSync(0);process.stdout.write('RESULT\\n');setInterval(()=>{},1000)",
      }),
      `${promptMarker}${'x'.repeat(8 * 1024 * 1024)}`,
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'prompt-transport-error' },
    });
    expect(result.error?.message).not.toContain(promptMarker);
  });

  // The limit line is on stderr before the pipe under the prompt breaks; the broken pipe must not
  // turn a seat-switch halt into a planner-call-failed one.
  it('classifies a usage limit printed by a child that exits before reading its stdin prompt', async () => {
    const line =
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s.';
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: `process.stderr.write(${JSON.stringify(`${line}\n`)});process.exit(1)`,
      }),
      'x'.repeat(8 * 1024 * 1024),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'usage-limit', message: line },
    });
    expect(runnerCallOutcome(result).state).toBe('usage-limit');
    let plannerError: unknown;
    try {
      requireCompletedCall(result);
    } catch (err) {
      plannerError = err;
    }
    expect(runnerOwnWords(plannerError)).toBe(line);
  });

  it('rejects transport overflow, malformed placeholders, and configured argument conflicts before spawn', async () => {
    const missingExecutable = missingExecutableIdentity();
    const overflow = await run(
      adapter({ kind: 'argv', maxBytes: 120_000, placement: 'positional' }),
      invocation({
        executable: missingExecutable,
        promptTransport: { kind: 'argv', maxBytes: 120_000, placement: 'positional' },
        args: ['<PROMPT>'],
        script: '',
      }),
      '🙂'.repeat(30_001),
    );
    const placeholder = await run(
      adapter({ kind: 'stdin' }),
      invocation({ executable: missingExecutable, args: ['prefix-<PROMPT>'], script: '' }),
    );
    const conflict = await run(
      adapter({ kind: 'stdin' }, { conflicts: ['--output-format'] }),
      invocation({ executable: missingExecutable, script: '' }),
    );

    expect(overflow.error?.code).toBe('prompt-transport-error');
    expect(placeholder.error?.code).toBe('prompt-transport-error');
    expect(conflict.error?.code).toBe('argument-conflict');
  });

  it('refuses an option-looking prompt only where argv places it positionally', async () => {
    const optionPrompt = '--sandbox danger-full-access';
    const positional = await run(
      adapter({ kind: 'argv', maxBytes: 120_000, placement: 'positional' }),
      invocation({
        executable: missingExecutableIdentity(),
        promptTransport: { kind: 'argv', maxBytes: 120_000, placement: 'positional' },
        args: ['<PROMPT>'],
        script: '',
      }),
      optionPrompt,
    );
    const flagValue = await run(
      adapter({ kind: 'argv', maxBytes: 120_000, placement: 'flag-value' }),
      invocation({
        promptTransport: { kind: 'argv', maxBytes: 120_000, placement: 'flag-value' },
        // `--` keeps node from claiming the fixture's own flag, mirroring a CLI
        // whose prompt fills the value slot of the flag before it.
        args: ['--', '--message', '<PROMPT>'],
        script: emitPromptScript('const v=process.argv[2];emit(v)'),
      }),
      optionPrompt,
    );

    expect(positional).toMatchObject({
      status: 'failed',
      error: { code: 'prompt-transport-error' },
    });
    expect(flagValue).toMatchObject({ status: 'completed', text: optionPrompt });
  });

  it('normalizes adapter validation throws and malformed results before spawning', async () => {
    const markerPath = join(tmpdir(), `splitbrief-prelaunch-${process.pid}.marker`);
    try {
      const throwing = await run(
        adapter(
          { kind: 'stdin' },
          {
            validateArgs: () => {
              throw new Error(`validation leaked ${markerPath}`);
            },
          },
        ),
        invocation({
          script: `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`,
        }),
      );
      const malformed = await run(
        adapter({ kind: 'stdin' }, { validateArgs: () => ({ valid: 'yes' }) as never }),
        invocation({
          script: `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`,
        }),
      );

      expect(throwing).toMatchObject({
        status: 'failed',
        error: { code: 'callback-failure' },
      });
      expect(malformed).toMatchObject({
        status: 'failed',
        error: { code: 'callback-failure' },
      });
      expect(JSON.stringify({ throwing, malformed })).not.toContain(markerPath);
      expect(throwing.error?.message).not.toContain(markerPath);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      try {
        unlinkSync(markerPath);
      } catch {
        // The marker is only a test canary; absence is the assertion above.
      }
    }
  });

  it('turns an onSpawned exception into a reaped callback-failure result', async () => {
    let spawned = false;
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: 'setInterval(()=>{},1000)' }),
      '',
      undefined,
      () => {
        spawned = true;
        throw new Error('prelaunch callback failed');
      },
    );

    expect(spawned).toBe(true);
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'callback-failure' },
    });
  });

  it.each([
    ['output protocol', '--output-format'],
    ['prompt transport', '--prompt'],
    ['permission mode', '--allow-all'],
    ['model policy', '--model'],
    ['terminal behavior', '--terminal-event'],
  ])('rejects a protected %s conflict from the exact invocation argv', async (_name, flag) => {
    const result = await run(
      adapter(
        { kind: 'stdin' },
        {
          validateArgs: ({ invocationArgs }) =>
            invocationArgs.includes(flag) ? { valid: false, conflicts: [flag] } : { valid: true },
        },
      ),
      invocation({
        executable: missingExecutableIdentity(),
        args: [flag],
        script: '',
      }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'argument-conflict', message: expect.stringContaining(flag) },
    });
  });

  it('preserves accepted argument order, quoting, Unicode, and prompt-like values', async () => {
    const acceptedArgs = [
      '--label',
      'two words',
      `quote'"pair`,
      'Zażółć 🙂',
      'Describe how --model affects a prompt',
    ];
    const result = await run(
      adapter(
        { kind: 'stdin' },
        {
          output: 'text',
          validateArgs: ({ invocationArgs }) =>
            invocationArgs.includes('--output-format')
              ? { valid: false, conflicts: ['--output-format'] }
              : { valid: true },
        },
      ),
      invocation({
        args: ['--', ...acceptedArgs],
        script: 'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      }),
    );

    expect(result.status).toBe('completed');
    expect(JSON.parse(result.text)).toEqual(acceptedArgs);
  });

  it('supports structured terminal failures and successful text-by-exit output', async () => {
    const structured = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: "process.stdout.write('ERROR\\n')" }),
    );
    const text = await run(
      adapter({ kind: 'stdin' }, { output: 'text' }),
      invocation({ script: "process.stdout.write('plain output');process.exitCode=7" }),
    );

    expect(structured).toMatchObject({
      status: 'refused',
      text: 'partial answer',
      partial: true,
      error: { code: 'fixture-refusal' },
    });
    expect(text).toMatchObject({ status: 'completed', text: 'plain output' });
  });

  it('surfaces the real Codex failure from its error + turn.failed pair on a non-zero exit', async () => {
    // Captured verbatim from `codex exec --json` (codex-cli 0.146.0): one failed
    // turn is reported as an `error` record, then `turn.failed`, then exit 1.
    const realMessage =
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
    const stream = [
      '{"type":"thread.started","thread_id":"019fd8af-fdab-7f11-a014-29c1de9fe822"}',
      '{"type":"turn.started"}',
      `{"type":"error","message":"${realMessage}"}`,
      `{"type":"turn.failed","error":{"message":"${realMessage}"}}`,
    ].join('\n');
    const encoded = Buffer.from(stream, 'utf8').toString('base64');
    const script = `process.stdout.write(Buffer.from('${encoded}','base64').toString('utf8')+'\\n');process.exitCode=1;`;

    const result = await run(
      codexImplementerAdapter,
      invocation({
        script,
        promptTransport: codexImplementerAdapter.promptTransport,
      }),
      'fixture prompt',
    );

    expect(result).toMatchObject({
      status: 'failed',
      nativeSessionId: '019fd8af-fdab-7f11-a014-29c1de9fe822',
      error: { code: 'codex-turn-failed', message: realMessage },
    });
  });

  it('carries data.message, not the bare exit code', () => {
    const detail = 'Unexpected server error. Check server logs for details.';
    const envelope = JSON.stringify({
      type: 'error',
      error: { name: 'UnknownError', data: { message: detail } },
    });

    expect(opencodeProtocolEvents(envelope)).toEqual([
      { type: 'warning', code: 'opencode-error', message: `UnknownError: ${detail}` },
    ]);
  });

  it('drives usage-limit and unauthenticated classification via runnerCallOutcome', async () => {
    const usageEnvelope = JSON.stringify({
      type: 'error',
      error: { name: 'UnknownError', data: { message: 'Rate limit exceeded' } },
    });
    const authEnvelope = JSON.stringify({
      type: 'error',
      error: {
        name: 'UnknownError',
        data: {
          message:
            'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
        },
      },
    });

    const usageResult = await run(
      opencodeImplementerAdapter,
      opencodeEnvelopeInvocation(usageEnvelope),
      'fixture prompt',
    );
    const authResult = await run(
      opencodeImplementerAdapter,
      opencodeEnvelopeInvocation(authEnvelope),
      'fixture prompt',
    );

    expect(usageResult.error?.message).toBe('UnknownError: Rate limit exceeded');
    expect(runnerCallOutcome(usageResult).state).toBe('usage-limit');
    expect(authResult.error?.message).toContain('log out and sign in again');
    expect(runnerCallOutcome(authResult).state).toBe('unauthenticated');
  });

  it("a text-exit adapter's parsed failed terminal wins over the bare non-zero exit code", async () => {
    // Captured verbatim from `opencode run --format json`: the provider failure
    // arrives as an error envelope on stdout and the process then exits 1.
    const envelope =
      '{"type":"error","timestamp":1786189284110,"sessionID":"ses_01ed27dc5ffeO5NkTAti48djZr","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_1bf036f6"}}}';
    const encoded = Buffer.from(envelope, 'utf8').toString('base64');

    const diagnosed = await run(
      opencodeImplementerAdapter,
      invocation({
        script: `process.stdout.write(Buffer.from('${encoded}','base64').toString('utf8')+'\\n');process.exitCode=1;`,
        args: ['<PROMPT>'],
        promptTransport: opencodeImplementerAdapter.promptTransport,
      }),
      'fixture prompt',
    );
    const undiagnosed = await run(
      adapter({ kind: 'stdin' }, { output: 'text' }),
      invocation({ script: 'process.exitCode=1' }),
    );

    expect(diagnosed).toMatchObject({
      status: 'failed',
      nativeSessionId: 'ses_01ed27dc5ffeO5NkTAti48djZr',
      error: {
        code: 'opencode-error',
        message: 'UnknownError: Unexpected server error. Check server logs for details.',
      },
    });
    expect(undiagnosed.error?.code).toBe('non-zero-exit');
  });

  // Reconstructed from run 2026-10-05-s6-central-checks-and-renders-plus-the-carried-in--3
  // (T006 implementer-6 at 18:35:32Z, T025 implementer-31 at 00:09:55Z) over the line shapes of
  // testing/fixtures/opencode/stream-json.ndjson: a tool step finished, the next provider call
  // failed with an error line, OpenCode retried it and went on streaming. The old adapter ended the
  // call on the error line and dropped its text, so the provider message here is illustrative.
  const OPENCODE_SESSION = 'ses_ef2ac0fd0ffe17uu23hHuymsa3';
  const openCodeLine = (record: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: 1791225332985, sessionID: OPENCODE_SESSION, ...record });
  const stepStart = openCodeLine({ type: 'step_start', part: { type: 'step-start' } });
  const toolStep = [
    stepStart,
    openCodeLine({
      type: 'tool_use',
      part: {
        type: 'tool',
        id: 'call_01_k7a6wkux102lafremdh2e8vw',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'grep -n checkCommandRefusal src/engine/orchestrator/planning' },
          output: '207:export function checkCommandRefusal(',
        },
      },
    }),
    openCodeLine({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'tool-calls',
        tokens: { input: 6071, output: 264, reasoning: 12, cache: { read: 172160, write: 0 } },
      },
    }),
  ];
  const providerError = openCodeLine({
    type: 'error',
    error: {
      name: 'APIError',
      data: { message: 'Upstream stream ended unexpectedly', statusCode: 502, isRetryable: true },
    },
  });
  const handBack =
    'Implemented the refusal check.\n\n{"status":"done","filesChanged":["src/engine/orchestrator/planning/sanitize-discovered-validation.ts"],"touchedNotSuggested":[],"notes":null,"decisions":[]}';
  const finalStep = [
    stepStart,
    openCodeLine({ type: 'text', part: { type: 'text', text: handBack } }),
    openCodeLine({
      type: 'step_finish',
      part: { type: 'step-finish', reason: 'stop', tokens: { input: 1200, output: 310 } },
    }),
  ];
  const opencodeStream = (lines: readonly string[], opts: { exitCode: number; stderr?: string }) =>
    invocation({
      script: [
        `process.stdout.write(Buffer.from('${Buffer.from(`${lines.join('\n')}\n`, 'utf8').toString('base64')}','base64').toString('utf8'))`,
        ...(opts.stderr === undefined
          ? []
          : [`process.stderr.write(${JSON.stringify(opts.stderr)})`]),
        `process.exitCode=${opts.exitCode}`,
      ].join(';'),
      args: ['<PROMPT>'],
      promptTransport: opencodeImplementerAdapter.promptTransport,
    });
  const warningsOf = (events: readonly RunnerCallEvent[]) =>
    events.flatMap((event) => (event.type === 'call_warning' ? [event.warning] : []));

  it('an OpenCode error line followed by more output is a warning with the provider text, and the call completes', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await run(
      opencodeImplementerAdapter,
      opencodeStream([...toolStep, providerError, ...finalStep], { exitCode: 0 }),
      'fixture prompt',
      (event) => events.push(event),
    );

    expect(result).toMatchObject({ status: 'completed', text: handBack, error: null });
    expect(result.nativeSessionId).toBe(OPENCODE_SESSION);
    expect(warningsOf(events)).toContainEqual(
      expect.objectContaining({
        code: 'opencode-error',
        message: 'APIError: Upstream stream ended unexpectedly',
      }),
    );
    expect(JSON.stringify(events)).not.toContain('CLI emitted output after its terminal result');
  });

  it('an OpenCode error line that ends the stream is the call failure in the provider words', async () => {
    const result = await run(
      opencodeImplementerAdapter,
      opencodeStream([...toolStep, providerError], { exitCode: 0 }),
      'fixture prompt',
    );

    expect(result).toMatchObject({
      status: 'failed',
      nativeSessionId: OPENCODE_SESSION,
      error: { code: 'opencode-error', message: 'APIError: Upstream stream ended unexpectedly' },
    });
  });

  // Reconstructed from the same run, T026 implementer-33 at 00:50:18Z: OpenCode printed its whole
  // hand-back (summary and JSON report, 00:50:18.439Z) and exited 1 a tenth of a second later with
  // no error line and no step finish after it.
  it('exit 1 right after a complete OpenCode hand-back keeps the hand-back and warns about the exit', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await run(
      opencodeImplementerAdapter,
      opencodeStream([...toolStep, stepStart, finalStep[1] ?? ''], { exitCode: 1 }),
      'fixture prompt',
      (event) => events.push(event),
    );

    expect(result).toMatchObject({ status: 'completed', text: handBack, error: null });
    expect(warningsOf(events)).toContainEqual(
      expect.objectContaining({
        code: 'non_zero_exit_after_answer',
        message: expect.stringContaining('code 1'),
      }),
    );
  });

  it('exit 1 with no final answer after the last tool call still fails on the exit code', async () => {
    const result = await run(
      opencodeImplementerAdapter,
      opencodeStream(
        [
          stepStart,
          openCodeLine({ type: 'text', part: { type: 'text', text: 'Let me read the files.' } }),
          ...toolStep.slice(1),
        ],
        { exitCode: 1 },
      ),
      'fixture prompt',
    );

    expect(result).toMatchObject({ status: 'failed', error: { code: 'non-zero-exit' } });
  });

  it('exit 1 after a hand-back with a halt line on stderr still halts in the tool words', async () => {
    const line = "You've hit your usage limit. Try again later.";
    const result = await run(
      opencodeImplementerAdapter,
      opencodeStream([...toolStep, stepStart, finalStep[1] ?? ''], {
        exitCode: 1,
        stderr: `${line}\n`,
      }),
      'fixture prompt',
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'usage-limit', message: line },
    });
  });

  it('exit 1 with the codex input-cap refusal on stderr classifies input-too-large, not a bare exit', async () => {
    // Captured live from `codex exec` on 2026-10-05; the halt read "CLI exited with code 1"
    // and offered a retry that rebuilds the same oversized prompt.
    const line =
      'Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1106026}';
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: `process.stderr.write(${JSON.stringify(`${line}\n`)});process.exit(1)`,
      }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'input-too-large', message: line },
    });
    expect(runnerCallOutcome(result).state).toBe('input-too-large');
  });

  it("an is_error result that says 'Prompt is too long' classifies input-too-large, not a result error", async () => {
    // Claude Code's refusal of an oversized final review, captured live on 2026-10-16.
    const frame = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Prompt is too long',
      session_id: 'claude-too-long',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const result = await run(
      claudeCodeImplementerAdapter,
      invocation({
        script: `process.stdout.write(${JSON.stringify(`${frame}\n`)});process.exitCode=1`,
      }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'input-too-large', message: 'Prompt is too long' },
    });
    expect(runnerCallOutcome(result).state).toBe('input-too-large');
  });

  it("exit 1 with 'Not logged in' on stderr classifies unauthenticated", async () => {
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: "process.stderr.write('Not logged in\\n');process.exit(1)" }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'unauthenticated', message: 'Not logged in' },
    });
  });

  it("exit 1 with 'unknown option' on stderr classifies implementer-recipe-invalid", async () => {
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: 'process.stderr.write("error: unknown option \'--yolo\'\\n");process.exit(1)',
      }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'implementer-recipe-invalid', message: "error: unknown option '--yolo'" },
    });
  });

  // The message templates in the claude 2.1.281 binary; the dependency names are illustrative.
  const sandboxReason =
    'sandbox is enabled but dependencies are missing: bubblewrap, socat · install missing tools (e.g. apt install bubblewrap socat) or see https://code.claude.com/docs/en/sandboxing';

  it('exit 1 from a Claude Code sandbox that refuses to start halts on its own line', async () => {
    const line = `Error: sandbox required but unavailable: ${sandboxReason}`;
    const stderr = `\n${line}\n  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n`;
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: `process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`,
      }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'implementer-recipe-invalid', message: line },
    });
  });

  it('a later failure after the unavailable-sandbox warning is not a recipe halt', async () => {
    const stderr = `\n⚠ Sandbox disabled: ${sandboxReason}\n  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n`;
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: `process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`,
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).not.toBe('implementer-recipe-invalid');
  });

  it('exit 3 with the antigravity quota line on stderr classifies usage-limit', async () => {
    // Captured live from `agy -p` (antigravity 1.2.7) on 2026-09-21: the retry after a first
    // hit that exited 0. The synthetic text-exit adapter here has no terminal, so only the
    // stderr tail can name the limit.
    const line =
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h3m48s.';
    const result = await run(
      adapter({ kind: 'stdin' }, { output: 'text' }),
      invocation({
        script: `process.stderr.write(${JSON.stringify(`${line}\n`)});process.exit(3)`,
      }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'usage-limit', message: line },
    });
    expect(runnerCallOutcome(result).state).toBe('usage-limit');
  });

  it('classifies a usage-limit phrase in the tail of stdout, not only stderr', async () => {
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: "process.stdout.write('TEXT:hit your usage limit\\n');process.exit(1)",
      }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'usage-limit', message: 'TEXT:hit your usage limit' },
    });
  });

  it('ignores halt phrases in the transcript above the last stdout line', async () => {
    const transcript = [
      'TEXT:wrote src/billing/invoice.ts',
      'TEXT:mkdir .cache: permission denied',
      'TEXT:added the "not logged in" banner to the header',
      'NOISE:turn finished',
    ].join('\n');

    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({
        script: `process.stdout.write(${JSON.stringify(`${transcript}\n`)});process.exit(1)`,
      }),
    );

    expect(result).toMatchObject({ status: 'failed', error: { code: 'non-zero-exit' } });
  });

  it('keeps last-result-wins for restated terminals and fail-closed on contradictory exits', async () => {
    const restated = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: "process.stdout.write('ERROR\\nERROR\\n')" }),
    );
    const contradiction = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: "process.stdout.write('RESULT\\n');process.exitCode=2" }),
    );

    expect(restated).toMatchObject({ status: 'refused', error: { code: 'fixture-refusal' } });
    expect(contradiction).toMatchObject({ status: 'failed', error: { code: 'non-zero-exit' } });
  });

  it.each([
    {
      name: 'spawn-not-found',
      expectedStatus: 'failed',
      expectedCode: 'spawn-not-found',
      invocation: invocation({ executable: missingExecutableIdentity(), script: '' }),
    },
    {
      name: 'non-zero-exit',
      expectedStatus: 'failed',
      expectedCode: 'non-zero-exit',
      invocation: invocation({ script: 'process.exit(23)' }),
    },
    {
      name: 'signal-exit',
      expectedStatus: 'failed',
      expectedCode: 'signal-exit',
      invocation: invocation({ script: "process.kill(process.pid,'SIGTERM')" }),
    },
    {
      name: 'protocol-failure',
      expectedStatus: 'failed',
      expectedCode: 'protocol-failure',
      invocation: invocation({ script: "process.stdout.write('not-protocol\\n')" }),
    },
    {
      name: 'missing-terminal',
      expectedStatus: 'incomplete',
      expectedCode: 'protocol-failure',
      invocation: invocation({ script: '' }),
    },
  ])(
    'maps $name to a stable terminal outcome',
    async ({ invocation: selected, expectedStatus, expectedCode }) => {
      const result = await run(adapter({ kind: 'stdin' }), selected);
      expect(result.status).toBe(expectedStatus);
      expect(result.error?.code).toBe(expectedCode);
    },
  );

  it('completes a long protocol session past the recorded-delta event budget', async () => {
    const deltas = 5_000;
    const script = [
      'const frames=[]',
      `for(let i=0;i<${deltas};i++)frames.push('TEXT:'+Buffer.from('delta '+i).toString('base64'))`,
      "frames.push('RESULT:'+Buffer.from('final answer').toString('base64'))",
      "process.stdout.write(frames.join('\\n')+'\\n')",
    ].join(';');
    const events: RunnerCallEvent[] = [];

    const result = await run(adapter({ kind: 'stdin' }), invocation({ script }), '', (event) =>
      events.push(event),
    );

    expect(result).toMatchObject({ status: 'completed', text: 'final answer' });
    expect(events.filter((event) => event.type === 'call_text_delta').length).toBeGreaterThan(
      4_096,
    );
  }, 20_000);

  it('completes a long protocol session emitting 300 000 small protocol records', async () => {
    const script = [
      "const line='TEXT:'+Buffer.from('d').toString('base64')+'\\n'",
      'const block=line.repeat(1_000)',
      'for(let i=0;i<300;i++)process.stdout.write(block)',
      "process.stdout.write('RESULT:'+Buffer.from('final answer').toString('base64')+'\\n')",
    ].join(';');

    const result = await run(adapter({ kind: 'stdin' }), invocation({ script, timeoutMs: 60_000 }));

    expect(result).toMatchObject({
      status: 'completed',
      text: 'final answer',
    });
    expect(result.error).toBeNull();
  }, 60_000);

  it('skips a 2 MB stdout line with a warning and completes on a valid terminal', async () => {
    const script = [
      "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\n')",
      "process.stdout.write('RESULT:'+Buffer.from('final answer').toString('base64')+'\\n')",
    ].join(';');

    const result = await run(adapter({ kind: 'stdin' }), invocation({ script }));

    expect(result).toMatchObject({
      status: 'completed',
      text: 'final answer',
    });
    expect(
      result.warnings.filter((warning) => warning.code === 'stdout_line_overflow'),
    ).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'reports fatal output-budget breach only after reaping the producer group',
    async () => {
      const promptMarker = 'OUTPUT-BUDGET-PROMPT-MUST-STAY-PRIVATE';
      const credential = 'output-budget-credential-must-stay-private';
      const events: RunnerCallEvent[] = [];
      let leaderPid = 0;
      let descendantPid = 0;
      let aliveBeforeTerminal: { leader: boolean; descendant: boolean } | undefined;
      let absentAtCallError: { leader: boolean; descendant: boolean } | undefined;
      const noiseFrames = Math.ceil(CLI_RAW_OUTPUT_MAX_BYTES / 1_000_000) + 2;
      const script = [
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'})",
        "const pids=String(process.pid)+':'+String(child.pid)",
        "process.stdout.write('TEXT:'+Buffer.from(pids).toString('base64')+'\\n')",
        "const frame='NOISE:'+'x'.repeat(999_993)+'\\n'",
        `setTimeout(()=>{for(let i=0;i<${noiseFrames};i++)process.stdout.write(frame)},25)`,
      ].join(';');
      const result = await run(
        adapter({ kind: 'stdin' }),
        invocation({ script, environment: { OPENAI_API_KEY: credential }, timeoutMs: 60_000 }),
        promptMarker,
        (event) => {
          events.push(event);
          if (event.type === 'call_text_delta') {
            const [leader, descendant] = event.text.split(':');
            leaderPid = Number.parseInt(leader ?? '', 10);
            descendantPid = Number.parseInt(descendant ?? '', 10);
            aliveBeforeTerminal = {
              leader: !processIsAbsent(leaderPid),
              descendant: !processIsAbsent(descendantPid),
            };
          }
          if (event.type === 'call_error' && event.error.code === 'output-budget-breach') {
            absentAtCallError = {
              leader: processIsAbsent(leaderPid),
              descendant: processIsAbsent(descendantPid),
            };
          }
        },
      );

      expect(result).toMatchObject({
        status: 'truncated',
        error: { code: 'output-budget-breach' },
      });
      expect(leaderPid).toBeGreaterThan(1);
      expect(descendantPid).toBeGreaterThan(1);
      expect(aliveBeforeTerminal).toEqual({ leader: true, descendant: true });
      expect(absentAtCallError).toEqual({ leader: true, descendant: true });
      expect({
        leader: processIsAbsent(leaderPid),
        descendant: processIsAbsent(descendantPid),
      }).toEqual({ leader: true, descendant: true });
      expect(JSON.stringify({ result, events })).not.toContain(promptMarker);
      expect(JSON.stringify({ result, events })).not.toContain(credential);
    },
    60_000,
  );

  it('distinguishes timeout, user abort, and callback failure', async () => {
    const timeout = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: 'setInterval(()=>{},1000)', timeoutMs: 30 }),
    );
    const controller = new AbortController();
    const abortedPromise = run(
      adapter({ kind: 'stdin' }),
      invocation({ script: 'setInterval(()=>{},1000)', signal: controller.signal }),
    );
    controller.abort();
    const aborted = await abortedPromise;
    const callback = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: "process.stdout.write('RESULT\\n')" }),
      '',
      (event) => {
        if (event.type === 'call_completed') throw new Error('consumer failed');
      },
    );

    expect(timeout).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
    expect(aborted).toMatchObject({ status: 'aborted', error: { code: 'runner_interrupted' } });
    expect(callback).toMatchObject({ status: 'failed', error: { code: 'callback-failure' } });
  });

  it('never emits a selected credential from success, failure, abort, or timeout output', async () => {
    const credential = 'opaque-cli-credential-canary-7d93c612';
    const environment = { OPENAI_API_KEY: credential };
    const outcomes: Array<{ result: Awaited<ReturnType<typeof run>>; events: RunnerCallEvent[] }> =
      [];

    const successEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        adapter({ kind: 'stdin' }),
        invocation({
          environment,
          script:
            "const v=process.env.OPENAI_API_KEY;process.stdout.write('TEXT:'+Buffer.from(v).toString('base64')+'\\nRESULT\\n')",
        }),
        '',
        (event) => successEvents.push(event),
      ),
      events: successEvents,
    });

    const failureEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        adapter({ kind: 'stdin' }),
        invocation({
          environment,
          script: "process.stderr.write('fatal debug '+process.env.OPENAI_API_KEY);process.exit(2)",
        }),
        '',
        (event) => failureEvents.push(event),
      ),
      events: failureEvents,
    });

    const abortController = new AbortController();
    const abortEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        adapter({ kind: 'stdin' }),
        invocation({
          environment,
          signal: abortController.signal,
          script:
            "process.stderr.write('debug '+process.env.OPENAI_API_KEY);setInterval(()=>{},1000)",
        }),
        '',
        (event) => {
          abortEvents.push(event);
          if (event.type === 'call_stderr_delta') abortController.abort();
        },
      ),
      events: abortEvents,
    });

    const timeoutEvents: RunnerCallEvent[] = [];
    outcomes.push({
      result: await run(
        adapter({ kind: 'stdin' }),
        invocation({
          environment,
          timeoutMs: 30,
          script:
            "process.stderr.write('debug '+process.env.OPENAI_API_KEY);setInterval(()=>{},1000)",
        }),
        '',
        (event) => timeoutEvents.push(event),
      ),
      events: timeoutEvents,
    });

    expect(outcomes.map(({ result }) => result.status)).toEqual([
      'completed',
      'failed',
      'aborted',
      'timeout',
    ]);
    const persisted = JSON.stringify(outcomes);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });

  it('redacts credentials read from a bridged CLI state file before callbacks and persistence', async () => {
    await withTempDir('splitbrief-state-redaction-host', async (hostHome) => {
      await withTempDir('splitbrief-state-redaction-project', async (projectDir) => {
        const credential = 'bridged-state-process-canary-2c71';
        mkdirSync(join(hostHome, '.codex'), { recursive: true });
        writeFileSync(
          join(hostHome, '.codex', 'auth.json'),
          JSON.stringify({ token: credential, account: 'selected-account' }),
        );
        const previousHome = process.env.HOME;
        process.env.HOME = hostHome;
        try {
          const sandboxEnv = await createRunnerSandboxEnv(
            projectDir,
            { kind: 'cli', tool: 'codex', authChannel: 'session' },
            'implementer',
          );
          const events: RunnerCallEvent[] = [];
          const result = await run(
            adapter({ kind: 'stdin' }),
            invocation({
              environment: toCliEnvironment(sandboxEnv),
              script:
                "const fs=require('node:fs');const path=require('node:path');const token=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.codex','auth.json'),'utf8')).token;process.stdout.write('TEXT:'+Buffer.from(token).toString('base64')+'\\nRESULT\\n');process.stderr.write('state='+token)",
            }),
            '',
            (event) => events.push(event),
          );

          const persisted = JSON.stringify({ result, events });
          expect(result.status).toBe('completed');
          expect(persisted).not.toContain(credential);
          expect(persisted).toContain('***REDACTED***');
        } finally {
          if (previousHome === undefined) delete process.env.HOME;
          else process.env.HOME = previousHome;
        }
      });
    });
  });

  it('rejects output after a terminal result and bounds stderr diagnostics', async () => {
    const ordered = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: "process.stdout.write('RESULT\\nTEXT:bGF0ZQ==\\n')" }),
    );
    const diagnosticEvents: RunnerCallEvent[] = [];
    const diagnostics = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script: `process.stderr.write('fatal '.repeat(20_000));process.exit(2)` }),
      '',
      (event) => diagnosticEvents.push(event),
    );
    const stderrBytes = diagnosticEvents
      .filter((event) => event.type === 'call_stderr_delta')
      .reduce((bytes, event) => bytes + Buffer.byteLength(event.text, 'utf8'), 0);

    expect(ordered).toMatchObject({ status: 'failed', error: { code: 'protocol-failure' } });
    expect(stderrBytes).toBeLessThanOrEqual(RUNNER_CALL_STDERR_MAX_BYTES);
    expect(diagnostics.warnings.some((warning) => warning.code === 'stderr_diagnostic')).toBe(true);
  });

  // G-23 synthetic strictness: the structured-terminal guard keeps a warning the CLI emitted
  // before its result and rejects one that trails the result, so a later warning is neither
  // recorded nor shown. The observed custom-stream sequence is still unproven live; the
  // text-exit path is covered in spawn-collect.test.ts.
  itUnix('rejects a warning frame after the terminal result and keeps one before it', async () => {
    const warningFrame = JSON.stringify({
      type: 'system',
      subtype: 'model_fallback',
      original_model: 'claude-opus-5-5',
      fallback_model: 'claude-sonnet-5',
      trigger: 'overloaded',
    });
    const resultFrame = JSON.stringify({ type: 'result', result: 'done' });
    const script = (lines: readonly string[]) =>
      lines.map((line) => `process.stdout.write(${JSON.stringify(line)}+'\\n');`).join('');

    const retainedEvents: RunnerCallEvent[] = [];
    const retained = await run(
      claudeCodeImplementerAdapter,
      invocation({ script: script([warningFrame, resultFrame]) }),
      '',
      (event) => retainedEvents.push(event),
    );
    const trailingEvents: RunnerCallEvent[] = [];
    const trailing = await run(
      claudeCodeImplementerAdapter,
      invocation({ script: script([resultFrame, warningFrame]) }),
      '',
      (event) => trailingEvents.push(event),
    );

    expect(retained).toMatchObject({ status: 'completed' });
    expect(retainedEvents).toContainEqual(
      expect.objectContaining({
        type: 'call_warning',
        warning: expect.objectContaining({
          code: 'claude_fallback',
          originalModel: 'claude-opus-5-5',
          fallbackModel: 'claude-sonnet-5',
        }),
      }),
    );
    expect(trailing).toMatchObject({ status: 'failed', error: { code: 'protocol-failure' } });
    expect(
      trailingEvents.some(
        (event) => event.type === 'call_warning' && event.warning.code === 'claude_fallback',
      ),
    ).toBe(false);
  });

  it('rejects executable identity drift immediately before spawn without exposing its path', async () => {
    await withTempDir('splitbrief-cli-identity', async (dir) => {
      const executablePath = join(dir, 'fixture');
      const markerPath = `${executablePath}.ran`;
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const trustedIdentity = executableIdentity(executablePath);
      writeFileSync(executablePath, '#!/bin/sh\ntouch "$0.ran"\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);

      const result = await run(
        adapter({ kind: 'stdin' }),
        invocation({ executable: trustedIdentity, script: '' }),
      );

      expect(result).toMatchObject({
        status: 'failed',
        error: {
          code: 'cli-executable-identity-drift',
          message:
            'OpenAI Codex CLI changed after SPLITBRIEF checked it, for example in an update. Try again checks it again.',
        },
      });
      expect(result.error?.message).not.toContain(trustedIdentity.path);
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  itUnix('blocks a metadata-preserving replacement at invocation without spawning it', async () => {
    await withTempDir('splitbrief-cli-digest-identity', async (dir) => {
      const executablePath = join(dir, 'fixture');
      const markerPath = `${executablePath}.ran`;
      const original = '#!/bin/sh\n:     "$0.ran"\nexit 0\n';
      const replacement = '#!/bin/sh\ntouch "$0.ran"\nexit 0\n';
      expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(replacement));
      writeFileSync(executablePath, original, { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const fixedTime = new Date(1_700_000_000_000);
      utimesSync(executablePath, fixedTime, fixedTime);
      const trustedIdentity = await resolveCliExecutable({
        command: executablePath,
        projectDir: process.cwd(),
      });
      const before = statSync(executablePath);

      writeFileSync(executablePath, replacement, { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      utimesSync(executablePath, fixedTime, fixedTime);
      const after = statSync(executablePath);

      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await revalidateCliExecutableIdentity(trustedIdentity)).toBe('drift');

      const result = await run(
        adapter({ kind: 'stdin' }),
        invocation({ executable: trustedIdentity, script: '' }),
      );

      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'cli-executable-identity-drift' },
      });
      expect(result.error?.message).not.toContain(executablePath);
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  it('names the tool, not the resolved executable path, when a silent runner is killed', async () => {
    const result = await invokeProcessCli(adapter({ kind: 'stdin' }), {
      invocation: invocation({ script: 'setTimeout(() => {}, 5_000);' }),
      prompt: '',
      callContext,
      idle: { warnMs: 10, killMs: 40 },
    });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'no-progress-cut' } });
    expect(result.error?.message).toContain(CLI_TOOL_CATALOG.codex.id);
    expect(result.error?.message).not.toContain(realpathSync(process.execPath));
  });

  describe('opt-in seat limits on a review call', () => {
    const reviewContext = { ...callContext, role: 'review' } satisfies RunnerCallContext;
    const unbounded = (script: string): CliInvocation => ({
      ...invocation({ script }),
      timeoutMs: undefined,
    });

    it('completes a call with no timeout and no idle kill after it falls silent past the warning', async () => {
      const events: RunnerCallEvent[] = [];
      const result = await invokeCliAdapter({
        adapter: adapter({ kind: 'stdin' }),
        invocation: unbounded("setTimeout(()=>process.stdout.write('RESULT\\n'),600)"),
        prompt: '',
        callContext: reviewContext,
        onCallEvent: (event) => events.push(event),
        idle: { warnMs: 50 },
      });

      expect(result).toMatchObject({ status: 'completed' });
      const watchdog = events
        .map((event) => event.type)
        .filter((type) => type === 'call_stalled' || type === 'call_stall_cleared');
      expect(watchdog).toEqual(['call_stalled', 'call_stall_cleared']);
    });

    it('ends a silent call at an explicit timeout', async () => {
      const result = await invokeCliAdapter({
        adapter: adapter({ kind: 'stdin' }),
        invocation: { ...unbounded('setInterval(()=>{},1000)'), timeoutMs: 100 },
        prompt: '',
        callContext: reviewContext,
        idle: { warnMs: 50 },
      });

      expect(result).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
    });

    it('ends a silent call at an explicit idle kill', async () => {
      const result = await invokeCliAdapter({
        adapter: adapter({ kind: 'stdin' }),
        invocation: unbounded('setInterval(()=>{},1000)'),
        prompt: '',
        callContext: reviewContext,
        idle: { warnMs: 50, killMs: 150 },
      });

      expect(result).toMatchObject({ status: 'failed', error: { code: 'no-progress-cut' } });
    });
  });

  it.skipIf(process.platform === 'win32')('awaits process-group reaping after abort', async () => {
    const controller = new AbortController();
    let descendantPid = 0;
    const script = [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      "process.stdout.write('TEXT:'+Buffer.from(String(child.pid)).toString('base64')+'\\n')",
      'setInterval(()=>{},1000)',
    ].join(';');
    const result = await run(
      adapter({ kind: 'stdin' }),
      invocation({ script, signal: controller.signal }),
      '',
      (event) => {
        if (event.type !== 'call_text_delta') return;
        descendantPid = Number.parseInt(event.text, 10);
        controller.abort();
      },
    );

    expect(result.status).toBe('aborted');
    expect(descendantPid).toBeGreaterThan(1);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'aborts a real CLI process and reaps its descendant before returning',
    async () => {
      await withTempDir('splitbrief-cli-abort', async (directory) => {
        const startedPath = join(directory, 'descendant-started.txt');
        const markerPath = join(directory, 'descendant-alive.txt');
        const childScript = `require('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 1000);`;
        const parentScript = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
        const controller = new AbortController();
        const pending = run(
          adapter({ kind: 'stdin' }),
          invocation({ script: parentScript, signal: controller.signal }),
          'Zażółć gęślą jaźń — 日本語 🧪',
        );
        for (let attempt = 0; attempt < 250 && !existsSync(startedPath); attempt += 1) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        expect(existsSync(startedPath)).toBe(true);
        controller.abort();
        expect(await pending).toMatchObject({
          status: 'aborted',
          error: { code: 'runner_interrupted' },
        });
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
        expect(existsSync(markerPath)).toBe(false);
      });
    },
  );
});

describe('invokeProcessCli antigravity stream-json liveness', () => {
  const FIXTURE = join(
    import.meta.dirname,
    '../../../../testing/fixtures/antigravity/stream-json.ndjson',
  );
  // The idle clock starts at spawn, so the warn threshold has to clear the shim's own start-up
  // as well as the gaps under test — and start-up is what a loaded four-worker run stretches.
  // The gaps keep their ratio to it: the streaming case sits far below, the stall case far above.
  const idle = { warnMs: 2_000, killMs: 10_000 };

  async function replay(dir: string, body: string, onEvent: (event: RunnerCallEvent) => void) {
    const shimPath = join(dir, 'agy');
    writeFileSync(shimPath, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    chmodSync(shimPath, 0o755);
    return invokeProcessCli(antigravityImplementerAdapter, {
      invocation: {
        executable: executableIdentity(shimPath),
        args: ['<PROMPT>'],
        promptTransport: antigravityImplementerAdapter.promptTransport,
        environment: { PATH: process.env.PATH ?? '' },
        cwd: dir,
        timeoutMs: 15_000,
        signal: undefined,
      },
      prompt: 'fixture prompt',
      callContext,
      idle,
      onEvent,
    });
  }

  itUnix(
    'streams tool steps as delta then done, and every frame resets the idle clock',
    async () => {
      await withTempDir('splitbrief-agy-stream', async (dir) => {
        const events: RunnerCallEvent[] = [];
        // 0.4 s gaps stay under a quarter of the warn threshold while the 13-frame replay outlasts
        // twice the threshold, so only a clock that every frame resets stays quiet.
        const script = `while IFS= read -r line; do printf '%s\\n' "$line"; sleep 0.4; done < ${JSON.stringify(FIXTURE)}`;
        const started = Date.now();
        const result = await replay(dir, script, (event) => events.push(event));

        expect(Date.now() - started).toBeGreaterThanOrEqual(2 * idle.warnMs);
        expect(result).toMatchObject({
          status: 'completed',
          text: 'OK\n',
          nativeSessionId: '50328626-c5df-4301-9da7-dee7ce900271',
        });
        const deltaIds = events.flatMap((event) =>
          event.type === 'call_tool_use_delta' ? [event.toolUseId] : [],
        );
        const doneIds = events.flatMap((event) =>
          event.type === 'call_tool_use_done' ? [event.toolUse.id] : [],
        );
        expect(deltaIds).toEqual(['step-2', 'step-4', 'step-6']);
        expect(doneIds).toEqual(deltaIds);
        for (const id of deltaIds) {
          const started = events.findIndex(
            (event) => event.type === 'call_tool_use_delta' && event.toolUseId === id,
          );
          const done = events.findIndex(
            (event) => event.type === 'call_tool_use_done' && event.toolUse.id === id,
          );
          expect(started).toBeLessThan(done);
        }
        expect(events.filter((event) => event.type === 'call_stalled')).toHaveLength(0);
      });
    },
  );

  itUnix('reports one stall when a frame is followed by three seconds of silence', async () => {
    await withTempDir('splitbrief-agy-stall', async (dir) => {
      const events: RunnerCallEvent[] = [];
      const fixture = JSON.stringify(FIXTURE);
      const script = `head -n 1 ${fixture}\nsleep 3\ntail -n 1 ${fixture}`;
      const result = await replay(dir, script, (event) => events.push(event));

      expect(result.status).toBe('completed');
      expect(events.filter((event) => event.type === 'call_stalled')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'call_stall_cleared')).toHaveLength(1);
    });
  });

  itUnix(
    'keeps a call whose tool-start frames outgrow the tool-delta budget completed',
    async () => {
      await withTempDir('splitbrief-agy-flood', async (dir) => {
        const events: RunnerCallEvent[] = [];
        const floodPath = join(dir, 'flood.cjs');
        // Seventeen 64 KiB start frames pass the 1 MiB tool-delta budget; the call itself is healthy.
        writeFileSync(
          floodPath,
          [
            "const parameters = { CodeContent: 'x'.repeat(64 * 1024) };",
            'for (let step = 0; step < 17; step += 1) {',
            "  const update = { conversation_id: 'c-1', step_index: step, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters } };",
            "  process.stdout.write(JSON.stringify({ event: 'step_update', step_update: update }) + '\\n');",
            '}',
            "process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK\\n' } }) + '\\n');",
          ].join('\n'),
        );
        const result = await replay(dir, `exec node ${JSON.stringify(floodPath)}`, (event) =>
          events.push(event),
        );

        expect(result.status).toBe('completed');
        expect(
          events.filter(
            (event) =>
              event.type === 'call_warning' &&
              event.warning.code === 'runner_call_tool_delta_limit',
          ),
        ).toHaveLength(1);
      });
    },
  );
});

describe('invokeProcessCli tool-use guard', () => {
  // The step agy streamed at 2026-09-23 when it searched the whole home directory.
  const ESCAPING_STEP = JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'c-1',
      step_index: 6,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'find /Users/alice -name "process-invoke.ts" 2>/dev/null' },
      },
    },
  });

  itUnix('stops the call at the guarded tool use and reaps the process group', async () => {
    await withTempDir('splitbrief-tool-guard', async (dir) => {
      const markerPath = join(dir, 'still-running.txt');
      const shimPath = join(dir, 'agy');
      // The shim holds the call open after the step, and a descendant would write the marker a
      // second later: the guard must end both, not wait for the tool to finish.
      writeFileSync(
        shimPath,
        [
          '#!/bin/bash',
          `(sleep 1; echo alive > ${JSON.stringify(markerPath)}) &`,
          `printf '%s\\n' ${JSON.stringify(ESCAPING_STEP)}`,
          'sleep 30',
        ].join('\n'),
        { mode: 0o755 },
      );
      const seen: string[] = [];
      const started = Date.now();
      const result = await invokeProcessCli(antigravityImplementerAdapter, {
        invocation: {
          executable: executableIdentity(shimPath),
          args: ['<PROMPT>'],
          promptTransport: antigravityImplementerAdapter.promptTransport,
          environment: { PATH: process.env.PATH ?? '' },
          cwd: dir,
          timeoutMs: 20_000,
          signal: undefined,
        },
        prompt: 'fixture prompt',
        callContext,
        toolUseGuard: (toolUse) => {
          seen.push(toolUse.name);
          return { code: 'implementer-left-isolation', message: `stopped ${toolUse.name}` };
        },
      });

      expect(Date.now() - started).toBeLessThan(10_000);
      expect(seen).toEqual(['run_command']);
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'implementer-left-isolation', message: 'stopped run_command' },
      });
      expect(result.toolUses).toEqual([]);
      expect(runnerCallOutcome(result).state).toBe('implementer-left-isolation');
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  itUnix('lets a call whose tool uses pass the guard complete', async () => {
    const FIXTURE = join(
      import.meta.dirname,
      '../../../../testing/fixtures/antigravity/stream-json.ndjson',
    );
    await withTempDir('splitbrief-tool-guard-pass', async (dir) => {
      const shimPath = join(dir, 'agy');
      writeFileSync(shimPath, `#!/bin/bash\ncat ${JSON.stringify(FIXTURE)}\n`, { mode: 0o755 });
      const result = await invokeProcessCli(antigravityImplementerAdapter, {
        invocation: {
          executable: executableIdentity(shimPath),
          args: ['<PROMPT>'],
          promptTransport: antigravityImplementerAdapter.promptTransport,
          environment: { PATH: process.env.PATH ?? '' },
          cwd: dir,
          timeoutMs: 15_000,
          signal: undefined,
        },
        prompt: 'fixture prompt',
        callContext,
        toolUseGuard: () => null,
      });
      expect(result.status).toBe('completed');
    });
  });

  itUnix('inspects a tool use once when its start and its end carry the same input', async () => {
    const FIXTURE = join(
      import.meta.dirname,
      '../../../../testing/fixtures/antigravity/stream-json.ndjson',
    );
    await withTempDir('splitbrief-tool-guard-once', async (dir) => {
      const shimPath = join(dir, 'agy');
      writeFileSync(shimPath, `#!/bin/bash\ncat ${JSON.stringify(FIXTURE)}\n`, { mode: 0o755 });
      const seen: string[] = [];
      const result = await invokeProcessCli(antigravityImplementerAdapter, {
        invocation: {
          executable: executableIdentity(shimPath),
          args: ['<PROMPT>'],
          promptTransport: antigravityImplementerAdapter.promptTransport,
          environment: { PATH: process.env.PATH ?? '' },
          cwd: dir,
          timeoutMs: 15_000,
          signal: undefined,
        },
        prompt: 'fixture prompt',
        callContext,
        toolUseGuard: (toolUse) => {
          seen.push(toolUse.name);
          return null;
        },
      });
      expect(result.status).toBe('completed');
      expect(seen).toEqual(['run_command', 'run_command', 'view_file']);
    });
  });

  itUnix(
    "inspects Claude Code's finished tool use, whose input its start record lacks",
    async () => {
      // Claude Code opens a tool use with an empty input and states the input when the call ends.
      const stream = [
        {
          type: 'stream_event',
          session_id: 's-1',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          },
        },
        {
          type: 'assistant',
          session_id: 's-1',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls ~' } },
            ],
          },
        },
        { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's-1' },
      ];
      await withTempDir('splitbrief-tool-guard-claude', async (dir) => {
        const streamPath = join(dir, 'stream.ndjson');
        writeFileSync(streamPath, `${stream.map((line) => JSON.stringify(line)).join('\n')}\n`);
        const shimPath = join(dir, 'claude');
        writeFileSync(
          shimPath,
          `#!/bin/bash\ncat > /dev/null\ncat ${JSON.stringify(streamPath)}\n`,
          {
            mode: 0o755,
          },
        );
        const seen: unknown[] = [];
        const result = await invokeProcessCli(claudeCodeImplementerAdapter, {
          invocation: {
            executable: executableIdentity(shimPath),
            args: [],
            promptTransport: claudeCodeImplementerAdapter.promptTransport,
            environment: { PATH: process.env.PATH ?? '' },
            cwd: dir,
            timeoutMs: 15_000,
            signal: undefined,
          },
          prompt: 'fixture prompt',
          callContext,
          toolUseGuard: (toolUse) => {
            seen.push(toolUse.input);
            return null;
          },
        });
        expect(result.status).toBe('completed');
        expect(seen).toEqual([{}, { command: 'ls ~' }]);
      });
    },
  );
});

describe('invokeProcessCli structured-terminal halts on stderr', () => {
  // Captured live from `agy -p` on 2026-09-21.
  const QUOTA_LINE =
    'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s.';

  async function runAgy(
    dir: string,
    output: Readonly<{ stdout?: readonly string[]; stderr?: readonly string[]; exit: number }>,
  ) {
    const shimPath = join(dir, 'agy');
    const body = [
      '#!/bin/bash',
      ...(output.stdout ?? []).map((line) => `printf '%s\\n' ${JSON.stringify(line)}`),
      ...(output.stderr ?? []).map((line) => `printf '%s\\n' ${JSON.stringify(line)} >&2`),
      `exit ${output.exit}`,
    ];
    writeFileSync(shimPath, `${body.join('\n')}\n`, { mode: 0o755 });
    return invokeProcessCli(antigravityImplementerAdapter, {
      invocation: {
        executable: executableIdentity(shimPath),
        args: ['<PROMPT>'],
        promptTransport: antigravityImplementerAdapter.promptTransport,
        environment: { PATH: process.env.PATH ?? '' },
        cwd: dir,
        timeoutMs: 15_000,
        signal: undefined,
      },
      prompt: 'fixture prompt',
      callContext,
    });
  }

  itUnix('halts on the stderr quota line when agy exits 0 without a result frame', async () => {
    await withTempDir('splitbrief-agy-quota-no-result', async (dir) => {
      const result = await runAgy(dir, { stderr: [QUOTA_LINE], exit: 0 });
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'usage-limit', message: QUOTA_LINE },
      });
      expect(runnerCallOutcome(result).state).toBe('usage-limit');
    });
  });

  itUnix(
    'ends incomplete when agy exits 0 without a result frame or stderr diagnosis',
    async () => {
      await withTempDir('splitbrief-agy-no-result', async (dir) => {
        const result = await runAgy(dir, { exit: 0 });
        expect(result).toMatchObject({
          status: 'incomplete',
          error: { code: 'protocol-failure' },
        });
      });
    },
  );

  itUnix('ends incomplete when stdout restates a halt phrase without a result frame', async () => {
    await withTempDir('splitbrief-agy-stdout-halt-phrase', async (dir) => {
      const stepUpdate = JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'c-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'I hit the usage limit.',
        },
      });
      const result = await runAgy(dir, { stdout: [stepUpdate], exit: 0 });
      expect(result).toMatchObject({
        status: 'incomplete',
        error: { code: 'protocol-failure' },
      });
    });
  });

  itUnix.each([0, 3])(
    'replaces uninformative ERROR result frame with stderr quota line on exit %i',
    async (exit) => {
      await withTempDir(`splitbrief-agy-quota-error-result-${exit}`, async (dir) => {
        const errorResult = JSON.stringify({
          event: 'result',
          result: { status: 'ERROR' },
        });
        const result = await runAgy(dir, {
          stdout: [errorResult],
          stderr: [QUOTA_LINE],
          exit,
        });
        expect(result).toMatchObject({
          status: 'failed',
          error: { code: 'usage-limit', message: QUOTA_LINE },
        });
        expect(runnerCallOutcome(result).state).toBe('usage-limit');
      });
    },
  );

  itUnix(
    'keeps a failed terminal that names its own halt over a conflicting stderr line',
    async () => {
      await withTempDir('splitbrief-agy-terminal-names-halt', async (dir) => {
        const quotaResult = JSON.stringify({
          event: 'result',
          result: {
            status: 'ERROR',
            error: "You've hit your usage limit. Try again later.",
          },
        });
        const result = await runAgy(dir, {
          stdout: [quotaResult],
          stderr: ['Error: not logged in'],
          exit: 1,
        });
        expect(result.error?.message).toBe("You've hit your usage limit. Try again later.");
        expect(runnerCallOutcome(result).state).toBe('usage-limit');
      });
    },
  );
});

describe('Claude Code process steering', () => {
  itUnix.each([claudeCodeImplementerAdapter, claudeCodePlannerAdapter])(
    'sends images on stream-json stdin for a non-steering $role call',
    async (selected) => {
      await withTempDir('claude-image-stdin', async (dir) => {
        const imagePath = join(dir, 'shot.data');
        const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
        writeFileSync(imagePath, bytes);
        const images = [
          {
            id: 'shot',
            kind: 'image' as const,
            path: imagePath,
            mimeType: 'image/png',
            sizeBytes: bytes.length,
          },
        ];
        const stdinFile = join(dir, 'stdin.jsonl');
        const argvFile = join(dir, 'argv.json');
        const executable = writeFakeNodeCli(
          dir,
          'claude',
          `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({type:'result', result:'done'}));
});
`,
        );
        const baseArgs = selected.baseArgs({
          prompt: '',
          model: undefined,
          projectDir: dir,
          configuredArgs: [],
          sessionId: null,
          effort: undefined,
          imagePaths: [imagePath],
        });
        const result = await invokeCliAdapter({
          adapter: selected,
          invocation: {
            executable: executableIdentity(executable),
            args: baseArgs,
            baseArgs,
            promptTransport: selected.promptTransport,
            environment: toCliEnvironment(process.env),
            cwd: dir,
            signal: undefined,
            timeoutMs: 5_000,
            images,
          },
          prompt: 'Inspect\nthis screenshot',
          callContext: { ...callContext, role: selected.role },
        });
        expect(result.status).toBe('completed');
        const args = JSON.parse(readFileSync(argvFile, 'utf8'));
        expect(
          args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2),
        ).toEqual(['--input-format', 'stream-json']);
        expect(args).not.toContain('--replay-user-messages');
        expect(readFileSync(stdinFile, 'utf8')).toBe(
          JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'Inspect\nthis screenshot' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: bytes.toString('base64'),
                  },
                },
              ],
            },
          }) + '\n',
        );
      });
    },
  );

  itUnix.each([
    [6, true],
    [900 * 1024, true],
    [900 * 1024, false],
  ] as const)(
    'keeps queued image and text attachments in the live Claude user turn with %i bytes and initial images %s',
    async (size, initialImages) => {
      await withTempDir('claude-steering-attachments', async (dir) => {
        const shim = installClaudeSteeringShim(dir);
        const port = createSteeringPort();
        const imagePath = join(dir, 'shot.png');
        const imageBytes = Buffer.alloc(size, 137);
        writeFileSync(imagePath, imageBytes);
        const images = [
          {
            id: 'shot',
            kind: 'image' as const,
            path: imagePath,
            mimeType: 'image/png',
            sizeBytes: imageBytes.length,
          },
        ];
        const turn: SteerMessage = {
          id: 'attached',
          text: formatMessageInput({ text: 'Use these notes:\nattached text contents', images }),
          images,
          attachedInputs: [
            { kind: 'text', path: '/outside/notes.txt' },
            { kind: 'image', path: imagePath },
          ],
        };
        const baseArgs = claudeCodeImplementerAdapter.baseArgs({
          prompt: '',
          model: undefined,
          projectDir: dir,
          configuredArgs: [],
          imagePaths: initialImages ? [imagePath] : undefined,
        });
        let delivery: Promise<SteerOutcome> | undefined;
        const result = await invokeCliAdapter({
          adapter: claudeCodeImplementerAdapter,
          invocation: {
            executable: executableIdentity(shim.executable),
            args: baseArgs,
            baseArgs,
            promptTransport: { kind: 'stdin' },
            environment: toCliEnvironment(process.env),
            cwd: dir,
            images: initialImages ? images : undefined,
            signal: undefined,
            timeoutMs: 5_000,
          },
          prompt: 'initial',
          installedVersion: '2.1.296',
          steering: port,
          callContext,
          onCallEvent: (event) => {
            if (event.type === 'call_tool_use_delta')
              delivery = deliverToRunningCall(port.current(), turn);
          },
        });
        expect(result.status).toBe('completed');
        expect(await delivery).toBe('delivered');
        const expectedLine = (text: string, hasImages = true) =>
          JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: hasImages
                ? [
                    { type: 'text', text },
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: imageBytes.toString('base64'),
                      },
                    },
                  ]
                : text,
            },
          }) + '\n';
        expect(readFileSync(shim.stdinFile, 'utf8')).toBe(
          expectedLine('initial', initialImages) + expectedLine(turn.text),
        );
      });
    },
  );

  itUnix.each(['tool', 'follow-up', 'repeated'] as const)(
    'acknowledges %s input and keeps the last result',
    async (mode) => {
      await withTempDir('claude-steering', async (dir) => {
        const shim = installClaudeSteeringShim(dir, mode);
        const restorePath = prependPath(dir);
        try {
          let captured: RunningCall | null = null;
          let late: Promise<SteerOutcome> | undefined;
          const port = createSteeringPort({
            onChange: (call) => {
              if (call !== null) captured = call;
              else late = deliverToRunningCall(captured, { id: 'late', text: 'never written' });
            },
          });
          const sends: Promise<SteerOutcome>[] = [];
          let started = false;
          const result = await invokeCliAdapter({
            adapter: claudeCodeImplementerAdapter,
            invocation: {
              executable: executableIdentity(shim.executable),
              args: ['-p'],
              baseArgs: ['-p'],
              promptTransport: { kind: 'stdin' },
              environment: toCliEnvironment(process.env),
              cwd: dir,
              signal: undefined,
              timeoutMs: 5_000,
            },
            installedVersion: '2.1.296',
            steering: port,
            prompt: 'initial',
            callContext: { ...callContext, taskId: taskId('T001') },
            onCallEvent: (event) => {
              if (event.type === 'call_tool_use_delta' && !started) {
                started = true;
                expect(port.current()).toMatchObject({
                  callId: callContext.callId,
                  role: 'implementer',
                  taskId: 'T001',
                });
                sends.push(deliverToRunningCall(port.current(), { id: 'one', text: 'same' }));
                if (mode === 'repeated')
                  sends.push(deliverToRunningCall(port.current(), { id: 'two', text: 'same' }));
              }
            },
          });
          expect(result.status).toBe('completed');
          expect(result.text).toBe('last');
          expect(result).toMatchObject({ structured: { answer: 'last' } });
          expect(result.usage).toMatchObject(
            mode === 'follow-up'
              ? { inputTokens: 13, outputTokens: 12 }
              : { inputTokens: 10, outputTokens: 5 },
          );
          expect(await Promise.all(sends)).toEqual(
            mode === 'repeated' ? ['delivered', 'delivered'] : ['delivered'],
          );
          expect(await late).toBe('deferred');
          expect(port.current()).toBeNull();
          const input = readFileSync(shim.stdinFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line).message.content);
          expect(input).toEqual(
            mode === 'repeated' ? ['initial', 'same', 'same'] : ['initial', 'same'],
          );
          expect(JSON.parse(readFileSync(shim.argvFile, 'utf8'))).toEqual([
            '-p',
            '--input-format',
            'stream-json',
            '--replay-user-messages',
          ]);
        } finally {
          restorePath();
        }
      });
    },
  );

  itUnix.each(['exit', 'abort', 'unsolicited'] as const)(
    'settles sends and detaches on %s',
    async (mode) => {
      await withTempDir('claude-steering-close', async (dir) => {
        const shim = installClaudeSteeringShim(dir, mode);
        const port = createSteeringPort();
        const controller = new AbortController();
        const sends: Promise<SteerOutcome>[] = [];
        let started = false;
        const result = await invokeProcessCli(claudeCodeImplementerAdapter, {
          invocation: {
            executable: executableIdentity(shim.executable),
            args: ['-p'],
            promptTransport: { kind: 'stdin' },
            environment: toCliEnvironment(process.env),
            cwd: dir,
            signal: controller.signal,
            timeoutMs: 5_000,
          },
          installedVersion: '2.1.296',
          steering: port,
          prompt: 'initial',
          callContext,
          onEvent: (event) => {
            if (event.type === 'call_tool_use_delta' && !started) {
              started = true;
              sends.push(deliverToRunningCall(port.current(), { id: 'one', text: 'one' }));
              if (mode === 'abort') {
                sends.push(deliverToRunningCall(port.current(), { id: 'two', text: 'two' }));
                controller.abort();
              }
            }
          },
        });
        expect(await Promise.all(sends)).toEqual(
          mode === 'unsolicited'
            ? ['delivered']
            : mode === 'abort'
              ? ['uncertain', 'uncertain']
              : ['uncertain'],
        );
        expect(result.status).toBe(
          mode === 'abort' ? 'aborted' : mode === 'exit' ? 'incomplete' : 'failed',
        );
        if (mode === 'unsolicited')
          expect(result.error).toMatchObject({ code: 'protocol-failure' });
        expect(port.current()).toBeNull();
      });
    },
  );

  itUnix.each([
    { version: '2.1.296', hasPort: false },
    { version: '2.1.295', hasPort: true },
    { version: undefined, hasPort: true },
    { version: 'unknown', hasPort: true },
  ])(
    'keeps one-shot stdin with version $version and port $hasPort',
    async ({ version, hasPort }) => {
      await withTempDir('claude-one-shot', async (dir) => {
        const shim = installClaudeSteeringShim(dir);
        const port = createSteeringPort();
        const result = await invokeProcessCli(claudeCodeImplementerAdapter, {
          invocation: {
            executable: executableIdentity(shim.executable),
            args: ['-p'],
            promptTransport: { kind: 'stdin' },
            environment: toCliEnvironment(process.env),
            cwd: dir,
            signal: undefined,
            timeoutMs: 5_000,
          },
          installedVersion: version,
          steering: hasPort ? port : undefined,
          prompt: 'plain\ntext',
          callContext,
        });
        expect(result.status).toBe('completed');
        expect(readFileSync(shim.stdinFile, 'utf8')).toBe('plain\ntext');
        expect(JSON.parse(readFileSync(shim.argvFile, 'utf8'))).toEqual(['-p']);
        expect(port.current()).toBeNull();
      });
    },
  );
});

describe('OpenCode process steering', () => {
  function setup(dir: string, mode: OpencodeSteeringShimMode = 'tool') {
    const shim = installOpencodeSteeringShim(dir, mode);
    const home = join(dir, 'sandbox-home');
    mkdirSync(home);
    const port = createSteeringPort();
    const events: RunnerCallEvent[] = [];
    const run = (
      opts: {
        role?: 'planner' | 'implementer' | 'review';
        version?: string;
        steering?: boolean;
        signal?: AbortSignal;
        timeoutMs?: number;
        onEvent?: (event: RunnerCallEvent) => void;
        onSpawned?: (proc: ChildProcess) => void;
        parserFailure?: boolean;
      } = {},
    ) => {
      const role = opts.role ?? 'implementer';
      const selected = role === 'implementer' ? opencodeImplementerAdapter : opencodePlannerAdapter;
      const input = {
        prompt: '<PROMPT>',
        model: 'provider/model',
        variant: 'high',
        projectDir: dir,
        configuredArgs: ['--title=fixture'],
        installedVersion: opts.version ?? '2.0.26',
        mode: 'plan' as const,
        sessionId: null,
        effort: undefined,
      };
      const baseArgs = selected.baseArgs(input);
      return invokeProcessCli(
        opts.parserFailure
          ? {
              ...selected,
              steering:
                selected.steering === undefined
                  ? undefined
                  : {
                      ...selected.steering,
                      open: async (value) => {
                        const session = await selected.steering?.open(value);
                        if (session === undefined) throw new Error('steering missing');
                        return {
                          ...session,
                          parse: (line) => {
                            if (JSON.parse(line).type === 'error')
                              throw new Error('invalid protocol');
                            return session.parse(line);
                          },
                        };
                      },
                    },
            }
          : selected,
        {
          invocation: {
            executable: executableIdentity(shim.executable),
            args: selected.buildArgs(input),
            baseArgs,
            promptTransport: selected.promptTransport,
            environment: {
              ...toCliEnvironment(process.env),
              HOME: home,
              PATH: `${dir}:${process.env['PATH'] ?? ''}`,
            },
            cwd: dir,
            signal: opts.signal,
            timeoutMs: opts.timeoutMs ?? 8_000,
          },
          prompt: 'initial',
          installedVersion: input.installedVersion,
          ...(opts.steering !== false && { steering: port }),
          callContext: { ...callContext, role },
          onSpawned: opts.onSpawned,
          onEvent: (event) => {
            events.push(event);
            opts.onEvent?.(event);
          },
        },
      );
    };
    const assertReaped = (file: string) => {
      const { pid } = JSON.parse(readFileSync(file, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    };
    return { shim, port, events, run, home, assertReaped };
  }

  itUnix('defers OpenCode image attachments while delivering a following text turn', async () => {
    await withTempDir('opencode-steering-attachments', async (dir) => {
      const fixture = setup(dir);
      const images = [
        {
          id: 'shot',
          kind: 'image' as const,
          path: '/outside/shot.png',
          mimeType: 'image/png',
          sizeBytes: 8,
        },
      ];
      const turn: SteerMessage = {
        id: 'attached',
        text: formatMessageInput({ text: 'Use these notes:\nattached text contents', images }),
        images,
        attachedInputs: [
          { kind: 'text', path: '/outside/notes.txt' },
          { kind: 'image', path: '/outside/shot.png' },
        ],
      };
      let delivery: Promise<SteerOutcome> | undefined;
      let textDelivery: Promise<SteerOutcome> | undefined;
      const result = await fixture.run({
        onEvent: (event) => {
          if (event.type === 'call_tool_use_delta') {
            delivery = deliverToRunningCall(fixture.port.current(), turn);
            textDelivery = deliverToRunningCall(fixture.port.current(), {
              id: 'text',
              text: 'Continue the current task.',
            });
          }
        },
      });
      expect(result.status, JSON.stringify(result.error)).toBe('completed');
      expect(await delivery).toBe('deferred');
      expect(await textDelivery).toBe('delivered');
      expect(JSON.parse(readFileSync(fixture.shim.requestsFile, 'utf8'))).toEqual({
        text: 'Continue the current task.',
        delivery: 'steer',
      });
      fixture.assertReaped(fixture.shim.serverFile);
    });
  });

  itUnix.each(['planner', 'implementer', 'review'] as const)(
    'delivers during a tool step for %s and redacts the password',
    async (role) => {
      await withTempDir('opencode-steering', async (dir) => {
        const fixture = setup(dir);
        let captured: RunningCall | null = null;
        let delivery: Promise<SteerOutcome> | undefined;
        const result = await fixture.run({
          role,
          onEvent: (event) => {
            if (event.type !== 'call_tool_use_delta') return;
            captured = fixture.port.current();
            expect(captured).toMatchObject({ role, callId: callContext.callId });
            delivery = deliverToRunningCall(captured, { id: 'mid', text: 'PINEAPPLE' });
          },
        });
        expect(await delivery).toBe('delivered');
        expect(result.status).toBe('completed');
        expect(result.text).toContain('PINEAPPLE');
        expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
        expect(result.nativeSessionId).toBe('ses-steering');
        expect(JSON.stringify({ result, events: fixture.events })).not.toContain(
          fixture.shim.password,
        );
        expect(fixture.events.filter((event) => event.type === 'call_started')).toHaveLength(1);
        const run = JSON.parse(readFileSync(fixture.shim.captureFile, 'utf8'));
        const server = JSON.parse(readFileSync(fixture.shim.serverFile, 'utf8'));
        expect(run.args).toContain('--server');
        expect(run.args).not.toContain('--standalone');
        expect(run.password).toBe(fixture.shim.password);
        expect(run.args).not.toContain(fixture.shim.password);
        expect(server.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0']);
        expect(run.home).toBe(fixture.home);
        expect(server.home).toBe(fixture.home);
        expect(realpathSync(run.cwd)).toBe(realpathSync(dir));
        expect(realpathSync(server.cwd)).toBe(realpathSync(dir));
        expect(JSON.parse(readFileSync(fixture.shim.requestsFile, 'utf8'))).toEqual({
          text: 'PINEAPPLE',
          delivery: 'steer',
        });
        expect(fixture.port.current()).toBeNull();
        expect(await deliverToRunningCall(captured, { id: 'late', text: 'too late' })).toBe(
          'deferred',
        );
        fixture.assertReaped(fixture.shim.captureFile);
        fixture.assertReaped(fixture.shim.serverFile);
      });
    },
  );

  itUnix(
    'posts another message while the first still awaits consumption, preserving FIFO',
    async () => {
      await withTempDir('opencode-repeated', async (dir) => {
        const fixture = setup(dir, 'repeated');
        const deliveries: Promise<SteerOutcome>[] = [];
        const result = await fixture.run({
          onEvent: (event) => {
            if (event.type !== 'call_tool_use_delta') return;
            for (const id of ['first', 'second']) {
              deliveries.push(deliverToRunningCall(fixture.port.current(), { id, text: 'same' }));
            }
          },
        });
        expect(result.status).toBe('completed');
        expect(result.text).toContain('same|same');
        expect(await Promise.all(deliveries)).toEqual(['delivered', 'delivered']);
        fixture.assertReaped(fixture.shim.serverFile);
      });
    },
  );

  itUnix.each([
    ['late', 'uncertain'],
    ['unconsumed', 'uncertain'],
    ['reject', 'deferred'],
    ['disconnect', 'uncertain'],
  ] as const)('settles %s admission as %s', async (mode, outcome) => {
    await withTempDir('opencode-admission', async (dir) => {
      const fixture = setup(dir, mode);
      let delivery: Promise<SteerOutcome> | undefined;
      const result = await fixture.run({
        onEvent: (event) => {
          if (event.type === 'call_tool_use_delta') {
            delivery = deliverToRunningCall(fixture.port.current(), { id: 'one', text: 'steer' });
          }
        },
      });
      expect(result.status).toBe('completed');
      expect(await delivery).toBe(outcome);
      expect(fixture.port.current()).toBeNull();
      fixture.assertReaped(fixture.shim.captureFile);
      fixture.assertReaped(fixture.shim.serverFile);
    });
  });

  itUnix.each(['no-url', 'no-password', 'serve-exit'] as const)(
    'fails clearly and reaps a sidecar with %s',
    async (mode) => {
      await withTempDir('opencode-startup', async (dir) => {
        const fixture = setup(dir, mode);
        const result = await fixture.run();
        expect(result).toMatchObject({
          status: 'failed',
          error: { code: 'steering-transport-error' },
        });
        expect(result.error?.message).toContain('OpenCode sidecar');
        expect(JSON.stringify(result)).not.toContain(fixture.shim.password);
        expect(existsSync(fixture.shim.captureFile)).toBe(false);
        fixture.assertReaped(fixture.shim.serverFile);
      });
    },
  );

  itUnix.each(['abort', 'timeout', 'protocol-failure', 'server-exit'] as const)(
    'reaps both processes and settles pending sends on %s',
    async (mode) => {
      await withTempDir('opencode-cleanup', async (dir) => {
        const fixture = setup(dir, mode === 'timeout' ? 'abort' : mode);
        const controller = new AbortController();
        let delivery: Promise<SteerOutcome> | undefined;
        const running = fixture.run({
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 750 : 8_000,
          parserFailure: mode === 'protocol-failure',
          onEvent: (event) => {
            if (event.type === 'call_tool_use_delta') {
              delivery = deliverToRunningCall(fixture.port.current(), {
                id: 'pending',
                text: 'steer',
              });
            }
          },
        });
        if (mode === 'abort') {
          await vi.waitFor(() => expect(existsSync(fixture.shim.requestsFile)).toBe(true));
          controller.abort();
        }
        const result = await running;
        expect(result.status).toBe(
          mode === 'abort' ? 'aborted' : mode === 'timeout' ? 'timeout' : 'failed',
        );
        expect(await delivery).toBe('uncertain');
        expect(fixture.port.current()).toBeNull();
        fixture.assertReaped(fixture.shim.captureFile);
        fixture.assertReaped(fixture.shim.serverFile);
      });
    },
  );

  itUnix('redacts a password repeated in a provider failure', async () => {
    await withTempDir('opencode-error-secret', async (dir) => {
      const fixture = setup(dir, 'error-secret');
      const result = await fixture.run();
      expect(result.status).toBe('failed');
      expect(JSON.stringify({ result, events: fixture.events })).not.toContain(
        fixture.shim.password,
      );
      fixture.assertReaped(fixture.shim.serverFile);
    });
  });

  itUnix('aborts and reaps a sidecar while waiting for its startup lines', async () => {
    await withTempDir('opencode-startup-abort', async (dir) => {
      const fixture = setup(dir, 'no-url');
      const controller = new AbortController();
      const running = fixture.run({ signal: controller.signal });
      await vi.waitFor(() => expect(existsSync(fixture.shim.serverFile)).toBe(true));
      controller.abort();
      expect((await running).status).toBe('aborted');
      expect(existsSync(fixture.shim.captureFile)).toBe(false);
      fixture.assertReaped(fixture.shim.serverFile);
    });
  });

  itUnix('times out and reaps a sidecar while waiting for its startup lines', async () => {
    await withTempDir('opencode-startup-timeout', async (dir) => {
      const fixture = setup(dir, 'no-url');
      const result = await fixture.run({ timeoutMs: 500 });
      expect(result).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
      expect(existsSync(fixture.shim.captureFile)).toBe(false);
      fixture.assertReaped(fixture.shim.serverFile);
    });
  });

  itUnix.each([
    { steering: false, version: '2.0.26' },
    { steering: true, version: '1.9.9' },
    { steering: true, version: 'unknown' },
  ])('preserves the existing invocation with %j', async (opts) => {
    await withTempDir('opencode-one-shot', async (dir) => {
      const fixture = setup(dir);
      const result = await fixture.run(opts);
      expect(result.status).toBe('completed');
      expect(result.text).toBe('standalone');
      const run = JSON.parse(readFileSync(fixture.shim.captureFile, 'utf8'));
      const expected =
        opts.version === '2.0.26'
          ? [
              'run',
              '--standalone',
              '--model',
              'provider/model#high',
              '--format',
              'json',
              '--agent',
              'build',
              'initial',
              '--title=fixture',
            ]
          : [
              'run',
              '--model',
              'provider/model',
              '--variant',
              'high',
              '--format',
              'json',
              '--agent',
              'build',
              'initial',
              '--title=fixture',
            ];
      expect(run.args).toEqual(expected);
      expect(run.password).toBeUndefined();
      expect(existsSync(fixture.shim.serverFile)).toBe(false);
      expect(fixture.port.current()).toBeNull();
    });
  });
});
