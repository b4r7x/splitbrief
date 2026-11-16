import { readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_HELP_FIXTURES, CODEX_HELP } from '#testing/helpers/arg-vector-help.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { checkRunnerArgVector } from './check.js';
import { type ArgVectorPreflightCheckInput, collectArgVectorPreflightChecks } from './preflight.js';

async function preflightWithVectors(
  input: ArgVectorPreflightCheckInput & {
    runHelp: NonNullable<ArgVectorPreflightCheckInput['runHelp']>;
  },
) {
  const vectors: (readonly string[])[] = [];
  const checks = await collectArgVectorPreflightChecks({
    ...input,
    runHelp: async (tool, argv) => {
      vectors.push(argv);
      return input.runHelp(tool, argv);
    },
  });
  return { checks, vectors };
}

describe('collectArgVectorPreflightChecks', () => {
  it.each([
    ['--worktree', 'other'],
    ['--worktree=other'],
    ['-w', 'other'],
    ['-wother'],
    ['-w=other'],
    ['--mod', 'plugin'],
    ['--mod=plugin'],
    ['--mod-option', 'key=value'],
    ['--mod-option=key=value'],
  ])('rejects Command Code adapter conflicts before probing help: %j', async (...args) => {
    const help = vi.fn(async () => 'Usage: cmd --worktree --mod --mod-option -w');
    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'command-code', args },
        implementer: { kind: 'cli', tool: 'command-code', args },
      }),
      projectDir: '/project',
      roles: ['planner', 'implementer'],
      runHelp: help,
    });
    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.severity === 'blocker')).toBe(true);
    expect(help).not.toHaveBeenCalled();
  });

  it('names the seats in PLAN, BUILD, REVIEW order', async () => {
    const runner = { kind: 'cli', tool: 'command-code' } as const;
    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({ planner: runner, implementer: runner, reviewer: runner }),
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: async () => null,
    });
    expect(checks.map((check) => check.summary)).toEqual([
      'Command Code CLI options for PLAN are configured.',
      'Command Code CLI options for BUILD are configured.',
      'Command Code CLI options for REVIEW are configured.',
    ]);
  });

  it('keeps an ordinary Command Code argument eligible for help comparison', async () => {
    const help = vi.fn(async () => null);
    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'command-code', args: ['--verbose'] } }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: help,
    });
    expect(checks[0]?.severity).toBe('ok');
    expect(help).toHaveBeenCalled();
  });
  const runHelp = (helpText: string) => async () => helpText;
  const unavailableHelp = async () => null;

  it('reports a configured runner whose binary rejects a flag as a readiness blocker', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
    });
    const checks = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: runHelp('Usage: codex exec [OPTIONS]\n  --model <MODEL>  Model to use'),
    });

    const check = checks.find(
      (candidate) => candidate.id === 'runners.cli.codex.arg-vector.planner',
    );
    expect(check).toMatchObject({
      severity: 'blocker',
      nextAction: 'fix-config',
      metadata: {
        tool: 'codex',
        role: 'planner',
        unsupported: expect.arrayContaining(['--json', '--cd']),
      },
    });
    expect(check?.summary).toContain('does not support');
  });

  it('reports deprecated-only findings as a warning that does not block', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex' },
    });
    const checks = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: runHelp(
        [
          'Usage: codex exec [OPTIONS]',
          '  --json (deprecated)               Use --output-format instead',
          '  --sandbox <SANDBOX_MODE>          Sandbox policy',
          '  --ask-for-approval <APPROVAL_POLICY>  Approval policy',
          '  --ignore-user-config              Do not load the user config',
          '  --ignore-rules                    Do not load rules files',
          '  --ephemeral                       Run without persisting sessions',
          '  --skip-git-repo-check             Allow running outside a git repo',
          '  --cd <DIR>                        Working directory',
        ].join('\n'),
      ),
    });

    const check = checks.find(
      (candidate) => candidate.id === 'runners.cli.codex.arg-vector.planner',
    );
    expect(check).toMatchObject({
      severity: 'warning',
      metadata: { deprecated: ['--json'], unsupported: [] },
    });
    expect(check?.fix).toContain('remove these options from .splitbrief/config.yaml');
  });

  it('reports ok when every emitted flag is advertised', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
    });
    const checks = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: runHelp(CODEX_HELP),
    });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'ok',
      }),
    ]);
  });

  it('reports ok rather than blocking when the help output cannot be obtained', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex' },
    });
    const checks = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: unavailableHelp,
    });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'ok',
      }),
    ]);
    expect(checks[0]?.metadata).toMatchObject({ checked: 'unavailable' });
  });

  it('skips runners that are not cli kind and skips implementers when excluded', async () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
        model: 'qwen2.5-coder:7b',
      },
    });

    const checks = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner'],
      runHelp: runHelp('Usage: codex exec [OPTIONS]'),
    });

    expect(checks).toEqual([]);
  });

  it('preflights a configured cli reviewer only when the reviewer seat is in the role set', async () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
        model: 'qwen2.5-coder:7b',
      },
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
    });
    const help = vi.fn(async () => 'Usage: codex exec [OPTIONS]');

    const included = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: help,
    });
    expect(included.map((check) => check.id)).toEqual(['runners.cli.codex.arg-vector.reviewer']);

    help.mockClear();
    const excluded = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner'],
      runHelp: help,
    });
    expect(excluded).toEqual([]);
    expect(help).not.toHaveBeenCalled();
  });
});

describe('collectArgVectorPreflightChecks — every emitted argv branch', () => {
  const claudeHelp = (...extra: string[]) =>
    [
      'Usage: claude [options] [command]',
      '  -p, --print                    Print response and exit',
      '  --output-format <format>       Output format',
      '  --verbose                      Verbose output',
      '  --include-partial-messages     Stream partial message events',
      '  --model <model>                Model for the session',
      '  --permission-mode <mode>       Permission mode for the session',
      ...extra,
    ].join('\n');

  const plannerChecksWithEffort = (helpText: string) =>
    preflightWithVectors({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: async () => helpText,
    });

  it('blocks on the resume and effort flags a binary that omits them would reject', async () => {
    const { checks } = await plannerChecksWithEffort(claudeHelp());

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.planner',
      severity: 'blocker',
      metadata: { unsupported: ['--effort', '--disallowedtools', '--resume'] },
    });
  });

  it('reports ok once the binary advertises the resume and effort flags', async () => {
    const { checks, vectors } = await plannerChecksWithEffort(
      claudeHelp(
        '  --effort <level>               Effort level for the session',
        '  -r, --resume [sessionId]       Resume a conversation by session ID',
        '  --disallowedTools <tools...>   Tools to block in this session',
      ),
    );

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.claude-code.arg-vector.planner',
        severity: 'ok',
      }),
    ]);
    expect(vectors.map((argv) => argv.join(' '))).toContain(
      '-p --output-format stream-json --verbose --include-partial-messages --model sonnet --effort high --permission-mode plan --disallowedTools AskUserQuestion',
    );
  });

  it('emits one read-only argv for the review seat, with no resume variant', async () => {
    const { checks, vectors } = await preflightWithVectors({
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          model: 'qwen2.5-coder:7b',
        },
        reviewer: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: async () =>
        claudeHelp(
          '  --effort <level>               Effort level for the session',
          '  -r, --resume [sessionId]       Resume a conversation by session ID',
          '  --disallowedTools <tools...>   Tools to block in this session',
        ),
    });

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.reviewer',
      severity: 'ok',
    });
    expect(vectors.map((argv) => argv.join(' '))).toEqual([
      '-p --output-format stream-json --verbose --include-partial-messages --model sonnet --effort high --permission-mode plan --disallowedTools AskUserQuestion',
    ]);
  });

  const implementerChecks = (helpText: string) =>
    preflightWithVectors({
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['implementer'],
      runHelp: async () => helpText,
    });

  it('emits --effort and the sandbox settings on the Claude Code implementer argv', async () => {
    const { checks, vectors } = await implementerChecks(
      claudeHelp(
        '  --effort <level>               Effort level for the session',
        '  --settings <file-or-json>      Path to a settings JSON file or a JSON string',
      ),
    );

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.implementer',
      severity: 'ok',
    });
    expect(vectors.map((argv) => argv.join(' '))).toEqual([
      '-p --output-format stream-json --verbose --include-partial-messages --model sonnet --effort high --permission-mode acceptEdits --settings {"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false},"permissions":{"blockReadsOutsideWorkingDirectories":true}}',
    ]);
  });

  it('blocks a Claude Code implementer whose binary cannot take the sandbox settings', async () => {
    const { checks } = await implementerChecks(
      claudeHelp('  --effort <level>               Effort level for the session'),
    );

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.implementer',
      severity: 'blocker',
      metadata: { unsupported: ['--settings'] },
    });
  });

  // No vector holds --ephemeral: Codex cannot start a sub-agent on a thread with no rollout.
  it('carries the codex planner effort into every emitted vector as a config override', async () => {
    const { checks, vectors } = await preflightWithVectors({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-5', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: async () => CODEX_HELP,
    });

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.codex.arg-vector.planner',
      severity: 'ok',
    });
    expect(vectors.map((argv) => argv.join(' '))).toEqual([
      '--model gpt-5 -c model_reasoning_effort=high --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --json --cd /project -',
      '-c model_reasoning_effort=high --sandbox read-only --ask-for-approval never exec resume --model gpt-5 --ignore-user-config --ignore-rules --json 00000000-0000-4000-8000-000000000000 -',
    ]);
  });

  // A review starts sub-agents only on a thread with a rollout, so its exec has no --ephemeral.
  it('preflights the fresh vector a codex review seat emits', async () => {
    const { vectors } = await preflightWithVectors({
      config: makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' } }),
      projectDir: '/project',
      roles: ['reviewer'],
      runHelp: async () => CODEX_HELP,
    });

    expect(vectors.map((argv) => argv.join(' '))).toEqual([
      '--model gpt-5 --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --json --cd /project -',
    ]);
  });

  it('blocks a codex binary whose help dropped the config-override entry but still quotes it', async () => {
    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-5', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: async () =>
        CODEX_HELP.split('\n')
          .filter((line) => !line.includes('-c, --config'))
          .concat('  -p, --profile <PROFILE>                Configuration profile')
          .join('\n'),
    });

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.codex.arg-vector.planner',
      severity: 'blocker',
      metadata: { unsupported: ['-c'] },
    });
  });

  // A short flag whose predecessor is itself a flag is read as that flag's value and skipped, so
  // `-c` is compared today only because the adapter puts it at the head of the resume vector and
  // after the `--model` value on the others. Walking the vectors the adapter really builds fails
  // on the vector that stopped being compared, rather than on an argv snapshot that merely moved.
  it('compares the config override in every codex vector the adapter builds', async () => {
    const { vectors } = await preflightWithVectors({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-5', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: async () => CODEX_HELP,
    });
    const withoutConfigEntry = CODEX_HELP.split('\n')
      .filter((line) => !line.includes('-c, --config'))
      .join('\n');

    // Fresh and resume are the only vectors: no call sends an --ephemeral one.
    expect(vectors).toHaveLength(2);
    for (const argv of vectors) {
      expect(checkRunnerArgVector({ argv, helpText: withoutConfigEntry }), argv.join(' ')).toEqual({
        ok: false,
        unsupported: ['-c'],
        deprecated: [],
      });
    }
  });

  const opencodeHelp = (...extra: string[]) =>
    [
      'Usage: opencode run [message..]',
      '  --model <model>      Model to use',
      '  --format <format>    Output format',
      '  --agent <agent>      Agent to run',
      ...extra,
    ].join('\n');

  const opencodePlannerChecksWithVariant = (helpText: string) =>
    preflightWithVectors({
      config: makeConfig({
        planner: {
          kind: 'cli',
          tool: 'opencode',
          model: 'openai/gpt-5.6-luna',
          variant: 'xhigh',
        },
      }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: async () => helpText,
    });

  it('blocks on the variant flag an opencode binary that omits it would reject', async () => {
    const { checks } = await opencodePlannerChecksWithVariant(opencodeHelp());

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.opencode.arg-vector.planner',
      severity: 'blocker',
      metadata: { unsupported: ['--variant'] },
    });
  });

  it('reports ok once the binary advertises --variant', async () => {
    const { checks, vectors } = await opencodePlannerChecksWithVariant(
      opencodeHelp('  --variant <name>     Model variant'),
    );

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.opencode.arg-vector.planner',
      severity: 'ok',
    });
    expect(vectors.map((argv) => argv.join(' '))).toEqual([
      'run --model openai/gpt-5.6-luna --variant xhigh --format json --agent plan',
    ]);
  });

  const opencodeImplementerChecks = (installedVersion: string, helpFixture: string) =>
    preflightWithVectors({
      config: makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'opencode',
          model: 'opencode-go/deepseek-v4-flash',
          variant: 'high',
        },
      }),
      projectDir: '/project',
      roles: ['implementer'],
      installedVersions: { opencode: installedVersion },
      runHelp: async () => readFileSync(join(CLI_HELP_FIXTURES, helpFixture), 'utf8'),
    });

  it('checks the vector dispatch builds for the admitted opencode 2 release', async () => {
    const { checks, vectors } = await opencodeImplementerChecks(
      '2.0.14',
      'opencode-v2-run-help.txt',
    );

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.opencode.arg-vector.implementer',
      severity: 'ok',
    });
    expect(vectors.map((argv) => argv.join(' '))).toEqual([
      'run --standalone --model opencode-go/deepseek-v4-flash#high --format json --agent build',
    ]);
  });

  it('keeps --variant and no --standalone for an admitted release below 2.0.0', async () => {
    const { checks, vectors } = await opencodeImplementerChecks('1.18.32', 'opencode-run-help.txt');

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.opencode.arg-vector.implementer',
      severity: 'ok',
    });
    expect(vectors.map((argv) => argv.join(' '))).toEqual([
      'run --model opencode-go/deepseek-v4-flash --variant high --format json --agent build',
    ]);
  });

  it('refuses a configured added-roots override before any help probe (REQ-018)', async () => {
    const configuredArgs = ['--add-dir', '/srv/shared-context'];
    let helpSpawns = 0;
    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'sonnet',
          effort: 'high',
          args: configuredArgs,
        },
      }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: async () => {
        helpSpawns += 1;
        return claudeHelp(
          '  --effort <level>               Effort level for the session',
          '  -r, --resume [sessionId]       Resume a conversation by session ID',
          '  --add-dir <dir>                Additional directory to expose',
        );
      },
    });

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.planner',
      severity: 'blocker',
      nextAction: 'fix-config',
      metadata: { semantic: ['--add-dir'], tool: 'claude-code', role: 'planner' },
    });
    expect(checks[0]?.fix).toContain('Remove the authority-bearing flags');
    expect(checks[0]?.details?.join('\n')).not.toContain(configuredArgs.join(' '));
    expect(helpSpawns).toBe(0);
  });
});

describe('collectArgVectorPreflightChecks — default help invocation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
  });

  function tempDir(prefix: string): string {
    const directory = createTempDir(prefix);
    tempDirs.push(directory);
    return directory;
  }

  it('allows reads from the project node_modules symlink target on the Claude Code implementer argv', async () => {
    const project = tempDir('preflight-project');
    const target = tempDir('preflight-node-modules');
    symlinkSync(target, join(project, 'node_modules'));

    const { vectors } = await preflightWithVectors({
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
      }),
      projectDir: project,
      roles: ['implementer'],
      runHelp: async () => null,
    });

    const argv = vectors[0] ?? [];
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '');
    expect(settings.sandbox.filesystem.allowRead).toEqual([realpathSync(target)]);
  });
});
