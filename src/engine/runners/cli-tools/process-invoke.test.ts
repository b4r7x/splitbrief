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
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../../core/schemas/task-compilation.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { RUNNER_CALL_STDERR_MAX_BYTES } from '../../calls/output-limit.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPromptTransport,
  CliProtocolEvent,
} from './contract.js';
import {
  CLI_RAW_OUTPUT_MAX_BYTES,
  CLI_RAW_PROTOCOL_MAX_EVENTS,
  invokeProcessCli,
} from './process-invoke.js';
import { runnerCallOutcome } from '../../implementers/pipeline/call-result.js';
import { codexImplementerAdapter } from './codex.js';
import { opencodeImplementerAdapter, opencodeProtocolEvents } from './opencode.js';
import { toCliEnvironment } from '../invoke-cli-adapter.js';
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

function contextWithEnvelope(env: TaskCompilationCallEnvelope): RunnerCallContext {
  return { ...callContext, envelope: env };
}

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
        args: ['<PROMPT>'],
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
      {
        type: 'result',
        status: 'failed',
        text: '',
        usage: null,
        nativeSessionId: null,
        error: { code: 'opencode-error', message: `UnknownError: ${detail}` },
        partial: true,
      },
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

  it('terminates a protocol stream that exceeds the raw event budget', async () => {
    const script = [
      `const line='TEXT:'+Buffer.from('d').toString('base64')+'\\n'`,
      `const block=line.repeat(1_000)`,
      `for(let i=0;i<${CLI_RAW_PROTOCOL_MAX_EVENTS / 1_000 + 1};i++)process.stdout.write(block)`,
    ].join(';');

    const result = await run(adapter({ kind: 'stdin' }), invocation({ script, timeoutMs: 60_000 }));

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'output-budget-breach', message: 'CLI protocol event budget was exceeded' },
    });
  }, 60_000);

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
    expect(aborted).toMatchObject({ status: 'aborted', error: { code: 'user-abort' } });
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
        error: { code: 'cli-executable-identity-drift' },
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

    expect(result).toMatchObject({ status: 'timeout', error: { code: 'timeout' } });
    expect(result.error?.message).toContain(CLI_TOOL_CATALOG.codex.id);
    expect(result.error?.message).not.toContain(realpathSync(process.execPath));
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
        for (let attempt = 0; attempt < 50 && !existsSync(startedPath); attempt += 1) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        expect(existsSync(startedPath)).toBe(true);
        controller.abort();
        expect(await pending).toMatchObject({ status: 'aborted', error: { code: 'user-abort' } });
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
        expect(existsSync(markerPath)).toBe(false);
      });
    },
  );

  it('classifies a raw-protocol overflow as the envelope limit while normalized output stays under', async () => {
    const noiseFrames = 700;
    const script = [
      "const line='NOISE:'+'x'.repeat(100)+'\\n'",
      `setTimeout(()=>{for(let i=0;i<${noiseFrames};i++)process.stdout.write(line)},10)`,
      'setInterval(()=>{},1000)',
    ].join(';');
    const env = envelope({ maxRawProtocolBytes: 64 * 1024 });

    const result = await invokeProcessCli(adapter({ kind: 'stdin' }), {
      invocation: invocation({ script, timeoutMs: 60_000 }),
      prompt: '',
      callContext: contextWithEnvelope(env),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'task_compiler_output_limited' },
    });
    expect(result.text).toBe('');
  }, 60_000);

  it('latches a cumulative normalized overflow that a later terminal cannot clear', async () => {
    const frames = 3_000;
    const script = [
      'const frames=[]',
      `for(let i=0;i<${frames};i++)frames.push('TEXT:'+Buffer.from('delta '.repeat(8)).toString('base64'))`,
      "frames.push('RESULT:'+Buffer.from('final answer').toString('base64'))",
      "process.stdout.write(frames.join('\\n')+'\\n')",
      'setInterval(()=>{},1000)',
    ].join(';');
    const env = envelope({ maxNormalizedOutputBytes: 96 * 1024 });

    const result = await invokeProcessCli(adapter({ kind: 'stdin' }), {
      invocation: invocation({ script, timeoutMs: 60_000 }),
      prompt: '',
      callContext: contextWithEnvelope(env),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'task_compiler_output_limited' },
    });
    expect(result.text).not.toBe('final answer');
  }, 60_000);

  it('stays truncated after a completed terminal record follows a latched overflow', async () => {
    const frames = 3_000;
    const script = [
      'const frames=[]',
      `for(let i=0;i<${frames};i++)frames.push('TEXT:'+Buffer.from('delta '.repeat(8)).toString('base64'))`,
      "frames.push('RESULT:'+Buffer.from('final answer').toString('base64'))",
      "process.stdout.write(frames.join('\\n')+'\\n')",
    ].join(';');
    const env = envelope({ maxNormalizedOutputBytes: 96 * 1024 });

    const result = await invokeProcessCli(adapter({ kind: 'stdin' }), {
      invocation: invocation({ script, timeoutMs: 60_000 }),
      prompt: '',
      callContext: contextWithEnvelope(env),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'task_compiler_output_limited' },
    });
  }, 60_000);
});
