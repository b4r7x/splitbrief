import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import {
  checkRunnerArgVector,
  collectArgVectorPreflightChecks,
  semanticConfiguredArgViolations,
} from './arg-vector-preflight.js';

const CLI_HELP_FIXTURES = join(import.meta.dirname, '../../../testing/fixtures/cli-help');

const CODEX_HELP = [
  'Usage: codex exec [OPTIONS]',
  '  -c, --config <key=value>              Override a configuration value',
  '          Examples: - `-c model="o3"` - `-c shell_environment_policy.inherit=all`',
  '      --enable <FEATURE>                Enable a feature (repeatable)',
  '          Equivalent to `-c features.<name>=true`',
  '  --model <MODEL>                       Model to use',
  '  --json                                Emit JSON output',
  '  --sandbox <SANDBOX_MODE>              Sandbox policy',
  '  --ask-for-approval <APPROVAL_POLICY>  Approval policy',
  '  --ignore-user-config                  Do not load the user config',
  '  --ignore-rules                        Do not load rules files',
  '  --ephemeral                           Run without persisting sessions',
  '  --skip-git-repo-check                 Allow running outside a git repo',
  '  -C, --cd <DIR>                        Working directory',
].join('\n');

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

  it('compares the short flag codex spends its reasoning effort on', () => {
    const argv = ['--model', 'gpt-5', '-c', 'model_reasoning_effort=high', 'exec', '--json'];

    expect(checkRunnerArgVector({ argv, helpText: CODEX_HELP })).toEqual({ ok: true });
    expect(
      checkRunnerArgVector({
        argv,
        helpText: [
          'Usage: codex exec [OPTIONS]',
          '  -p, --profile <PROFILE>  Configuration profile',
          '  --model <MODEL>          Model to use',
          '  --json                   Emit JSON output',
        ].join('\n'),
      }),
    ).toEqual({ ok: false, unsupported: ['-c'], deprecated: [] });
  });

  it('reports ok for a help text that advertises no short flag at all', () => {
    const outcome = checkRunnerArgVector({
      argv: ['-c', 'model_reasoning_effort=high', 'exec', '--json'],
      helpText: 'Usage: codex exec [OPTIONS]\n  --json  Emit JSON output',
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('holds a short flag apart from its upper-case namesake', () => {
    const configOnly = [
      'Usage: codex exec [OPTIONS]',
      '  -c, --config <key=value>  Override a configuration value',
      '  --json                    Emit JSON output',
    ].join('\n');

    expect(checkRunnerArgVector({ argv: ['-C', '/tmp', '--json'], helpText: configOnly })).toEqual({
      ok: false,
      unsupported: ['-C'],
      deprecated: [],
    });
    expect(checkRunnerArgVector({ argv: ['-C', '/tmp', '--json'], helpText: CODEX_HELP })).toEqual({
      ok: true,
    });
  });

  it('reads a bare configured value as a value, not as a short flag', () => {
    const helpText = [
      CODEX_HELP,
      '  --max-turns <N>                       Turn cap',
      '  --title <TITLE>                       Session title',
    ].join('\n');

    expect(
      checkRunnerArgVector({ argv: ['exec', '--json', '--max-turns', '-1'], helpText }),
    ).toEqual({ ok: true });
    expect(checkRunnerArgVector({ argv: ['exec', '--json', '--title', '-x'], helpText })).toEqual({
      ok: true,
    });
  });

  it('does not take a short flag quoted in a description as evidence the binary has it', () => {
    const outcome = checkRunnerArgVector({
      argv: ['--model', 'gpt-5', '-c', 'model_reasoning_effort=high', 'exec'],
      helpText: [
        'Usage: codex exec [OPTIONS]',
        '  -p, --profile <PROFILE>               Configuration profile',
        '  --model <MODEL>                       Model to use',
        '      --enable <FEATURE>                Enable a feature (repeatable)',
        '          Equivalent to `-c features.<name>=true`',
      ].join('\n'),
    });
    expect(outcome).toEqual({ ok: false, unsupported: ['-c'], deprecated: [] });
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

  it('emits --effort on the Claude Code implementer argv when config sets it', async () => {
    const checks = await collectArgVectorPreflightChecks({
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
      }),
      projectDir: '/project',
      roles: ['implementer'],
      runHelp: async () =>
        claudeHelp('  --effort <level>               Effort level for the session'),
    });

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.claude-code.arg-vector.implementer',
      severity: 'ok',
    });
    expect(checks[0]?.details).toEqual([
      'Emitted argv: -p --output-format stream-json --verbose --include-partial-messages --model sonnet --effort high --permission-mode acceptEdits',
    ]);
  });

  it('carries the codex planner effort into every emitted vector as a config override', async () => {
    const checks = await collectArgVectorPreflightChecks({
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
    expect(checks[0]?.details).toEqual([
      'Emitted argv: --model gpt-5 -c model_reasoning_effort=high --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --ephemeral --json --cd . <PROMPT>',
      'Emitted argv: --model gpt-5 -c model_reasoning_effort=high --sandbox workspace-write --ask-for-approval never exec --ignore-user-config --json --skip-git-repo-check --cd . <PROMPT>',
      'Emitted argv: -c model_reasoning_effort=high --sandbox read-only --ask-for-approval never exec resume --model gpt-5 --ignore-user-config --ignore-rules --json 00000000-0000-4000-8000-000000000000 <PROMPT>',
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
    const checks = await collectArgVectorPreflightChecks({
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
    const vectors = (checks[0]?.details ?? []).map((detail) =>
      detail.replace('Emitted argv: ', '').split(' '),
    );

    expect(vectors).toHaveLength(3);
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
    collectArgVectorPreflightChecks({
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
    const checks = await opencodePlannerChecksWithVariant(opencodeHelp());

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.opencode.arg-vector.planner',
      severity: 'blocker',
      metadata: { unsupported: ['--variant'] },
    });
  });

  it('reports ok once the binary advertises --variant', async () => {
    const checks = await opencodePlannerChecksWithVariant(
      opencodeHelp('  --variant <name>     Model variant'),
    );

    expect(checks[0]).toMatchObject({
      id: 'runners.cli.opencode.arg-vector.planner',
      severity: 'ok',
    });
    expect(checks[0]?.details).toEqual([
      'Emitted argv: run --model openai/gpt-5.6-luna --variant xhigh --format json --agent plan <PROMPT>',
      'Emitted argv: run --model openai/gpt-5.6-luna --variant xhigh --format json --agent build <PROMPT>',
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

  // The seat carries an effort so the recorded help — where `-c, --config <key=value>` stands
  // alone on its entry line and the description follows indented — is what the short-flag
  // comparison is pinned against, not only the hand-written CODEX_HELP above.
  it('probes the plan, escalate and resume argv against one fetch of each clap help', async () => {
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
    expect(checks[0]?.details).toEqual([
      'Emitted argv: -c model_reasoning_effort=high --sandbox read-only --ask-for-approval never exec --ignore-user-config --ignore-rules --ephemeral --json --cd . <PROMPT>',
      'Emitted argv: -c model_reasoning_effort=high --sandbox workspace-write --ask-for-approval never exec --ignore-user-config --json --skip-git-repo-check --cd . <PROMPT>',
      'Emitted argv: -c model_reasoning_effort=high --sandbox read-only --ask-for-approval never exec resume --ignore-user-config --ignore-rules --json 00000000-0000-4000-8000-000000000000 <PROMPT>',
    ]);
    expect(helpInvocations(log)).toEqual(['--help', 'exec --help']);
  });
});
