import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_HELP_FIXTURES, CODEX_HELP } from '#testing/helpers/arg-vector-help.js';
import { buildClaudeArgs } from '../../planners/claude-code/args.js';
import { antigravityPlannerAdapter } from '../cli-tools/antigravity/adapter.js';
import { codexPlannerAdapter } from '../cli-tools/codex/adapter.js';
import { checkRunnerArgVector } from './check.js';

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

  it('accepts the schema-bearing Claude Code vector against its installed help', () => {
    const outcome = checkRunnerArgVector({
      argv: buildClaudeArgs({
        projectDir: '/p',
        schema: { json: { type: 'object' } },
      }),
      helpText: readFileSync(join(CLI_HELP_FIXTURES, 'claude-help.txt'), 'utf8'),
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('accepts the schema-bearing Antigravity planner vector against its installed help', () => {
    const outcome = checkRunnerArgVector({
      argv: antigravityPlannerAdapter.baseArgs({
        model: undefined,
        projectDir: '/p',
        configuredArgs: [],
        sessionId: null,
        effort: undefined,
        schema: { json: { type: 'object' } },
      }),
      helpText: readFileSync(join(CLI_HELP_FIXTURES, 'agy-help.txt'), 'utf8'),
    });
    expect(outcome).toEqual({ ok: true });
  });

  // Every fresh Codex planner call sends this vector; it keeps its rollout for sub-agents.
  it('accepts the schema-bearing codex planner fresh vector against its installed help', () => {
    const outcome = checkRunnerArgVector({
      argv: codexPlannerAdapter.baseArgs({
        model: undefined,
        projectDir: '/project',
        configuredArgs: [],
        sessionId: null,
        effort: undefined,
        schema: { json: {}, path: '/tmp/s/schema.json' },
      }),
      helpText:
        readFileSync(join(CLI_HELP_FIXTURES, 'codex-help.txt'), 'utf8') +
        '\n' +
        readFileSync(join(CLI_HELP_FIXTURES, 'codex-exec-help.txt'), 'utf8'),
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('accepts the schema-bearing codex planner resume vector against its installed help', () => {
    const outcome = checkRunnerArgVector({
      argv: codexPlannerAdapter.baseArgs({
        model: 'gpt-5',
        projectDir: '/project',
        configuredArgs: [],
        sessionId: 'session-1',
        effort: 'high',
        schema: { json: {}, path: '/tmp/s/schema.json' },
      }),
      helpText:
        readFileSync(join(CLI_HELP_FIXTURES, 'codex-help.txt'), 'utf8') +
        '\n' +
        readFileSync(join(CLI_HELP_FIXTURES, 'codex-exec-resume-help.txt'), 'utf8'),
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
