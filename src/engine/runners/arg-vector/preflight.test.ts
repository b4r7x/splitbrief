import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_HELP_FIXTURES, CODEX_HELP } from '#testing/helpers/arg-vector-help.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import { spawnWithTimeout } from '../../../lib/process/spawn/progress.js';
import { abortError } from '../../../utils/abort.js';
import { checkRunnerArgVector } from './check.js';
import { type ArgVectorPreflightCheckInput, collectArgVectorPreflightChecks } from './preflight.js';

vi.mock('../../../lib/process/spawn/progress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/process/spawn/progress.js')>();
  return { ...actual, spawnWithTimeout: vi.fn(actual.spawnWithTimeout) };
});

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
    vi.unstubAllEnvs();
    for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
  });

  function tempDir(prefix: string): string {
    const directory = createTempDir(prefix);
    tempDirs.push(directory);
    return directory;
  }

  /** Records the environment it was handed, then answers like a real `--help`. */
  function writeCodexStub(path: string, envRecord: string): void {
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        '{',
        `  printf 'HOME=%s\\n' "\${HOME-<unset>}"`,
        `  printf 'CANARY=%s\\n' "\${SPLITBRIEF_PREFLIGHT_CANARY-<unset>}"`,
        `} >> ${JSON.stringify(envRecord)}`,
        `printf 'Usage: codex exec [OPTIONS]\\n  --model <MODEL>  Model to use\\n'`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(path, 0o755);
  }

  /** Answers `--help` and `<subcommand> --help` from a captured fixture, logging each call. */
  function writeHelpStub(
    path: string,
    log: string,
    fixtures: Readonly<Record<string, string>>,
  ): void {
    const branches = Object.entries(fixtures).map(
      ([argument, fixture]) =>
        `  ${argument}) cat ${JSON.stringify(join(CLI_HELP_FIXTURES, fixture))} ;;`,
    );
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        'case "$1" in',
        ...branches,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(path, 0o755);
  }

  function plannerChecks(
    projectDir: string,
    planner: Readonly<{ tool: CliToolId; model?: string; effort?: EffortLevel }> = {
      tool: 'codex',
    },
  ) {
    return collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', ...planner } }),
      projectDir,
      roles: ['planner'],
    });
  }

  function helpInvocations(log: string): string[] {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
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

  it('never runs a project-local executable the trust ladder refuses, and reports ok', async () => {
    const project = tempDir('preflight-project');
    const binDir = join(project, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const envRecord = join(project, 'child-env');
    writeCodexStub(join(binDir, 'codex'), envRecord);
    vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project);

    expect(existsSync(envRecord)).toBe(false);
    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'unavailable' }),
      }),
    ]);
  });

  it('hands the trusted executable neither an ambient credential nor the real HOME', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const envRecord = join(toolDir, 'child-env');
    writeCodexStub(join(toolDir, 'codex'), envRecord);
    vi.stubEnv('HOME', '/home/real-user');
    vi.stubEnv('SPLITBRIEF_PREFLIGHT_CANARY', 'sk-canary-do-not-leak');
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project);

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'blocker',
        metadata: expect.objectContaining({ unsupported: expect.arrayContaining(['--json']) }),
      }),
    ]);
    const childEnv = readFileSync(envRecord, 'utf8');
    expect(childEnv).not.toContain('/home/real-user');
    expect(childEnv).not.toContain('sk-canary-do-not-leak');
  });

  it('gives every help read one minute', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    writeHelpStub(join(toolDir, 'opencode'), join(toolDir, 'invocations'), {
      '--help': 'opencode-help.txt',
      run: 'opencode-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    vi.mocked(spawnWithTimeout).mockClear();

    await plannerChecks(project, { tool: 'opencode' });

    const helpReads = vi
      .mocked(spawnWithTimeout)
      .mock.calls.filter(([options]) => options.args.includes('--help'));
    expect(helpReads.map(([options]) => options.args)).toEqual([['--help'], ['run', '--help']]);
    expect(helpReads.map(([options]) => options.timeout)).toEqual([60_000, 60_000]);
  });

  it('hands the preparation signal to every help read', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    writeHelpStub(join(toolDir, 'opencode'), join(toolDir, 'invocations'), {
      '--help': 'opencode-help.txt',
      run: 'opencode-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    vi.mocked(spawnWithTimeout).mockClear();
    const controller = new AbortController();

    await collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }),
      projectDir: project,
      roles: ['planner'],
      signal: controller.signal,
    });

    const helpReads = vi
      .mocked(spawnWithTimeout)
      .mock.calls.filter(([options]) => options.args.includes('--help'));
    expect(helpReads).toHaveLength(2);
    for (const [options] of helpReads) expect(options.signal).toBe(controller.signal);
  });

  it('rejects with the abort when the help read stops on the preparation signal', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    writeCodexStub(join(toolDir, 'codex'), join(toolDir, 'child-env'));
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);
    const controller = new AbortController();
    const aborted = abortError(undefined);
    vi.mocked(spawnWithTimeout).mockImplementationOnce(async () => {
      controller.abort();
      throw aborted;
    });

    await expect(
      collectArgVectorPreflightChecks({
        config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
        projectDir: project,
        roles: ['planner'],
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
  });

  it('descends into a yargs subcommand, whose help is the only one advertising --format', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'opencode'), log, {
      '--help': 'opencode-help.txt',
      run: 'opencode-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const topLevel = readFileSync(join(CLI_HELP_FIXTURES, 'opencode-help.txt'), 'utf8');
    expect(topLevel).toContain('opencode run [message..]');
    expect(topLevel).not.toContain('--format');

    const checks = await plannerChecks(project, { tool: 'opencode' });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.opencode.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(helpInvocations(log)).toEqual(['--help', 'run --help']);
  });

  it('descends into an opencode 2 SUBCOMMANDS entry, whose help alone advertises the run flags', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'opencode'), log, {
      '--help': 'opencode-v2-help.txt',
      run: 'opencode-v2-run-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const topLevel = readFileSync(join(CLI_HELP_FIXTURES, 'opencode-v2-help.txt'), 'utf8');
    expect(topLevel).toContain('SUBCOMMANDS');
    expect(topLevel).not.toContain('--model');

    const checks = await plannerChecks(project, { tool: 'opencode' });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.opencode.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(helpInvocations(log)).toEqual(['--help', 'run --help']);
  });

  // Command Code is the other tool whose emitted vector carries short flags — `-p` at index 0
  // and `-m` before the model — so widening the comparison to short flags put its whole
  // invocation at risk of a fabricated blocker. This is its real vector against its own help.
  it("accepts Command Code's short flags against the help the binary itself prints", async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'cmd'), log, { '--help': 'command-code-help.txt' });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project, {
      tool: 'command-code',
      model: 'claude-opus-5',
      effort: 'high',
    });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.command-code.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(helpInvocations(log)).toEqual(['--help']);
  });

  // With no HOME, `cmd` reads the user's own home through the account database. It then shows and
  // clears a pending "Updated X → Y" notice there, so the user never sees it in their next session.
  it('runs the help in a HOME of its own, never the user home', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const hostHome = tempDir('preflight-host-home');
    const envRecord = join(toolDir, 'child-home');
    writeFileSync(
      join(toolDir, 'cmd'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "\${HOME-<unset>}" >> ${JSON.stringify(envRecord)}`,
        `cat ${JSON.stringify(join(CLI_HELP_FIXTURES, 'command-code-help.txt'))}`,
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(toolDir, 'cmd'), 0o755);
    vi.stubEnv('HOME', hostHome);
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    await plannerChecks(project, { tool: 'command-code', model: 'claude-opus-5' });

    const childHome = readFileSync(envRecord, 'utf8').trim();
    expect(childHome).not.toBe('<unset>');
    expect(childHome).not.toBe(hostHome);
    expect(childHome).not.toBe('');
  });

  // The seat carries an effort so the recorded help — where `-c, --config <key=value>` stands
  // alone on its entry line and the description follows indented — is what the short-flag
  // comparison is pinned against, not only the hand-written CODEX_HELP above.
  it('probes the plan, one-shot and resume argv against one fetch of each clap help', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'codex'), log, {
      '--help': 'codex-help.txt',
      exec: 'codex-exec-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project, { tool: 'codex', effort: 'high' });

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(checks[0]?.details).toBeUndefined();
    expect(helpInvocations(log)).toEqual(['--help', 'exec --help']);
  });
});
