import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('a stack that narrows by name or package never runs the named file itself', () => {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'api.rs'), 'fn add_works() {}\n');
    mkdirSync(join(dir, 'util'), { recursive: true });
    writeFileSync(join(dir, 'util', 'strings.go'), 'package util\n');
    expect(findAffectedTestFiles('tests/api.rs', dir, rustStack)).toEqual([]);
    expect(findAffectedTestFiles('util/strings.go', dir, goStack)).toEqual([]);
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
      buildTestArgs({ cmd: 'npm', args: ['test'] }, ['src/a.test.ts'], {
        kind: 'path-arg',
        separator: '--',
      }),
    ).toEqual(['test', '--', 'src/a.test.ts']);
  });

  it("path-arg '' appends the targets directly", () => {
    expect(
      buildTestArgs({ cmd: 'pytest', args: [] }, ['tests/test_a.py'], {
        kind: 'path-arg',
        separator: '',
      }),
    ).toEqual(['tests/test_a.py']);
  });

  it('package-arg replaces ./... with the target packages', () => {
    expect(
      buildTestArgs({ cmd: 'go', args: ['test', './...'] }, ['pkg/a_test.go'], {
        kind: 'package-arg',
      }),
    ).toEqual(['test', './pkg/']);
  });

  it('name-filter -- passes the module names', () => {
    expect(
      buildTestArgs({ cmd: 'cargo', args: ['test'] }, ['src/pkg.rs'], {
        kind: 'name-filter',
        flag: '--',
      }),
    ).toEqual(['test', '--', 'pkg']);
  });

  it('name-filter -run joins the names with a pipe', () => {
    expect(
      buildTestArgs({ cmd: 'go', args: ['test'] }, ['pkg/a_test.go', 'pkg/b_test.go'], {
        kind: 'name-filter',
        flag: '-run',
      }),
    ).toEqual(['test', '-run', 'a_test|b_test']);
  });

  it('none leaves the args unchanged', () => {
    expect(buildTestArgs({ cmd: 'make', args: ['test'] }, ['src/a.ts'], { kind: 'none' })).toEqual([
      'test',
    ]);
  });

  it('no target leaves the args unchanged', () => {
    expect(
      buildTestArgs({ cmd: 'go', args: ['test', './...'] }, [], { kind: 'package-arg' }),
    ).toEqual(['test', './...']);
  });
});
