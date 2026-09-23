import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_CONFORMANCE_CANDIDATES,
  claudeCodeImplementerAdapter,
  claudeCodePlannerAdapter,
  claudeProtocolEvents,
} from './claude-code.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';

const IMPLEMENTER_SANDBOX = {
  sandbox: { enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false },
  permissions: { blockReadsOutsideWorkingDirectories: true },
};
const IMPLEMENTER_SETTINGS = ['--settings', JSON.stringify(IMPLEMENTER_SANDBOX)] as const;

describe('Claude Code role adapters', () => {
  it('exports planner then implementer conformance candidates with stable hashes', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    for (const candidate of CLI_CONFORMANCE_CANDIDATES) {
      expect(candidate.id).toBe('claude-code');
      expect(candidate.rawContract.id).toBe(candidate.id);
      expect(candidate.rawContract.role).toBe(candidate.role);
      expect(candidate.contractSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(candidate.adapter.role).toBe(candidate.role);
      expect(candidate.adapter.descriptor).toBe(CLI_TOOL_CATALOG['claude-code']);
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.contractSha256).not.toBe(
      CLI_CONFORMANCE_CANDIDATES[1]?.contractSha256,
    );
  });

  it('keeps the lossless stdin and structured-terminal contracts explicit', () => {
    expect(claudeCodePlannerAdapter.promptTransport).toEqual({ kind: 'stdin' });
    expect(claudeCodeImplementerAdapter.promptTransport).toEqual({ kind: 'stdin' });
    expect(claudeCodePlannerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(claudeCodeImplementerAdapter.outputContract).toEqual({
      kind: 'structured-terminal',
      terminalEvent: 'required',
    });
    expect(claudeCodePlannerAdapter.probe.version.command).toEqual(['claude', '--version']);
    expect(claudeCodePlannerAdapter.probe.auth.command).toEqual(['claude', 'auth']);
  });

  it('preserves Claude planner session/model/effort placement and implementer permissions', () => {
    const plannerArgs = claudeCodePlannerAdapter.buildArgs({
      prompt: '<brief>',
      model: 'claude-sonnet-4-6',
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
      mode: 'plan',
      sessionId: 'session-1',
      effort: 'high',
    });
    expect(plannerArgs).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--permission-mode',
      'plan',
      '--disallowedTools',
      'AskUserQuestion',
      '--resume',
      'session-1',
      '--label',
      'fixture',
    ]);
    const plannerBase = plannerArgs.slice(0, -2);
    expect(
      claudeCodePlannerAdapter.validateArgs({ invocationArgs: plannerArgs, baseArgs: plannerBase }),
    ).toEqual({
      valid: true,
    });
    expect(
      claudeCodePlannerAdapter.validateArgs({
        invocationArgs: [...plannerArgs, '--model', 'other'],
        baseArgs: plannerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--model'] });

    const implementerArgs = claudeCodeImplementerAdapter.buildArgs({
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
    });
    expect(implementerArgs).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'acceptEdits',
      ...IMPLEMENTER_SETTINGS,
      '--label',
      'fixture',
    ]);
    const implementerBase = implementerArgs.slice(0, -2);
    expect(
      claudeCodeImplementerAdapter.validateArgs({
        invocationArgs: implementerArgs,
        baseArgs: implementerBase,
      }),
    ).toEqual({
      valid: true,
    });
    expect(
      claudeCodeImplementerAdapter.validateArgs({
        invocationArgs: [...implementerArgs, '--permission-mode', 'skip'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--permission-mode'] });
  });

  it('places implementer --effort after the model pair and omits it when unset', () => {
    const withEffort = claudeCodeImplementerAdapter.buildArgs({
      prompt: '<brief>',
      model: 'claude-sonnet-4-6',
      projectDir: '/project',
      configuredArgs: [],
      effort: 'high',
    });
    expect(withEffort).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
      ...IMPLEMENTER_SETTINGS,
    ]);

    const unset = claudeCodeImplementerAdapter.buildArgs({
      prompt: '<brief>',
      model: 'claude-sonnet-4-6',
      projectDir: '/project',
      configuredArgs: [],
    });
    expect(unset).not.toContain('--effort');
    expect(unset).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-4-6',
      '--permission-mode',
      'acceptEdits',
      ...IMPLEMENTER_SETTINGS,
    ]);
  });

  it('never re-sends a consumed session id: fresh calls carry no session flag, continuations resume', () => {
    const common = {
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      effort: undefined,
    } as const;
    const firstCall = claudeCodePlannerAdapter.buildArgs({ ...common, sessionId: null });
    const capturedId = '0a3443ac-432e-40c8-bdf9-29859130257f';
    const retryCall = claudeCodePlannerAdapter.buildArgs({ ...common, sessionId: capturedId });

    expect(firstCall).not.toContain('--session-id');
    expect(firstCall).not.toContain('--resume');
    expect(retryCall).not.toContain('--session-id');
    expect(retryCall.slice(retryCall.indexOf('--resume'))).toEqual(['--resume', capturedId]);
    expect(retryCall).not.toEqual(firstCall);
  });

  it('pins the exact read-only plan init: plan permission, no session flags, no tools flags', () => {
    const init = claudeCodePlannerAdapter.buildArgs({
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    expect(init).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'plan',
      '--disallowedTools',
      'AskUserQuestion',
    ]);
    expect(claudeCodePlannerAdapter.validateArgs({ invocationArgs: init, baseArgs: init })).toEqual(
      { valid: true },
    );
  });

  it('rejects hostile configuration that could widen the planner plan vector', () => {
    const init = claudeCodePlannerAdapter.buildArgs({
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    const hostile = [
      ['--permission-mode', 'acceptEdits'],
      ['--permission-mode', 'bypassPermissions'],
      ['--allowedTools', 'Write,Bash'],
      ['--allowed-tools', 'Write'],
      ['--disallowedTools', 'Read'],
      ['--disallowed-tools', 'Read'],
      ['--mcp-config', 'servers.json'],
      ['--dangerously-skip-permissions'],
      ['--add-dir', '/srv/other'],
      ['--resume', 'other-session'],
      ['--session-id', 'other-session'],
    ] as const;
    for (const tail of hostile) {
      expect(
        claudeCodePlannerAdapter.validateArgs({
          invocationArgs: [...init, ...tail],
          baseArgs: init,
        }),
      ).toEqual({
        valid: false,
        conflicts: expect.arrayContaining([tail[0] ?? '']),
      });
    }
  });

  it('keeps the implementer contained to acceptEdits: bypass and skip permission modes fail', () => {
    const implementerArgs = claudeCodeImplementerAdapter.buildArgs({
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
    });
    const implementerBase = implementerArgs.slice(0, -2);
    expect(
      claudeCodeImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--permission-mode', 'bypassPermissions'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--permission-mode'] });
    expect(
      claudeCodeImplementerAdapter.validateArgs({
        invocationArgs: [...implementerBase, '--allowedTools', 'Write'],
        baseArgs: implementerBase,
      }),
    ).toEqual({ valid: false, conflicts: ['--allowedTools'] });
  });

  it('runs the implementer in the strict native sandbox and records it in the raw contract', () => {
    const args = claudeCodeImplementerAdapter.buildArgs({
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
    });
    expect(args.slice(-2)).toEqual([...IMPLEMENTER_SETTINGS]);
    expect(JSON.parse(args.at(-1) ?? '')).toEqual(IMPLEMENTER_SANDBOX);
    expect(CLI_CONFORMANCE_CANDIDATES[1]?.rawContract.rawInvocation.slice(-4)).toEqual([
      '--permission-mode',
      'acceptEdits',
      ...IMPLEMENTER_SETTINGS,
    ]);
  });

  it('omits the read block below 2.1.257, keeps it at 2.1.257', () => {
    const settingsFor = (installedVersion: string | undefined) =>
      JSON.parse(
        claudeCodeImplementerAdapter
          .buildArgs({
            prompt: '<brief>',
            model: undefined,
            projectDir: '/project',
            configuredArgs: [],
            installedVersion,
          })
          .at(-1) ?? '',
      );

    expect(settingsFor('2.1.256')).toEqual({ sandbox: IMPLEMENTER_SANDBOX.sandbox });
    expect(settingsFor('2.1.257')).toEqual(IMPLEMENTER_SANDBOX);
    expect(settingsFor(undefined)).toEqual(IMPLEMENTER_SANDBOX);
  });

  it('opens reads of a linked node_modules target to the sandbox, and nothing else', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-sandbox-')));
    try {
      const checkoutModules = join(root, 'checkout', 'node_modules');
      const worktree = join(root, 'worktree');
      const ownModules = join(root, 'own', 'node_modules');
      mkdirSync(checkoutModules, { recursive: true });
      mkdirSync(worktree);
      mkdirSync(ownModules, { recursive: true });
      symlinkSync(checkoutModules, join(worktree, 'node_modules'), 'dir');
      const settingsFor = (projectDir: string) =>
        JSON.parse(
          claudeCodeImplementerAdapter
            .buildArgs({ prompt: '<brief>', model: undefined, projectDir, configuredArgs: [] })
            .at(-1) ?? '',
        );

      expect(settingsFor(worktree)).toEqual({
        ...IMPLEMENTER_SANDBOX,
        sandbox: { ...IMPLEMENTER_SANDBOX.sandbox, filesystem: { allowRead: [checkoutModules] } },
      });
      expect(settingsFor(join(root, 'own'))).toEqual(IMPLEMENTER_SANDBOX);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives the planner and reviewer vectors no sandbox settings', () => {
    for (const mode of ['plan', 'escalate'] as const) {
      const args = claudeCodePlannerAdapter.buildArgs({
        prompt: '<brief>',
        model: 'sonnet',
        projectDir: '/project',
        configuredArgs: [],
        mode,
        sessionId: null,
        effort: 'high',
      });
      expect(args).not.toContain('--settings');
    }
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.rawContract.rawInvocation).not.toContain('--settings');
  });

  it('rejects configuration that would replace or widen the implementer sandbox', () => {
    const base = claudeCodeImplementerAdapter.buildArgs({
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
    });
    const hostile = [
      ['--settings', '{"sandbox":{"enabled":false}}'],
      ['--settings={"sandbox":{"allowUnsandboxedCommands":true}}'],
      ['--dangerously-skip-permissions'],
      ['--allow-dangerously-skip-permissions'],
      ['--add-dir', '/srv/other'],
      ['--permission-mode', 'bypassPermissions'],
    ] as const;
    for (const tail of hostile) {
      expect(
        claudeCodeImplementerAdapter.validateArgs({
          invocationArgs: [...base, ...tail],
          baseArgs: base,
        }),
      ).toEqual({
        valid: false,
        conflicts: expect.arrayContaining([tail[0].split('=')[0]]),
      });
    }
    expect(
      claudeCodeImplementerAdapter.validateArgs({
        invocationArgs: base.slice(0, -2),
        baseArgs: base,
      }),
    ).toEqual({ valid: false, conflicts: ['argument-order'] });
  });
});

describe('Claude Code stream protocol adapter', () => {
  it('projects assistant/session/usage records and a required terminal result', () => {
    const events = claudeProtocolEvents(
      JSON.stringify({
        type: 'assistant',
        session_id: 'session-2',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    );
    expect(events).toEqual([
      { type: 'session', nativeSessionId: 'session-2' },
      { type: 'text', channel: 'assistant', text: 'hello', semantics: 'final' },
    ]);

    const terminal = claudeProtocolEvents(
      JSON.stringify({
        type: 'result',
        session_id: 'session-2',
        result: 'hello',
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    );
    expect(terminal.at(-1)).toMatchObject({
      type: 'result',
      status: 'completed',
      text: 'hello',
      nativeSessionId: 'session-2',
      error: null,
      partial: false,
    });
    expect(terminal).toContainEqual({
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
  });

  it('streams a partial message once: the assistant record restates it, never appends again', () => {
    const deltas = ['returning `a', ' - b`'];
    const message = deltas.join('');
    const lines = [
      ...deltas.map((text) =>
        JSON.stringify({
          type: 'stream_event',
          session_id: 'session-3',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        }),
      ),
      JSON.stringify({
        type: 'assistant',
        session_id: 'session-3',
        message: { content: [{ type: 'text', text: message }] },
      }),
    ];
    const textEvents = lines
      .flatMap((line) => claudeProtocolEvents(line))
      .filter((event) => event.type === 'text');

    const appended = textEvents
      .filter((event) => event.semantics !== 'final')
      .map((event) => event.text)
      .join('');
    expect(appended).toBe(message);
    expect(textEvents.at(-1)).toEqual({
      type: 'text',
      channel: 'assistant',
      text: message,
      semantics: 'final',
    });
  });

  it('marks a content_block_start tool_use as started before the assistant record completes it', () => {
    expect(
      claudeProtocolEvents(
        JSON.stringify({
          type: 'stream_event',
          session_id: 'session-4',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
          },
        }),
      ),
    ).toEqual([
      { type: 'session', nativeSessionId: 'session-4' },
      { type: 'tool-use', stage: 'started', id: 'toolu_1', name: 'Read', input: {} },
    ]);
    expect(
      claudeProtocolEvents(
        JSON.stringify({
          type: 'assistant',
          session_id: 'session-4',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
            ],
          },
        }),
      ),
    ).toContainEqual({
      type: 'tool-use',
      id: 'toolu_1',
      name: 'Read',
      input: { file_path: 'src/a.ts' },
    });
  });

  it('retains explicit failure terminals and bounded parser warnings', () => {
    const failure = claudeProtocolEvents(
      JSON.stringify({ type: 'result', is_error: true, result: 'request failed' }),
    );
    expect(failure.at(-1)).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'runner_result_error', message: 'request failed' },
      partial: true,
    });

    const malformed = claudeProtocolEvents('{not-json');
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({
      type: 'warning',
      code: 'malformed_stream_json',
    });
  });
});
