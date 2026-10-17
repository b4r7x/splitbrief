import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { buildTestArgs, detectStack, findAffectedTestFiles, isTestScript } from './registry.js';
import { goStack } from './go.js';
import { javascriptStack } from './javascript.js';
import { pythonStack } from './python.js';
import { rustStack } from './rust.js';
import { typescriptStack } from './typescript.js';

describe('detectStack', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('stack-registry');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it('Cargo.toml beats package.json', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '5' } }),
    );
    expect(detectStack(dir)?.id).toBe('rust');
  });

  it('package.json with a typescript dependency selects typescript over javascript', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '5' } }),
    );
    expect(detectStack(dir)?.id).toBe('typescript');
  });

  it('package.json without typescript selects javascript', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(detectStack(dir)?.id).toBe('javascript');
  });

  it('validation.stack pin wins over markers', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '');
    expect(detectStack(dir, 'python')?.id).toBe('python');
  });

  it('no marker returns null', () => {
    expect(detectStack(dir)).toBeNull();
  });
});

describe('isTestScript', () => {
  it('recognises test patterns and test directories across stacks', () => {
    expect(isTestScript('test/unit/parse.mjs')).toBe(true);
    expect(isTestScript('src/a.test.ts')).toBe(true);
    expect(isTestScript('src/test_a.py')).toBe(true);
    expect(isTestScript('src/__tests__/a.ts')).toBe(true);
    expect(isTestScript('tests/conftest.py', [pythonStack])).toBe(true);
    expect(isTestScript('src/a.ts')).toBe(false);
  });

  it('uses only the supplied stacks for a runner', () => {
    expect(isTestScript('test/unit/parse.mjs', [typescriptStack])).toBe(true);
    expect(isTestScript('src/test_a.py', [typescriptStack])).toBe(false);
  });
});

describe('findAffectedTestFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('stack-affected');
    mkdirSync(join(dir, 'src'), { recursive: true });
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it('finds the colocated test and the tests/ mirror', () => {
    writeFileSync(join(dir, 'src', 'a.test.ts'), '');
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'a.test.ts'), '');
    expect(findAffectedTestFiles('src/a.ts', dir, typescriptStack)).toEqual([
      join(dir, 'src', 'a.test.ts'),
      join(dir, 'tests', 'a.test.ts'),
    ]);
  });

  it('a task file that is itself a test is its own target', () => {
    writeFileSync(join(dir, 'src', 'a.test.ts'), '');
    expect(findAffectedTestFiles('src/a.test.ts', dir, typescriptStack)).toEqual([
      join(dir, 'src', 'a.test.ts'),
    ]);
  });

  it('inlineTests marks the task file itself', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '');
    writeFileSync(join(dir, 'src', 'lib.rs'), 'fn main() {}\n#[cfg(test)]\nmod tests {}\n');
    expect(findAffectedTestFiles('src/lib.rs', dir, rustStack)).toEqual([
      join(dir, 'src', 'lib.rs'),
    ]);
  });

  it('a named file no test pattern maps is its own target', () => {
    writeFileSync(join(dir, 'test.js'), '');
    expect(findAffectedTestFiles('test.js', dir, javascriptStack, '*.test.js')).toEqual([
      join(dir, 'test.js'),
    ]);
  });

  it('a named file under a test folder is its own target', () => {
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'api.js'), '');
    expect(findAffectedTestFiles('test/api.js', dir, javascriptStack)).toEqual([
      join(dir, 'test', 'api.js'),
    ]);
  });

  it('a named source file no test maps is no target', () => {
    writeFileSync(join(dir, 'src', 'add.mjs'), '');
    expect(findAffectedTestFiles('src/add.mjs', dir, javascriptStack)).toEqual([]);
  });

  it('a stack that narrows by package never runs the named file itself', () => {
    mkdirSync(join(dir, 'util'), { recursive: true });
    writeFileSync(join(dir, 'util', 'strings.go'), 'package util\n');
    expect(findAffectedTestFiles('util/strings.go', dir, goStack)).toEqual([]);
  });

  it.each([
    ['tests/api.rs', '#[test]\nfn add_works() {}\n'],
    ['crates/foo/tests/api.rs', '#[test]\nfn add_works() {}\n'],
    ['crates/foo/src/x.rs', '#[cfg(test)]\nmod tests {}\n'],
    ['examples/e.rs', '#[cfg(test)]\nmod tests {}\n'],
    ['benches/b.rs', '#[cfg(test)]\nmod tests {}\n'],
  ])('the Rust file %s is its own target', (file, content) => {
    writeFileSync(join(dir, 'Cargo.toml'), '');
    mkdirSync(join(dir, 'crates', 'foo'), { recursive: true });
    writeFileSync(join(dir, 'crates', 'foo', 'Cargo.toml'), '');
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
    expect(findAffectedTestFiles(file, dir, rustStack)).toEqual([join(dir, file)]);
  });

  it.each([
    ['tests/it/main.rs', 'mod helpers;\n'],
    ['tests/it/helpers.rs', '#[test]\nfn works() {}\n'],
    ['examples/multi/main.rs', 'fn main() {}\n'],
    ['benches/multi/main.rs', 'fn main() {}\n'],
  ])('the Rust file %s of a multi-file target is its own target', (file, content) => {
    writeFileSync(join(dir, 'Cargo.toml'), '');
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dirname(join(dir, file)), 'main.rs'), 'fn main() {}\n');
    writeFileSync(join(dir, file), content);
    expect(findAffectedTestFiles(file, dir, rustStack)).toEqual([join(dir, file)]);
  });

  it.each(['examples/hello/src/lib.rs', 'crates/tests/src/lib.rs'])(
    'the Rust file %s of a member crate in a target-named folder is its own target',
    (file) => {
      writeFileSync(join(dir, 'Cargo.toml'), '');
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dirname(dirname(join(dir, file))), 'Cargo.toml'), '');
      writeFileSync(join(dir, file), '#[cfg(test)]\nmod tests {}\n');
      expect(findAffectedTestFiles(file, dir, rustStack)).toEqual([join(dir, file)]);
    },
  );

  it.each([
    ['tests/common/mod.rs', '#[cfg(test)]\nmod tests {}\n'],
    ['build.rs', '#[cfg(test)]\nmod tests {}\n'],
    ['tests/sub/x.rs', '#[cfg(test)]\nmod tests {}\n'],
    ['crates/bar/tests/api.rs', '#[test]\nfn add_works() {}\n'],
    ['crates/bar/src/x.rs', '#[cfg(test)]\nmod tests {}\n'],
  ])('the Rust file %s is no cargo target', (file, content) => {
    writeFileSync(join(dir, 'Cargo.toml'), '');
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
    expect(findAffectedTestFiles(file, dir, rustStack)).toEqual([]);
  });

  it('returns nothing when no test file exists', () => {
    expect(findAffectedTestFiles('src/a.ts', dir, typescriptStack)).toEqual([]);
  });

  it('rejects a traversing test pattern', () => {
    writeFileSync(join(dir, 'src', 'a.test.ts'), '');
    expect(findAffectedTestFiles('src/a.ts', dir, typescriptStack, '../a.test.ts')).toEqual([]);
  });
});

describe('buildTestArgs', () => {
  it("path-arg '--' appends the targets after a separator", () => {
    expect(
      buildTestArgs(
        { cmd: 'npm', args: ['test'] },
        ['src/a.test.ts'],
        {
          kind: 'path-arg',
          separator: '--',
        },
        '.',
      ),
    ).toEqual(['test', '--', 'src/a.test.ts']);
  });

  it("path-arg '' appends the targets directly", () => {
    expect(
      buildTestArgs(
        { cmd: 'pytest', args: [] },
        ['tests/test_a.py'],
        {
          kind: 'path-arg',
          separator: '',
        },
        '.',
      ),
    ).toEqual(['tests/test_a.py']);
  });

  it('package-arg replaces ./... with the target packages', () => {
    expect(
      buildTestArgs(
        { cmd: 'go', args: ['test', './...'] },
        ['pkg/a_test.go'],
        {
          kind: 'package-arg',
        },
        '.',
      ),
    ).toEqual(['test', './pkg/']);
  });

  let cargoDir: string;
  beforeAll(() => {
    cargoDir = createTempDir('stack-cargo');
    for (const file of [
      'Cargo.toml',
      'crates/foo/Cargo.toml',
      'crates/tests/Cargo.toml',
      'examples/hello/Cargo.toml',
      'tests/it/main.rs',
      'examples/multi/main.rs',
      'benches/multi/main.rs',
    ]) {
      mkdirSync(dirname(join(cargoDir, file)), { recursive: true });
      writeFileSync(join(cargoDir, file), '');
    }
  });
  afterAll(() => {
    cleanupTempDir(cargoDir);
  });

  it.each([
    [['tests/api.rs'], ['test', '--test', 'api']],
    [
      ['tests/api.rs', 'tests/cli.rs'],
      ['test', '--test', 'api', '--test', 'cli'],
    ],
    [['src/parser.rs'], ['test', '--', 'parser::']],
    [['src/a/b.rs'], ['test', '--', 'a::b::']],
    [
      ['src/a/b/mod.rs', 'src/parser.rs'],
      ['test', '--', 'a::b::', 'parser::'],
    ],
    [['src/tests/x.rs'], ['test', '--', 'tests::x::']],
    [['src/lib.rs'], ['test']],
    [['src/main.rs'], ['test']],
    [['src/bin/tool.rs'], ['test']],
    [['src/my-mod.rs'], ['test']],
    [['src/lib.rs', 'src/parser.rs'], ['test']],
    [['tests/api.rs', 'src/parser.rs'], ['test']],
    [['examples/e.rs'], ['test', '--example', 'e']],
    [['benches/b.rs'], ['test', '--bench', 'b']],
    [
      ['crates/foo/tests/api.rs'],
      ['test', '--manifest-path', 'crates/foo/Cargo.toml', '--test', 'api'],
    ],
    [['crates/foo/src/x.rs'], ['test', '--manifest-path', 'crates/foo/Cargo.toml', '--', 'x::']],
    [['crates/foo/src/lib.rs'], ['test', '--manifest-path', 'crates/foo/Cargo.toml']],
    [['tests/it/main.rs'], ['test', '--test', 'it']],
    [['tests/it/helpers.rs'], ['test', '--test', 'it']],
    [['tests/common/mod.rs'], null],
    [['examples/multi/main.rs'], ['test', '--example', 'multi']],
    [['benches/multi/util.rs'], ['test', '--bench', 'multi']],
    [['examples/hello/src/lib.rs'], ['test', '--manifest-path', 'examples/hello/Cargo.toml']],
    [
      ['crates/tests/src/a.rs'],
      ['test', '--manifest-path', 'crates/tests/Cargo.toml', '--', 'a::'],
    ],
    [['build.rs'], null],
    [['tests/sub/x.rs'], null],
    [['crates/foo/src/x.rs', 'src/parser.rs'], null],
  ])('cargo selects the tests of %j', (targets, expected) => {
    expect(
      buildTestArgs({ cmd: 'cargo', args: ['test'] }, targets, rustStack.narrowing, cargoDir),
    ).toEqual(expected);
  });

  it('none leaves the args unchanged', () => {
    expect(
      buildTestArgs({ cmd: 'make', args: ['test'] }, ['src/a.ts'], { kind: 'none' }, '.'),
    ).toEqual(['test']);
  });

  it('no target leaves the args unchanged', () => {
    expect(
      buildTestArgs({ cmd: 'go', args: ['test', './...'] }, [], { kind: 'package-arg' }, '.'),
    ).toEqual(['test', './...']);
  });
});
