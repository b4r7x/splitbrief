import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readManifestCommands } from '../../validation/manifest-commands.js';
import { detectStack, STACKS } from '../../validation/stacks/registry.js';
import { resolveStageCommand } from '../../validation/stage-command.js';
import { buildValidationChecks, probeValidationBaseline } from './validation.js';

describe('probeValidationBaseline', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('readiness-probe');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('reports a warning when an enabled stage already fails on the working tree', async () => {
    const config = makeConfig({
      validation: {
        typecheck: true,
        lint: false,
        test: true,
        typecheckCommand: 'node -e "process.exit(0)"',
        testCommand: 'node -e "process.exit(1)"',
      },
    });

    const checks = await probeValidationBaseline(config, tempDir);

    const failing = checks.find((c) => c.id === 'validation.already-failing');
    expect(failing).toBeDefined();
    expect(failing?.severity).toBe('warning');
    expect(failing?.summary).toContain('test');
    expect(failing?.summary).not.toContain('typecheck');
  });

  it('names the exact commands the probe ran in the check details', async () => {
    const config = makeConfig({
      validation: {
        typecheck: true,
        lint: true,
        test: true,
        typecheckCommand: 'node -e "process.exit(1)"',
        lintCommand: 'node -e "process.exit(0)"',
        testCommand: 'node -e "process.exit(1)"',
      },
    });

    const checks = await probeValidationBaseline(config, tempDir);

    const failing = checks.find((c) => c.id === 'validation.already-failing');
    expect(failing?.details?.[0]).toContain("typecheck: node -e 'process.exit(1)'");
    expect(failing?.details?.[0]).toContain("lint: node -e 'process.exit(0)'");
    expect(failing?.details?.[0]).toContain("test: node -e 'process.exit(1)'");
    expect(failing?.details?.[1]).toContain('pre-run commands');
    expect(failing?.details?.[1]).toContain('planner discovery');
  });

  it('reports nothing when every enabled stage passes', async () => {
    const config = makeConfig({
      validation: {
        typecheck: true,
        lint: false,
        test: true,
        typecheckCommand: 'node -e "process.exit(0)"',
        testCommand: 'node -e "process.exit(0)"',
      },
    });

    const checks = await probeValidationBaseline(config, tempDir);

    expect(checks).toHaveLength(0);
  });

  it('treats a missing command as not-failing rather than a red baseline', async () => {
    const config = makeConfig({
      validation: {
        typecheck: true,
        lint: false,
        test: false,
        typecheckCommand: 'definitely-not-a-real-command-xyz --check',
      },
    });

    const checks = await probeValidationBaseline(config, tempDir);

    expect(checks).toHaveLength(0);
  });

  it('treats a missing subcommand (exit 101, "no such command") as not-failing', async () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    const config = makeConfig({
      validation: {
        typecheck: false,
        lint: true,
        test: false,
        lintCommand:
          'node -e "process.stderr.write(\'error: no such command: clippy\'); process.exit(101)"',
      },
    });

    const checks = await probeValidationBaseline(config, tempDir);

    expect(checks).toHaveLength(0);
  });
});

describe('buildValidationChecks lint posture', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('readiness-lint');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const packageScripts = { packageJsonExists: false, scripts: {} };

  it('reports lint as skipped instead of on when no lint command resolves', () => {
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    const config = makeConfig({ validation: { typecheck: true, lint: true, test: true } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const configured = checks.find((c) => c.id === 'validation.configured');
    expect(configured?.summary).toContain('lint skipped (no lint command)');
    expect(configured?.summary).not.toContain('lint on');
    expect(configured?.metadata?.['lintCommand']).toBeNull();
  });

  it('reports lint on with the discovered command when a lint package script exists', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      '{"devDependencies":{"typescript":"^5"},"scripts":{"lint":"eslint ."}}',
    );
    const config = makeConfig({ validation: { typecheck: true, lint: true, test: true } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const configured = checks.find((c) => c.id === 'validation.configured');
    expect(configured?.summary).toContain('lint on');
    expect(configured?.metadata?.['lintCommand']).toBe('npm run lint');
    expect(checks.some((c) => c.id === 'validation.lint-unknown')).toBe(false);
  });

  it('reports lint off when the stage is disabled', () => {
    const config = makeConfig({ validation: { typecheck: true, lint: false, test: true } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const configured = checks.find((c) => c.id === 'validation.configured');
    expect(configured?.summary).toContain('lint off');
    expect(configured?.metadata?.['lintCommand']).toBeNull();
  });

  it('points JS/TS projects at ESLint/Biome config discovery', () => {
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    const config = makeConfig({ validation: { typecheck: false, lint: true, test: false } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const info = checks.find((c) => c.id === 'validation.lint-unknown');
    expect(info?.details?.[0]).toContain('ESLint/Biome');
    expect(info?.details?.[0]).not.toContain('rust');
  });

  it('names the stack when its linter config is missing', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "test"');
    const config = makeConfig({ validation: { typecheck: false, lint: true, test: false } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const info = checks.find((c) => c.id === 'validation.lint-unknown');
    expect(info?.details?.[0]).toContain('python');
    expect(info?.details?.[0]).toContain('validation.lintCommand');
  });

  it('reports the stack lint command for a non-JS project that has one', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    const config = makeConfig({ validation: { typecheck: false, lint: true, test: false } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const configured = checks.find((c) => c.id === 'validation.configured');
    expect(configured?.summary).toContain('lint on');
    expect(configured?.metadata?.['lintCommand']).toBe('cargo clippy --no-deps');
    expect(checks.some((c) => c.id === 'validation.lint-unknown')).toBe(false);
  });

  it('resolves no command for an unconfigured stage of an unrecognised stack', () => {
    const config = makeConfig({
      validation: { typecheck: true, lint: true, test: true, testCommand: undefined },
    });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const configured = checks.find((c) => c.id === 'validation.configured');
    expect(configured?.summary).toContain('lint skipped (no lint command)');
    expect(configured?.details?.[0]).toBe('Test command: none (unrecognised stack)');
    expect(configured?.metadata?.['testCommand']).toBeNull();
  });
});

// One file per stack row, so `detectStack` admits the row the loop is standing on.
const STACK_MARKER_FILES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  rust: [['Cargo.toml', '[package]\nname = "x"\n']],
  go: [['go.mod', 'module x\n']],
  python: [['pyproject.toml', '[tool.pytest.ini_options]\n']],
  typescript: [
    ['tsconfig.json', '{}'],
    ['package.json', '{"scripts":{"test":"vitest run"}}'],
  ],
  javascript: [['package.json', '{"scripts":{"test":"vitest run"}}']],
};

describe('buildValidationChecks', () => {
  it('readiness and engine resolve the same command for every stack', () => {
    for (const stack of STACKS) {
      const dir = createTempDir(`readiness-${stack.id}`);
      try {
        for (const [name, content] of STACK_MARKER_FILES[stack.id] ?? []) {
          writeFileSync(join(dir, name), content);
        }
        const config = makeConfig({ validation: { typecheck: true, lint: true, test: true } });
        const engine = resolveStageCommand({
          stage: 'test',
          config,
          manifest: readManifestCommands(dir),
          discovered: undefined,
          stack: detectStack(dir, config.validation.stack),
          projectDir: dir,
        });
        const configured = buildValidationChecks(
          config,
          { packageJsonExists: false, scripts: {} },
          dir,
        ).find((check) => check.id === 'validation.configured');

        expect(engine).not.toBeNull();
        expect(configured?.metadata?.['testCommand']).toBe(
          engine === null ? null : [engine.cmd, ...engine.args].join(' '),
        );
      } finally {
        cleanupTempDir(dir);
      }
    }
  });
});
