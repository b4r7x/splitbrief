import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/validation-fixtures.js';
import {
  checkCommandRefusal,
  sanitizeDiscoveredValidation,
  unsafeCommandReason,
} from './sanitize-discovered-validation.js';
import type { Config } from '../../../core/schemas/config.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';

const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
let recorder = makeBusRecorder();

beforeEach(() => {
  stderr.mockClear();
  recorder = makeBusRecorder();
});

function sanitize(discovered: DiscoveredValidation | null | undefined) {
  return sanitizeDiscoveredValidation(discovered, { bus: recorder.bus, phase: 'researching' });
}

function warnings(): string[] {
  return recorder.events.flatMap((event) => (event.type === 'warning' ? [event.message] : []));
}

function sanitizeResolving(
  discovered: DiscoveredValidation,
  validation: Partial<Config['validation']>,
) {
  return sanitizeDiscoveredValidation(
    discovered,
    { bus: recorder.bus, phase: 'researching' },
    {
      projectDir: '/tmp/splitbrief-fixture',
      config: makeConfig(validation),
      manifest: {},
      stack: null,
    },
  );
}

describe('sanitizeDiscoveredValidation', () => {
  it.each([
    ['', 'names no program'],
    ['./check', 'runs a file by path (./check)'],
    ['unknown test', 'runs a program outside the allowlist (unknown)'],
    ['npx --package=tool check', 'uses the code-loading option npx --package'],
    ['npx -p tool check', 'uses the code-loading option npx -p'],
    ['npx --call=check', 'uses the code-loading option npx --call'],
    ['npx -c check', 'uses the code-loading option npx -c'],
    ['npx -y python3 x', 'passes an operand to python3 (x)'],
    [
      'npx python3 -c x',
      'passes -c to python3; a command through npx takes no -p, --package, -c or --call option',
    ],
    ['npx python3 -', 'reads code from standard input (python3 -)'],
    ['npx python3 -- x', 'uses the script separator python3 --'],
    ['npx python3 -m', 'runs python3 -m without a module name'],
    ['npx python3 -mcustom', 'runs a Python module outside the stack tools (custom)'],
    ['npx python3 --command=x', 'uses the code-loading option python3 --command'],
    [
      'npx --no-install tsc -p tsconfig.json',
      'passes -p to tsc; a command through npx takes no -p, --package, -c or --call option',
    ],
    [
      'npx --no-install tsc --project=x --call=y',
      'passes --call to tsc; a command through npx takes no -p, --package, -c or --call option',
    ],
    [
      'npx --no-install tsc --types node',
      'passes node to tsc; a command through npx takes no tsx, ts-node or node argument',
    ],
    [
      'npx --no-install tsc --types node -p tsconfig.json',
      'passes node to tsc; a command through npx takes no tsx, ts-node or node argument',
    ],
    [
      'npx --no-install tsc --types node --target es2022',
      'passes node to tsc; a command through npx takes no tsx, ts-node or node argument',
    ],
    [
      'npx --no-install tsc --types npm',
      'passes npm to tsc; a validation command takes no npm, pnpm, yarn or bun argument',
    ],
    [
      'npx --no-install vitest run -t npm',
      'passes npm to vitest; a validation command takes no npm, pnpm, yarn or bun argument',
    ],
    [
      'npx --no-install tsc --types uv',
      'passes uv to tsc; a validation command takes no uv or poetry argument',
    ],
    [
      'npx --no-install uv run pytest -k poetry',
      'passes poetry to pytest; a validation command takes no uv or poetry argument',
    ],
    [
      'uv run poetry run pytest -k npm',
      'passes npm to pytest; a validation command takes no npm, pnpm, yarn or bun argument',
    ],
    [
      'npx --no-install vitest tsx',
      'passes tsx to vitest; a command through npx takes no tsx, ts-node or node argument',
    ],
    [
      'npx ./check.js',
      'passes the path ./check.js through npx; a command through npx takes no path arguments',
    ],
    [
      'npx --no-install tsc --project ./tsconfig.json',
      'passes the path ./tsconfig.json through npx; a command through npx takes no path arguments',
    ],
    ['npx tsx check.ts', 'runs the code loader tsx through npx'],
    ['npm exec check', 'runs a package script or binary (npm exec)'],
    ['pnpm dlx check', 'runs a package script or binary (pnpm dlx)'],
    ['npx npm install', 'uses npm install instead of the required npm test'],
    ['npx --no-install npx npm install', 'uses npm install instead of the required npm test'],
    ['pnpm --filter x test node', 'uses pnpm --filter instead of the required pnpm test'],
    ['yarn run check', 'runs a package script or binary (yarn run)'],
    [
      'npm test -- run',
      'passes the argument run to npm test; an npm command takes no run, exec, exec-env or explore argument',
    ],
    [
      'npm test -- exec',
      'passes the argument exec to npm test; an npm command takes no run, exec, exec-env or explore argument',
    ],
    [
      'npm --prefix x run foo',
      'passes the argument run to npm; an npm command takes no run, exec, exec-env or explore argument',
    ],
    [
      'npm -w a exec foo',
      'passes the argument exec to npm; an npm command takes no run, exec, exec-env or explore argument',
    ],
    [
      'pnpm test -- dlx',
      'passes the argument dlx to pnpm test; a pnpm command takes no run, exec or dlx argument',
    ],
    [
      'yarn test -- run',
      'passes the argument run to yarn test; a yarn command takes no run or dlx argument',
    ],
    ['bun run test', 'uses bun run instead of the required bun test'],
    ['npm', 'runs npm without the required test subcommand'],
    [
      'npm test make',
      'passes make to npm test; a validation command takes no make or just argument',
    ],
    [
      'npm test node -e 1',
      'passes node to npm test; a validation command takes no node, python or python3 argument',
    ],
    ['npm test -- src/check.ts', 'passes a path to npm test (src/check.ts)'],
    ['make', 'runs make without a stage target'],
    [
      'vitest -t make',
      'passes make to vitest; a validation command takes no make or just argument',
    ],
    ['make check', 'runs the non-stage target make check'],
    [
      'make test node',
      'passes extra arguments to make test; only one bare stage target is allowed',
    ],
    ['just --shell bash test', 'uses the option just --shell; only a bare stage target is allowed'],
    [
      'just test lint',
      'passes extra arguments to just test; only one bare stage target is allowed',
    ],
    ['uv', 'runs uv without the required run subcommand'],
    ['uv tool run pytest', 'uses uv tool instead of the required uv run'],
    ['poetry run', 'runs poetry run without a Python stack tool'],
    [
      'poetry run custom',
      'requires a Python stack tool directly after poetry run (received custom)',
    ],
    [
      'uv run pytest -k poetry',
      'passes poetry to pytest; a validation command takes no uv or poetry argument',
    ],
    [
      'uv run pytest -k uv run pytest poetry',
      'passes poetry to pytest; a validation command takes no uv or poetry argument',
    ],
    [
      'vitest -t node x',
      'passes node to vitest; a validation command takes no node, python or python3 argument',
    ],
    [
      'vitest -t node --test a.test.js',
      'passes node to vitest; a validation command takes no node, python or python3 argument',
    ],
    [
      'vitest -t node --check a.js',
      'passes node to vitest; a validation command takes no node, python or python3 argument',
    ],
    [
      'vitest -t npm test x.py',
      'passes npm to vitest; a validation command takes no npm, pnpm, yarn or bun argument',
    ],
    ['vitest --config ./check.ts', 'loads a test config by path (vitest --config ./check.ts)'],
    ['jest --config=./check.js', 'loads a test config by path (jest --config ./check.js)'],
    ['jest -c ./check.js', 'loads a test config by path (jest -c ./check.js)'],
    ['npm test && echo done', 'contains a shell operator'],
  ])('names the planner rule that refuses %s', (command, reason) => {
    expect(unsafeCommandReason(command)).toBe(reason);
    if (command.length === 0) return;
    expect(sanitize({ testCommand: command })).toBeUndefined();
    expect(warnings()).toEqual([
      `The test checks do not take ${command} from the plan: it ${reason}. They use config, the manifest or the stack default.`,
    ]);
  });

  it('returns undefined for null input', () => {
    expect(sanitize(null)).toBeUndefined();
    expect(sanitize(undefined)).toBeUndefined();
  });

  it('passes through safe commands unchanged', () => {
    const input: DiscoveredValidation = {
      testCommand: 'npm test',
      language: 'typescript',
      testPattern: '*.test.ts',
    };
    const result = sanitize(input);
    expect(result).toEqual(input);
  });

  it('allows cargo, go, and pytest commands', () => {
    const rust: DiscoveredValidation = {
      testCommand: 'cargo test',
      language: 'rust',
    };
    expect(sanitize(rust)).toEqual(rust);

    const go: DiscoveredValidation = {
      testCommand: 'go test ./...',
      language: 'go',
    };
    expect(sanitize(go)).toEqual(go);

    const python: DiscoveredValidation = {
      testCommand: 'pytest',
      language: 'python',
    };
    expect(sanitize(python)).toEqual(python);
  });

  it('blocks commands with relative paths like ./evil-script', () => {
    const input: DiscoveredValidation = {
      testCommand: './scripts/evil',
      language: 'javascript',
    };
    const result = sanitize(input);
    expect(result?.testCommand).toBeUndefined();
    expect(warnings()).toEqual([expect.stringContaining('./scripts/evil')]);
  });

  it('blocks commands with parent-relative paths', () => {
    const input: DiscoveredValidation = {
      testCommand: '../other-repo/typecheck.sh',
    };
    const result = sanitize(input);
    expect(result).toBeUndefined();
  });

  it('blocks commands with absolute paths', () => {
    const input: DiscoveredValidation = {
      testCommand: '/usr/local/bin/custom-linter',
    };
    const result = sanitize(input);
    expect(result).toBeUndefined();
  });

  it('blocks commands with shell operators', () => {
    const cases = [
      'npm test | grep pass',
      'npm test && echo done',
      'npm test; rm -rf /',
      'npm test `whoami`',
      'npm test $(whoami)',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('blocks node scripts/... code-loading forms', () => {
    const cases = [
      'node scripts/check-invariants.ts',
      'node ./scripts/check.ts',
      'node scripts/foo',
      'node -e "console.log(1)"',
      'node --eval "console.log(1)"',
      'node --require ./evil.js -e ""',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('allows node without script-loading arguments', () => {
    const result = sanitize({ testCommand: 'node --version' });
    expect(result?.testCommand).toBe('node --version');
  });

  it.each([
    'node --watch --test -m pytest',
    'node --test --loader=./setup.mjs -m pytest',
    'node --test --experimental-loader=./setup.mjs -mpytest',
    'node --test --test-reporter=./setup.mjs -m pytest',
    'node --test --test-name-pattern -m pytest',
    'node --build-snapshot --test -mpytest',
    'node --test -mpytest src/a.js',
    'node -m pytest --watch --test',
  ])('preserves base plan and discovery admission for the module form %s', (command) => {
    expect(unsafeCommandReason(command)).toBeNull();
    expect(
      checkCommandRefusal(command, {
        npmScriptsApproved: false,
        packageScripts: { packageJsonExists: false, scripts: {} },
      }),
    ).toBeNull();
    expect(sanitize({ testCommand: command })?.testCommand).toBe(command);
  });

  it.each([
    'node --test test/a.test.js',
    'node --test test/unit/parse.mjs',
    'node --test --test-reporter=tap src/a.test.ts test/b.spec.js',
    'node --test --test-name-pattern=parse test/unit/parse.mjs',
    'node --check src/a.js',
    'node -c scripts/build.js',
  ])('admits %s: it runs only test files, or only parses its file', (command) => {
    expect(sanitize({ testCommand: command })?.testCommand).toBe(command);
    expect(warnings()).toEqual([]);
    expect(
      checkCommandRefusal(command, {
        npmScriptsApproved: false,
        packageScripts: { packageJsonExists: false, scripts: {} },
      }),
    ).toBeNull();
  });

  it.each([
    ['node --test test/', 'passes an operand to node (test/)'],
    ['node --test test/unit/', 'passes an operand to node (test/unit/)'],
    ['node --test src/helper.js', 'passes an operand to node (src/helper.js)'],
    ['node --test test/a.test.js scripts/x.js', 'passes an operand to node (scripts/x.js)'],
    ['node --test test/a.test.js --require', 'passes an operand to node (--require)'],
    ['node --test ../other/a.test.js', 'passes an operand to node (../other/a.test.js)'],
    ['node --test /tmp/a.test.js', 'passes an operand to node (/tmp/a.test.js)'],
    ['node --test test/*.test.js', 'passes an operand to node (test/*.test.js)'],
    ['node --check -r ./setup.js src/a.js', 'uses the code-loading option node -r'],
    ['node --check --build-snapshot src/a.js', 'passes an operand to node (src/a.js)'],
    ['node --test src/test_a.py', 'passes an operand to node (src/test_a.py)'],
    ['node --check /etc/passwd', 'passes a path outside the workspace to node (/etc/passwd)'],
    ['node --check ../x.js', 'passes a path outside the workspace to node (../x.js)'],
    ['node -c ../x.js', 'passes a path outside the workspace to node (../x.js)'],
    ['node --check src/*.js', 'passes an operand to node (src/*.js)'],
    ['node -c src/a?.js', 'passes an operand to node (src/a?.js)'],
    ['node --check src/[ab].js', 'passes an operand to node (src/[ab].js)'],
    ['node --check test/', 'passes an operand to node (test/)'],
    ['node -c --build-snapshot src/a.js', 'uses the code-loading option node -c'],
    ['node --test -c src/a.test.js', 'uses the code-loading option node -c'],
    [
      'node --test --loader=./setup.mjs test/unit/parse.mjs',
      'uses the code-loading option node --loader',
    ],
    [
      'node --loader=./setup.mjs --test test/unit/parse.mjs',
      'uses the code-loading option node --loader',
    ],
    [
      'node --test --experimental-loader=./setup.mjs test/unit/parse.mjs',
      'uses the code-loading option node --experimental-loader',
    ],
    [
      'node --test --build-snapshot test/unit/parse.mjs',
      'uses an unsupported test-file option node --build-snapshot',
    ],
    [
      'node --test --build-snapshot-config=./config.json src/a.test.js',
      'uses an unsupported test-file option node --build-snapshot-config',
    ],
    [
      'node --test --test-reporter=./scripts/reporter.mjs src/a.test.js',
      "loads a test reporter outside Node's built-in reporters (./scripts/reporter.mjs)",
    ],
    [
      'node --test --experimental-config-file=./config.json src/a.test.js',
      'uses an unsupported test-file option node --experimental-config-file',
    ],
    [
      'node --test --test-name-pattern test/unit/parse.mjs',
      'requires --test-name-pattern=<value> before a test file',
    ],
    [
      'node --test --test-global-setup=./scripts/setup.mjs src/a.test.js',
      'uses an unsupported test-file option node --test-global-setup',
    ],
    ['python -c 1', 'uses the code-loading option python -c'],
    ['node scripts/check.js', 'passes an operand to node (scripts/check.js)'],
    ['node -e 1', 'uses the code-loading option node -e'],
    ['node --require=./setup.js --test', 'uses the code-loading option node --require'],
    ['node --run test', 'uses the code-loading option node --run'],
    ['node -', 'reads code from standard input (node -)'],
    ['node -- check.js', 'uses the script separator node --'],
    ['python -m custom_check', 'runs a Python module outside the stack tools (custom_check)'],
    [
      'node --watch --test -m custom_check',
      'runs a Python module outside the stack tools (custom_check)',
    ],
    ['node --test --loader=./setup.mjs -m', 'runs node -m without a module name'],
    ['python -m', 'runs python -m without a module name'],
    ['uv run python -c1', 'uses the code-loading option python -c'],
    ['uv run poetry run python --eval=1', 'uses the code-loading option python --eval'],
  ])('names the interpreter rule that refuses %s', (command, reason) => {
    expect(sanitize({ testCommand: command })).toBeUndefined();
    expect(warnings()).toEqual([
      `The test checks do not take ${command} from the plan: it ${reason}. They use config, the manifest or the stack default.`,
    ]);
    expect(
      checkCommandRefusal(command, {
        npmScriptsApproved: true,
        packageScripts: { packageJsonExists: false, scripts: {} },
      }),
    ).toBe(reason);
  });

  it('blocks npx forms that execute repo-local scripts or code loaders', () => {
    const cases = [
      'npx tsx scripts/pwn.ts',
      'npx node scripts/pwn.js',
      'npx ./scripts/pwn.js',
      'npx --package evil scripts/pwn.js',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it.each([
    'npx NPM run pwn',
    'npx Node pwn',
    'npx npm@10 run pwn',
    'npx NoDe@20 pwn',
    'npx TsX@4 pwn',
    'npx npm@ run pwn',
    'npx Node@ pwn',
    'npx TsX@ pwn',
  ])('refuses a code-running command behind %s', (command) => {
    expect(sanitize({ testCommand: command })).toBeUndefined();
    expect(warnings()).toEqual([expect.stringContaining(`${command} from the plan:`)]);
  });

  it.each([
    'npx tsc --noEmit',
    'npx tsc@5 --noEmit',
    'npx tsc@ --noEmit',
    'npx biome@2 check',
    'npx npm@10 test',
    'npx npm@ test',
    'npx python3 -m pytest',
    'npx --no-install tsc --types python3',
    'vitest node',
    'vitest -t node',
    'vitest -t node -m pytest python3 x.py',
    'vitest -t npm test',
    'vitest -t make test',
    'vitest -t uv run pytest',
    'npm test --types node',
    'npm test --types npm',
    'uv run pytest python',
    'uv run pytest -k python3',
    'uv run pytest -k uv run pytest',
    'uv run pytest',
    'npx --no-install uv run pytest',
    'uv run poetry run pytest',
  ])('keeps an admitted tool form: %s', (command) => {
    expect(sanitize({ testCommand: command })).toEqual({ testCommand: command });
    expect(warnings()).toEqual([]);
  });

  it('blocks npm/pnpm/yarn script runners', () => {
    const cases = ['npm run pwn', 'pnpm run pwn', 'yarn run pwn', 'npm exec scripts/pwn.js'];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('warns once on the run bus that a run script is not taken from the planner', () => {
    const result = sanitize({ language: 'typescript', testCommand: 'npm run unit' });
    expect(result).toEqual({ language: 'typescript' });
    expect(recorder.events).toEqual([
      expect.objectContaining({ type: 'warning', phase: 'researching', category: 'validation' }),
    ]);
    expect(warnings()).toEqual([
      expect.stringMatching(/^The test checks .*npm run unit from the plan:.*package script/),
    ]);
    expect(warnings().join('\n')).not.toMatch(/ignored|sanitize-discovered|allowlist/);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('blames the allowlist only for a program outside it', () => {
    const allowlisted = [
      'npm run lint',
      'node -e "process.exit(0)"',
      'npx tsx scripts/pwn.ts',
      'vitest --config scripts/pwn.js',
      'npm test | grep pass',
    ];
    for (const cmd of allowlisted) sanitize({ testCommand: cmd });
    expect(warnings()).toHaveLength(allowlisted.length);
    expect(warnings().join('\n')).not.toContain('allowlist');

    recorder = makeBusRecorder();
    sanitize({ testCommand: 'custom-lint --all' });
    expect(warnings()).toEqual([expect.stringContaining('outside the allowlist')]);
  });

  it('blocks vitest/jest config paths that load repo-local files', () => {
    const cases = ['vitest --config scripts/pwn.js', 'jest -c scripts/pwn.js'];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('admits uv run pytest, golangci-lint run and make test, still rejects node -e', () => {
    for (const cmd of ['uv run pytest', 'golangci-lint run', 'make test']) {
      expect(sanitize({ testCommand: cmd })?.testCommand).toBe(cmd);
    }
    for (const cmd of ['node -e "process.exit(0)"', 'uv run python -c "print(1)"']) {
      expect(sanitize({ testCommand: cmd })?.testCommand).toBeUndefined();
    }
  });

  it('blocks unrecognized commands', () => {
    const input: DiscoveredValidation = {
      testCommand: 'custom-test-tool --all',
    };
    const result = sanitize(input);
    expect(result?.testCommand).toBeUndefined();
  });

  it('keeps safe fields when the test command is blocked', () => {
    const input: DiscoveredValidation = {
      testCommand: './evil-script',
      language: 'typescript',
      testPattern: '*.test.ts',
    };
    const result = sanitize(input);
    expect(result?.testCommand).toBeUndefined();
    expect(result?.language).toBe('typescript');
    expect(result?.testPattern).toBe('*.test.ts');
  });

  it('blocks traversal testPattern values', () => {
    const result = sanitize({
      testPattern: '../../outside.test.ts',
      language: 'typescript',
    });
    expect(result?.testPattern).toBeUndefined();
    expect(result?.language).toBe('typescript');
    expect(warnings()).toEqual([
      expect.stringMatching(/^The test checks .*\.\.\/\.\.\/outside\.test\.ts from the plan:/),
    ]);
  });

  it('gives each refused testPattern a reason that holds for it', () => {
    const refused = ['..test.ts', 'src/*.test.ts', 'tests\\*.test.ts', '../../outside.test.ts'];
    for (const testPattern of refused) sanitize({ testPattern });
    expect(warnings()).toEqual(
      refused.map((pattern) =>
        expect.stringContaining(
          `${pattern} from the plan: it contains ${pattern.includes('..') ? '".."' : 'a path separator'}.`,
        ),
      ),
    );
  });

  it('names the path separator for a pattern that has one and no ".."', () => {
    const result = sanitize({ language: 'typescript', testPattern: '**/*.test.{ts,tsx}' });
    expect(result).toEqual({ language: 'typescript' });
    expect(warnings()).toEqual([expect.stringContaining(': it contains a path separator.')]);
    expect(warnings().join('\n')).not.toContain('..');
    expect(warnings().join('\n')).toContain("stack's test file patterns");
  });

  it('names ".." for a pattern that climbs out', () => {
    sanitize({ testPattern: '..test.ts' });
    expect(warnings()).toEqual([expect.stringContaining(': it contains "..".')]);
  });

  it('publishes nothing when the test check resolves to the refused command', () => {
    const result = sanitizeResolving(
      { testCommand: 'npm run unit' },
      { testCommand: 'npm run unit' },
    );
    expect(result).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('publishes one warning when the resolved command differs', () => {
    const result = sanitizeResolving({ testCommand: 'npm run unit' }, { testCommand: 'npm test' });
    expect(result).toBeUndefined();
    expect(warnings()).toEqual([
      expect.stringMatching(/^The test checks .*npm run unit from the plan:.*package script/),
    ]);
  });

  it('preserves language and testPattern even when all commands are blocked', () => {
    const input: DiscoveredValidation = {
      testCommand: './evil',
      language: 'javascript',
      testPattern: '*.spec.js',
    };
    const result = sanitize(input);
    expect(result?.testCommand).toBeUndefined();
    expect(result?.language).toBe('javascript');
    expect(result?.testPattern).toBe('*.spec.js');
  });
});

describe('sanitizeDiscoveredValidation — script runners', () => {
  it('blocks the aliases, short forms and exec forms of every package manager', () => {
    const cases = [
      'npm run-script pwn',
      'npm rum pwn',
      'npm run-s pwn',
      'npm x pwn',
      'npm start',
      'npm create pwn',
      'npm --prefix test run-script pwn',
      'pnpm pwn',
      'pnpm run-script pwn',
      'yarn pwn',
      'yarn exec pwn',
      'bun run pwn',
      'bun pwn',
      'bun x pwn',
      'bun exec pwn',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('blocks a path that the test entry passes on', () => {
    const cases = [
      'npm test -- --config scripts/pwn.js',
      'npm test -- --config=pwn.config.ts',
      'npm test --prefix ../other',
      'bun test --preload ./pwn.ts',
      'bun test --preload pwn.ts',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('blocks make and just recipes other than a validation stage', () => {
    const cases = [
      'make pwn',
      'just pwn',
      'make test pwn',
      'make -f pwn.mk test',
      'make test SHELL=./pwn.sh',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('blocks a runner or an unlisted command behind a front-end', () => {
    const cases = [
      'uv run npm run pwn',
      'npx npm run pwn',
      'poetry run make pwn',
      'uv run touch pwn',
      'uv run pwn.py',
      'poetry run pwn',
      'uv tool run pwn',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('blocks node --run and flags spelled with =', () => {
    const cases = ['node --run pwn', 'node --run=pwn', 'npx --package=evil pwn'];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('blocks a script, module or inline program that an interpreter runs', () => {
    const cases = [
      'node pwn.js',
      'node pwn',
      'node -p process.env',
      'python pwn.py',
      'python -m pwn',
      'python -mpwn',
      'python -cimport pwn',
      'uv run python pwn.py',
    ];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('gives each new refusal a reason that holds for it', () => {
    const refusals = [
      ['yarn lint', 'uses yarn lint instead of the required yarn test'],
      ['pnpm --filter web test', 'uses pnpm --filter instead of the required pnpm test'],
      ['npm test --prefix ../other', 'passes a path to npm test (../other)'],
      ['make check', 'runs the non-stage target make check'],
      ['make -j4 test', 'uses the option make -j4; only a bare stage target is allowed'],
      [
        'uv run --frozen pytest',
        'requires a Python stack tool directly after uv run (received --frozen)',
      ],
      ['python -m pwn', 'runs a Python module outside the stack tools (pwn)'],
      ['npx --package=evil pwn', 'uses the code-loading option npx --package'],
    ] as const;
    for (const [cmd] of refusals) sanitize({ testCommand: cmd });
    expect(warnings()).toEqual(
      refusals.map(([cmd, reason]) =>
        expect.stringContaining(`${cmd} from the plan: it ${reason}.`),
      ),
    );
  });

  it('still admits the test entry, the stage targets and Python tools behind a front-end', () => {
    const cases = [
      'npm test',
      'npm test -- --run --reporter=dot',
      'pnpm test',
      'yarn test',
      'bun test',
      'make lint',
      'just typecheck',
      'poetry run pytest',
      'uv run python -m pytest',
      'python -m pytest -rA',
      'node --test',
    ];
    for (const cmd of cases) {
      expect(sanitize({ testCommand: cmd })?.testCommand).toBe(cmd);
    }
    expect(warnings()).toEqual([]);
  });
});

describe('checkCommandRefusal', () => {
  const packageScripts = {
    packageJsonExists: true,
    scripts: { lint: 'biome check', test: 'vitest run', typecheck: 'tsc --noEmit' },
  };
  const scriptsApproved = { npmScriptsApproved: true, packageScripts };

  it('keeps the discovered-validation reason for reuse', () => {
    expect(unsafeCommandReason('npm run lint')).toBe('runs a package script or binary (npm run)');
    expect(unsafeCommandReason('npm test')).toBeNull();
  });

  it('refuses npm run without the plan approval through the discovered-validation policy', () => {
    const withoutApproval = { npmScriptsApproved: false, packageScripts };
    expect(checkCommandRefusal('npm run lint', withoutApproval)).toBe(
      'runs a package script or binary (npm run)',
    );
    expect(checkCommandRefusal('npm run typecheck', withoutApproval)).toBe(
      'runs a package script or binary (npm run)',
    );
  });

  it('admits run test without approval as the bare test it is for npm, pnpm and yarn', () => {
    const withoutApproval = { npmScriptsApproved: false, packageScripts };
    for (const command of ['npm test', 'npm run test', 'pnpm run test', 'yarn run test']) {
      expect(checkCommandRefusal(command, withoutApproval)).toBeNull();
    }
    expect(checkCommandRefusal('npm run test', scriptsApproved)).toBeNull();
    expect(checkCommandRefusal('npm run test -- src/a.test.ts', withoutApproval)).toBe(
      'passes a path to npm test (src/a.test.ts)',
    );
    expect(checkCommandRefusal('npm run test:unit', withoutApproval)).toBe(
      'runs a package script or binary (npm run)',
    );
  });

  it('refuses bun run test without approval: bare bun test is the bun runner, not the script', () => {
    expect(unsafeCommandReason('bun test')).toBeNull();
    expect(unsafeCommandReason('bun run test')).toBe(
      'uses bun run instead of the required bun test',
    );
  });

  it('admits an npm run script only when package.json defines it', () => {
    expect(checkCommandRefusal('npm run lint', scriptsApproved)).toBeNull();
    expect(checkCommandRefusal('npm run typecheck', scriptsApproved)).toBeNull();
    expect(checkCommandRefusal('npm run deploy', scriptsApproved)).toBe(
      'runs the npm script deploy, which package.json does not define',
    );
    expect(
      checkCommandRefusal('npm run lint', {
        npmScriptsApproved: true,
        packageScripts: { packageJsonExists: false, scripts: {} },
      }),
    ).toBe('runs an npm script, but package.json was not found');
  });

  it('refuses npm run without a script name or behind a shell operator', () => {
    expect(checkCommandRefusal('npm run', scriptsApproved)).toBe(
      'runs npm run without a script name',
    );
    expect(checkCommandRefusal('npm run lint && echo done', scriptsApproved)).toBe(
      'contains a shell operator',
    );
  });

  it('admits npx only as an installed stack tool at every approve level', () => {
    for (const approved of [true, false]) {
      const opts = { npmScriptsApproved: approved, packageScripts };
      expect(checkCommandRefusal('npx --no-install tsc --noEmit', opts)).toBeNull();
      expect(checkCommandRefusal('npx --no-install vitest run', opts)).toBeNull();
      expect(checkCommandRefusal('npx --quiet --no-install vitest run', opts)).toBe(
        'runs npx without --no-install as its first option',
      );
      expect(checkCommandRefusal('npx tsc --noEmit', opts)).toBe(
        'runs npx without --no-install as its first option',
      );
      expect(checkCommandRefusal('npx --no-install', opts)).toBe('runs npx without a program');
      expect(checkCommandRefusal('npx some-package', opts)).toBe(
        'runs npx without --no-install as its first option',
      );
      expect(checkCommandRefusal('npx --no-install evil-tool', opts)).toBe(
        'requires a stack tool directly after npx --no-install (received evil-tool)',
      );
      expect(checkCommandRefusal('npx --no-install node -e "process.exit(0)"', opts)).toBe(
        'requires a stack tool directly after npx --no-install (received node)',
      );
      expect(checkCommandRefusal('npx --no-install --quiet vitest run', opts)).toBe(
        'requires a stack tool directly after npx --no-install (received --quiet)',
      );
      expect(checkCommandRefusal('npx --no-install -- vitest run', opts)).toBe(
        'requires a stack tool directly after npx --no-install (received --)',
      );
    }
  });

  it.each([
    'test -e README.md',
    'test -f src/a.js',
    'test -x src/cli.js',
    'test -L docs/readme.md',
  ])('admits the file test %s at every approve level', (command) => {
    for (const npmScriptsApproved of [true, false]) {
      expect(checkCommandRefusal(command, { npmScriptsApproved, packageScripts })).toBeNull();
    }
  });

  const oneFileTest =
    'does not name one file test; a plan check runs test only as test -e, -f, -x or -L <file>';
  it.each([
    ['test', oneFileTest],
    ['test -d src', oneFileTest],
    ['test -h docs/readme.md', oneFileTest],
    ['test -s src/a.js', oneFileTest],
    ['test ! -x src/cli.js', oneFileTest],
    ['test a = b', oneFileTest],
    ['test -x', oneFileTest],
    ['test -x src/a.js src/b.js', oneFileTest],
    ['test -x src/a.js -a -f src/b.js', oneFileTest],
    ['test "$(readlink docs/readme.md)" = "../README.md" && test -f docs/readme.md', oneFileTest],
    ['test -x ../a', 'passes a path outside the workspace to test (../a)'],
    ['test -x /etc/passwd', 'passes a path outside the workspace to test (/etc/passwd)'],
    ['test -x src/*.js', 'passes an operand to test (src/*.js)'],
    ['test -x src/', 'passes an operand to test (src/)'],
    ['test -x -f', 'passes an operand to test (-f)'],
    ['test -x $HOME', 'passes an operand to test ($HOME)'],
    ['TEST -x src/cli.js', 'runs a program outside the allowlist (TEST)'],
    ['[ -x src/cli.js ]', 'runs a program outside the allowlist ([)'],
    ['stat src/cli.js', 'runs a program outside the allowlist (stat)'],
    ['ls -l src', 'runs a program outside the allowlist (ls)'],
    ['readlink docs/readme.md', 'runs a program outside the allowlist (readlink)'],
    ['find src -perm -u+x', 'runs a program outside the allowlist (find)'],
    ['git ls-files -s src/cli.js', 'runs a program outside the allowlist (git)'],
  ])('refuses %s: a plan check reads file state only through one file test', (command, reason) => {
    for (const npmScriptsApproved of [true, false]) {
      expect(checkCommandRefusal(command, { npmScriptsApproved, packageScripts })).toBe(reason);
    }
  });

  it('keeps a file test out of the discovered test command', () => {
    expect(unsafeCommandReason('test -x src/cli.js')).toBe(
      'runs a program outside the allowlist (test)',
    );
    expect(sanitize({ testCommand: 'test -x src/cli.js' })).toBeUndefined();
    expect(warnings()).toEqual([
      'The test checks do not take test -x src/cli.js from the plan: it runs a program outside the allowlist (test). They use config, the manifest or the stack default.',
    ]);
    expect(warnings()[0]).not.toMatch(/\([^()]*\(/);
  });

  it('keeps the discovered-validation policy for every other command', () => {
    expect(checkCommandRefusal('npm test', scriptsApproved)).toBeNull();
    expect(checkCommandRefusal('tsc --noEmit', scriptsApproved)).toBeNull();
    expect(
      checkCommandRefusal('tsc --noEmit', { npmScriptsApproved: false, packageScripts }),
    ).toBeNull();
    expect(checkCommandRefusal('node scripts/deploy.ts', scriptsApproved)).toBe(
      'passes an operand to node (scripts/deploy.ts)',
    );
    expect(checkCommandRefusal('curl https://example.com', scriptsApproved)).toBe(
      'runs a program outside the allowlist (curl)',
    );
    expect(checkCommandRefusal('', scriptsApproved)).toBe('names no program');
  });
});
