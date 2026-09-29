import { chmodSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import {
  CLI_CONFORMANCE_CANDIDATES,
  CODEX_NATIVE_MODEL_CATALOG_PROBE,
  codexImplementerAdapter,
  codexPlannerAdapter,
  codexProtocolEvents,
} from './codex.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { invokeCliAdapter } from '../invoke-cli-adapter.js';
import type { CliProtocolEvent } from './contract.js';

const PROMPT = '<PROMPT>';

function terminalInput(
  adapter: typeof codexPlannerAdapter,
  events: ReturnType<typeof codexProtocolEvents>,
) {
  return adapter.terminal({
    outputContract: adapter.outputContract,
    events,
    stderr: '',
    exitCode: 0,
    signal: null,
  });
}

describe('Codex role adapters', () => {
  it('exports planner then implementer candidates with matching canonical hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('codex');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.rawContract.promptTransport).toBe('stdin');
      expect(candidate.rawContract.rawInvocation).not.toContain(PROMPT);
      expect(candidate.rawContract.rawInvocation.at(-1)).toBe('-');
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG.codex);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps stdin and terminal contracts explicit for both roles', () => {
    expect(codexPlannerAdapter.promptTransport).toEqual({ kind: 'stdin' });
    expect(codexImplementerAdapter.promptTransport).toEqual({ kind: 'stdin' });
    expect(codexPlannerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(codexImplementerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(codexPlannerAdapter.probe.version.command).toEqual(['codex', '--version']);
    expect(codexPlannerAdapter.probe.auth.command).toEqual(['codex', 'login', 'status']);
    expect(CODEX_NATIVE_MODEL_CATALOG_PROBE).toEqual({
      capability: 'debug-models-v2',
      command: ['codex', 'debug', 'models'],
      timeoutMs: 5_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
  });

  it('preserves planner exec/resume, model, cd, escalation, and configured argument order', () => {
    const resumed = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
      mode: 'plan',
      sessionId: 'session-1',
      effort: 'high',
    });
    expect(resumed).toEqual([
      '-c',
      'model_reasoning_effort=high',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      'resume',
      '--model',
      'gpt-5',
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      'session-1',
      '-',
      '--label',
      'fixture',
    ]);
    expect(
      codexPlannerAdapter.validateArgs({ invocationArgs: resumed, baseArgs: resumed.slice(0, -2) }),
    ).toEqual({
      valid: true,
    });

    const readOnly = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    // REQ-017: the fresh planner vector owns global read-only + never
    // approval before `exec`, ignores ambient config/rules, and keeps its thread
    // for the resume that follows.
    expect(readOnly).toEqual([
      '--model',
      'gpt-5',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      '--cd',
      '/project',
      '-',
    ]);

    const escalation = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'escalate',
      sessionId: 'session-1',
      effort: undefined,
    });
    expect(escalation).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      'exec',
      '--ignore-user-config',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/project',
      '-',
    ]);
  });

  it('spends the configured effort as a config override ahead of exec on every vector', () => {
    const seat = {
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: [],
      effort: 'high',
    } as const;
    const vectors = {
      'plan · resumed': codexPlannerAdapter.buildArgs({
        ...seat,
        mode: 'plan',
        sessionId: 'session-1',
      }),
      'plan · fresh': codexPlannerAdapter.buildArgs({ ...seat, mode: 'plan', sessionId: null }),
      escalate: codexPlannerAdapter.buildArgs({ ...seat, mode: 'escalate', sessionId: null }),
      implementer: codexImplementerAdapter.buildArgs(seat),
    };

    for (const [vector, args] of Object.entries(vectors)) {
      expect(args, vector).toContain('-c');
      expect(args[args.indexOf('-c') + 1], vector).toBe('model_reasoning_effort=high');
      expect(args.indexOf('-c'), vector).toBeLessThan(args.indexOf('exec'));
    }
  });

  it('overrides no configuration when the seat spends no effort', () => {
    const seat = {
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: [],
      effort: undefined,
    } as const;
    const vectors = {
      'plan · resumed': codexPlannerAdapter.buildArgs({
        ...seat,
        mode: 'plan',
        sessionId: 'session-1',
      }),
      'plan · fresh': codexPlannerAdapter.buildArgs({ ...seat, mode: 'plan', sessionId: null }),
      escalate: codexPlannerAdapter.buildArgs({ ...seat, mode: 'escalate', sessionId: null }),
      implementer: codexImplementerAdapter.buildArgs(seat),
    };

    for (const [vector, args] of Object.entries(vectors)) {
      expect(args, vector).not.toContain('-c');
      expect(
        args.some((arg) => arg.startsWith('model_reasoning_effort=')),
        vector,
      ).toBe(false);
    }
  });

  it('preserves implementer workspace-write, cd, model, and prompt placement', () => {
    const args = codexImplementerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5.2',
      projectDir: '/staged',
      configuredArgs: ['--label', 'fixture'],
    });
    expect(args).toEqual([
      '--model',
      'gpt-5.2',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      'exec',
      '--ignore-user-config',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/staged',
      '-',
      '--label',
      'fixture',
    ]);
    const base = args.slice(0, -2);
    expect(codexImplementerAdapter.validateArgs({ invocationArgs: args, baseArgs: base })).toEqual({
      valid: true,
    });
    expect(
      codexImplementerAdapter.validateArgs({
        invocationArgs: [...args, '--sandbox', 'danger'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--sandbox'],
    });
    expect(
      codexImplementerAdapter.validateArgs({
        invocationArgs: [...args, 'prefix-<PROMPT>'],
        baseArgs: base,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(
      codexImplementerAdapter.validateArgs({ invocationArgs: [...args, '--json'], baseArgs: base }),
    ).toEqual({
      valid: false,
      conflicts: ['--json'],
    });
  });

  it.each([
    ['--sandbox', 'danger'],
    ['--ask-for-approval', 'full-auto'],
    ['-a', 'plan'],
    ['--ignore-user-config'],
    ['--ignore-rules'],
    ['--ephemeral'],
    ['--output-last-message', '/tmp/out.md'],
    ['--approve-for-me'],
    ['--yolo'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--dangerously-bypass-hook-trust'],
    ['--config', 'custom.toml'],
    ['-c', 'sandbox_mode="danger-full-access"'],
    ['--add-dir', '/elsewhere'],
    ['-C', '/elsewhere'],
    ['-s', 'danger-full-access'],
  ])('rejects the configured authority override %j with zero dispatch', (...tokens) => {
    const base = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    const invocation = [...base, ...tokens];
    const validation = codexPlannerAdapter.validateArgs({
      invocationArgs: invocation,
      baseArgs: base,
    });
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.conflicts.length).toBeGreaterThan(0);
    }
  });
});

describe('Codex stdin prompt transport', () => {
  // Past the 120 000-byte cap of the tools that take the prompt on argv.
  const prompt = `HEAD_SENTINEL ${'x'.repeat(200_000)} 🙂漢字 TAIL_SENTINEL`;
  const seat = {
    prompt: PROMPT,
    model: 'gpt-5',
    projectDir: '/project',
    configuredArgs: [],
    effort: 'low',
  } as const;

  it.each([
    [
      'plan · fresh',
      codexPlannerAdapter,
      codexPlannerAdapter.buildArgs({ ...seat, mode: 'plan', sessionId: null }),
    ],
    [
      'plan · resumed',
      codexPlannerAdapter,
      codexPlannerAdapter.buildArgs({ ...seat, mode: 'plan', sessionId: 'session-1' }),
    ],
    [
      'escalate',
      codexPlannerAdapter,
      codexPlannerAdapter.buildArgs({ ...seat, mode: 'escalate', sessionId: null }),
    ],
    ['implementer', codexImplementerAdapter, codexImplementerAdapter.buildArgs(seat)],
  ] as const)(
    '%s hands the child the whole prompt on stdin and none of it on argv',
    async (_vector, adapter, args) => {
      await withTempDir('splitbrief-codex-stdin', async (dir) => {
        const executablePath = join(dir, 'codex');
        const capturePath = join(dir, 'capture.json');
        writeFileSync(
          executablePath,
          [
            `#!${process.execPath}`,
            "const { writeFileSync } = require('node:fs');",
            'const chunks = [];',
            "process.stdin.on('data', (chunk) => chunks.push(chunk));",
            "process.stdin.on('end', () => {",
            `  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8') }));`,
            "  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-stdin' }));",
            "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STDIN-OK' } }));",
            "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
            '});',
            '',
          ].join('\n'),
          { mode: 0o755 },
        );
        chmodSync(executablePath, 0o755);
        const path = realpathSync(executablePath);
        const info = statSync(path);

        const result = await invokeCliAdapter({
          adapter,
          invocation: {
            executable: {
              path,
              fingerprint: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
            },
            args,
            baseArgs: args,
            promptTransport: adapter.promptTransport,
            environment: {},
            cwd: dir,
            timeoutMs: 10_000,
            signal: undefined,
          },
          prompt,
          callContext: {
            callId: 'codex-stdin',
            role: adapter.role,
            backendKind: 'cli',
            runnerName: 'codex',
          },
        });

        expect(result).toMatchObject({ status: 'completed', text: 'STDIN-OK' });
        const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
          args: string[];
          stdin: string;
        };
        expect(capture.stdin).toBe(prompt);
        expect(capture.args).toEqual(args);
        expect(capture.args.at(-1)).toBe('-');
        expect(capture.args).not.toContain(PROMPT);
      });
    },
  );
});

describe('Codex JSONL protocol adapter', () => {
  it('marks item.started tool items as started and item.completed ones as done', () => {
    expect(
      codexProtocolEvents(
        JSON.stringify({
          type: 'item.started',
          item: { id: 'item_1', type: 'command_execution', command: 'npm test' },
        }),
      ),
    ).toEqual([
      {
        type: 'tool-use',
        stage: 'started',
        id: 'item_1',
        name: 'command_execution',
        input: { command: 'npm test' },
      },
    ]);
    expect(
      codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_1', type: 'command_execution', output: 'ok' },
        }),
      ),
    ).toEqual([
      { type: 'tool-use', id: 'item_1', name: 'command_execution', input: {}, output: 'ok' },
    ]);
  });

  it('carries the paths a file change names as its input', () => {
    expect(
      codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_2',
            type: 'file_change',
            changes: [{ path: '/tmp/probe/src/app.ts', kind: 'update' }],
            status: 'completed',
          },
        }),
      ),
    ).toEqual([
      {
        type: 'tool-use',
        id: 'item_2',
        name: 'file_change',
        input: { changes: [{ path: '/tmp/probe/src/app.ts', kind: 'update' }] },
        output: 'completed',
      },
    ]);
  });

  it('projects session, assistant text, usage, and a required terminal result', () => {
    const events = [
      ...codexProtocolEvents(JSON.stringify({ type: 'thread.started', thread_id: 'session-2' })),
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'hello' },
        }),
      ),
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      ),
    ];
    expect(events).toContainEqual({ type: 'session', nativeSessionId: 'session-2' });
    expect(events).toContainEqual({ type: 'text', channel: 'assistant', text: 'hello' });
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        counterCoverage: {
          input: 'reported',
          output: 'partial',
          cacheRead: 'missing',
          cacheCreate: 'missing',
          reasoning: 'missing',
        },
        providerTotals: { output: 1 },
      },
      semantics: 'final',
    });
    expect(terminalInput(codexPlannerAdapter, events)).toMatchObject({
      type: 'result',
      status: 'completed',
      nativeSessionId: 'session-2',
      error: null,
      partial: false,
    });
  });

  it('carries the real Codex message through the error + turn.failed pair in either order and alone', () => {
    // Captured verbatim from `codex exec --json` (codex-cli 0.146.0) failing a turn.
    const threadLine =
      '{"type":"thread.started","thread_id":"019fd8af-fdab-7f11-a014-29c1de9fe822"}';
    const turnLine = '{"type":"turn.started"}';
    const errorLine =
      '{"type":"error","message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}';
    const failedLine =
      '{"type":"turn.failed","error":{"message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}}';
    const realMessage =
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';

    const captured = [threadLine, turnLine, errorLine, failedLine].flatMap((line) => [
      ...codexProtocolEvents(line),
    ]);
    expect(captured.filter((event) => event.type === 'result')).toHaveLength(2);
    expect(terminalInput(codexPlannerAdapter, captured)).toMatchObject({
      status: 'failed',
      nativeSessionId: '019fd8af-fdab-7f11-a014-29c1de9fe822',
      error: { code: 'codex-turn-failed', message: realMessage },
    });

    const reversed = [threadLine, turnLine, failedLine, errorLine].flatMap((line) => [
      ...codexProtocolEvents(line),
    ]);
    expect(terminalInput(codexPlannerAdapter, reversed)).toMatchObject({
      status: 'failed',
      error: { code: 'codex-error', message: realMessage },
    });

    expect(terminalInput(codexPlannerAdapter, codexProtocolEvents(errorLine))).toMatchObject({
      status: 'failed',
      error: { code: 'codex-error', message: realMessage },
    });
    expect(terminalInput(codexPlannerAdapter, codexProtocolEvents(failedLine))).toMatchObject({
      status: 'failed',
      error: { code: 'codex-turn-failed', message: realMessage },
    });
  });

  it('a double-encoded turn.failed body yields the inner human message as the failure message', () => {
    const humanMessage =
      "The 'gpt-5-totally-bogus-model' model is not supported when using Codex with a ChatGPT account.";
    const envelope = JSON.stringify({
      type: 'error',
      status: 400,
      error: { type: 'invalid_request_error', message: humanMessage },
    });
    const line = JSON.stringify({ type: 'turn.failed', error: { message: envelope } });
    const terminal = terminalInput(codexPlannerAdapter, codexProtocolEvents(line));

    expect(terminal.status).toBe('failed');
    expect(terminal.error).toEqual({
      code: 'codex-turn-failed',
      message: `${humanMessage}\n${envelope}`,
    });
  });

  it('fails explicit turn.failed and malformed required records', () => {
    const failed = codexProtocolEvents(JSON.stringify({ type: 'turn.failed' }));
    expect(terminalInput(codexPlannerAdapter, failed)).toMatchObject({
      status: 'failed',
      error: { code: 'codex-turn-failed' },
    });

    const malformed = codexProtocolEvents('{not-json');
    expect(terminalInput(codexPlannerAdapter, malformed)).toMatchObject({
      status: 'failed',
      error: { code: 'malformed-codex-json' },
    });

    const malformedRequired = codexProtocolEvents(
      JSON.stringify({ type: 'thread.started', thread_id: 42 }),
    );
    expect(terminalInput(codexPlannerAdapter, malformedRequired)).toMatchObject({
      status: 'failed',
      error: { code: 'malformed-codex-record' },
    });
  });

  it('requires a terminal event instead of treating a partial stream as success', () => {
    const events = codexProtocolEvents(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }),
    );
    expect(() => terminalInput(codexPlannerAdapter, events)).toThrow(
      'Codex output ended without a terminal result',
    );
  });

  it('retains unknown additive records as bounded warnings', () => {
    expect(codexProtocolEvents(JSON.stringify({ type: 'future.event', id: 'fixture' }))).toEqual([
      { type: 'warning', code: 'unknown-codex-record', message: 'Unknown Codex record' },
    ]);
  });
});

describe('Codex exact last-message terminal (REQ-013)', () => {
  function turnEvents(input: {
    earlierMessage?: string | undefined;
    toolInput?: string | undefined;
    finalMessage?: string | undefined;
    failed?: boolean | undefined;
  }): CliProtocolEvent[] {
    const events: CliProtocolEvent[] = [
      ...codexProtocolEvents(JSON.stringify({ type: 'thread.started', thread_id: 'session-last' })),
    ];
    if (input.earlierMessage !== undefined) {
      events.push(
        ...codexProtocolEvents(
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: input.earlierMessage },
          }),
        ),
      );
    }
    if (input.toolInput !== undefined) {
      events.push(
        ...codexProtocolEvents(
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'local_shell_exec', input: { command: input.toolInput } },
          }),
        ),
      );
    }
    if (input.finalMessage !== undefined) {
      events.push(
        ...codexProtocolEvents(
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: input.finalMessage },
          }),
        ),
      );
    }
    events.push(
      ...(input.failed === true
        ? codexProtocolEvents(
            JSON.stringify({ type: 'turn.failed', error: { message: 'turn exploded' } }),
          )
        : codexProtocolEvents(JSON.stringify({ type: 'turn.completed' }))),
    );
    return events;
  }

  it('leases exactly the fresh turn final message as terminal content', () => {
    const terminal = terminalInput(
      codexPlannerAdapter,
      turnEvents({
        earlierMessage: 'EARLIER MESSAGE TEXT',
        toolInput: 'tool ran',
        finalMessage: 'FINAL MESSAGE ONLY',
      }),
    );

    expect(terminal).toMatchObject({
      type: 'result',
      status: 'completed',
      nativeSessionId: 'session-last',
      error: null,
      partial: false,
    });
    expect(terminal.text).toBe('FINAL MESSAGE ONLY');
  });

  it('rejects stale earlier-message and tool traffic from the leased content', () => {
    const terminal = terminalInput(
      codexPlannerAdapter,
      turnEvents({
        earlierMessage: 'STALE PROGRESS MESSAGE',
        toolInput: 'TOOL TRAFFIC PAYLOAD',
        finalMessage: 'final brief text',
      }),
    );

    expect(terminal.text).toBe('final brief text');
  });

  it('falls back to the last message, never tool traffic, when the turn ends on a tool call', () => {
    const terminal = terminalInput(
      codexPlannerAdapter,
      turnEvents({ earlierMessage: 'progress', toolInput: 'tool ran' }),
    );

    expect(terminal.status).toBe('completed');
    expect(terminal.text).toBe('progress');
  });

  it('starts every message of the final group on its own line', () => {
    const events = [
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'part one' },
        }),
      ),
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: ' part two' },
        }),
      ),
      ...codexProtocolEvents(JSON.stringify({ type: 'turn.completed' })),
    ];
    expect(terminalInput(codexPlannerAdapter, events).text).toBe('part one\n\n part two');
  });

  it('rejects an oversize or malformed protocol line instead of treating it as content', () => {
    const events = codexProtocolEvents(`${'x'.repeat(1024 * 1024)}`);
    expect(terminalInput(codexPlannerAdapter, events)).toMatchObject({
      status: 'failed',
      error: { code: 'malformed-codex-json' },
    });
  });

  it('does not promote earlier text when the terminal record is missing', () => {
    const events = [
      ...codexProtocolEvents(JSON.stringify({ type: 'thread.started', thread_id: 'session-last' })),
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'EARLIER MESSAGE TEXT' },
        }),
      ),
      ...codexProtocolEvents(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'local_shell_exec', input: { command: 'tool ran' } },
        }),
      ),
    ];
    expect(() => terminalInput(codexPlannerAdapter, events)).toThrow(
      'Codex output ended without a terminal result',
    );
  });

  it('keeps a failed terminal content-free and failed', () => {
    const terminal = terminalInput(
      codexPlannerAdapter,
      turnEvents({ finalMessage: 'should never promote', failed: true }),
    );

    expect(terminal.status).toBe('failed');
    expect(terminal.error).toEqual({
      code: 'codex-turn-failed',
      message: 'turn exploded',
    });
  });

  it('keeps unknown additive records as bounded warnings without drifting the terminal', () => {
    const events = [
      ...codexProtocolEvents(JSON.stringify({ type: 'future.event', id: 'drift-1' })),
      ...codexProtocolEvents(
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
      ),
      ...codexProtocolEvents(JSON.stringify({ type: 'turn.completed' })),
    ];
    expect(events).toContainEqual({
      type: 'warning',
      code: 'unknown-codex-record',
      message: 'Unknown Codex record',
    });
    expect(terminalInput(codexPlannerAdapter, events).text).toBe('final');
  });
});
