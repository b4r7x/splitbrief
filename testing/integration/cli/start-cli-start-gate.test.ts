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
import { cliReadinessFactsFor } from '#testing/helpers/factories/detection.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDefaultConfig } from '../../../src/core/config/load/io.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../../src/core/paths.js';
import { AUTOMATIC_MODEL } from '../../../src/core/providers/automatic-model.js';
import { deriveCliReadiness } from '../../../src/core/schemas/readiness.js';
import type { CliReadinessState } from '../../../src/core/discovery/detection.js';
import type { CliStartGates } from '../../../src/engine/runners/start-gate.js';
import type { StartDeps } from '../../../src/cli/commands/start/types.js';

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

/**
 * The injected legacy readiness result is intentionally independent from the
 * executable shim. That makes this a stale-report test: production start must
 * inspect the current shim through detectRunnerEvidence before it creates a
 * session or calls the headless runner.
 */
function startDeps(
  legacyState: CliReadinessState,
  run: { gates?: CliStartGates | undefined },
): Partial<StartDeps> {
  return {
    detectCliReadiness: async ({ config }) =>
      config.planner.kind === 'cli'
        ? [deriveCliReadiness(cliReadinessFactsFor(legacyState, config.planner.tool))]
        : [],
    initStores: async () => {},
    runHeadless: async ({ trustedCliGates }) => {
      run.gates = trustedCliGates;
    },
  };
}

function startWithLegacyReadiness(legacyState: CliReadinessState) {
  const run: { gates?: CliStartGates | undefined } = {};
  return runCommand(
    ['start', '--project', tmp, '--json', 'add endpoint'],
    startDeps(legacyState, run),
  ).then((result) => ({ ...result, run }));
}

describe('CLI integration: fresh CLI runner start gate', () => {
  it.each([
    '0.1.0',
    '0.39.9',
  ] as const)('blocks fresh incompatible Codex %s even when the earlier report was ready', async (version) => {
    activateCodexShim(version);

    const { exitCode, stderr, run } = await startWithLegacyReadiness('ready');

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('version is incompatible');
    expect(stderr).toContain('tested compatible version');
    expect(run.gates).toBeUndefined();
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  it('admits fresh Codex 0.999.0 newer than the tested release', async () => {
    const shim = activateCodexShim('0.999.0');

    const { exitCode, run } = await startWithLegacyReadiness('ready');

    expect(exitCode).toBe(0);
    expect(run.gates?.get('codex')?.executable).toMatchObject({ path: shim.path });
  });

  it('reconciles an unverified earlier report with a fresh verified executable before running', async () => {
    const shim = activateCodexShim('0.40.0');

    const { exitCode, stderr, run } = await startWithLegacyReadiness('unverified');

    expect(exitCode).toBe(0);
    expect(stderr).toContain('fresh result');
    expect(run.gates?.get('codex')?.executable).toMatchObject({
      path: shim.path,
      executableIdentity: {
        fingerprint: expect.stringMatching(/:sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(stdoutWrites.join('')).toContain('"type":"readiness_report"');
    expect(stdoutWrites.join('')).toContain('"status":"ready-with-warnings"');
  });
});
