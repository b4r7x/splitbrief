import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import YAML from 'yaml';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { projectRunnerDiscoveryContext } from '../../../src/core/config/accessors/runner-discovery-context.js';
import { createDefaultConfig, loadConfig } from '../../../src/core/config/load/io.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';

// Runner availability is a live network claim, and the default config points the
// implementer at a local Ollama. The shared no-claim mock keeps the verdict off
// whatever daemon this machine happens to be running.
vi.mock('../../../src/engine/runners/probe-availability.js', () => ({
  probeRunnerAvailability: async (
    ...args: Parameters<
      typeof import('../../../src/engine/runners/probe-availability.js').probeRunnerAvailability
    >
  ) => (await import('#testing/helpers/start-command.js')).probeRunnerAvailabilityMock(...args),
}));

const API_KEY = 'legacy-claude-api-key-canary-6f21';

let projectDir: string;
let binDir: string;
let homeDir: string;
let authMarkerPath: string;
let originalPath: string | undefined;
let originalApiKey: string | undefined;
let originalHome: string | undefined;
let stdoutWrites: string[];

function configFilePath(): string {
  return join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
}

function writeLegacyConfig(): void {
  const config = {
    ...createDefaultConfig(),
    planner: {
      kind: 'cli' as const,
      tool: 'claude-code' as const,
      model: 'claude-opus-4-6',
    },
  };
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    configFilePath(),
    `# Keep this legacy Claude selection byte-for-byte.\n${YAML.stringify(toYaml(config))}`,
    'utf-8',
  );
}

function writeClaudeShim(): void {
  const command = join(binDir, 'claude');
  writeFileSync(
    command,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      "  printf 'claude 2.0.0\\n'",
      '  exit 0',
      'fi',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      '  if [ -n "$ANTHROPIC_API_KEY" ]; then',
      `    printf 'api-key\\n' > ${JSON.stringify(authMarkerPath)}`,
      '  else',
      `    printf 'session\\n' > ${JSON.stringify(authMarkerPath)}`,
      '  fi',
      "  printf 'authenticated\\n'",
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf-8',
  );
  chmodSync(command, 0o755);
}

beforeEach(() => {
  resetAllStores();
  projectDir = createTempDir('legacy-cli-auth-channel');
  binDir = createTempDir('legacy-cli-auth-channel-bin');
  authMarkerPath = join(binDir, 'auth-channel.txt');
  createTestGitRepo(projectDir);
  writeLegacyConfig();
  writeClaudeShim();
  homeDir = createTempDir('legacy-cli-auth-channel-home');
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  writeFileSync(join(homeDir, '.claude', '.credentials.json'), '{"session":"stub"}\n', 'utf-8');
  stdoutWrites = [];
  originalPath = process.env.PATH;
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  originalHome = process.env.HOME;
  process.env.PATH = [binDir, originalPath ?? ''].filter(Boolean).join(delimiter);
  process.env.ANTHROPIC_API_KEY = API_KEY;
  process.env.HOME = homeDir;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  cleanupTempDir(binDir);
  cleanupTempDir(projectDir);
  cleanupTempDir(homeDir);
});

describe('CLI integration: legacy Claude auth-channel start', () => {
  it('projects the session default channel without rewriting the loaded YAML', async () => {
    const path = configFilePath();
    const before = readFileSync(path, 'utf-8');
    const beforeStat = statSync(path, { bigint: true });
    const config = loadConfig(projectDir).config;
    const context = projectRunnerDiscoveryContext({ config, role: 'planner' });
    const sameConfigContext = projectRunnerDiscoveryContext({ config, role: 'planner' });

    expect(config.planner).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      model: 'claude-opus-4-6',
    });
    expect(context.authChannel).toBe('session');
    expect(sameConfigContext.configGeneration).toBe(context.configGeneration);

    let gates: readonly RunnerGate[] | undefined;
    const result = await runCommand(
      ['start', '--project', projectDir, '--json', 'verify legacy auth'],
      {
        initStores: async () => {},
        runHeadless: async ({ prepared }) => {
          gates = prepared.gates;
        },
      },
    );

    const after = readFileSync(path, 'utf-8');
    const afterStat = statSync(path, { bigint: true });
    const emitted = [result.stdout, result.stderr, stdoutWrites.join('')].join('');

    expect(result.exitCode).toBe(0);
    expect(gates?.find((gate) => gate.kind === 'cli' && gate.tool === 'claude-code')).toBeDefined();
    expect(readFileSync(authMarkerPath, 'utf-8')).toBe('session\n');
    expect(after).toBe(before);
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    expect(emitted).not.toContain(API_KEY);
  });
});
