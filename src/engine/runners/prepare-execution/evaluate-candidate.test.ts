import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { settleUnderFakeTimers } from '#testing/helpers/fake-timers.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { CliExecutableReceiptSchema } from '../../../core/discovery/detection.js';
import type { AuthFact, RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import { READINESS_DIAGNOSTIC_REMEDIATION } from '../../../core/readiness/format.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../../core/schemas/config.js';
import { cliAuthRemediation } from '../../../core/schemas/readiness.js';
import { runnerDiscoveryContextKey } from '../../detection/runner-evidence.js';
import { getSplitbriefPath } from '../../../core/paths.js';
import { saveDetectionCache } from '../../detection/cache.js';
import { evaluateCandidate, inlineRunnerRefusal } from './evaluate-candidate.js';
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
const hostPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
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
    routeCatalogs: new Map(),
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

describe('evaluateCandidate policy denial remediation', () => {
  it.each([
    { platform: 'linux', tool: 'antigravity', unsupported: true },
    { platform: 'darwin', tool: 'antigravity', unsupported: false },
    { platform: 'linux', tool: 'codex', unsupported: false },
  ] as const)('gives the platform or policy remedy for $tool on $platform', async (scenario) => {
    Object.defineProperty(process, 'platform', { value: scenario.platform, configurable: true });
    const config = makeConfig({ planner: { kind: 'cli', tool: scenario.tool } });
    const candidate: RunnerCandidate = {
      slot: { role: 'planner' },
      runner: config.planner,
      trustLabel: 'planner',
    };
    const detect: PrepareExecutionDependencies['detectRunnerEvidence'] = async ({ context }) => ({
      ...evidence(context, 'policy-denied'),
      runner: { id: scenario.tool, kind: 'cli', locality: 'local', enabled: 'enabled' },
    });

    vi.useFakeTimers();
    const result = await settleUnderFakeTimers(
      evaluateCandidate(candidate, preparationContext(config, detect)),
    );

    expect(result.kind).toBe('blocked');
    expect(result.check).toMatchObject({
      severity: 'blocker',
      diagnosticState: 'auth-policy-denied',
      fix: scenario.unsupported
        ? cliAuthRemediation({ tool: scenario.tool, authChannel: 'session' }, 'doctor')
        : READINESS_DIAGNOSTIC_REMEDIATION['auth-policy-denied'],
    });
  });
});

describe('evaluateCandidate on a repo-local command without the grant', () => {
  it.each([
    {
      purpose: 'new-workflow',
      fix: 'Use a system-installed command, or start the run from the command line with `splitbrief start --allow-repo-runners`.',
    },
    {
      purpose: 'resume',
      fix: 'Use a system-installed command, or continue the run from the command line with `splitbrief continue --allow-repo-runners`.',
    },
    {
      purpose: 'spec',
      fix: 'Use a system-installed command, or run `splitbrief spec --allow-repo-runners`.',
    },
    {
      purpose: 'review',
      fix: 'Use a system-installed command, or run `splitbrief review --allow-repo-runners`.',
    },
  ] as const)('names the command that grants it for $purpose', async ({ purpose, fix }) => {
    const config = makeConfig({ planner: { kind: 'shell', command: './scripts/planner' } });
    const candidate: RunnerCandidate = {
      slot: { role: 'planner' },
      runner: config.planner,
      trustLabel: 'planner',
    };
    const base = preparationContext(config, notCalled('detectRunnerEvidence'));
    const context: PreparationContext = {
      ...base,
      policy: { ...base.policy, purpose },
      nativeTrustViolations: new Set(['planner']),
    };

    const result = await evaluateCandidate(candidate, context);

    expect(result.kind).toBe('blocked');
    expect(result.check).toMatchObject({
      details: ['Configured command is outside the current trust policy.'],
      fix,
    });
  });
});

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
      "model: auto — OpenAI Codex CLI has no readable model selection; the tool's own default applies.",
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
    const result = await settleUnderFakeTimers(
      evaluateCandidate(candidate, preparationContext(config, detect)),
    );

    expect(detect).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('admitted');
    expect(result.check.severity).toBe('warning');
    expect(result.check.metadata?.warnings).toEqual(['readiness_probe_retried']);
    expect(result.check.details).toContain(
      'OpenAI Codex CLI reported no sign-in at first and confirmed it on a second check.',
    );
  });

  it('blocks when the second probe agrees, and gives the sign-in action', async () => {
    stubHome();
    const { config, candidate } = plannerSeat('gpt-6-mini');
    const probe: PrepareExecutionDependencies['detectRunnerEvidence'] = async ({ context }) =>
      evidence(context, 'missing');
    const detect = vi.fn(probe);

    vi.useFakeTimers();
    const result = await settleUnderFakeTimers(
      evaluateCandidate(candidate, preparationContext(config, detect)),
    );

    expect(detect).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe('blocked');
    expect(result.check.severity).toBe('blocker');
    expect(result.check.fix).toBe(
      'SPLITBRIEF looks for the OpenAI Codex CLI session in its session files. Sign in to OpenAI Codex CLI, then run `splitbrief doctor` again.',
    );
  });

  it('blocks a Codex sign-in kept in the system keyring, and names how to move it', async () => {
    stubHome();
    const { config, candidate } = plannerSeat('gpt-6-mini');
    const probe: PrepareExecutionDependencies['detectRunnerEvidence'] = async ({ context }) =>
      evidence(context, 'keyring');

    vi.useFakeTimers();
    const result = await settleUnderFakeTimers(
      evaluateCandidate(candidate, preparationContext(config, vi.fn(probe))),
    );

    expect(result.kind).toBe('blocked');
    expect(result.check).toMatchObject({
      severity: 'blocker',
      details: expect.arrayContaining([
        'OpenAI Codex CLI keeps its sign-in in the system keyring, which a run cannot reach.',
      ]),
      fix: 'Set cli_auth_credentials_store = "file" in config.toml and run codex login again, or use OPENAI_API_KEY, then run `splitbrief doctor` again.',
      runnerCause: { tool: 'codex', cause: 'unauthenticated' },
    });
  });
});

describe('evaluateCandidate on a model route with no credential', () => {
  const config = makeConfig({
    implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
  });
  const candidate: RunnerCandidate = {
    slot: { role: 'implementer', profile: 'default' },
    runner: config.implementer,
    trustLabel: 'implementer',
  };
  const signedInToGo = () =>
    preparationContext(config, async ({ context }) => ({
      ...evidence(context),
      runner: { id: 'opencode', kind: 'cli', locality: 'local', enabled: 'enabled' },
      providerAuth: { kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'stored' }] },
    }));

  it('admits the seat and reports the route with its sign-in step', async () => {
    stubHome();
    const context = signedInToGo();
    mkdirSync(getSplitbriefPath(context.projectDir), { recursive: true });
    await saveDetectionCache({
      projectDir: context.projectDir,
      snapshot: {
        contextKey: 'readiness-remembered',
        fetchedAt: Date.now(),
        validatedAt: Date.now(),
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [],
        cliCatalogs: [
          {
            tool: 'opencode',
            models: [{ id: 'opencode-go/kimi-k3' }],
            namesProject: true,
            probedAt: Date.now(),
          },
        ],
      },
    });

    const result = await evaluateCandidate(candidate, context);

    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.check).toEqual({
      id: 'runners.preparation.implementer.default',
      severity: 'warning',
      summary: 'BUILD is ready with warnings.',
      details: ['BUILD: OpenCode CLI has no credential for ollama-cloud.'],
      fix: 'Run `opencode auth login ollama-cloud`, or choose another model in Settings > Crew > BUILD.',
      metadata: {
        role: 'implementer',
        kind: 'cli',
        warnings: ['runners.route.implementer.default'],
      },
    });
  });

  it('reports no route when the project has no saved model list', async () => {
    stubHome();
    const result = await evaluateCandidate(candidate, signedInToGo());

    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.check).toMatchObject({ severity: 'ok', summary: 'BUILD is ready to start.' });
  });
});

describe('evaluateCandidate on a local-only OpenCode seat', () => {
  /** `freshList`: what a fresh read of the tool's model list answers; omitted, the read fails. */
  function localSeat(model: string, freshList?: readonly string[]) {
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'opencode', model } });
    const candidate: RunnerCandidate = {
      slot: { role: 'implementer', profile: 'default' },
      runner: config.implementer,
      trustLabel: 'implementer',
    };
    const detect = vi.fn<PrepareExecutionDependencies['detectRunnerEvidence']>(
      async ({ context: discovery, includeCatalog }) => ({
        ...evidence(discovery, 'missing'),
        runner: { id: 'opencode', kind: 'cli', locality: 'local', enabled: 'enabled' },
        // `ollama/llama3` set up in the global opencode.json: `opencode auth list` prints [].
        providerAuth: { kind: 'empty' },
        ...(includeCatalog === true && {
          catalog:
            freshList === undefined
              ? { kind: 'command-failed', cause: 'exit 1' }
              : { kind: 'success', value: freshList.map((id) => ({ id })) },
        }),
      }),
    );
    return { candidate, context: preparationContext(config, detect), detect };
  }

  async function rememberModelList(
    projectDir: string,
    ids: readonly string[],
    namesProject = true,
  ): Promise<void> {
    mkdirSync(getSplitbriefPath(projectDir), { recursive: true });
    await saveDetectionCache({
      projectDir,
      snapshot: {
        contextKey: 'readiness-remembered',
        fetchedAt: Date.now(),
        validatedAt: Date.now(),
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [],
        cliCatalogs: [
          {
            tool: 'opencode',
            models: ids.map((id) => ({ id })),
            namesProject,
            probedAt: Date.now(),
          },
        ],
      },
    });
  }

  it('admits the seat when the saved model list serves its route', async () => {
    stubHome();
    const { candidate, context } = localSeat('ollama/llama3');
    await rememberModelList(context.projectDir, ['ollama/llama3']);

    const result = await evaluateCandidate(candidate, context);

    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.check).toMatchObject({ severity: 'ok', summary: 'BUILD is ready to start.' });
    expect(result.gate).toMatchObject({ kind: 'cli', tool: 'opencode' });
  });

  it("admits a seat left on auto by the model the tool's own config selects", async () => {
    const home = stubHome();
    writeHostFile(home, '.config/opencode/opencode.json', '{"model":"ollama/llama3"}');
    const { candidate, context } = localSeat('auto');
    await rememberModelList(context.projectDir, ['ollama/llama3']);

    const result = await evaluateCandidate(candidate, context);

    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.gate).toMatchObject({ kind: 'cli', effectiveModel: 'ollama/llama3' });
  });

  it('reads the model list fresh when none is saved, and admits the seat it serves', async () => {
    stubHome();
    const { candidate, context, detect } = localSeat('ollama/llama3', ['ollama/llama3']);

    const result = await evaluateCandidate(candidate, context);

    expect(detect).toHaveBeenCalledWith(expect.objectContaining({ includeCatalog: true }));
    expect(result.kind).toBe('admitted');
  });

  it('reads no model list fresh when one is saved', async () => {
    stubHome();
    const { candidate, context, detect } = localSeat('ollama/llama3', ['ollama/llama3']);
    await rememberModelList(context.projectDir, ['lmstudio/qwen3']);

    await evaluateCandidate(candidate, context);

    expect(detect).not.toHaveBeenCalledWith(expect.objectContaining({ includeCatalog: true }));
  });

  it('admits the seat on a saved list that did not name the project but serves its route', async () => {
    stubHome();
    const { candidate, context, detect } = localSeat('ollama/llama3');
    await rememberModelList(context.projectDir, ['ollama/llama3'], false);

    const result = await evaluateCandidate(candidate, context);

    expect(detect).not.toHaveBeenCalledWith(expect.objectContaining({ includeCatalog: true }));
    expect(result.kind).toBe('admitted');
  });

  it('reads the model list fresh when the saved one did not name the project and does not serve the route', async () => {
    stubHome();
    const { candidate, context, detect } = localSeat('ollama-cloud/glm-5', ['ollama-cloud/glm-5']);
    await rememberModelList(context.projectDir, ['ollama/llama3'], false);

    const result = await evaluateCandidate(candidate, context);

    expect(detect).toHaveBeenCalledWith(expect.objectContaining({ includeCatalog: true }));
    expect(result.kind).toBe('admitted');
  });

  it.each([
    ['no saved model list and a failed fresh read', undefined, undefined],
    [
      'no saved model list and a fresh one that does not serve the route',
      undefined,
      ['lmstudio/qwen3'],
    ],
    ['a saved model list that does not serve the route', ['lmstudio/qwen3'], undefined],
  ])('keeps the tool sign-in blocker with %s', async (_, ids, freshList) => {
    stubHome();
    const { candidate, context } = localSeat('ollama/llama3', freshList);
    if (ids !== undefined) await rememberModelList(context.projectDir, ids);

    const result = await evaluateCandidate(candidate, context);

    expect(result.kind).toBe('blocked');
    expect(result.check).toMatchObject({
      severity: 'blocker',
      details: expect.arrayContaining(['OpenCode CLI is not signed in.']),
      runnerCause: { tool: 'opencode', cause: 'unauthenticated' },
    });
  });
});

describe('inlineRunnerRefusal', () => {
  it.each([
    ['shell', 'a shell runner command'],
    ['agent', 'an agent runner command'],
  ] as const)('names %s with its article in every refusal', (kind, phrase) => {
    const reasons = (['missing', 'non-executable', 'untrusted'] as const).map(
      (status) => inlineRunnerRefusal({ kind: 'denied', status }, kind).reason,
    );

    for (const reason of reasons) expect(reason).toContain(`declares ${phrase} that`);
  });
});
