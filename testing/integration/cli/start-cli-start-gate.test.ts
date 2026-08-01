import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { cliReadinessFactsFor, PROBE_EXECUTABLE } from '#testing/helpers/factories/detection.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDefaultConfig } from '../../../src/core/config/load/io.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../../src/core/paths.js';
import { AUTOMATIC_MODEL } from '../../../src/core/providers/automatic-model.js';
import { deriveCliReadiness } from '../../../src/core/schemas/readiness.js';
import {
  cliStartGatesFromReadiness,
  type CliStartGates,
} from '../../../src/engine/runners/start-gate.js';
import type { CliReadinessState } from '../../../src/core/discovery/detection.js';
import type { StartDeps } from '../../../src/cli/commands/start/types.js';

let tmp: string;
let stdoutWrites: string[];

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-start-gate');
  createTestGitRepo(tmp);
  mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(tmp, SPLITBRIEF_DIR, CONFIG_FILE),
    YAML.stringify(
      toYaml({
        ...createDefaultConfig(),
        planner: { kind: 'cli', tool: 'codex', model: AUTOMATIC_MODEL },
      }),
    ),
    'utf-8',
  );
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDir(tmp);
});

/**
 * The CLI probe is a live measurement of this machine, so the readiness state
 * is injected through the documented `StartDeps` seam. Headless execution is
 * faked to record the gates start handed it — the gate map is the artifact
 * under test, not the workflow.
 */
function startDeps(
  state: CliReadinessState,
  run: { gates?: CliStartGates | undefined },
): Partial<StartDeps> {
  return {
    detectCliReadiness: async ({ config }) =>
      config.planner.kind === 'cli'
        ? [deriveCliReadiness(cliReadinessFactsFor(state, config.planner.tool))]
        : [],
    initStores: async () => {},
    runHeadless: async ({ trustedCliGates }) => {
      run.gates = trustedCliGates;
    },
  };
}

function startWithReadiness(state: CliReadinessState) {
  const run: { gates?: CliStartGates | undefined } = {};
  return runCommand(
    ['start', '--project', tmp, '--json', 'add endpoint'],
    startDeps(state, run),
  ).then((result) => ({ ...result, run }));
}

describe('CLI integration: CLI runner start gate', () => {
  it('refuses to start an unverified CLI planner and names its remediation', async () => {
    const probe = deriveCliReadiness(cliReadinessFactsFor('unverified', 'codex'));
    // The refusal exists because this probe yields no gate: without it the run
    // would reach the orchestrator and abort with cli-executable-untrusted.
    expect(cliStartGatesFromReadiness([probe]).size).toBe(0);
    expect(probe.remediation).toContain('Verify codex');

    const { exitCode, stderr, run } = await startWithReadiness('unverified');

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('no trusted readiness identity for codex');
    expect(stderr).toContain(probe.remediation ?? '');
    expect(run.gates).toBeUndefined();
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
  });

  it('keeps the readiness report itself advisory while start refuses', async () => {
    await startWithReadiness('unverified');

    const emitted = JSON.parse(stdoutWrites[0]?.trim() ?? '{}') as {
      type?: string;
      report?: { status?: string; checks?: Array<{ id: string; severity: string }> };
    };
    expect(emitted.type).toBe('readiness_report');
    expect(emitted.report?.status).toBe('ready-with-warnings');
    expect(
      emitted.report?.checks?.find((check) => check.id === 'runners.cli.codex.readiness'),
    ).toMatchObject({ severity: 'warning' });
  });

  it('starts with a trusted gate when the CLI planner readiness is ready', async () => {
    const { exitCode, stderr, run } = await startWithReadiness('ready');

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(run.gates?.get('codex')?.executable.path).toBe(PROBE_EXECUTABLE.path);
  });
});
