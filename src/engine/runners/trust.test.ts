import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../../core/schemas/config.js';
import { matches } from '../../utils/error.js';
import { customRunnerAdmissionError } from './custom-launchability.js';
import { checkRunnerTrust, rejectUntrustedRunners } from './trust.js';
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
  it.each(['claude', 'codex', 'node', 'npm', 'python', 'python3', 'cargo', 'go'])(
    'trusts the bare system command %s',
    (command) => {
      const config = makeConfig(shellConfig(command));
      const result = checkRunnerTrust(config, '/tmp/project');
      expect(result.violations.map((violation) => violation.command)).toEqual([]);
    },
  );

  it('flags package-manager script execution as repo-local execution', () => {
    const config = makeConfig(shellConfig('npm run build'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toContain('npm run build');
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
      expect(result.violations.map((violation) => violation.command)).toContain('local-runner');
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('flags relative-path commands as untrusted', () => {
    const config = makeConfig(shellConfig('./scripts/my-runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toContain(
      './scripts/my-runner',
    );
  });

  it('flags bare repo-relative script paths as untrusted', () => {
    const config = makeConfig(shellConfig('scripts/runner.sh'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toContain('scripts/runner.sh');
  });

  it('flags interpreter args pointing at repo-local scripts as untrusted', () => {
    const config = makeConfig(shellConfig('node scripts/malicious.js'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toContain(
      'node scripts/malicious.js',
    );
  });

  it('does not flag interpreter eval text that mentions repo paths', () => {
    const config = makeConfig(shellConfig('node -e process.stdout.write("file: src/hello.ts")'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toEqual([]);
  });

  it('flags repo-local paths embedded in --flag=path tokens as untrusted', () => {
    for (const flag of ['--import=./scripts/evil.js', '--require=./x.js']) {
      const config = makeConfig(shellConfig(`node ${flag}`));
      const result = checkRunnerTrust(config, '/tmp/project');
      expect(result.violations.map((violation) => violation.command)).toContain(`node ${flag}`);
    }
  });

  it('does not flag --flag=path tokens pointing outside the project dir', () => {
    const config = makeConfig(shellConfig('node --import=/usr/local/lib/safe.js'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toEqual([]);
  });

  it('does not flag value-less flags', () => {
    const config = makeConfig(shellConfig('node --enable-source-maps'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toEqual([]);
  });

  it('flags parent-relative commands as untrusted', () => {
    const config = makeConfig(shellConfig('../other/runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toContain('../other/runner');
  });

  it('flags absolute paths inside project dir as untrusted', () => {
    const config = makeConfig(shellConfig('/tmp/project/bin/runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toContain(
      '/tmp/project/bin/runner',
    );
  });

  it('does not flag absolute paths outside project dir', () => {
    const config = makeConfig(shellConfig('/usr/local/bin/some-tool'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toEqual([]);
  });

  it.each([`sh -c 'cat >/dev/null; echo hi'`, `sh -c '/usr/bin/env true'`])(
    'does not flag the sh -c script %s, whose only paths sit outside the project dir',
    (command) => {
      const config = makeConfig(shellConfig(command));
      const result = checkRunnerTrust(config, '/tmp/project');
      expect(result.violations.map((violation) => violation.command)).toEqual([]);
    },
  );

  it.each([
    `sh -c 'cat >/dev/null; ./scripts/evil.sh'`,
    `sh -c '/bin/sh ./scripts/evil.sh'`,
    `sh -c '/usr/bin/env $1'`,
    `sh -c 'cat >/dev/null; npm test'`,
  ])('flags the sh -c script %s, which reaches project content', (command) => {
    const config = makeConfig(shellConfig(command));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations.map((violation) => violation.command)).toContain(command);
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
    expect(result.violations.map((violation) => violation.command)).toEqual([]);
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

  it('flags a repo-local reviewer command exactly as it flags the same planner command', () => {
    const command = './scripts/review.sh';
    const planner = makeConfig({ planner: { kind: 'shell', command } });
    const reviewer = makeConfig({ reviewer: { kind: 'shell', command } });

    expect(checkRunnerTrust(planner, '/tmp/project').violations).toEqual([
      { label: 'planner', command },
    ]);
    expect(checkRunnerTrust(reviewer, '/tmp/project').violations).toEqual([
      { label: 'reviewer', command },
    ]);
    expect(() =>
      rejectUntrustedRunners({
        config: reviewer,
        projectDir: '/tmp/project',
        allowRepoRunners: false,
      }),
    ).toThrow(/untrusted runner/i);
    expect(() =>
      rejectUntrustedRunners({
        config: reviewer,
        projectDir: '/tmp/project',
        allowRepoRunners: true,
      }),
    ).not.toThrow();
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

    expect(
      checkRunnerTrust(config, '/tmp/project').violations.map((violation) => violation.command),
    ).toContain('bash -c printf "%s" "{prompt}"');
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

    expect(checkRunnerTrust(config, '/tmp/project')).toEqual({ violations: [] });
    expect(() =>
      rejectUntrustedRunners({ config, projectDir: '/tmp/project', allowRepoRunners: false }),
    ).not.toThrow();
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
      expect(
        () =>
          rejectUntrustedRunners({ config, projectDir: '/tmp/project', allowRepoRunners: false }),
        name,
      ).toThrow(/untrusted runner/i);
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
      violations: [
        { label: 'implementer', command: './tools/not-cataloged --json' },
        {
          label: 'implementer profile unsafe',
          command: 'bash -c printf "%s" "{prompt}"',
        },
      ],
    });
    expect(() =>
      rejectUntrustedRunners({ config, projectDir: '/tmp/project', allowRepoRunners: false }),
    ).toThrow(/untrusted runner/i);
  });
});

function flagsCommand(command: string): boolean {
  const config = makeConfig(shellConfig(command));
  return checkRunnerTrust(config, '/tmp/project').violations.length > 0;
}

describe('checkRunnerTrust on an interpreter given a script file', () => {
  it.each([
    'sh run.sh',
    'bash ./x',
    'node index.js',
    'python3 script.py',
    'python3.12 -u script.py',
    'tsx a.ts',
    'deno run a.ts',
    'ruby x.rb',
    'perl x.pl',
    'node --enable-source-maps index.js',
    'node --title runner index.js',
    'node --unknown-option /opt/tools/value.js index.js',
    'bash --rcfile run.sh /opt/tools/run.sh',
    `sh -c 'cat >/dev/null; node index.js'`,
  ])('flags %s, whose script resolves inside the project', (command) => {
    expect(flagsCommand(command)).toBe(true);
  });

  it.each([
    'node /opt/tools/runner.js',
    'node --enable-source-maps /opt/tools/runner.js',
    'python3 -u /opt/tools/runner.py',
    'sh /opt/tools/run.sh',
    'bash',
    'node --version',
    'python3 --version',
  ])('does not flag %s, which runs nothing from the project', (command) => {
    expect(flagsCommand(command)).toBe(false);
  });
});

describe('checkRunnerTrust on module, preload and inline-program flags', () => {
  it.each([
    'python3 -m run',
    'python3 -Im run',
    'python3 -m venv',
    `python3 -c 'import run'`,
    `python3 -c 'print(1)'`,
    'node --require ./x',
    'node --import ./x',
    'node -r ./x',
    'node -r lodash /opt/tools/runner.js',
    'node --import=data:text/javascript,1 /opt/tools/runner.js',
    'node --env-file=.env /opt/tools/runner.js',
    'node --test',
    'node --run build',
    `node -e "require('./x')"`,
    `node -e "import('./x.mjs')"`,
    `node -e "require('node:child_process').execSync('npm test')"`,
    `node -e "process['getBuiltinModule']('child_process')"`,
    `env NODE_OPTIONS='--require ./x.js' node /opt/tools/runner.js`,
    `env NODE_OPTIONS=--import=lodash node /opt/tools/runner.js`,
    `sh -c 'cat >/dev/null; python3 -m venv'`,
  ])('flags %s, which can load a module from the project', (command) => {
    expect(flagsCommand(command)).toBe(true);
  });

  it('flags an inline program that spells a loader with a unicode escape', () => {
    const config = makeConfig({
      implementer: {
        kind: 'shell',
        command: 'node',
        args: ['-e', "\\u0072equire('./x')"],
        model: 'test-model',
      },
    });
    expect(checkRunnerTrust(config, '/tmp/project').violations).toHaveLength(1);
  });

  it.each([
    `node -e "require('node:fs').readFileSync('/etc/hosts')"`,
    'node --import=node:fs /opt/tools/runner.js',
    'env NODE_OPTIONS=--max-old-space-size=4096 node /opt/tools/runner.js',
  ])('does not flag %s, which loads only builtins and outside files', (command) => {
    expect(flagsCommand(command)).toBe(false);
  });
});

describe('checkRunnerTrust on command wrappers', () => {
  it.each([
    `env sh -c 'npm test'`,
    `env -S 'node x.js'`,
    `env -iS 'FOO=1 python3 -m run'`,
    'env FOO=1 node x.js',
    'env PYTHONPATH=/opt/lib python3 /opt/tools/runner.py',
    'nice -n 5 node x.js',
    'nohup python3 -m run',
    'timeout 5 node x.js',
    'timeout -s KILL 5s bash run.sh',
    'stdbuf -oL node x.js',
    'xargs node',
    'time -p node x.js',
    'command node x.js',
    `sh -c 'exec python3 -m run'`,
    'env -C /opt/tools node runner.js',
    'timeout --unknown-flag 5 /usr/bin/true',
    'caffeinate -i python3 /opt/tools/runner.py',
  ])('flags %s, whose wrapped command or form is repo-local', (command) => {
    expect(flagsCommand(command)).toBe(true);
  });

  it.each([
    '/usr/bin/env true',
    'env FOO=1 /usr/bin/true',
    `env -S '/usr/bin/true --flag'`,
    'nice -n 5 /usr/local/bin/some-tool',
    'timeout 5 /usr/local/bin/some-tool --json',
    'nohup /usr/local/bin/some-tool',
    '/usr/local/bin/some-tool exec --json',
    '/usr/local/bin/some-tool env list',
  ])('does not flag %s, whose wrapped command is outside the project', (command) => {
    expect(flagsCommand(command)).toBe(false);
  });
});

describe('checkRunnerTrust on task runners, build tools, test runners and package managers', () => {
  it.each([
    'make',
    'make build',
    '/usr/bin/make -j4 all',
    'make --version --debug',
    'gmake test',
    'just',
    'just deploy',
    'task build',
    'task -v',
    'rake spec',
    'cargo run',
    'cargo test',
    'cargo build',
    'Cargo run',
    'cargo frobnicate',
    'go run main.go',
    'go test',
    'go generate',
    'go build',
    'pytest',
    'pytest --version',
    'py.test -q',
    'tox',
    'tox --version',
    'nox -s tests',
    'uv run pytest',
    'uv version',
    'uvx ruff',
    'poetry run pytest',
    'poetry --version',
    'pipenv run pytest',
    'npm exec vitest',
    'npm x vitest',
    'npm test',
    'npm start',
    'npm install',
    'npm deploy',
    'npx vitest',
    'yarn',
    'yarn build',
    'yarn --version',
    'yarnpkg --version',
    'pnpm build',
    'pnpm exec vitest',
    'pnpm --version',
    'pnpx vitest',
    'bun run build',
    'bun x vitest',
    'bun build',
    'bun test',
    'bunx vitest',
    'deno task build',
    'deno',
    'tsx',
    'ts-node',
    'mvn test',
    'mvn --version',
    'gradle build',
    'gradle --version',
    './gradlew build',
    'sbt test',
    'dotnet run',
    'dotnet test',
    'dotnet --version',
    'mix',
    'mix test',
    'bundle',
    'bundle exec rspec',
    'composer run test',
    'composer --version',
  ])('flags %s, which runs code the project defines', (command) => {
    expect(flagsCommand(command)).toBe(true);
  });

  it('flags bare npx, which starts the script-shell a project .npmrc names (script-shell=./evil.sh ran evil.sh)', () => {
    expect(flagsCommand('npx')).toBe(true);
  });

  it.each([
    'make --version',
    'make -v',
    'make --help',
    'gmake -h',
    'just --version',
    'task --version',
    'rake -V',
    'cargo --version',
    'cargo -V',
    'cargo version',
    'cargo help',
    '/opt/homebrew/bin/cargo --version',
    'go version',
    'go help',
    'nox --version',
    'uv --version',
    'uv help',
    'uvx --version',
    'npm --version',
    'npm -v',
    'npm help',
    'npx --version',
    'bun',
    'bun --version',
    'bunx --help',
    'deno --version',
    'tsx --version',
    'ts-node -v',
    'mix --version',
    'bundle version',
  ])('does not flag %s, which returns before it reads a project file', (command) => {
    expect(flagsCommand(command)).toBe(false);
  });

  it.each([
    'env FOO=1 make build',
    'env cargo test',
    'nice -n 5 cargo test',
    'timeout 5 pytest',
    'timeout 5 npm exec vitest',
    'caffeinate -i make',
    `sh -c 'cat >/dev/null; cargo test'`,
    `sh -c 'go run main.go'`,
  ])('flags %s, whose wrapped task runner runs project code', (command) => {
    expect(flagsCommand(command)).toBe(true);
  });

  it.each(['env make --version', 'nice -n 5 go version', `sh -c 'cargo --version'`])(
    'does not flag %s, whose wrapped task runner only prints its version',
    (command) => {
      expect(flagsCommand(command)).toBe(false);
    },
  );
});

describe('checkRunnerTrust in a project whose files select the toolchain binary', () => {
  function flagsIn(files: readonly string[], command: string): boolean {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-runner-toolchain-'));
    try {
      for (const file of files) {
        mkdirSync(dirname(join(projectDir, file)), { recursive: true });
        writeFileSync(join(projectDir, file), '');
      }
      return checkRunnerTrust(makeConfig(shellConfig(command)), projectDir).violations.length > 0;
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  it.each([
    ['rust-toolchain.toml', 'cargo --version'],
    ['rust-toolchain.toml', 'cargo'],
    ['rust-toolchain', 'cargo help'],
    ['rust-toolchain.toml', 'rustc --version'],
    ['rust-toolchain', 'rustup show'],
    ['rust-toolchain.toml', 'env cargo -V'],
    ['rust-toolchain.toml', `sh -c 'cargo --version'`],
    ['go.mod', 'go version'],
    ['go.work', 'go'],
    ['Gemfile.lock', 'bundle --version'],
    ['.bundle/config', 'bundle version'],
    ['gems.rb.lock', 'bundle --version'],
    ['gem.deps.rb.lock', 'bundle -v'],
    ['Isolate.lock', 'bundle help'],
  ])('flags every form once %s selects the binary: %s', (file, command) => {
    expect(flagsIn([file], command)).toBe(true);
  });

  it.each(['cargo --version', 'rustc --version', 'rustup show', 'go version', 'bundle version'])(
    'does not flag %s in a project with no toolchain file',
    (command) => {
      expect(flagsIn([], command)).toBe(false);
    },
  );

  const rustupProxies = [
    'cargo-clippy',
    'cargo-fmt',
    'cargo-miri',
    'clippy-driver',
    'rls',
    'rust-analyzer',
    'rust-gdb',
    'rust-gdbgui',
    'rust-lldb',
    'rustdoc',
    'rustfmt',
  ];

  it.each(rustupProxies)(
    'flags every form of the rustup proxy %s once a toolchain file exists',
    (proxy) => {
      expect(flagsIn(['rust-toolchain.toml'], `${proxy} --version`)).toBe(true);
      expect(flagsIn(['rust-toolchain'], proxy)).toBe(true);
    },
  );

  it.each([...rustupProxies, 'rustc', 'rustup'])(
    'flags a command whose argument names the toolchain program %s',
    (program) => {
      expect(flagsIn([], `/usr/local/bin/some-tool ${program}`)).toBe(true);
    },
  );

  it.each(rustupProxies)(
    'does not flag %s --version in a project with no toolchain file',
    (proxy) => {
      expect(flagsIn([], `${proxy} --version`)).toBe(false);
    },
  );

  it.each([
    ['rust-toolchain.toml', 'cargo --version'],
    ['rust-toolchain', 'rustfmt --version'],
    ['go.work', 'go version'],
    ['Gemfile.lock', 'bundle --version'],
  ])(
    'flags every form once %s in a parent of the project selects the binary: %s',
    (file, command) => {
      const root = mkdtempSync(join(tmpdir(), 'splitbrief-runner-toolchain-parent-'));
      try {
        writeFileSync(join(root, file), '');
        const projectDir = join(root, 'checkout');
        mkdirSync(projectDir);
        expect(
          checkRunnerTrust(makeConfig(shellConfig(command)), projectDir).violations,
        ).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(realpathSync('/tmp') !== '/private/tmp')(
    'flags cargo --version for a /tmp project once /private/tmp above it holds a toolchain file',
    () => {
      const root = mkdtempSync('/private/tmp/splitbrief-runner-toolchain-tmp-');
      try {
        const projectDir = join('/tmp', basename(root), 'checkout');
        mkdirSync(projectDir);
        const config = makeConfig(shellConfig('cargo --version'));
        expect(checkRunnerTrust(config, projectDir).violations).toEqual([]);
        writeFileSync(join(root, 'rust-toolchain.toml'), '');
        expect(checkRunnerTrust(config, projectDir).violations).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('flags a rustup proxy when the toolchain file is above the resolved path of a symlinked project', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-runner-toolchain-link-'));
    try {
      mkdirSync(join(root, 'volume', 'checkout'), { recursive: true });
      writeFileSync(join(root, 'volume', 'rust-toolchain.toml'), '');
      symlinkSync(join(root, 'volume', 'checkout'), join(root, 'link'));
      const config = makeConfig(shellConfig('rustfmt --version'));
      expect(checkRunnerTrust(config, join(root, 'link')).violations).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rejectUntrustedRunners', () => {
  it('throws for repo-local commands without allowRepoRunners', () => {
    const config = makeConfig(shellConfig('./scripts/evil'));
    expect(() =>
      rejectUntrustedRunners({ config, projectDir: '/tmp/project', allowRepoRunners: false }),
    ).toThrow(/untrusted runner/i);
  });

  it('allows repo-local commands when allowRepoRunners is true', () => {
    const config = makeConfig(shellConfig('./scripts/my-runner'));
    expect(() =>
      rejectUntrustedRunners({ config, projectDir: '/tmp/project', allowRepoRunners: true }),
    ).not.toThrow();
  });

  it('does not throw for a system command', () => {
    const config = makeConfig(shellConfig('opencode'));
    expect(() =>
      rejectUntrustedRunners({ config, projectDir: '/tmp/project', allowRepoRunners: false }),
    ).not.toThrow();
  });
});
