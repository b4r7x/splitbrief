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
  it('returns undefined for null input', () => {
    expect(sanitize(null)).toBeUndefined();
    expect(sanitize(undefined)).toBeUndefined();
  });

  it('passes through safe commands unchanged', () => {
    const input: DiscoveredValidation = {
      typecheckCommand: 'npx tsc --noEmit',
      lintCommand: 'npx biome check',
      testCommand: 'npm test',
      language: 'typescript',
      testPattern: '*.test.ts',
    };
    const result = sanitize(input);
    expect(result).toEqual(input);
  });

  it('allows cargo, go, and pytest commands', () => {
    const rust: DiscoveredValidation = {
      typecheckCommand: 'cargo check',
      lintCommand: 'cargo clippy --no-deps',
      testCommand: 'cargo test',
      language: 'rust',
    };
    expect(sanitize(rust)).toEqual(rust);

    const go: DiscoveredValidation = {
      typecheckCommand: 'go vet ./...',
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
      typecheckCommand: '../other-repo/typecheck.sh',
    };
    const result = sanitize(input);
    expect(result).toBeUndefined();
  });

  it('blocks commands with absolute paths', () => {
    const input: DiscoveredValidation = {
      lintCommand: '/usr/local/bin/custom-linter',
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
    expect(sanitize({ lintCommand: command })).toBeUndefined();
    expect(warnings()).toEqual([expect.stringContaining(`${command} from the planner`)]);
  });

  it.each([
    'npx tsc --noEmit',
    'npx tsc@5 --noEmit',
    'npx tsc@ --noEmit',
    'npx biome@2 check',
    'npx npm@10 test',
    'npx npm@ test',
  ])('keeps an admitted tool form: %s', (command) => {
    expect(sanitize({ lintCommand: command })).toEqual({ lintCommand: command });
    expect(warnings()).toEqual([]);
  });

  it('blocks npm/pnpm/yarn script runners', () => {
    const cases = ['npm run pwn', 'pnpm run pwn', 'yarn run pwn', 'npm exec scripts/pwn.js'];
    for (const cmd of cases) {
      const result = sanitize({ testCommand: cmd });
      expect(result?.testCommand).toBeUndefined();
    }
  });

  it('warns on the run bus, once per stage, that a run script is not taken from the planner', () => {
    const result = sanitize({
      language: 'typescript',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'npm run lint',
      testCommand: 'npm test',
    });
    expect(result).toEqual({ language: 'typescript', testCommand: 'npm test' });
    expect(recorder.events).toEqual([
      expect.objectContaining({ type: 'warning', phase: 'researching', category: 'validation' }),
      expect.objectContaining({ type: 'warning', phase: 'researching', category: 'validation' }),
    ]);
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^The typecheck stage .*npm run typecheck from the planner.*package script/,
      ),
      expect.stringMatching(/^The lint stage .*npm run lint from the planner.*package script/),
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
    for (const cmd of allowlisted) sanitize({ lintCommand: cmd });
    expect(warnings()).toHaveLength(allowlisted.length);
    expect(warnings().join('\n')).not.toContain('allowlist');

    recorder = makeBusRecorder();
    sanitize({ lintCommand: 'custom-lint --all' });
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

  it('keeps safe fields when some commands are blocked', () => {
    const input: DiscoveredValidation = {
      typecheckCommand: 'npx tsc --noEmit',
      testCommand: './evil-script',
      language: 'typescript',
      testPattern: '*.test.ts',
    };
    const result = sanitize(input);
    expect(result?.typecheckCommand).toBe('npx tsc --noEmit');
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
      expect.stringMatching(/^The test stage .*\.\.\/\.\.\/outside\.test\.ts from the planner/),
    ]);
  });

  it('gives each refused testPattern a reason that holds for it', () => {
    const refused = ['..test.ts', 'src/*.test.ts', 'tests\\*.test.ts', '../../outside.test.ts'];
    for (const testPattern of refused) sanitize({ testPattern });
    expect(warnings()).toEqual(
      refused.map((pattern) =>
        expect.stringContaining(
          `${pattern} from the planner: a test pattern may not contain ".." or a path separator`,
        ),
      ),
    );
  });

  it('names the real rule from isTestPatternSafe when it refuses a testPattern', () => {
    const result = sanitize({ language: 'typescript', testPattern: '**/*.test.{ts,tsx}' });
    expect(result).toEqual({ language: 'typescript' });
    const [reason = ''] = warnings();
    expect(reason).toContain('a test pattern may not contain ".." or a path separator');
    expect(reason).toContain("stack's test file patterns apply");
  });

  it('publishes nothing when the stage resolves to the refused command', () => {
    const result = sanitizeResolving(
      { typecheckCommand: 'npm run typecheck' },
      { typecheckCommand: 'npm run typecheck' },
    );
    expect(result).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('publishes one warning when the resolved command differs', () => {
    const result = sanitizeResolving(
      { typecheckCommand: 'npm run typecheck' },
      { typecheckCommand: 'tsc --noEmit' },
    );
    expect(result).toBeUndefined();
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^The typecheck stage .*npm run typecheck from the planner.*package script/,
      ),
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
      ['yarn lint', 'runs a package manager, not as a bare test'],
      ['pnpm --filter web test', 'runs a package manager, not as a bare test'],
      ['npm test --prefix ../other', 'passes a path to the test command'],
      ['make check', 'runs make or just, not on a bare stage'],
      ['make -j4 test', 'runs make or just, not on a bare stage'],
      ['uv run --frozen pytest', 'differs from a bare run of a Python tool'],
      ['python -m pwn', 'runs a script or inline code'],
      ['npx --package=evil pwn', 'runs code through npx'],
    ] as const;
    for (const [cmd] of refusals) sanitize({ testCommand: cmd });
    expect(warnings()).toEqual(
      refusals.map(([cmd, reason]) =>
        expect.stringContaining(`${cmd} from the planner (it ${reason})`),
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
    expect(unsafeCommandReason('npm run lint')).toBe('runs a package script or binary');
    expect(unsafeCommandReason('npm test')).toBeNull();
  });

  it('refuses npm run without the plan approval through the discovered-validation policy', () => {
    const withoutApproval = { npmScriptsApproved: false, packageScripts };
    expect(checkCommandRefusal('npm run lint', withoutApproval)).toBe(
      'runs a package script or binary',
    );
    expect(checkCommandRefusal('npm run typecheck', withoutApproval)).toBe(
      'runs a package script or binary',
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
      expect(checkCommandRefusal('npx tsc --noEmit', opts)).toBe('runs npx without --no-install');
      expect(checkCommandRefusal('npx some-package', opts)).toBe('runs npx without --no-install');
      expect(checkCommandRefusal('npx --no-install evil-tool', opts)).toBe(
        'runs a program outside the stack tools through npx',
      );
      expect(checkCommandRefusal('npx --no-install node -e "process.exit(0)"', opts)).toBe(
        'runs a program outside the stack tools through npx',
      );
    }
  });

  it('keeps the discovered-validation policy for every other command', () => {
    expect(checkCommandRefusal('npm test', scriptsApproved)).toBeNull();
    expect(checkCommandRefusal('tsc --noEmit', scriptsApproved)).toBeNull();
    expect(
      checkCommandRefusal('tsc --noEmit', { npmScriptsApproved: false, packageScripts }),
    ).toBeNull();
    expect(checkCommandRefusal('node scripts/deploy.ts', scriptsApproved)).toBe(
      'runs a script or inline code',
    );
    expect(checkCommandRefusal('curl https://example.com', scriptsApproved)).toBe(
      'runs a program outside the allowlist',
    );
    expect(checkCommandRefusal('', scriptsApproved)).toBe('names no program');
  });
});
