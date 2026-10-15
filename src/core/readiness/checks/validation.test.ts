import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readManifestCommands } from '../../validation/manifest-commands.js';
import { detectStack, STACKS } from '../../validation/stacks/registry.js';
import { resolveTestCommand } from '../../validation/stage-command.js';
import { buildValidationChecks } from './validation.js';

describe('buildValidationChecks End-of-run checks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('readiness-end-checks');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const packageScripts = { packageJsonExists: false, scripts: {} };

  it('reports End-of-run checks on by default, with no warning', () => {
    const checks = buildValidationChecks(makeConfig(), packageScripts, tempDir);

    const configured = checks.find((c) => c.id === 'validation.configured');
    expect(configured?.summary).toBe('End-of-run checks: on.');
    expect(configured?.metadata?.['endChecks']).toBe(true);
    expect(checks.some((c) => c.id === 'validation.end-checks-off')).toBe(false);
  });

  it('reports End-of-run checks off and warns that nothing verifies the change', () => {
    const config = makeConfig({ validation: { endChecks: false } });

    const checks = buildValidationChecks(config, packageScripts, tempDir);

    const configured = checks.find((c) => c.id === 'validation.configured');
    expect(configured?.summary).toBe('End-of-run checks: off.');
    expect(configured?.metadata?.['endChecks']).toBe(false);
    const off = checks.find((c) => c.id === 'validation.end-checks-off');
    expect(off?.severity).toBe('warning');
    expect(off?.fix).toContain('validation.end_checks: true');
  });

  it.each(['empty', 'javascript'])(
    'explains how to set a test command for a %s project',
    (stack) => {
      if (stack === 'javascript') {
        writeFileSync(join(tempDir, 'package.json'), '{"name":"example"}');
        expect(detectStack(tempDir)?.id).toBe('javascript');
      }
      const config = makeConfig({ validation: { testCommand: undefined } });

      const checks = buildValidationChecks(config, packageScripts, tempDir);

      const configured = checks.find((c) => c.id === 'validation.configured');
      expect(configured?.details?.[1]).toBe('No test command found.');
      expect(configured?.details?.[2]).toBe(
        'Set validation.test_command in .splitbrief/config.yaml, or set Test command in Settings.',
      );
      expect(configured?.metadata?.['testCommand']).toBeNull();
    },
  );

  it('warns when the test check command names a package script that does not exist', () => {
    const config = makeConfig({ validation: { testCommand: 'npm run unit' } });

    const checks = buildValidationChecks(
      config,
      { packageJsonExists: true, scripts: { test: 'vitest run' } },
      tempDir,
    );

    const missing = checks.find((c) => c.id === 'validation.test-script-missing');
    expect(missing?.summary).toContain('"unit"');
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
        const config = makeConfig();
        const engine = resolveTestCommand({
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
