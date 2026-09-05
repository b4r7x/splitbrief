import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createProductionDetectionDeps } from './deps.js';

const STATE_SOURCE_ENV = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] as const;

function writeShim(dir: string, name: string, lines: readonly string[]): string {
  const argsLog = join(dir, `${name}.args`);
  const executable = join(dir, name);
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'args=$(printf \'%s|\' "$@")',
      `printf '%s\\n' "$args" >> ${JSON.stringify(argsLog)}`,
      ...lines,
    ].join('\n'),
    'utf8',
  );
  chmodSync(executable, 0o755);
  return argsLog;
}

function seedSessionState(homeDir: string, relativePath: string): void {
  const target = join(homeDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '{"session":"stub"}\n', 'utf8');
}

describe.runIf(process.platform !== 'win32')('native catalog discovery scope', () => {
  let shimDir: string;
  let homeDir: string;
  let projectDir: string;
  let savedEnv: readonly (readonly [string, string | undefined])[];

  beforeEach(() => {
    shimDir = createTempDir('catalog-scope-shims');
    homeDir = createTempDir('catalog-scope-home');
    projectDir = createTempDir('catalog-scope-project');
    savedEnv = ['PATH', ...STATE_SOURCE_ENV].map((name) => [name, process.env[name]] as const);
    process.env.PATH = shimDir;
    process.env.HOME = homeDir;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    seedSessionState(homeDir, '.local/share/opencode/auth.json');
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanupTempDir(shimDir);
    cleanupTempDir(homeDir);
    cleanupTempDir(projectDir);
  });

  it('carries manual catalog refresh through the production dependency closure', async () => {
    const argsLog = writeShim(shimDir, 'opencode', [
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' '0.5.0'",
      '  exit 0',
      'fi',
      "printf '%s\\n' 'openai/gpt-5.4'",
    ]);

    const deps = createProductionDetectionDeps({
      config: makeConfig({ planner: { kind: 'cli', tool: 'opencode' } }),
      projectDir,
    });
    const attempts = await deps.discoverAllCliTools({
      mode: 'manual',
      signal: new AbortController().signal,
    });

    const opencodePlanner = attempts.find(
      (attempt) => attempt.connection.role === 'planner' && attempt.connection.tool === 'opencode',
    );
    expect(opencodePlanner).toEqual(
      expect.objectContaining({
        outcome: { kind: 'success', value: [{ id: 'openai/gpt-5.4', nativeOrder: 0 }] },
      }),
    );
    expect(existsSync(argsLog)).toBe(true);
    expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toContain(
      'models|--verbose|--refresh|',
    );
  });

  it('probes a non-active opencode and keeps every provider variant of a duplicated model', async () => {
    writeShim(shimDir, 'codex', [
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' 'codex-cli 0.146.0'",
      '  exit 0',
      'fi',
      'exit 0',
    ]);
    const opencodeArgsLog = writeShim(shimDir, 'opencode', [
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' '1.18.10'",
      '  exit 0',
      'fi',
      'if [ "$1" = "models" ]; then',
      "  printf '%s\\n' 'ollama-cloud/deepseek-v4-flash'",
      "  printf '%s\\n' 'opencode-go/deepseek-v4-flash'",
      '  exit 0',
      'fi',
      'exit 0',
    ]);

    const deps = createProductionDetectionDeps({
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      projectDir,
    });
    const attempts = await deps.discoverAllCliTools({
      mode: 'automatic',
      signal: new AbortController().signal,
    });
    const forTool = (tool: string) =>
      attempts.filter((attempt) => attempt.connection.tool === tool);

    const opencodeAttempts = forTool('opencode');
    expect(opencodeAttempts.map((attempt) => attempt.connection.role).toSorted()).toEqual([
      'implementer',
      'planner',
    ]);
    for (const attempt of opencodeAttempts) {
      expect(attempt.outcome).toEqual({
        kind: 'success',
        value: [
          { id: 'ollama-cloud/deepseek-v4-flash', nativeOrder: 0 },
          { id: 'opencode-go/deepseek-v4-flash', nativeOrder: 1 },
        ],
      });
    }
    expect(existsSync(opencodeArgsLog)).toBe(true);

    expect(forTool('codex').map((attempt) => attempt.connection.role)).toContain('planner');
    for (const tool of ['kilo-code']) {
      expect(forTool(tool).map((attempt) => attempt.outcome.kind)).toEqual(['not-run', 'not-run']);
      expect(existsSync(join(shimDir, `${tool}.args`))).toBe(false);
    }
    for (const tool of ['claude-code', 'copilot']) {
      expect(forTool(tool)).toEqual([]);
    }
  });
});
