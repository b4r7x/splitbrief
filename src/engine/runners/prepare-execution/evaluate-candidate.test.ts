import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { CliExecutableReceiptSchema } from '../../../core/discovery/detection.js';
import type { AuthFact, RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../../core/schemas/config.js';
import { runnerDiscoveryContextKey } from '../../detection/runner-evidence.js';
import { evaluateCandidate } from './evaluate-candidate.js';
import type { RunnerCandidate } from './runner-candidates.js';
import type { PreparationContext, PrepareExecutionDependencies } from './types.js';

const executable = CliExecutableReceiptSchema.parse({
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/usr/local/bin/codex',
    realPath: '/usr/local/bin/codex',
    platformFileId: '1:2',
    fingerprint: `1:2:3:4:sha256:${'a'.repeat(64)}`,
    resolvedAt: 1,
  },
});

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.push(directory);
  return directory;
}

/** A host whose only state is what a test writes into it. */
function stubHome(): string {
  const home = tempDir('evaluate-candidate-home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('XDG_STATE_HOME', join(home, '.local', 'state'));
  return home;
}

function writeHostFile(home: string, relative: string, contents: string): string {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

function evidence(
  discoveryContext: Parameters<typeof runnerDiscoveryContextKey>[0],
  auth: AuthFact = 'verified',
): RunnerEvidence {
  const key = runnerDiscoveryContextKey(discoveryContext);
  const testedVersion = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;
  return {
    runner: { id: 'codex', kind: 'cli', locality: 'local', enabled: 'enabled' },
    context: { key, observedAt: 1, source: 'fresh' },
    installation: 'installed',
    executable: { kind: 'trusted', identity: executable.executableIdentity },
    compatibility: { kind: 'compatible', installedVersion: testedVersion, testedVersion },
    credential: 'present',
    auth,
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: discoveryContext.model ?? 'unselected',
      observedAt: 1,
      contextKey: key,
    },
  };
}

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} is not part of candidate evaluation`);
  };
}

function preparationContext(
  config: Config,
  detectRunnerEvidence: PrepareExecutionDependencies['detectRunnerEvidence'],
): PreparationContext {
  return {
    projectDir: tempDir('evaluate-candidate-project'),
    config,
    policy: {
      purpose: 'new-workflow',
      interaction: 'headless',
      unverifiedAuth: 'denied',
      allowRepoRunners: false,
      allowHooks: true,
    },
    preparationId: 'preparation-1',
    signal: new AbortController().signal,
    nativeTrustViolations: new Set(),
    deps: {
      detectRunnerEvidence,
      collectReadiness: notCalled('collectReadiness'),
      collectArgVectorPreflightChecks: notCalled('collectArgVectorPreflightChecks'),
      probeRunnerAvailability: notCalled('probeRunnerAvailability'),
      prepareCustomRunnerAdmission: notCalled('prepareCustomRunnerAdmission'),
      resolveCliExecutableAliases: notCalled('resolveCliExecutableAliases'),
      prepareNewSession: notCalled('prepareNewSession'),
      reactivateExistingSession: notCalled('reactivateExistingSession'),
      newPreparationId: () => 'preparation-1',
    },
  };
}

function plannerSeat(model: string): { config: Config; candidate: RunnerCandidate } {
  const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', model } });
  return {
    config,
    candidate: { slot: { role: 'planner' }, runner: config.planner, trustLabel: 'planner' },
  };
}

describe('evaluateCandidate resolves a seat left on auto', () => {
  it('names the model the tool has selected on this host and carries it on the gate', async () => {
    const home = stubHome();
    const source = writeHostFile(home, '.codex/config.toml', 'model = "gpt-6-astra"');
    const { config, candidate } = plannerSeat('auto');

    const result = await evaluateCandidate(
      candidate,
      preparationContext(config, async ({ context }) => evidence(context)),
    );

    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.gate).toMatchObject({ kind: 'cli', effectiveModel: 'gpt-6-astra' });
    expect(result.check.severity).toBe('ok');
    expect(result.check.details).toEqual([`model: auto → gpt-6-astra (from ${source})`]);
  });

  it('admits the seat with a warning when the tool keeps no readable selection', async () => {
    stubHome();
    const { config, candidate } = plannerSeat('auto');

    const result = await evaluateCandidate(
      candidate,
      preparationContext(config, async ({ context }) => evidence(context)),
    );

    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.gate).not.toHaveProperty('effectiveModel');
    expect(result.check.severity).toBe('warning');
    expect(result.check.details?.[0]).toBe(
      "model: auto — codex has no readable model selection; the tool's own default applies.",
    );
    expect(result.check.metadata?.warnings).toEqual(['host_model_selection_unreadable']);
  });

  it('leaves an explicitly configured model alone', async () => {
    const home = stubHome();
    writeHostFile(home, '.codex/config.toml', 'model = "gpt-6-astra"');
    const { config, candidate } = plannerSeat('gpt-6-mini');

    const result = await evaluateCandidate(
      candidate,
      preparationContext(config, async ({ context }) => evidence(context)),
    );

    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.gate).not.toHaveProperty('effectiveModel');
    expect(result.check.severity).toBe('ok');
  });
});

describe('evaluateCandidate retries a transient session denial', () => {
  it('admits the seat when the second probe finds the session', async () => {
    stubHome();
    const { config, candidate } = plannerSeat('gpt-6-mini');
    const answers: AuthFact[] = ['missing', 'verified'];
    const probe: PrepareExecutionDependencies['detectRunnerEvidence'] = async ({ context }) =>
      evidence(context, answers.shift() ?? 'verified');
    const detect = vi.fn(probe);

    vi.useFakeTimers();
    const pending = evaluateCandidate(candidate, preparationContext(config, detect));
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(detect).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('admitted');
    expect(result.check.severity).toBe('warning');
    expect(result.check.metadata?.warnings).toEqual(['readiness_probe_retried']);
  });

  it('blocks when the second probe agrees, and says to run the status command first', async () => {
    stubHome();
    const { config, candidate } = plannerSeat('gpt-6-mini');
    const probe: PrepareExecutionDependencies['detectRunnerEvidence'] = async ({ context }) =>
      evidence(context, 'missing');
    const detect = vi.fn(probe);

    vi.useFakeTimers();
    const pending = evaluateCandidate(candidate, preparationContext(config, detect));
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;

    expect(detect).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('blocked');
    expect(result.check.severity).toBe('blocker');
    expect(result.check.fix).toContain('Run it once yourself, then continue again.');
  });
});
