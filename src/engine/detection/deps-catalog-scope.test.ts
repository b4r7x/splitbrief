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

    const opencodeAttempts = attempts.filter((attempt) => attempt.connection.tool === 'opencode');
    expect(opencodeAttempts).toHaveLength(1);
    expect(opencodeAttempts[0]).toEqual(
      expect.objectContaining({
        outcome: { kind: 'success', value: [{ id: 'openai/gpt-5.4', nativeOrder: 0 }] },
      }),
    );
    expect(existsSync(argsLog)).toBe(true);
    expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toContain(
      'models|--verbose|--refresh|',
    );
    expect(
      readFileSync(argsLog, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line === 'models|--verbose|--refresh|'),
    ).toHaveLength(1);
  });

  it('probes each catalog-capable tool once and keeps every provider variant of a duplicated model', async () => {
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
    expect(opencodeAttempts).toHaveLength(1);
    expect(opencodeAttempts[0]?.outcome).toEqual({
      kind: 'success',
      value: [
        { id: 'ollama-cloud/deepseek-v4-flash', nativeOrder: 0 },
        { id: 'opencode-go/deepseek-v4-flash', nativeOrder: 1 },
      ],
    });
    expect(existsSync(opencodeArgsLog)).toBe(true);
    expect(
      readFileSync(opencodeArgsLog, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line === 'models|--verbose|'),
    ).toHaveLength(1);

    expect(forTool('codex')).toHaveLength(1);
    for (const tool of ['kilo-code', 'copilot']) {
      expect(forTool(tool).map((attempt) => attempt.outcome.kind)).toEqual(['not-run']);
      expect(existsSync(join(shimDir, `${tool}.args`))).toBe(false);
    }
    expect(forTool('claude-code')).toEqual([]);
  });

  it('issues one version probe and at most one catalog probe per installed tool', async () => {
    const versionShim = (name: string, version: string, catalogLines: readonly string[]) =>
      writeShim(shimDir, name, [
        'if [ "$1" = "--version" ]; then',
        `  printf '%s\\n' '${version}'`,
        '  exit 0',
        'fi',
        ...catalogLines,
        'exit 0',
      ]);
    const logs = {
      codex: versionShim('codex', 'codex-cli 0.146.0', []),
      opencode: versionShim('opencode', '1.18.10', ["printf '%s\\n' 'openai/gpt-5.4'"]),
      kilo: versionShim('kilo', '7.0.49', ["printf '%s\\n' 'kilo/openrouter/free'"]),
      cmd: versionShim('cmd', '1.53.0', ["printf '%s\\n' 'deepseek/deepseek-v4-pro   fast'"]),
      'cursor-agent': versionShim('cursor-agent', '2026.09.01-abc1234', [
        "printf '%s\\n' 'gpt-5.4'",
      ]),
      copilot: versionShim('copilot', 'GitHub Copilot CLI 1.0.77.', [
        "printf '%s\\n' 'model: gpt-5.4'",
      ]),
    } as const;

    const deps = createProductionDetectionDeps({
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      projectDir,
    });
    const attempts = await deps.discoverAllCliTools({
      mode: 'automatic',
      signal: new AbortController().signal,
    });

    expect(attempts).toHaveLength(6);
    expect(attempts.map((attempt) => attempt.connection.tool).toSorted()).toEqual([
      'codex',
      'command-code',
      'copilot',
      'cursor',
      'kilo-code',
      'opencode',
    ]);
    for (const [name, log] of Object.entries(logs)) {
      const lines = readFileSync(log, 'utf8').trim().split('\n');
      expect(
        lines.filter((line) => line === '--version|'),
        name,
      ).toHaveLength(1);
      const catalogLines = lines.filter(
        (line) =>
          line.startsWith('models|') || line === '--list-models|' || line === 'help|config|',
      );
      expect(catalogLines.length, name).toBeLessThanOrEqual(1);
    }
  });
});
