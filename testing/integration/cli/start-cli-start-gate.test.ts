import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDefaultConfig } from '../../../src/core/config/load/io.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../../src/core/paths.js';
import { AUTOMATIC_MODEL } from '../../../src/core/providers/automatic-model.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';
import type { StartDeps } from '../../../src/cli/commands/start/types.js';

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

let tmp: string;
let binDir: string;
let stdoutWrites: string[];
let restoreCompatibleCliShim: (() => void) | undefined;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-start-gate');
  binDir = createTempDir('cli-start-gate-bin');
  createTestGitRepo(tmp);
  mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(tmp, SPLITBRIEF_DIR, CONFIG_FILE),
    YAML.stringify(
      toYaml({
        ...createDefaultConfig(),
        planner: {
          kind: 'cli',
          tool: 'codex',
          model: AUTOMATIC_MODEL,
          authChannel: 'api-key',
        },
      }),
    ),
    'utf-8',
  );
  stdoutWrites = [];
  // NDJSON is written to the real stdout boundary, outside runCommand's
  // Commander capture; intercept it only to keep this integration fixture quiet.
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreCompatibleCliShim?.();
  restoreCompatibleCliShim = undefined;
  cleanupTempDir(binDir);
  cleanupTempDir(tmp);
});

function activateCodexShim(version: string) {
  const shim = installCompatibleCliShim({
    directory: binDir,
    tool: 'codex',
    authChannel: 'api-key',
    version,
  });
  restoreCompatibleCliShim = activateCompatibleCliShim(shim, 'test-only-start-gate-key');
  return shim;
}

function startDeps(run: { gates?: readonly RunnerGate[] | undefined }): Partial<StartDeps> {
  return {
    initStores: async () => {},
    runHeadless: async ({ prepared }) => {
      run.gates = prepared.gates;
    },
  };
}

// A cheap auth probe proves a credential exists, never that the server still
// honours it, so fresh CLI evidence reports auth as unknown and a headless
// start stays fail-closed without --allow-unverified-auth. These fixtures
// accept unverified auth so the assertions stay about version admission.
function startWithFreshPreparation() {
  const run: { gates?: readonly RunnerGate[] | undefined } = {};
  return runCommand(
    ['start', '--project', tmp, '--json', '--allow-unverified-auth', 'add endpoint'],
    startDeps(run),
  ).then((result) => ({ ...result, run }));
}

describe('CLI integration: fresh CLI runner start gate', () => {
  it.each([
    '0.1.0',
    '0.39.9',
  ] as const)('blocks fresh incompatible Codex %s before creating a session', async (version) => {
    activateCodexShim(version);

    const { exitCode, run } = await startWithFreshPreparation();

    expect(exitCode).not.toBe(0);
    expect(stdoutWrites.join('')).toContain('Fresh CLI evidence denied admission: compatibility.');
    expect(run.gates).toBeUndefined();
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  it('fail-closes a headless start on unverified auth and names the escape hatch', async () => {
    activateCodexShim('0.999.0');

    const run: { gates?: readonly RunnerGate[] | undefined } = {};
    const { exitCode } = await runCommand(
      ['start', '--project', tmp, '--json', 'add endpoint'],
      startDeps(run),
    );

    expect(exitCode).not.toBe(0);
    expect(run.gates).toBeUndefined();
    const emitted = stdoutWrites.join('');
    expect(emitted).toContain('Fresh CLI evidence denied admission: authentication-unverified.');
    expect(emitted).toContain('--allow-unverified-auth');
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  it('admits fresh Codex 0.999.0 newer than the tested release', async () => {
    const shim = activateCodexShim('0.999.0');

    const { exitCode, run } = await startWithFreshPreparation();

    expect(exitCode).toBe(0);
    expect(run.gates?.find((gate) => gate.kind === 'cli')).toMatchObject({
      kind: 'cli',
      executable: { path: shim.path },
    });
  });

  it('emits the fresh readiness report and prepared executable before running', async () => {
    const shim = activateCodexShim('0.40.0');

    const { exitCode, run } = await startWithFreshPreparation();

    expect(exitCode).toBe(0);
    expect(run.gates?.find((gate) => gate.kind === 'cli')).toMatchObject({
      kind: 'cli',
      executable: {
        path: shim.path,
        executableIdentity: {
          fingerprint: expect.stringMatching(/:sha256:[a-f0-9]{64}$/u),
        },
      },
    });
    expect(stdoutWrites.join('')).toContain('"type":"readiness_report"');
    expect(stdoutWrites.join('')).toContain('"status":"ready-with-warnings"');
  });
});
