import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { buildStageContext, planTestCheck } from './run.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../../core/schemas/config.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { makeConfig } from '#testing/helpers/validation-fixtures.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';

describe('planTestCheck', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('val-layer');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function plan(file: string, config: Config, discovered?: DiscoveredValidation) {
    const ctx = buildStageContext({
      projectDir: tempDir,
      config,
      discoveredValidation: discovered,
      notices: { bus: makeBusRecorder().bus, phase: 'implementing' },
    });
    return planTestCheck(file, ctx);
  }

  it('runs a config-pinned command as written, over the planner and the stack', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    const planned = plan('src/main.rs', makeConfig({ testCommand: 'make test' }), {
      testCommand: 'cargo test',
    });

    expect(planned).toMatchObject({ kind: 'run', command: 'make test', args: ['test'] });
  });

  it('takes the planner command over the stack default', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
    const planned = plan('pkg/x.go', makeConfig({ testCommand: undefined }), {
      testCommand: 'cargo test',
    });

    expect(planned).toMatchObject({ kind: 'run', command: 'cargo test' });
  });

  it.each(['node --test test/unit/parse.mjs', 'node --check src/a.js', 'node -c src/a.js'])(
    'runs the same discovered command for every test check: %s',
    (testCommand) => {
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      for (const file of ['src/a.test.ts', 'src/b.test.ts']) {
        expect(plan(file, makeConfig({ testCommand: undefined }), { testCommand })).toMatchObject({
          kind: 'run',
          command: testCommand,
          resolved: { source: 'discovered' },
        });
      }
    },
  );

  it('takes the manifest test script over the planner command', () => {
    writeFileSync(join(tempDir, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'app.test.js'), '');
    const planned = plan('src/app.js', makeConfig({ testCommand: undefined }), {
      testCommand: 'npx --no-install jest',
    });

    expect(planned).toMatchObject({ kind: 'run', resolved: { cmd: 'npm', source: 'manifest' } });
  });

  it('runs the stack-default cargo test unfiltered for a crate root when the loaded config sets no test_command', () => {
    const configDir = join(tempDir, SPLITBRIEF_DIR);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), YAML.stringify({ version: 3 }), 'utf-8');
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'main.rs'), '#[cfg(test)]\nmod tests {}');

    const { config } = loadConfig(tempDir);
    expect(config.validation.testCommand).toBeUndefined();

    expect(plan('src/main.rs', config)).toMatchObject({
      kind: 'run',
      command: 'cargo test',
      args: ['test'],
    });
  });

  it.each([
    ['tests/api.rs', '#[test]\nfn add_works() {}', 'cargo test --test api'],
    ['src/lib.rs', '#[cfg(test)]\nmod tests {}', 'cargo test'],
    ['src/parser.rs', '#[cfg(test)]\nmod tests {}', 'cargo test -- parser::'],
    ['src/my-mod.rs', '#[cfg(test)]\nmod tests {}', 'cargo test'],
    ['examples/e.rs', '#[cfg(test)]\nmod tests {}', 'cargo test --example e'],
    ['benches/b.rs', '#[cfg(test)]\nmod tests {}', 'cargo test --bench b'],
    [
      'crates/foo/tests/api.rs',
      '#[test]\nfn add_works() {}',
      'cargo test --manifest-path crates/foo/Cargo.toml --test api',
    ],
    [
      'crates/foo/src/x.rs',
      '#[cfg(test)]\nmod tests {}',
      'cargo test --manifest-path crates/foo/Cargo.toml -- x::',
    ],
  ])('runs the Rust tests of %s', (file, content, command) => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    mkdirSync(join(tempDir, 'crates', 'foo'), { recursive: true });
    writeFileSync(join(tempDir, 'crates', 'foo', 'Cargo.toml'), '[package]\nname = "foo"');
    mkdirSync(dirname(join(tempDir, file)), { recursive: true });
    writeFileSync(join(tempDir, file), content);

    expect(plan(file, makeConfig({ testCommand: undefined }))).toMatchObject({
      kind: 'run',
      command,
    });
  });

  it.each([
    ['tests/it/helpers.rs', 'tests/it/main.rs', 'cargo test --test it'],
    [
      'examples/hello/src/lib.rs',
      'examples/hello/Cargo.toml',
      'cargo test --manifest-path examples/hello/Cargo.toml',
    ],
  ])('runs the Rust tests of %s, a file of its own target folder', (file, owner, command) => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    mkdirSync(dirname(join(tempDir, file)), { recursive: true });
    writeFileSync(join(tempDir, owner), '');
    writeFileSync(join(tempDir, file), '#[cfg(test)]\nmod tests {}');

    expect(plan(file, makeConfig({ testCommand: undefined }))).toMatchObject({
      kind: 'run',
      command,
    });
  });

  it.each(['build.rs', 'tests/sub/x.rs'])(
    'skips the Rust file %s that no cargo target runs',
    (file) => {
      writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
      mkdirSync(dirname(join(tempDir, file)), { recursive: true });
      writeFileSync(join(tempDir, file), '#[cfg(test)]\nmod tests {}');

      expect(plan(file, makeConfig({ testCommand: undefined }))).toEqual({
        kind: 'skip',
        reason: 'no affected test file found',
      });
    },
  );

  it('skips when a narrowing command finds no affected test file', () => {
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    writeFileSync(join(tempDir, 'package.json'), '{"scripts":{"test":"vitest run"}}');

    expect(plan('src/app.ts', makeConfig({ testCommand: undefined }))).toEqual({
      kind: 'skip',
      reason: 'no affected test file found',
    });
  });

  it('runs the test file a check names when no test pattern maps it', () => {
    writeFileSync(join(tempDir, 'package.json'), '{"scripts":{"test":"mocha"}}');
    writeFileSync(join(tempDir, 'test.js'), '');

    expect(
      plan('test.js', makeConfig({ testCommand: undefined }), {
        testCommand: 'npm test',
        testPattern: '*.test.js',
      }),
    ).toMatchObject({
      kind: 'run',
      command: 'npm test -- test.js',
      args: ['test', '--', 'test.js'],
    });
  });

  it('skips with its reason on an unrecognised stack', () => {
    expect(plan('src/app.ts', makeConfig({ testCommand: undefined }))).toEqual({
      kind: 'skip',
      reason: 'no test command for an unrecognised stack',
    });
  });

  it('narrows a manifest test script to the affected test file', () => {
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    writeFileSync(join(tempDir, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'a.test.ts'), '');

    expect(plan('src/a.ts', makeConfig({ testCommand: undefined }))).toMatchObject({
      kind: 'run',
      args: ['test', '--', 'src/a.test.ts'],
    });
  });

  it.each([
    'node --test test/unit && node --test test/e2e',
    'node --test; eslint .',
    'node --test | tap-spec',
  ])('runs a chained package test script as written, never with a file after --: %s', (script) => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: script } }));
    mkdirSync(join(tempDir, 'test', 'unit'), { recursive: true });
    writeFileSync(join(tempDir, 'test', 'unit', 'a.test.js'), '');

    expect(plan('test/unit/a.test.js', makeConfig({ testCommand: undefined }))).toMatchObject({
      kind: 'run',
      command: 'npm test',
      args: ['test'],
    });
  });

  it("narrows a python stack with path-arg ''", () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "x"');
    mkdirSync(join(tempDir, 'tests'), { recursive: true });
    writeFileSync(join(tempDir, 'tests', 'test_a.py'), '');

    expect(plan('src/a.py', makeConfig({ testCommand: undefined }))).toMatchObject({
      kind: 'run',
      resolved: { cmd: 'pytest' },
      args: [join('tests', 'test_a.py')],
    });
  });

  it('narrows a go stack with package-arg', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
    mkdirSync(join(tempDir, 'pkg'), { recursive: true });
    writeFileSync(join(tempDir, 'pkg', 'x_test.go'), '');

    expect(plan('pkg/x.go', makeConfig({ testCommand: undefined }))).toMatchObject({
      kind: 'run',
      resolved: { cmd: 'go' },
      args: ['test', './pkg/'],
    });
  });

  it('runs a config-pinned command whole, never narrowed', () => {
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'a.test.ts'), '');

    expect(plan('src/a.ts', makeConfig({ testCommand: 'npm test' }))).toMatchObject({
      kind: 'run',
      command: 'npm test',
      args: ['test'],
    });
  });

  it('does not take an unsafe planner command and falls back to the stack default', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module example.com/test');
    mkdirSync(join(tempDir, 'pkg'), { recursive: true });
    writeFileSync(join(tempDir, 'pkg', 'x_test.go'), '');

    expect(
      plan('pkg/x.go', makeConfig({ testCommand: undefined }), { testCommand: './evil-script' }),
    ).toMatchObject({ kind: 'run', resolved: { cmd: 'go', source: 'default' } });
  });
});
