import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../../core/schemas/config.js';
import { matches } from '../../utils/error.js';
import { checkRunnerTrust, customRunnerAdmissionError, rejectUntrustedRunners } from './trust.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

type ConfigOverrides = NonNullable<Parameters<typeof makeConfig>[0]>;

function shellConfig(command: string): ConfigOverrides {
  return {
    implementer: {
      kind: 'shell',
      command,
      model: 'test-model',
    },
  };
}

function withCustomCommands(config: ReturnType<typeof makeConfig>, customCommands: unknown) {
  return ConfigSchema.parse({ ...config, customCommands });
}

describe('custom runner admission errors', () => {
  it('preserves typed discriminators, messages, and empty data', () => {
    const invalid = customRunnerAdmissionError.invalid();
    const plannerDenied = customRunnerAdmissionError.denied('planner');
    const implementerDenied = customRunnerAdmissionError.denied('implementer');
    const scopeMismatch = customRunnerAdmissionError.scopeMismatch();
    const executableMissing = customRunnerAdmissionError.executableMissing();
    const executableDrifted = customRunnerAdmissionError.executableDrifted();
    const resolutionDrifted = customRunnerAdmissionError.executableResolutionDrifted();

    expect(matches('custom-runner-admission-invalid')(invalid)).toBe(true);
    expect(invalid).toMatchObject({
      kind: 'custom-runner-admission-invalid',
      message: 'Custom runner admission is invalid.',
    });
    expect(matches('custom-runner-admission-denied')(plannerDenied)).toBe(true);
    expect(plannerDenied.message).toBe('Configured custom planner admission was denied.');
    expect(matches('custom-runner-admission-denied')(implementerDenied)).toBe(true);
    expect(implementerDenied.message).toBe('Configured custom runner admission was denied.');
    expect(matches('custom-runner-admission-scope-mismatch')(scopeMismatch)).toBe(true);
    expect(scopeMismatch).toMatchObject({
      kind: 'custom-runner-admission-scope-mismatch',
      message: 'Custom runner admission no longer matches this project and definition.',
    });
    expect(matches('custom-runner-executable-missing')(executableMissing)).toBe(true);
    expect(executableMissing).toMatchObject({
      kind: 'custom-runner-executable-missing',
      message:
        'Custom runner executable is no longer available. Re-run custom runner admission before execution.',
    });
    expect(matches('custom-runner-executable-drifted')(executableDrifted)).toBe(true);
    expect(executableDrifted).toMatchObject({
      kind: 'custom-runner-executable-drifted',
      message:
        'Custom runner executable identity changed. Re-run custom runner admission before execution.',
    });
    expect(matches('custom-runner-executable-resolution-drifted')(resolutionDrifted)).toBe(true);
    expect(resolutionDrifted).toMatchObject({
      kind: 'custom-runner-executable-resolution-drifted',
      message: 'Custom runner executable no longer resolves to the admitted identity.',
    });

    for (const value of [
      invalid,
      plannerDenied,
      implementerDenied,
      scopeMismatch,
      executableMissing,
      executableDrifted,
      resolutionDrifted,
    ]) {
      expect(value.data).toBeUndefined();
    }
  });
});

describe('checkRunnerTrust', () => {
  it('trusts system commands like claude and codex', () => {
    const config = makeConfig(shellConfig('claude'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('trusts node, npx, and other common tools', () => {
    for (const cmd of ['node', 'npx', 'npm', 'python', 'python3', 'cargo', 'go']) {
      const config = makeConfig(shellConfig(cmd));
      const result = checkRunnerTrust(config, '/tmp/project');
      expect(result.untrustedCommands).toEqual([]);
    }
  });

  it('flags package-manager script execution as repo-local execution', () => {
    const config = makeConfig(shellConfig('npm run build'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('npm run build');
  });

  it('flags bare commands that PATH resolves inside the project', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-runner-trust-'));
    const savedPath = process.env['PATH'];
    try {
      const binDir = join(projectDir, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const runner = join(binDir, 'local-runner');
      writeFileSync(runner, '#!/bin/sh\n');
      chmodSync(runner, 0o755);
      process.env['PATH'] = [binDir, savedPath].filter(Boolean).join(delimiter);

      const config = makeConfig(shellConfig('local-runner'));
      const result = checkRunnerTrust(config, projectDir);
      expect(result.untrustedCommands).toContain('local-runner');
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('flags relative-path commands as untrusted', () => {
    const config = makeConfig(shellConfig('./scripts/my-runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('./scripts/my-runner');
  });

  it('flags bare repo-relative script paths as untrusted', () => {
    const config = makeConfig(shellConfig('scripts/runner.sh'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('scripts/runner.sh');
  });

  it('flags interpreter args pointing at repo-local scripts as untrusted', () => {
    const config = makeConfig(shellConfig('node scripts/malicious.js'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('node scripts/malicious.js');
  });

  it('does not flag interpreter eval text that mentions repo paths', () => {
    const config = makeConfig(shellConfig('node -e process.stdout.write("file: src/hello.ts")'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('flags repo-local paths embedded in --flag=path tokens as untrusted', () => {
    for (const flag of ['--import=./scripts/evil.js', '--require=./x.js']) {
      const config = makeConfig(shellConfig(`node ${flag}`));
      const result = checkRunnerTrust(config, '/tmp/project');
      expect(result.untrustedCommands).toContain(`node ${flag}`);
    }
  });

  it('does not flag --flag=path tokens pointing outside the project dir', () => {
    const config = makeConfig(shellConfig('node --import=/usr/local/lib/safe.js'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('does not flag value-less flags', () => {
    const config = makeConfig(shellConfig('node --enable-source-maps'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('flags parent-relative commands as untrusted', () => {
    const config = makeConfig(shellConfig('../other/runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('../other/runner');
  });

  it('flags absolute paths inside project dir as untrusted', () => {
    const config = makeConfig(shellConfig('/tmp/project/bin/runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('/tmp/project/bin/runner');
  });

  it('does not flag absolute paths outside project dir', () => {
    const config = makeConfig(shellConfig('/usr/local/bin/some-tool'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('ignores non-shell/agent runners', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'test',
        apiBase: 'http://localhost:11434/v1',
      },
    });
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('flags repo-local implementer profile commands', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'test',
        apiBase: 'http://localhost:11434/v1',
      },
      implementerProfiles: {
        default: 'safe',
        profiles: {
          safe: {
            kind: 'api',
            provider: 'ollama',
            model: 'test',
            apiBase: 'http://localhost:11434/v1',
          },
          local: {
            kind: 'agent',
            command: './scripts/agent',
            model: 'agent-default',
          },
        },
      },
    });

    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations).toContainEqual({
      label: 'implementer profile local',
      command: './scripts/agent',
    });
  });

  it('flags shell-evaluated prompt placeholders for agent implementers', () => {
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: 'bash',
        args: ['-c', 'printf "%s" "{prompt}"'],
        model: 'agent-default',
      },
    });

    expect(checkRunnerTrust(config, '/tmp/project').untrustedCommands).toContain(
      'bash -c printf "%s" "{prompt}"',
    );
  });

  it('skips exact configured custom tuples for planner, default implementer, and profile rows', () => {
    const config = withCustomCommands(
      makeConfig({
        planner: {
          kind: 'shell',
          command: './tools/plan',
          args: ['--json'],
          outputFormat: 'text',
          idleWarnMs: 1_000,
          idleKillMs: 2_000,
          env: ['PLANNER_TOKEN'],
        },
        implementer: {
          kind: 'agent',
          command: './tools/apply',
          args: ['--write'],
          outputFormat: 'jsonl',
          idleWarnMs: 1_100,
          idleKillMs: 2_100,
          env: ['IMPLEMENTER_TOKEN'],
          model: 'local-agent',
        },
        implementerProfiles: {
          default: 'reviewer',
          profiles: {
            reviewer: {
              kind: 'shell',
              command: './tools/review',
              args: ['--diff'],
              outputFormat: 'stream-json',
              idleWarnMs: 1_200,
              idleKillMs: 2_200,
              env: ['PROFILE_B', 'PROFILE_A'],
              model: 'local-reviewer',
            },
          },
        },
      }),
      {
        plan: {
          label: 'Configured planner',
          contract: 'output',
          executable: './tools/plan',
          argv: ['--json'],
          outputFormat: 'text',
          idleWarnMs: 1_000,
          idleKillMs: 2_000,
          env: ['PLANNER_TOKEN'],
        },
        apply: {
          label: 'Configured implementer',
          contract: 'direct',
          executable: './tools/apply',
          argv: ['--write'],
          outputFormat: 'jsonl',
          idleWarnMs: 1_100,
          idleKillMs: 2_100,
          env: ['IMPLEMENTER_TOKEN'],
        },
        review: {
          label: 'Configured profile',
          contract: 'output',
          executable: './tools/review',
          argv: ['--diff'],
          outputFormat: 'stream-json',
          idleWarnMs: 1_200,
          idleKillMs: 2_200,
          env: ['PROFILE_A', 'PROFILE_B'],
        },
      },
    );

    expect(checkRunnerTrust(config, '/tmp/project')).toEqual({
      untrustedCommands: [],
      violations: [],
    });
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).not.toThrow();
  });

  it('keeps every diverged execution tuple in the legacy trust gate', () => {
    const customCommands = {
      review: {
        label: 'Configured review',
        contract: 'output' as const,
        executable: './tools/review',
        argv: ['--json'],
        outputFormat: 'text' as const,
        idleWarnMs: 1_000,
        idleKillMs: 2_000,
        env: ['ALPHA', 'BETA'],
      },
    };
    const shellPlanner = (overrides: {
      command?: string;
      args?: string[];
      outputFormat?: 'text' | 'jsonl';
      idleWarnMs?: number;
      idleKillMs?: number;
      env?: string[];
    }) =>
      withCustomCommands(
        makeConfig({
          planner: {
            kind: 'shell',
            command: overrides.command ?? './tools/review',
            args: overrides.args ?? ['--json'],
            outputFormat: overrides.outputFormat ?? 'text',
            idleWarnMs: overrides.idleWarnMs ?? 1_000,
            idleKillMs: overrides.idleKillMs ?? 2_000,
            env: overrides.env ?? ['ALPHA', 'BETA'],
          },
        }),
        customCommands,
      );
    const cases = [
      ['executable', shellPlanner({ command: './tools/other' }), './tools/other --json'],
      ['argv', shellPlanner({ args: ['--text'] }), './tools/review --text'],
      ['output format', shellPlanner({ outputFormat: 'jsonl' }), './tools/review --json'],
      ['idle warning', shellPlanner({ idleWarnMs: 1_100 }), './tools/review --json'],
      ['idle kill', shellPlanner({ idleKillMs: 2_100 }), './tools/review --json'],
      ['environment', shellPlanner({ env: ['ALPHA', 'GAMMA'] }), './tools/review --json'],
      [
        'contract',
        withCustomCommands(
          makeConfig({
            planner: {
              kind: 'agent',
              command: './tools/review',
              args: ['--json'],
              outputFormat: 'text',
              idleWarnMs: 1_000,
              idleKillMs: 2_000,
              env: ['ALPHA', 'BETA'],
            },
          }),
          customCommands,
        ),
        './tools/review --json',
      ],
    ] as const;

    for (const [name, config, command] of cases) {
      expect(checkRunnerTrust(config, '/tmp/project').violations, name).toEqual([
        { label: 'planner', command },
      ]);
      expect(() => rejectUntrustedRunners(config, '/tmp/project', false), name).toThrow(
        /untrusted runner/i,
      );
    }
  });

  it('keeps safe, unsafe, and noncatalog repo-local rows rejected beside a configured custom tuple', () => {
    const config = withCustomCommands(
      makeConfig({
        planner: {
          kind: 'shell',
          command: './tools/cataloged',
          args: ['--json'],
        },
        implementer: {
          kind: 'shell',
          command: './tools/not-cataloged',
          args: ['--json'],
          model: 'local-shell',
        },
        implementerProfiles: {
          default: 'unsafe',
          profiles: {
            unsafe: {
              kind: 'agent',
              command: 'bash',
              args: ['-c', 'printf "%s" "{prompt}"'],
              model: 'local-agent',
            },
          },
        },
      }),
      {
        cataloged: {
          label: 'Cataloged planner',
          contract: 'output',
          executable: './tools/cataloged',
          argv: ['--json'],
        },
      },
    );

    expect(checkRunnerTrust(config, '/tmp/project')).toEqual({
      untrustedCommands: ['./tools/not-cataloged --json', 'bash -c printf "%s" "{prompt}"'],
      violations: [
        { label: 'implementer', command: './tools/not-cataloged --json' },
        {
          label: 'implementer profile unsafe',
          command: 'bash -c printf "%s" "{prompt}"',
        },
      ],
    });
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).toThrow(
      /untrusted runner/i,
    );
  });
});

describe('rejectUntrustedRunners', () => {
  it('throws for repo-local commands without allowRepoRunners', () => {
    const config = makeConfig(shellConfig('./scripts/evil'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).toThrow(
      /untrusted runner/i,
    );
  });

  it('allows repo-local commands when allowRepoRunners is true', () => {
    const config = makeConfig(shellConfig('./scripts/my-runner'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', true)).not.toThrow();
  });

  it('allows system commands without allowHooks', () => {
    const config = makeConfig(shellConfig('aider'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).not.toThrow();
  });
});
