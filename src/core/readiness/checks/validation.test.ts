import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
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

describe('buildValidationChecks lint-unknown info', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('readiness-lint');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const packageScripts = { packageJsonExists: false, scripts: {} };

  it('points JS/TS projects at ESLint/Biome config discovery', () => {
    writeFileSync(join(tempDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    const config = makeConfig({ validation: { typecheck: false, lint: true, test: false } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const info = checks.find((c) => c.id === 'validation.lint-unknown');
    expect(info?.details?.[0]).toContain('ESLint/Biome');
    expect(info?.details?.[0]).not.toContain('rust');
  });

  it('tells non-JS projects that lint auto-discovery is JS-only and to set lintCommand', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    const config = makeConfig({ validation: { typecheck: false, lint: true, test: false } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const info = checks.find((c) => c.id === 'validation.lint-unknown');
    expect(info?.details?.[0]).toContain('rust');
    expect(info?.details?.[0]).toContain('validation.lintCommand');
  });
});
