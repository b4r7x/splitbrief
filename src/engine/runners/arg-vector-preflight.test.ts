import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  checkRunnerArgVector,
  collectArgVectorPreflightChecks,
  semanticConfiguredArgViolations,
} from './arg-vector-preflight.js';

const CLI_HELP_FIXTURES = join(import.meta.dirname, '../../../testing/fixtures/cli-help');

describe('checkRunnerArgVector', () => {
  it('reports a flag the installed binary does not advertise as unsupported', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec', '--json', '--cd', '.'],
      helpText: 'Usage: codex exec [OPTIONS]\n  --cd <DIR>  Working directory',
    });
    expect(outcome).toEqual({ ok: false, unsupported: ['--json'], deprecated: [] });
  });

  it('reports a flag the binary marks deprecated as deprecated but not unsupported', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec', '--full-auto'],
      helpText: 'Usage: codex exec [OPTIONS]\n  --full-auto  (deprecated) use --sandbox instead',
    });
    expect(outcome).toEqual({ ok: false, unsupported: [], deprecated: ['--full-auto'] });
  });

  it('does not carry a deprecation marker from one option entry to the next', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec', '--json', '--sandbox', 'workspace-write'],
      helpText: [
        'Usage: codex exec [OPTIONS]',
        '  --json                    Emit JSON output',
        '  --sandbox <SANDBOX_MODE>  (deprecated) use --ask-for-approval instead',
      ].join('\n'),
    });
    expect(outcome).toEqual({ ok: false, unsupported: [], deprecated: ['--sandbox'] });
  });

  it('does not mark a flag deprecated because another entry quotes its name', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec', '--sandbox', 'workspace-write'],
      helpText: [
        'Usage: codex exec [OPTIONS]',
        '  --sandbox <SANDBOX_MODE>  Sandbox policy',
        '  --full-auto               (deprecated) use --sandbox instead',
      ].join('\n'),
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('reports ok when every emitted flag is advertised', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec', '--json', '--sandbox', 'workspace-write'],
      helpText: [
        'Usage: codex exec [OPTIONS]',
        '  --json                        Emit JSON output',
        '  --sandbox <SANDBOX_MODE>      Sandbox policy',
        '  --skip-git-repo-check         Allow running outside a git repo',
      ].join('\n'),
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('reports ok for a terse or unparsable help text rather than fabricating blockers', () => {
    const terse = checkRunnerArgVector({
      argv: ['exec', '--json'],
      helpText: 'codex exec -- run codex non-interactively',
    });
    expect(terse).toEqual({ ok: true });

    const empty = checkRunnerArgVector({
      argv: ['exec', '--json'],
      helpText: '',
    });
    expect(empty).toEqual({ ok: true });
  });

  it('reports ok when the emitted argv carries no long flags', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec'],
      helpText: 'Usage: codex exec [OPTIONS]\n  --json  Emit JSON output',
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('reads a flag from a --flag=value token', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec', '--model=gpt-5'],
      helpText: 'Usage: codex exec [OPTIONS]\n  --cd <DIR>  Working directory',
    });
    expect(outcome).toEqual({ ok: false, unsupported: ['--model'], deprecated: [] });
  });
});

describe('checkRunnerArgVector — recorded runner arg-vector failures', () => {
  it.each([
    [
      "error: unexpected argument '--reasoni…'",
      '--reasoning-effort',
      ['exec', '--reasoning-effort', 'high'],
    ],
    ["unexpected argument '--quiet…'", '--quiet', ['exec', '--quiet']],
    ["unexpected argument '--quiet…'", '--quiet', ['exec', '--quiet']],
    ["unexpected argument '--quiet…'", '--quiet', ['exec', '--quiet']],
    ['unexpected stdin read', '--input-format', ['exec', '--input-format', 'json']],
    ['claude session-id error', '--session-id', ['-p', '--session-id', 'session-1']],
  ] as const)(
    '%s maps to an unsupported finding against a help text that omits the flag',
    (_failure, flag, argv) => {
      const helpText = [
        'Usage: tool exec [OPTIONS]',
        '  --json         Emit JSON output',
        '  --cd <DIR>     Working directory',
      ].join('\n');
      const outcome = checkRunnerArgVector({ argv, helpText });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.unsupported).toContain(flag);
    },
  );

  it('maps "warning: --full-auto is deprecated" to a deprecated finding', () => {
    const outcome = checkRunnerArgVector({
      argv: ['exec', '--full-auto'],
      helpText: [
        'Usage: tool exec [OPTIONS]',
        '  --json         Emit JSON output',
        '  --full-auto    Enable fully automatic mode',
        '                 (deprecated)',
      ].join('\n'),
    });
    expect(outcome).toEqual({ ok: false, unsupported: [], deprecated: ['--full-auto'] });
  });
});

describe('semanticConfiguredArgViolations (REQ-018)', () => {
  it('reports authority-bearing long flags in plain and attached value forms', () => {
    expect(semanticConfiguredArgViolations(['--sandbox', 'workspace-write'])).toEqual([
      '--sandbox',
    ]);
    expect(semanticConfiguredArgViolations(['--sandbox=read-only'])).toEqual(['--sandbox']);
    expect(semanticConfiguredArgViolations(['--cwd', '/tmp/work'])).toEqual(['--cwd']);
  });

  it('reports authority-bearing short flags and their attached short forms', () => {
    expect(semanticConfiguredArgViolations(['-y'])).toEqual(['-y']);
    expect(semanticConfiguredArgViolations(['-yyes'])).toEqual(['-y']);
  });

  it('a positional separator does not hide a flag from the scan', () => {
    expect(semanticConfiguredArgViolations(['--', '--session-id', 's1'])).toEqual(['--session-id']);
  });

  it('covers role, permission, approval, config-source, and session aliases', () => {
    expect(semanticConfiguredArgViolations(['--approval-mode', 'acceptEdits'])).toEqual([
      '--approval-mode',
    ]);
    expect(semanticConfiguredArgViolations(['--dangerously-skip-permissions'])).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(semanticConfiguredArgViolations(['--mcp-config', 'x.json'])).toEqual(['--mcp-config']);
    expect(semanticConfiguredArgViolations(['--output-format', 'text'])).toEqual([
      '--output-format',
    ]);
    expect(semanticConfiguredArgViolations(['--resume', 'session-1'])).toEqual(['--resume']);
  });

  it('leaves ordinary configured flags alone', () => {
    expect(
      semanticConfiguredArgViolations(['--model', 'gpt-5', '--verbose', '--max-turns', '5']),
    ).toEqual([]);
  });
});

describe('collectArgVectorPreflightChecks', () => {
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
    expect(check?.fix).toBeUndefined();
  });

  it('reports ok when every emitted flag is advertised', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
    });
    const checks = await collectArgVectorPreflightChecks({
      config,
      projectDir: '/project',
      roles: ['planner', 'implementer', 'reviewer'],
      runHelp: runHelp(
        [
          'Usage: codex exec [OPTIONS]',
          '  --model <MODEL>                   Model to use',
          '  --json                            Emit JSON output',
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
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
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
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
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
    collectArgVectorPreflightChecks({
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['planner'],
      runHelp: async () => helpText,
    });

  it('blocks on the resume and effort flags a binary that omits them would reject', async () => {
    const checks = await plannerChecksWithEffort(claudeHelp());

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.planner',
      severity: 'blocker',
      metadata: { unsupported: ['--effort', '--resume'] },
    });
  });

  it('reports ok once the binary advertises the resume and effort flags', async () => {
    const checks = await plannerChecksWithEffort(
      claudeHelp(
        '  --effort <level>               Effort level for the session',
        '  -r, --resume [sessionId]       Resume a conversation by session ID',
      ),
    );

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.claude-code.arg-vector.planner',
        severity: 'ok',
      }),
    ]);
    expect(checks[0]?.details).toContain(
      'Emitted argv: -p --output-format stream-json --verbose --include-partial-messages --model sonnet --effort high --permission-mode plan',
    );
  });

  it('emits one plan-mode argv for the review seat, with no escalate or resume variant', async () => {
    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'openrouter',
          service: 'openrouter',
          offering: 'payg',
          apiBase: 'https://openrouter.ai/api/v1',
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
        ),
    });

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.reviewer',
      severity: 'ok',
    });
    expect(checks[0]?.details).toEqual([
      'Emitted argv: -p --output-format stream-json --verbose --include-partial-messages --model sonnet --effort high --permission-mode plan',
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

  function plannerChecks(projectDir: string, tool: 'codex' | 'opencode' = 'codex') {
    return collectArgVectorPreflightChecks({
      config: makeConfig({ planner: { kind: 'cli', tool } }),
      projectDir,
      roles: ['planner'],
    });
  }

  function helpInvocations(log: string): string[] {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }

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

    const checks = await plannerChecks(project, 'opencode');

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.opencode.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(helpInvocations(log)).toEqual(['--help', 'run --help']);
  });

  it('probes the plan, escalate and resume argv against one fetch of each clap help', async () => {
    const project = tempDir('preflight-project');
    const toolDir = tempDir('preflight-tools');
    const log = join(toolDir, 'invocations');
    writeHelpStub(join(toolDir, 'codex'), log, {
      '--help': 'codex-help.txt',
      exec: 'codex-exec-help.txt',
    });
    vi.stubEnv('PATH', `${toolDir}${delimiter}${process.env.PATH ?? ''}`);

    const checks = await plannerChecks(project);

    expect(checks).toEqual([
      expect.objectContaining({
        id: 'runners.cli.codex.arg-vector.planner',
        severity: 'ok',
        metadata: expect.objectContaining({ checked: 'help' }),
      }),
    ]);
    expect(checks[0]?.details).toEqual([
      'Emitted argv: --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --ephemeral --json --cd . <PROMPT>',
      'Emitted argv: --sandbox workspace-write --ask-for-approval never exec --ignore-user-config --json --skip-git-repo-check --cd . <PROMPT>',
      'Emitted argv: --sandbox read-only --ask-for-approval never exec resume --ignore-user-config --ignore-rules --json 00000000-0000-4000-8000-000000000000 <PROMPT>',
    ]);
    expect(helpInvocations(log)).toEqual(['--help', 'exec --help']);
  });
});
