import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import {
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_STDERR_MAX_BYTES,
} from '../../calls/output-limit.js';
import type { RunnerCallContext, RunnerCallEvent } from '../../calls/types.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPromptTransport,
  CliProtocolEvent,
} from './contract.js';
import { invokeProcessCli } from './process-invoke.js';
import { toCliEnvironment } from '../cli-tools.js';
import { createRunnerSandboxEnv } from '../sandbox-env.js';

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
      | ((
          invocationArgs: readonly string[],
        ) => Readonly<{ valid: true }> | Readonly<{ valid: false; conflicts: readonly string[] }>)
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
      if (opts.output === 'text') return [];
      if (line === 'RESULT') return [completed];
      if (line === 'ERROR') return [failed];
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
    terminal: ({ events, stdout }) => {
      if (opts.output === 'text') return { ...completed, text: stdout };
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
      adapter({ kind: 'argv', maxBytes: 120_000 }),
      invocation({
        promptTransport: { kind: 'argv', maxBytes: 120_000 },
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
      adapter({ kind: 'argv', maxBytes: 120_000 }),
      invocation({
        executable: missingExecutable,
        promptTransport: { kind: 'argv', maxBytes: 120_000 },
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
          validateArgs: (invocationArgs) =>
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
          validateArgs: (invocationArgs) =>
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
  ])('maps $name to a stable terminal outcome', async ({
    invocation: selected,
    expectedStatus,
    expectedCode,
  }) => {
    const result = await run(adapter({ kind: 'stdin' }), selected);
    expect(result.status).toBe(expectedStatus);
    expect(result.error?.code).toBe(expectedCode);
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
      const script = [
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'})",
        "const pids=String(process.pid)+':'+String(child.pid)",
        "process.stdout.write('TEXT:'+Buffer.from(pids).toString('base64')+'\\n')",
        `setTimeout(()=>process.stdout.write('x'.repeat(${RUNNER_CALL_OUTPUT_MAX_BYTES + 2})),25)`,
      ].join(';');
      const result = await run(
        adapter({ kind: 'stdin' }),
        invocation({ script, environment: { OPENAI_API_KEY: credential } }),
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
          const sandboxEnv = await createRunnerSandboxEnv(projectDir, {
            kind: 'cli',
            tool: 'codex',
            authChannel: 'session',
          });
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
});
