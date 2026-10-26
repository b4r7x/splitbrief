import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import { PLAN_ANSWER_JSON_SCHEMA } from '../../../core/schemas/plan.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { RunningCall } from '../../calls/steering.js';

const IMPLEMENTER_SANDBOX = {
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
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
      model: 'claude-sonnet-4-6',
      projectDir: '/project',
      configuredArgs: ['--label', 'fixture'],
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

  it('adds --json-schema after --effort only when a schema is given, byte-identical otherwise', () => {
    const schema = { json: { type: 'object' } };
    const withSchema = claudeCodePlannerAdapter.buildArgs({
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      sessionId: null,
      effort: 'high',
      schema,
    });
    expect(withSchema).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--effort',
      'high',
      '--json-schema',
      '{"type":"object"}',
      '--permission-mode',
      'plan',
      '--disallowedTools',
      'AskUserQuestion',
    ]);

    const withoutSchema = claudeCodePlannerAdapter.buildArgs({
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      sessionId: null,
      effort: 'high',
    });
    expect(withoutSchema).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--effort',
      'high',
      '--permission-mode',
      'plan',
      '--disallowedTools',
      'AskUserQuestion',
    ]);
  });

  it('passes the plan schema to --json-schema without a $schema draft ref, which claude rejects', () => {
    const args = claudeCodePlannerAdapter.buildArgs({
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      sessionId: null,
      effort: undefined,
      schema: { json: PLAN_ANSWER_JSON_SCHEMA },
    });
    const sent = JSON.parse(args[args.indexOf('--json-schema') + 1] ?? '');
    expect(sent).not.toHaveProperty('$schema');
    expect(sent).toMatchObject({ type: 'object', required: ['result'] });
  });

  it('carries the implementer schema directly before the acceptEdits permission', () => {
    const args = claudeCodeImplementerAdapter.buildArgs({
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      schema: { json: { type: 'object' } },
    });
    const schemaIndex = args.indexOf('--json-schema');
    expect(args.slice(schemaIndex, schemaIndex + 4)).toEqual([
      '--json-schema',
      '{"type":"object"}',
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('refuses a configured --json-schema that would override the adapter schema', () => {
    const base = claudeCodePlannerAdapter.buildArgs({
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      sessionId: null,
      effort: undefined,
    });
    expect(
      claudeCodePlannerAdapter.validateArgs({
        invocationArgs: [...base, '--json-schema', '{}'],
        baseArgs: base,
      }),
    ).toEqual({ valid: false, conflicts: ['--json-schema'] });
  });

  it('never re-sends a consumed session id: fresh calls carry no session flag, continuations resume', () => {
    const common = {
      prompt: '<brief>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
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
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
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
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
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
            .buildArgs({ model: undefined, projectDir, configuredArgs: [] })
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

  it('opens attached global skills to reads and closes them to every write, and nothing else', () => {
    const settingsFor = (skillRoots?: readonly string[]) =>
      claudeCodeImplementerAdapter
        .buildArgs({
          model: undefined,
          projectDir: '/project',
          configuredArgs: [],
          ...(skillRoots !== undefined && { skillRoots }),
        })
        .at(-1) ?? '';
    const auth = '/home/me/.claude/skills/auth';
    const tokens = '/home/me/.agents/skills/tokens';

    expect(JSON.parse(settingsFor([auth, tokens]))).toEqual({
      sandbox: {
        ...IMPLEMENTER_SANDBOX.sandbox,
        filesystem: { allowRead: [auth, tokens], denyWrite: [auth, tokens] },
      },
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        additionalDirectories: [auth, tokens],
        deny: [`Edit(/${auth})`, `Edit(/${auth}/**)`, `Edit(/${tokens})`, `Edit(/${tokens}/**)`],
      },
    });
    expect(JSON.parse(settingsFor([auth])).permissions.deny).toEqual([
      'Edit(//home/me/.claude/skills/auth)',
      'Edit(//home/me/.claude/skills/auth/**)',
    ]);
    expect(settingsFor([])).toBe(JSON.stringify(IMPLEMENTER_SANDBOX));
    expect(settingsFor()).toBe(JSON.stringify(IMPLEMENTER_SANDBOX));
  });

  it('closes a skill that is one file to an edit of that file, not only of paths under it', () => {
    const loose = '/home/me/.claude/skills/loose.md';
    const settings = JSON.parse(
      claudeCodeImplementerAdapter
        .buildArgs({
          model: undefined,
          projectDir: '/project',
          configuredArgs: [],
          skillRoots: [loose],
        })
        .at(-1) ?? '',
    );

    expect(settings.permissions.deny).toContain('Edit(//home/me/.claude/skills/loose.md)');
    expect(settings.sandbox.filesystem.denyWrite).toEqual([loose]);
  });

  it('opens attached global skills to the planner and reviewer reads, never to a write', () => {
    const auth = '/home/me/.claude/skills/auth';
    const args = claudeCodePlannerAdapter.buildArgs({
      model: 'sonnet',
      projectDir: '/project',
      configuredArgs: [],
      sessionId: null,
      effort: 'high',
      skillRoots: [auth],
    });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '');
    expect(settings).toEqual({
      permissions: {
        additionalDirectories: [auth],
        deny: [`Edit(/${auth})`, `Edit(/${auth}/**)`],
      },
      sandbox: { filesystem: { allowRead: [auth], denyWrite: [auth] } },
    });
  });

  it('gives the planner and reviewer vectors no sandbox settings', () => {
    const args = claudeCodePlannerAdapter.buildArgs({
      model: 'sonnet',
      projectDir: '/project',
      configuredArgs: [],
      sessionId: null,
      effort: 'high',
    });
    expect(args).not.toContain('--settings');
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.rawContract.rawInvocation).not.toContain('--settings');
  });

  it('rejects configuration that would replace or widen the implementer sandbox', () => {
    const base = claudeCodeImplementerAdapter.buildArgs({
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
  it('keeps the usage step on a rate_limit_event warning at 75 percent weekly', () => {
    const events = claudeProtocolEvents(
      JSON.stringify({
        type: 'rate_limit_event',
        session_id: 'sess-weekly',
        rate_limit_info: {
          status: 'allowed_warning',
          unifiedWindows: { seven_day: { utilization: 0.75, resetsAt: 1_794_000_000 } },
        },
      }),
    );

    expect(events.filter((event) => event.type === 'warning')).toMatchObject([
      {
        code: 'claude_rate_limit',
        severity: 'warning',
        usage: { window: 'seven_day', step: 75, resetsAt: 1_794_000_000_000 },
      },
    ]);
  });

  it.each([claudeCodePlannerAdapter, claudeCodeImplementerAdapter])(
    'carries every fragmented tool input with its identity for the $role seat',
    (adapter) => {
      const parse = adapter.createParser?.();
      if (parse === undefined) throw new Error('Claude requires a stateful parser');
      parse(
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'tool-read', name: 'Read', input: {} },
          },
        }),
      );
      for (const inputDelta of ['{"file_path":', '"src/app.ts"}']) {
        const events = parse(
          JSON.stringify({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: inputDelta },
            },
          }),
        );
        expect(events.filter((event) => event.type === 'tool-use-delta')).toEqual([
          { type: 'tool-use-delta', id: 'tool-read', name: 'Read', inputDelta },
        ]);
      }
    },
  );

  it('keeps the subagent identity and assistant channel on deltas and complete records', () => {
    const records = [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'subagent answer' },
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'subagent answer' }] },
      },
    ];
    expect(
      records.flatMap((record) =>
        claudeProtocolEvents(JSON.stringify({ ...record, parent_tool_use_id: 'agent-1' })),
      ),
    ).toEqual([
      {
        type: 'text',
        channel: 'assistant',
        subagentId: 'agent-1',
        text: 'subagent answer',
        semantics: 'delta',
      },
      {
        type: 'text',
        channel: 'assistant',
        subagentId: 'agent-1',
        text: 'subagent answer',
        semantics: 'final',
      },
    ]);
  });

  it.each([claudeCodePlannerAdapter, claudeCodeImplementerAdapter])(
    'rebuilds max_tokens continuation for the $role seat',
    (adapter) => {
      const fixtures = join(import.meta.dirname, '../../../../testing/fixtures/claude-code');
      const parse = adapter.createParser?.();
      if (parse === undefined) throw new Error('Claude requires a stateful parser');
      const events = readFileSync(join(fixtures, 'claude-planner-max-tokens.jsonl'), 'utf8')
        .split('\n')
        .flatMap(parse);
      const terminal = events.findLast((event) => event.type === 'result');
      expect(terminal).toMatchObject({
        status: 'completed',
        text: readFileSync(join(fixtures, 'claude-planner-max-tokens.expected.txt'), 'utf8'),
      });
    },
  );

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

  it('carries structured_output from a schema-constrained result record to the terminal', () => {
    const terminal = claudeProtocolEvents(
      '{"type":"result","subtype":"success","is_error":false,"result":"","session_id":"s-1","structured_output":{"answer":"ok","count":2}}',
    ).findLast((event) => event.type === 'result');

    expect(terminal).toMatchObject({
      type: 'result',
      status: 'completed',
      structured: { answer: 'ok', count: 2 },
    });
  });

  it('leaves the completed terminal without a structured key when the result carries none', () => {
    const terminal = claudeProtocolEvents(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'plain', session_id: 's-1' }),
    ).findLast((event) => event.type === 'result');

    expect(terminal).toBeDefined();
    expect(terminal !== undefined && 'structured' in terminal).toBe(false);
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
      stage: 'started',
      id: 'toolu_1',
      name: 'Read',
      input: { file_path: 'src/a.ts' },
    });
  });

  it('closes a tool on its user tool_result, not on the assistant record that completes its input', () => {
    const parse = claudeCodeImplementerAdapter.createParser?.();
    if (parse === undefined) throw new Error('claude-code declares a stateful parser');
    parse(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
        },
      }),
    );
    const input = parse(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
          ],
        },
      }),
    );
    expect(input.filter((event) => event.type === 'tool-use')).toEqual([
      {
        type: 'tool-use',
        stage: 'started',
        id: 'toolu_1',
        name: 'Read',
        input: { file_path: 'src/a.ts' },
      },
    ]);
    expect(
      parse(
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] },
        }),
      ),
    ).toEqual([
      {
        type: 'tool-use',
        stage: 'done',
        id: 'toolu_1',
        name: 'Read',
        input: { file_path: 'src/a.ts' },
      },
    ]);
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

describe('Claude steering transport', () => {
  it('sends initial images and steered images as content blocks and acknowledges their text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-image-input-'));
    try {
      const path = join(dir, 'screenshot.data');
      const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
      writeFileSync(path, bytes);
      const images: Attachment[] = [
        { id: 'shot', kind: 'image', path, mimeType: 'image/png', sizeBytes: bytes.length },
      ];
      const content = (text: string) => [
        { type: 'text', text },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
        },
      ];
      const line = (text: string) =>
        JSON.stringify({ type: 'user', message: { role: 'user', content: content(text) } }) + '\n';
      const baseArgs = claudeCodeImplementerAdapter.baseArgs({
        model: undefined,
        projectDir: dir,
        configuredArgs: [],
        imagePaths: [path],
      });
      const transport = claudeCodeImplementerAdapter.steering;
      if (transport === undefined) throw new Error('transport missing');
      let send: RunningCall['send'] = () => Promise.resolve('deferred');
      const session = await transport.open({
        invocation: {
          executable: { path: '/claude', fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 } },
          args: baseArgs,
          baseArgs,
          promptTransport: { kind: 'stdin' },
          environment: {},
          cwd: dir,
          signal: undefined,
          images,
        },
        prompt: 'initial\ntext',
        onReady: (value) => {
          send = value;
        },
        onAdmissionClosed: () => {},
      });
      try {
        expect(
          await claudeCodeImplementerAdapter.encodePrompt?.({
            invocation: session.invocation,
            prompt: 'initial\ntext',
          }),
        ).toBe(line('initial\ntext'));
        expect(session.invocation.args.filter((arg) => arg === '--input-format')).toHaveLength(1);
        expect(session.invocation.args).toContain('--replay-user-messages');
        const writes: string[] = [];
        session.onStdinReady?.({
          write: async (value) => {
            writes.push(value);
          },
          end: () => {},
        });
        const echo = (text: string) => {
          const value = JSON.stringify({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: content(text) },
          });
          const events = session.parse(value);
          expect(events).toEqual([{ type: 'input-ack', text }]);
          session.onLine(value, events);
        };
        echo('initial\ntext');
        const delivery = send({ id: 'steer', text: 'correction\ntext', images });
        const next = send({ id: 'next', text: 'next correction' });
        await expect.poll(() => writes.length).toBe(2);
        expect(writes[0]).toBe(line('correction\ntext'));
        expect(writes[1]).toBe(
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'next correction' } }) +
            '\n',
        );
        echo('correction\ntext');
        expect(await delivery).toBe('delivered');
        echo('next correction');
        expect(await next).toBe('delivered');
      } finally {
        await session.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gates only canonical proven releases', () => {
    const transport = claudeCodeImplementerAdapter.steering;
    expect(transport).toBeDefined();
    expect(transport?.supportsVersion('2.1.296')).toBe(true);
    expect(transport?.supportsVersion('2.1.297')).toBe(true);
    expect(transport?.supportsVersion('2.1.295')).toBe(false);
    expect(transport?.supportsVersion(undefined)).toBe(false);
    expect(transport?.supportsVersion('unknown')).toBe(false);
  });

  it.each(['--input-format', '--replay-user-messages'])('rejects configured %s', (flag) => {
    expect(
      claudeCodeImplementerAdapter.validateArgs({
        invocationArgs: ['-p', flag, 'stream-json'],
        baseArgs: ['-p'],
      }),
    ).toEqual({ valid: false, conflicts: [flag] });
  });

  it.each([claudeCodeImplementerAdapter, claudeCodePlannerAdapter])(
    'protects stream-json image input from configured overrides for the $role seat',
    (adapter) => {
      const baseArgs = adapter.baseArgs({
        model: undefined,
        projectDir: '/project',
        configuredArgs: [],
        sessionId: null,
        effort: undefined,
        imagePaths: ['/outside/shot.png'],
      });
      expect(baseArgs).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
      expect(adapter.validateArgs({ invocationArgs: baseArgs, baseArgs })).toEqual({ valid: true });
      for (const configuredArgs of [['--input-format', 'text'], ['--input-format=text']]) {
        expect(
          adapter.validateArgs({ invocationArgs: [...baseArgs, ...configuredArgs], baseArgs }),
        ).toEqual({ valid: false, conflicts: ['--input-format'] });
      }
    },
  );

  it('parses input echoes separately from tool results and subagents', () => {
    expect(
      claudeProtocolEvents(
        JSON.stringify({
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'same' },
        }),
      ),
    ).toEqual([{ type: 'input-ack', text: 'same' }]);
    expect(
      claudeProtocolEvents(
        JSON.stringify({
          type: 'user',
          parent_tool_use_id: null,
          message: { content: [{ type: 'tool_result', tool_use_id: 't' }] },
        }),
      ),
    ).not.toContainEqual({ type: 'input-ack', text: 'same' });
    expect(
      claudeProtocolEvents(
        JSON.stringify({
          type: 'user',
          parent_tool_use_id: 'nested',
          message: { role: 'user', content: 'same' },
        }),
      ),
    ).not.toContainEqual({ type: 'input-ack', text: 'same' });
  });

  it('sums turn finals while replacing each turn streaming snapshots and keeps the last answer', () => {
    const parse = claudeCodeImplementerAdapter.createParser?.();
    if (parse === undefined) throw new Error('missing parser');
    const lines = [
      {
        type: 'assistant',
        message: { id: 'a', content: [], usage: { input_tokens: 100, output_tokens: 0 } },
      },
      {
        type: 'result',
        result: 'first',
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 1,
      },
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: { id: 'a', content: [], usage: { input_tokens: 2, output_tokens: 0 } },
      },
      {
        type: 'result',
        result: 'last',
        structured_output: { answer: 'last' },
        usage: { input_tokens: 3, output_tokens: 7 },
        total_cost_usd: 2,
      },
    ];
    const events = lines.flatMap((line) => parse(JSON.stringify(line)));
    let usage: TokenDelta | null = null;
    for (const event of events)
      if (event.type === 'usage') usage = accumulateTokenUsage(usage, event.usage, event.semantics);
    expect(usage).toMatchObject({ inputTokens: 13, outputTokens: 12 });
    expect(events.filter((event) => event.type === 'usage').at(-2)).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 5 },
      semantics: 'cumulative',
    });
    expect(
      claudeCodeImplementerAdapter.terminal({
        outputContract: claudeCodeImplementerAdapter.outputContract,
        events,
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    ).toMatchObject({
      text: 'last',
      structured: { answer: 'last' },
      usage: { inputTokens: 13, outputTokens: 12 },
    });
  });
});

it('opens a Claude steering session with adapter-owned flags and JSON-line stdin', async () => {
  const transport = claudeCodePlannerAdapter.steering;
  if (transport === undefined) throw new Error('transport missing');
  const invocation = {
    executable: { path: '/claude', fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 } },
    args: ['-p', '--label', 'fixture'],
    baseArgs: ['-p'],
    promptTransport: { kind: 'stdin' as const },
    environment: {},
    cwd: '/project',
    signal: undefined,
  };
  const session = await transport.open({
    invocation,
    prompt: 'initial\ntext',
    onReady: () => {},
    onAdmissionClosed: () => {},
  });
  expect(session.invocation.args).toEqual([
    '-p',
    '--input-format',
    'stream-json',
    '--replay-user-messages',
    '--label',
    'fixture',
  ]);
  expect(session.invocation.baseArgs).toEqual([
    '-p',
    '--input-format',
    'stream-json',
    '--replay-user-messages',
  ]);
  expect(
    await claudeCodePlannerAdapter.encodePrompt?.({
      invocation: session.invocation,
      prompt: 'initial\ntext',
    }),
  ).toBe(
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'initial\ntext' } }) + '\n',
  );
  expect(invocation.args).toEqual(['-p', '--label', 'fixture']);
  await session.close();
});
