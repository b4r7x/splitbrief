import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { settleUnderFakeTimers } from '#testing/helpers/fake-timers.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { CliExecutableReceiptSchema } from '../../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { ConfigSchema } from '../../../core/schemas/config.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import {
  readActiveRecord,
  reactivateExistingSession,
  writeActive,
} from '../../../core/sessions/active-pointer.js';
import { LOCKFILE, sessionDir, STATE_FILE } from '../../../core/paths.js';
import { createInitialState } from '../../../core/state/machine.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { runnerDiscoveryContextKey } from '../../detection/runner-evidence.js';
import { resolveCustomRunnerTrustFile } from '../custom-trust.js';
import { prepareCustomRunnerAdmission } from '../custom-admission.js';
import type { probeRunnerAvailability } from '../probe-availability.js';
import {
  prepareExecution,
  prepareReviewExecution,
  collectRunnerAdmissionChecks,
  type PrepareExecutionInput,
} from './prepare-execution.js';
import type { PreparationPolicy, PrepareExecutionDependencies } from './types.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { buildReadinessReport } from '../../../core/readiness/checks/build.js';

const EXECUTABLE_DIGEST = 'a'.repeat(64);
const executable = CliExecutableReceiptSchema.parse({
  path: '/usr/local/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/usr/local/bin/codex',
    realPath: '/usr/local/bin/codex',
    platformFileId: '1:2',
    fingerprint: `1:2:3:4:sha256:${EXECUTABLE_DIGEST}`,
    resolvedAt: 1,
  },
});

const tempDirs: string[] = [];

// A cli seat with no model, or `auto`, makes preparation read the model the tool selected on this
// host. Left alone, every case below would take the developer's own `~/.codex/config.toml` or
// `~/.claude/settings.json` and prepare a different config on each machine. The host each case
// sees holds only what that case wrote into it; a case that needs its own re-stubs and wins.
beforeEach(() => {
  const home = createTempDir('prepare-execution-home');
  tempDirs.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function projectDir(): string {
  const directory = createTempDir('prepare-execution');
  tempDirs.push(directory);
  return directory;
}

function shadowCodexOnPath(): void {
  const stubDir = createTempDir('prepare-execution-stub');
  tempDirs.push(stubDir);
  const stub = join(stubDir, 'codex');
  writeFileSync(
    stub,
    '#!/bin/sh\nprintf "Usage: codex [OPTIONS]\\n  --model <MODEL>\\n"\n',
    'utf8',
  );
  chmodSync(stub, 0o755);
  vi.stubEnv('PATH', `${stubDir}${delimiter}${process.env.PATH ?? ''}`);
}

function readyReport(
  project: string,
  runnerChecks: ReadinessReport['sections'][number]['checks'] = [
    { id: 'runners.configured', severity: 'ok', summary: 'Configured' },
  ],
): ReadinessReport {
  return {
    generatedAt: '2026-08-03T20:00:00.000Z',
    projectDir: project,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: runnerChecks,
      },
    ],
    metadata: {},
  };
}

function freshCliEvidence(
  context: Parameters<typeof runnerDiscoveryContextKey>[0],
  overrides: Partial<Pick<RunnerEvidence, 'installation' | 'executable'>> = {},
): RunnerEvidence {
  const key = runnerDiscoveryContextKey(context);
  const tool = context.id === 'codex' ? context.id : 'codex';
  const testedVersion = CLI_TOOL_CATALOG[tool].compatibility.testedVersion;
  return {
    runner: { id: tool, kind: 'cli', locality: 'local', enabled: 'enabled' },
    context: { key, observedAt: 1, source: 'fresh' },
    installation: overrides.installation ?? 'installed',
    executable: overrides.executable ?? {
      kind: 'trusted',
      identity: executable.executableIdentity,
    },
    compatibility: { kind: 'compatible', installedVersion: testedVersion, testedVersion },
    credential: 'present',
    auth: 'verified',
    endpoint: { kind: 'not-run' },
    catalog: { kind: 'not-run' },
    modelRun: {
      kind: 'unknown',
      selectionId: context.model ?? 'unselected',
      observedAt: 1,
      contextKey: key,
    },
  };
}

function policy(
  purpose: 'new-workflow' | 'spec' = 'new-workflow',
): Extract<PreparationPolicy, { purpose: 'new-workflow' | 'spec' }> {
  return {
    purpose,
    interaction: 'headless',
    unverifiedAuth: 'denied',
    allowRepoRunners: true,
    allowHooks: true,
  };
}

function noArtifactPaths(project: string): string[] {
  return [
    join(project, '.splitbrief', 'active'),
    join(project, '.splitbrief', 'sessions'),
    join(project, '.splitbrief', 'server.json'),
  ];
}

function preparedSession(project: string, sessionId: string) {
  const ownership = {
    version: 1 as const,
    sessionId,
    generation: '66666666-6666-4666-8666-666666666666',
  };
  return {
    kind: 'prepared' as const,
    session: {
      ref: { projectDir: project, sessionId },
      ownership,
      active: ownership,
    },
  };
}

function configuredApprovalConfig(processSentinel: string) {
  const childProgram = `require('node:fs').writeFileSync(${JSON.stringify(processSentinel)}, 'started')`;
  return ConfigSchema.parse({
    ...makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
        apiKey: 'sk-endpoint-test',
        model: 'claude-opus-4-6',
      },
      implementerProfiles: {
        default: 'review',
        profiles: {
          review: {
            kind: 'shell',
            command: process.execPath,
            args: ['-e', childProgram],
            model: 'custom-reviewer',
          },
        },
      },
    }),
    customCommands: {
      review: {
        label: 'Review changes',
        contract: 'output',
        executable: process.execPath,
        argv: ['-e', childProgram],
      },
    },
  });
}

function reviewerChecks(report: ReadinessReport): ReadinessReport['sections'][number]['checks'] {
  return (
    report.sections
      .find((section) => section.id === 'runners')
      ?.checks.filter((check) => check.id === 'runners.preparation.reviewer') ?? []
  );
}

function writeDeadRun(project: string, sessionId: string): void {
  const dir = sessionDir(project, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, STATE_FILE),
    JSON.stringify({ ...createInitialState('feature'), phase: 'implementing' }),
  );
  writeFileSync(
    join(dir, LOCKFILE),
    JSON.stringify(makeSessionLockfile(sessionId, { pid: 99999999 })),
  );
}

async function resumeActivation(prior: 'absent' | 'legacy' | 'v1' | 'different' | 'dead-other') {
  const project = projectDir();
  const config = makeConfig({
    planner: { kind: 'cli', tool: 'codex' },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:7b',
    },
  });
  const existingSession = { projectDir: project, sessionId: `resume-${prior}` };
  if (prior === 'legacy') writeActive(existingSession);
  if (prior === 'v1') reactivateExistingSession(existingSession);
  if (prior === 'different') writeActive({ projectDir: project, sessionId: 'another-session' });
  if (prior === 'dead-other') {
    writeDeadRun(project, 'dead-session');
    writeActive({ projectDir: project, sessionId: 'dead-session' });
  }
  const before = readActiveRecord(project);

  const outcome = await prepareExecution({
    feature: 'resume activation contract',
    effectiveConfig: config,
    signal: new AbortController().signal,
    policy: {
      purpose: 'resume',
      interaction: 'headless',
      unverifiedAuth: 'denied',
      allowRepoRunners: true,
      allowHooks: true,
    },
    existingSession,
    deps: {
      collectArgVectorPreflightChecks: async () => [],
      collectReadiness: async () => ({ report: readyReport(project), config }),
      detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
      resolveCliExecutableAliases: async () => ({
        command: 'codex',
        executable,
        usedFallback: false,
      }),
    },
  });

  return { project, existingSession, before, outcome };
}

describe('prepareExecution', () => {
  it('names blocked preparation reports with the host catalog', async () => {
    const project = projectDir();
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } });
    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'catalog report',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: {
        ...policy(),
        modelCache: makeModelCacheAccessor({
          providerModels: { codex: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
        }),
      },
      deps: {
        collectReadiness: async (input) => ({
          config,
          report: buildReadinessReport({
            projectDir: project,
            config,
            seatDisplayName: input.seatDisplayName,
            configLoad: { state: 'loaded', path: 'config.yaml', warnings: [] },
            packageScripts: { packageJsonExists: false, scripts: {} },
            repo: { isGitRepo: false, hasCommits: false, dirtyFiles: [], untrackedFiles: [] },
          }),
        }),
      },
    });
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') throw new Error('Expected repository blocker');
    expect(JSON.stringify(outcome.report)).toContain('OpenAI Codex CLI · GPT-6-Luna');
    expect(JSON.stringify(outcome.report)).not.toContain('GPT-6 Luna');
  });

  it('checks planner and every configured profile and derives report and gates from each result', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex' },
      implementerProfiles: {
        default: 'api',
        profiles: {
          api: {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
          },
          shell: { kind: 'shell', command: 'node', model: 'local-shell' },
          agent: { kind: 'agent', command: 'node', model: 'local-agent' },
        },
      },
    });
    const prepareSession = vi.fn(() => preparedSession(project, 'prepared-session'));
    const collectReadiness = vi.fn(async () => ({ report: readyReport(project), config }));

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'prepare every runner',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness,
        detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
        resolveCliExecutableAliases: async () => ({
          command: 'codex',
          executable,
          usedFallback: false,
        }),
        prepareNewSession: prepareSession,
        newPreparationId: () => 'preparation-all-slots',
      },
    });

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    // The report describes the run that starts: a headless one approves its plan unattended.
    expect(collectReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ interaction: 'headless' }),
    );
    expect(outcome.execution.gates).toHaveLength(4);
    expect(outcome.execution.gates.map((gate) => [gate.slot, gate.kind])).toEqual([
      [{ role: 'planner' }, 'cli'],
      [{ role: 'implementer', profile: 'agent' }, 'agent'],
      [{ role: 'implementer', profile: 'api' }, 'api'],
      [{ role: 'implementer', profile: 'shell' }, 'shell'],
    ]);
    expect(
      outcome.execution.report.sections
        .find((section) => section.id === 'runners')
        ?.checks.filter((check) => check.id.startsWith('runners.preparation.')),
    ).toHaveLength(4);
    expect(
      outcome.execution.gates.every(
        (gate) => gate.preparationId === outcome.execution.preparationId,
      ),
    ).toBe(true);
    expect(prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config: outcome.execution.config,
        report: outcome.execution.report,
      }),
    );
    expect(outcome.execution.session).toMatchObject({
      kind: 'new',
      ref: { projectDir: project, sessionId: 'prepared-session' },
      ownership: { generation: '66666666-6666-4666-8666-666666666666' },
      active: { generation: '66666666-6666-4666-8666-666666666666' },
    });
    expect(Object.isFrozen(outcome.execution.config)).toBe(true);
  });

  it('reaches the same outcome whether or not a stub executable shadows the tool on PATH', async () => {
    const project = projectDir();
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const run = () =>
      prepareExecution({
        projectDir: project,
        feature: 'machine-independent preparation',
        effectiveConfig: config,
        signal: new AbortController().signal,
        policy: policy('new-workflow'),
        deps: {
          collectArgVectorPreflightChecks: async () => [],
          collectReadiness: async () => ({ report: readyReport(project), config }),
          detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
          resolveCliExecutableAliases: async () => ({
            command: 'codex',
            executable,
            usedFallback: false,
          }),
          prepareNewSession: () => preparedSession(project, 'machine-independent-session'),
          newPreparationId: () => 'preparation-machine-independent',
        },
      });

    const withoutStub = await run();
    shadowCodexOnPath();
    const withStub = await run();

    expect(withoutStub.kind).toBe('prepared');
    expect(withStub).toEqual(withoutStub);
  });

  it('blocks an explicit auth channel the enforcement matrix cannot guarantee', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
    });
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'explicit auth channel',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
        resolveCliExecutableAliases: async () => ({
          command: 'codex',
          executable,
          usedFallback: false,
        }),
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    const check = outcome.report.sections
      .find((section) => section.id === 'runners')
      ?.checks.find((entry) => entry.id === 'runners.preparation.planner');
    expect(check?.severity).toBe('blocker');
    expect(check?.fix).toContain('auth_channel');
    expect(prepareSession).not.toHaveBeenCalled();
  });

  it('leaves the arg-vector preflight unrun when the trust ladder refuses the executable', async () => {
    const project = projectDir();
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const preflight = vi.fn(async () => []);

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'no preflight before admission',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: preflight,
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) =>
          freshCliEvidence(context, { executable: { kind: 'untrusted' } }),
        prepareNewSession: vi.fn(),
      },
    });

    expect(outcome.kind).toBe('blocked');
    expect(preflight).not.toHaveBeenCalled();
  });

  it('blocks on an arg-vector preflight blocker raised after the runner is admitted', async () => {
    const project = projectDir();
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'preflight blocker after admission',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [
          {
            id: 'runners.cli.codex.arg-vector.planner',
            severity: 'blocker',
            summary: 'OpenAI Codex CLI planner invocation uses unsupported flags.',
          },
        ],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
        resolveCliExecutableAliases: async () => ({
          command: 'codex',
          executable,
          usedFallback: false,
        }),
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(
      outcome.report.sections
        .find((section) => section.id === 'runners')
        ?.checks.map((check) => check.id),
    ).toEqual(
      expect.arrayContaining([
        'runners.preparation.planner',
        'runners.cli.codex.arg-vector.planner',
      ]),
    );
    expect(prepareSession).not.toHaveBeenCalled();
  });

  it('uses fresh denial instead of remembered ready presentation state', async () => {
    const project = projectDir();
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const rememberedReady = {
      id: 'runners.cli.codex.readiness',
      severity: 'ok' as const,
      summary: 'OpenAI Codex CLI is installed, trusted, compatible, and signed in.',
      metadata: {
        tool: 'codex',
        status: 'ready',
        installation: 'installed',
        trust: 'trusted',
        compatibility: 'compatible',
        auth: 'authenticated',
        executablePath: '/remembered/codex',
      },
    };
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'fresh denial wins',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project, [rememberedReady]), config }),
        detectRunnerEvidence: async ({ context }) =>
          freshCliEvidence(context, {
            installation: 'missing',
            executable: { kind: 'missing' },
          }),
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    const runnerChecks = outcome.report.sections.find(
      (section) => section.id === 'runners',
    )?.checks;
    expect(runnerChecks).not.toContainEqual(rememberedReady);
    expect(runnerChecks).toContainEqual(
      expect.objectContaining({
        id: 'runners.preparation.planner',
        severity: 'blocker',
      }),
    );
    expect(outcome).not.toHaveProperty('execution');
    expect(prepareSession).not.toHaveBeenCalled();
  });

  it('reauthorizes the exact resume ref without creating a session', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex' },
      implementer: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
      },
    });
    const existingSession = { projectDir: project, sessionId: 'existing-session' };
    const prepareSession = vi.fn();
    const collect = vi.fn(async () => ({ report: readyReport(project), config }));
    const detect = vi.fn(async ({ context }) => freshCliEvidence(context));
    const revalidate = vi.fn(async () => ({
      command: 'codex',
      executable,
      usedFallback: false,
    }));
    const active = {
      version: 1 as const,
      sessionId: existingSession.sessionId,
      generation: '77777777-7777-4777-8777-777777777777',
    };
    const reactivate = vi.fn(() => active);
    const input = {
      feature: 'resume exact session',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: {
        purpose: 'resume',
        interaction: 'headless',
        unverifiedAuth: 'denied',
        allowRepoRunners: true,
        allowHooks: true,
      },
      existingSession,
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: collect,
        detectRunnerEvidence: detect,
        resolveCliExecutableAliases: revalidate,
        prepareNewSession: prepareSession,
        reactivateExistingSession: reactivate,
      },
    } satisfies PrepareExecutionInput;

    const outcome = await prepareExecution(input);

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    expect(outcome.execution.session.kind).toBe('existing');
    expect(outcome.execution.session.ref).toBe(existingSession);
    expect(outcome.execution.session.active).toBe(active);
    expect(outcome.execution.gates.map((gate) => gate.slot)).toEqual([
      { role: 'planner' },
      { role: 'implementer', profile: 'default' },
    ]);
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: project, resumeSession: existingSession }),
    );
    expect(detect).toHaveBeenCalledWith(expect.objectContaining({ projectDir: project }));
    expect(revalidate).toHaveBeenCalledWith(expect.objectContaining({ projectDir: project }));
    expect(prepareSession).not.toHaveBeenCalled();
    expect(reactivate).toHaveBeenCalledWith(existingSession);

    const conflictingInput = { ...input, projectDir: '/different-project' };
    // @ts-expect-error Resume derives its project from existingSession and cannot override it.
    void (conflictingInput satisfies PrepareExecutionInput);
  });

  it.each(['absent', 'legacy', 'v1'] as const)(
    'reactivates the same session from %s prior state',
    async (prior) => {
      const { project, existingSession, outcome } = await resumeActivation(prior);

      expect(outcome.kind).toBe('prepared');
      if (outcome.kind !== 'prepared') return;
      expect(outcome.execution.session).toMatchObject({
        kind: 'existing',
        ref: existingSession,
        active: { version: 1, sessionId: existingSession.sessionId },
      });
      expect(readActiveRecord(project)).toEqual({
        kind: 'v1',
        receipt: outcome.execution.session.active,
      });
    },
  );

  it('rotates the generation when reactivating a v1 record', async () => {
    const { before, outcome } = await resumeActivation('v1');

    expect(before?.kind).toBe('v1');
    expect(outcome.kind).toBe('prepared');
    if (before?.kind !== 'v1' || outcome.kind !== 'prepared') return;
    expect(outcome.execution.session.active.generation).not.toBe(before.receipt.generation);
  });

  it('refuses to reactivate when another session owns the active record', async () => {
    const { project, before, outcome } = await resumeActivation('different');

    expect(outcome).toMatchObject({
      kind: 'failed',
      error: { kind: 'session-still-active' },
      report: { status: 'ready', counts: { blocker: 0 } },
    });
    expect(readActiveRecord(project)).toEqual(before);
  });

  it('takes over the active record from a run whose owner is dead', async () => {
    const { project, existingSession, outcome } = await resumeActivation('dead-other');

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    expect(outcome.execution.session.active.sessionId).toBe(existingSession.sessionId);
    expect(readActiveRecord(project)).toEqual({
      kind: 'v1',
      receipt: outcome.execution.session.active,
    });
  });

  it('prepares only the planner for spec execution', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        apiBase: 'https://api.example.test/v1',
        apiKey: 'sk-endpoint-test',
        model: 'claude-opus-4-6',
      },
      implementerProfiles: {
        profiles: {
          primary: {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
          },
          review: {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:14b',
          },
        },
      },
    });
    const prepareSession = vi.fn(() => preparedSession(project, 'spec-session'));

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'planner-only spec',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('spec'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    expect(outcome.execution.gates).toEqual([
      expect.objectContaining({ kind: 'api', slot: { role: 'planner' } }),
    ]);
    expect(prepareSession).toHaveBeenCalledOnce();
  });

  it('suppresses session mutation when abort follows runner evidence or final revalidation', async () => {
    for (const abortAt of ['evidence', 'revalidation'] as const) {
      const project = projectDir();
      const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
      const controller = new AbortController();
      const prepareSession = vi.fn();

      const outcome = await prepareExecution({
        projectDir: project,
        feature: `abort after ${abortAt}`,
        effectiveConfig: config,
        signal: controller.signal,
        policy: policy('new-workflow'),
        deps: {
          collectArgVectorPreflightChecks: async () => [],
          collectReadiness: async () => ({ report: readyReport(project), config }),
          detectRunnerEvidence: async ({ context }) => {
            await Promise.resolve();
            if (abortAt === 'evidence') controller.abort();
            return freshCliEvidence(context);
          },
          resolveCliExecutableAliases: async () => {
            if (abortAt === 'revalidation') controller.abort();
            return { command: 'codex', executable, usedFallback: false };
          },
          prepareNewSession: prepareSession,
        },
      });

      expect(outcome).toEqual({ kind: 'aborted' });
      expect(prepareSession).not.toHaveBeenCalled();
    }
  });

  it('aborts configured-runner approval before trust or session artifacts are written', async () => {
    const project = projectDir();
    const stateDir = join(project, 'runner-state');
    const processSentinel = join(project, 'configured-runner-started');
    const config = configuredApprovalConfig(processSentinel);
    const controller = new AbortController();
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'abort configured runner approval',
      effectiveConfig: config,
      signal: controller.signal,
      policy: {
        purpose: 'new-workflow',
        interaction: 'interactive',
        unverifiedAuth: 'denied',
        allowRepoRunners: false,
        allowHooks: true,
        stateDir,
        onTieredApproval: async () => {
          controller.abort();
          return {
            decision: 'confirm',
            phrase: CONFIRM_PHRASE,
            reason: 'I reviewed this command.',
          };
        },
      },
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(prepareSession).not.toHaveBeenCalled();
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(false);
    expect(existsSync(processSentinel)).toBe(false);
    for (const artifact of noArtifactPaths(project)) expect(existsSync(artifact)).toBe(false);
  });

  it('reports failure rather than a clean abort when cancellation follows trust publication', async () => {
    const project = projectDir();
    const stateDir = join(project, 'runner-state');
    const processSentinel = join(project, 'configured-runner-started');
    const config = configuredApprovalConfig(processSentinel);
    const controller = new AbortController();
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'abort after configured runner trust publication',
      effectiveConfig: config,
      signal: controller.signal,
      policy: {
        purpose: 'new-workflow',
        interaction: 'interactive',
        unverifiedAuth: 'denied',
        allowRepoRunners: false,
        allowHooks: true,
        stateDir,
        onTieredApproval: async () => ({
          decision: 'confirm',
          phrase: CONFIRM_PHRASE,
          reason: 'I reviewed this command.',
        }),
      },
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        prepareCustomRunnerAdmission: (options) =>
          prepareCustomRunnerAdmission({
            ...options,
            _afterTrustWrite: () => controller.abort(),
          }),
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      error: { kind: 'custom-runner-trust-persisted-after-abort' },
    });
    expect(prepareSession).not.toHaveBeenCalled();
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(true);
    expect(existsSync(processSentinel)).toBe(false);
    for (const artifact of noArtifactPaths(project)) expect(existsSync(artifact)).toBe(false);
  });

  it('names the credential the runner is missing when the start gate denies authentication', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'session' },
    });
    const detectRunnerEvidence = vi.fn<PrepareExecutionDependencies['detectRunnerEvidence']>(
      async ({ context }) => ({
        ...freshCliEvidence(context),
        credential: 'absent',
        auth: 'missing',
      }),
    );

    // A session denial is probed again after the readiness retry delay; the
    // fake clock spends that delay instead of the wall clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = prepareExecution({
      projectDir: project,
      feature: 'unauthenticated planner',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('spec'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence,
        resolveCliExecutableAliases: async () => ({
          command: 'codex',
          executable,
          usedFallback: false,
        }),
        prepareNewSession: vi.fn(),
      },
    });
    await vi.waitFor(() => expect(detectRunnerEvidence).toHaveBeenCalledTimes(1));
    const outcome = await settleUnderFakeTimers(pending);

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    const check = outcome.report.sections
      .find((section) => section.id === 'runners')
      ?.checks.find((candidate) => candidate.id === 'runners.preparation.planner');
    expect(check).toMatchObject({ severity: 'blocker' });
    // "Review the configured runner" sends the user back to a config that
    // looks right; the gate knows exactly which credential is missing.
    expect(check?.fix).toBe(
      'SPLITBRIEF looks for the OpenAI Codex CLI session in its session files. Sign in to OpenAI Codex CLI, then run `splitbrief doctor` again.',
    );
  });

  it.each([
    {
      label: 'incompatible version',
      evidence: {
        compatibility: { kind: 'incompatible', installedVersion: '0.1.0', testedVersion: '9.8.7' },
      },
      remedy:
        'Install the tested OpenAI Codex CLI version (9.8.7), then run `splitbrief doctor` again.',
    },
    {
      label: 'unknown version',
      evidence: {
        compatibility: { kind: 'unknown', installedVersion: null, testedVersion: '9.8.7' },
      },
      remedy:
        'Verify OpenAI Codex CLI against tested version 9.8.7, then run `splitbrief doctor` again.',
    },
    {
      label: 'untrusted executable',
      evidence: { executable: { kind: 'untrusted' } },
      remedy:
        'Install OpenAI Codex CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again.',
    },
    {
      label: 'changed executable',
      evidence: { executable: { kind: 'identity-drifted' } },
      remedy:
        'Install OpenAI Codex CLI outside the project. Put its absolute directory first on PATH, then run `splitbrief doctor` again.',
    },
    {
      label: 'missing executable',
      evidence: { executable: { kind: 'missing' } },
      remedy: 'Install OpenAI Codex CLI, then run `splitbrief doctor` again.',
    },
    {
      label: 'missing installation',
      evidence: { installation: 'missing' },
      remedy: 'Install OpenAI Codex CLI, then run `splitbrief doctor` again.',
    },
    {
      label: 'unknown installation',
      evidence: { installation: 'unknown' },
      remedy:
        'Check that OpenAI Codex CLI is installed and on PATH, then run `splitbrief doctor` again.',
    },
    {
      label: 'disabled tool',
      evidence: { runner: { id: 'codex', kind: 'cli', locality: 'local', enabled: 'disabled' } },
      remedy: 'Enable OpenAI Codex CLI before selecting it as a runner.',
    },
  ] as const)('supplies the specific remedy for $label', async ({ evidence, remedy }) => {
    const checks = await collectRunnerAdmissionChecks({
      routeCatalogs: new Map(),
      projectDir: projectDir(),
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex' } }),
      purpose: 'spec',
      interaction: 'headless',
      deps: {
        detectRunnerEvidence: async ({ context }) => ({
          ...freshCliEvidence(context),
          ...evidence,
        }),
      },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.fix).toBe(remedy);
  });

  it('reports an unknown version shared by three seats once', async () => {
    const seat = { kind: 'cli', tool: 'codex' } as const;
    const checks = await collectRunnerAdmissionChecks({
      routeCatalogs: new Map(),
      projectDir: projectDir(),
      config: makeConfig({ planner: seat, implementer: seat, reviewer: seat }),
      interaction: 'headless',
      deps: {
        detectRunnerEvidence: async ({ context }) => ({
          ...freshCliEvidence(context),
          compatibility: { kind: 'unknown', installedVersion: null, testedVersion: '9.8.7' },
        }),
      },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      summary: 'PLAN, BUILD and REVIEW cannot start with OpenAI Codex CLI.',
      details: ['OpenAI Codex CLI version could not be confirmed as compatible.'],
      runnerCause: { tool: 'codex', cause: 'unknown-version' },
    });
    expect(checks[0]?.diagnosticState).toBeUndefined();
    expect(checks[0]?.runnerCause?.authChannel).toBeUndefined();
  });

  it.each([
    [
      'missing',
      'unauthenticated',
      'unauthenticated',
      'OpenAI Codex CLI is not signed in.',
      'Sign in to OpenAI Codex CLI',
    ],
    [
      'invalid',
      'unauthenticated',
      'unauthenticated',
      'OpenAI Codex CLI credentials are invalid.',
      'Sign in to OpenAI Codex CLI',
    ],
    [
      'timeout',
      'auth-timeout',
      'auth-timeout',
      'OpenAI Codex CLI sign-in check timed out.',
      'Check the network connection',
    ],
    [
      'offline',
      'auth-offline',
      'auth-offline',
      'OpenAI Codex CLI sign-in check could not connect.',
      'Check the network connection',
    ],
    [
      'malformed',
      'auth-malformed',
      'auth-malformed',
      'SPLITBRIEF could not read the OpenAI Codex CLI sign-in check result.',
      'Run `splitbrief doctor` again.',
    ],
    [
      'policy-denied',
      'auth-policy-denied',
      'auth-policy-denied',
      'OpenAI Codex CLI sign-in check was denied by a policy.',
      'Check the account and access policy',
    ],
    [
      'not-selected',
      undefined,
      'auth-not-selected',
      'OpenAI Codex CLI has no authentication channel selected.',
      'Select an authentication channel',
    ],
    [
      'cancelled',
      undefined,
      'auth-check-cancelled',
      'OpenAI Codex CLI sign-in check was cancelled.',
      'Run `splitbrief doctor` again.',
    ],
    [
      'not-run',
      undefined,
      'auth-check-not-run',
      'OpenAI Codex CLI sign-in check did not run.',
      'Run `splitbrief doctor` again.',
    ],
  ] as const)(
    'reports the authentication fact %s with its recovery',
    async (auth, state, cause, message, remedy) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = collectRunnerAdmissionChecks({
        routeCatalogs: new Map(),
        projectDir: projectDir(),
        config: makeConfig({ planner: { kind: 'cli', tool: 'codex', authChannel: 'session' } }),
        purpose: 'spec',
        interaction: 'headless',
        deps: {
          detectRunnerEvidence: async ({ context }) => ({ ...freshCliEvidence(context), auth }),
        },
      });
      const checks = await settleUnderFakeTimers(pending);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({
        details: [message],
        fix: expect.stringContaining(remedy),
      });
      expect(checks[0]?.diagnosticState).toBe(state);
      expect(checks[0]?.runnerCause).toMatchObject({ cause, authChannel: 'session' });
      if (auth !== 'missing' && auth !== 'invalid') {
        expect(checks[0]?.fix).not.toContain('Sign in to');
      }
    },
  );

  it('keeps an unknown session separate from a policy denial on another seat', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const seat = { kind: 'cli', tool: 'codex', authChannel: 'session' } as const;
    const pending = collectRunnerAdmissionChecks({
      routeCatalogs: new Map(),
      projectDir: projectDir(),
      config: makeConfig({ planner: seat, implementer: seat }),
      interaction: 'headless',
      deps: {
        detectRunnerEvidence: async ({ context }) => ({
          ...freshCliEvidence(context),
          auth: context.role === 'implementer' ? 'policy-denied' : 'unknown',
        }),
      },
    });
    const checks = await settleUnderFakeTimers(pending);
    expect(checks).toHaveLength(2);
    expect(checks.find((check) => check.diagnosticState === 'auth-unknown')?.fix).toContain(
      '--allow-unverified-auth',
    );
    expect(checks.find((check) => check.diagnosticState === 'auth-policy-denied')).toMatchObject({
      details: ['OpenAI Codex CLI sign-in check was denied by a policy.'],
      fix: 'Check the account and access policy, then run `splitbrief doctor` again.',
      runnerCause: { seats: ['BUILD'] },
    });
  });

  it('names --allow-unverified-auth when headless admission fail-closes on unverified auth', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'session' },
    });

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'unverified planner',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('spec'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) => ({
          ...freshCliEvidence(context),
          auth: 'unknown',
        }),
        resolveCliExecutableAliases: async () => ({
          command: 'codex',
          executable,
          usedFallback: false,
        }),
        prepareNewSession: vi.fn(),
      },
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    const check = outcome.report.sections
      .find((section) => section.id === 'runners')
      ?.checks.find((candidate) => candidate.id === 'runners.preparation.planner');
    expect(check?.details).toContain('OpenAI Codex CLI sign-in status is unknown.');
    // The denial is policy, not a broken credential; the fix must name the
    // escape hatch instead of sending the user back to a config that is fine.
    expect(check?.fix).toContain('--allow-unverified-auth');
  });

  it('blocks without a session when final CLI identity revalidation fails', async () => {
    const project = projectDir();
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'changed executable identity',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
        resolveCliExecutableAliases: async () => {
          throw new Error('Executable identity mismatch');
        },
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(
      outcome.report.sections
        .find((section) => section.id === 'runners')
        ?.checks.find((check) => check.id === 'runners.preparation.planner'),
    ).toMatchObject({ severity: 'blocker' });
    expect(outcome).not.toHaveProperty('execution');
    expect(prepareSession).not.toHaveBeenCalled();
  });

  it('admits a configured custom runner once and keeps its invocation in the generic gate', async () => {
    const project = projectDir();
    const config = ConfigSchema.parse({
      ...makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'sk-endpoint-test',
          model: 'claude-opus-4-6',
        },
        implementerProfiles: {
          default: 'review',
          profiles: {
            review: { kind: 'shell', command: 'node', model: 'custom-reviewer' },
          },
        },
      }),
      customCommands: {
        review: { label: 'Review changes', contract: 'output', executable: 'node' },
      },
    });
    const prepareAdmission = vi.fn(async (options) => ({
      kind: 'admitted' as const,
      trustPersisted: false,
      invocation: {
        kind: 'custom-runner-invocation' as const,
        runner: options.runner,
        posture: options.posture,
        executable,
        authorization: 'explicit-grant' as const,
        scope: {
          projectIdentity: `sha256:${'b'.repeat(64)}`,
          definitionId: options.runner.command.id,
          definitionDigest: `sha256:${'c'.repeat(64)}`,
        },
      },
    }));

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'prepare configured command',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        prepareCustomRunnerAdmission: prepareAdmission,
        prepareNewSession: () => preparedSession(project, 'custom-session'),
      },
    });

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    expect(prepareAdmission).toHaveBeenCalledTimes(1);
    expect(outcome.execution.gates).toContainEqual(
      expect.objectContaining({
        kind: 'shell',
        slot: { role: 'implementer', profile: 'review' },
        command: expect.objectContaining({
          kind: 'configured-custom',
          invocation: expect.objectContaining({
            scope: expect.objectContaining({ definitionId: 'review' }),
          }),
        }),
      }),
    );
  });

  it('admits a configured reviewer as its own seat and blocks the start when it fails', async () => {
    const project = projectDir();
    const withReviewer = (apiKey: string | undefined) =>
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'sk-endpoint-test',
          model: 'claude-opus-4-6',
        },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:7b',
        },
        reviewer: {
          kind: 'api',
          provider: 'reviewer-endpoint',
          apiBase: 'https://reviewer.example.test/v1',
          model: 'some-model',
          ...(apiKey !== undefined && { apiKey }),
        },
      });
    const run = (config: ReturnType<typeof withReviewer>, sessionId: string) =>
      prepareExecution({
        projectDir: project,
        feature: 'prepare the reviewer seat',
        effectiveConfig: config,
        signal: new AbortController().signal,
        policy: policy('new-workflow'),
        deps: {
          collectArgVectorPreflightChecks: async () => [],
          collectReadiness: async () => ({ report: readyReport(project), config }),
          prepareNewSession: () => preparedSession(project, sessionId),
        },
      });

    const admitted = await run(withReviewer('sk-reviewer-test'), 'reviewer-session');
    expect(admitted.kind).toBe('prepared');
    if (admitted.kind !== 'prepared') return;
    expect(admitted.execution.gates).toContainEqual(
      expect.objectContaining({ kind: 'api', slot: { role: 'reviewer' } }),
    );
    expect(reviewerChecks(admitted.execution.report)).toEqual([
      expect.objectContaining({ severity: 'ok' }),
    ]);

    const blocked = await run(withReviewer(undefined), 'reviewer-blocked-session');
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind !== 'blocked') return;
    expect(reviewerChecks(blocked.report)).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        summary: expect.stringContaining('REVIEW'),
      }),
    ]);
  });

  it('admits a shell reviewer through the configured custom command path', async () => {
    const project = projectDir();
    const config = ConfigSchema.parse({
      ...makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'sk-endpoint-test',
          model: 'claude-opus-4-6',
        },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:7b',
        },
        reviewer: { kind: 'shell', command: 'node', model: 'custom-reviewer' },
      }),
      customCommands: {
        review: { label: 'Review changes', contract: 'output', executable: 'node' },
      },
    });
    const prepareAdmission = vi.fn(async (options) => ({
      kind: 'admitted' as const,
      trustPersisted: false,
      invocation: {
        kind: 'custom-runner-invocation' as const,
        runner: options.runner,
        posture: options.posture,
        executable,
        authorization: 'explicit-grant' as const,
        scope: {
          projectIdentity: `sha256:${'b'.repeat(64)}`,
          definitionId: options.runner.command.id,
          definitionDigest: `sha256:${'c'.repeat(64)}`,
        },
      },
    }));

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'prepare a configured shell reviewer',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        prepareCustomRunnerAdmission: prepareAdmission,
        prepareNewSession: () => preparedSession(project, 'shell-reviewer-session'),
      },
    });

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    expect(prepareAdmission.mock.calls[0]?.[0]?.posture).toMatchObject({ role: 'planner' });
    expect(outcome.execution.gates).toContainEqual(
      expect.objectContaining({ kind: 'shell', slot: { role: 'reviewer' } }),
    );
  });

  it('blocked preparation leaves no session readiness active liveness or process artifact', async () => {
    const project = projectDir();
    const config = makeConfig({ planner: { kind: 'cli', tool: 'codex' } });
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'blocked without artifacts',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) =>
          freshCliEvidence(context, { executable: { kind: 'untrusted' } }),
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome.kind).toBe('blocked');
    expect(prepareSession).not.toHaveBeenCalled();
    expect(noArtifactPaths(project).some(existsSync)).toBe(false);
  });

  it('failed preparation leaves no session readiness active liveness or process artifact', async () => {
    const project = projectDir();
    const config = makeConfig();
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'failed without artifacts',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => {
          throw new Error('readiness failed');
        },
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome).toMatchObject({ kind: 'failed', error: { message: 'readiness failed' } });
    expect(prepareSession).not.toHaveBeenCalled();
    expect(noArtifactPaths(project).some(existsSync)).toBe(false);
  });

  it('aborted preparation leaves no session readiness active liveness or process artifact', async () => {
    const project = projectDir();
    const config = makeConfig();
    const controller = new AbortController();
    controller.abort();
    const collect = vi.fn();
    const prepareSession = vi.fn();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'aborted without artifacts',
      effectiveConfig: config,
      signal: controller.signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: collect,
        prepareNewSession: prepareSession,
      },
    });

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(collect).not.toHaveBeenCalled();
    expect(prepareSession).not.toHaveBeenCalled();
    expect(noArtifactPaths(project).some(existsSync)).toBe(false);
  });
});

describe('inline command runner admission', () => {
  const CONFIRMED = {
    decision: 'confirm',
    phrase: CONFIRM_PHRASE,
    reason: 'I read the command and I want it to run.',
  } as const;

  function inlineShellConfig(sentinel: string) {
    return ConfigSchema.parse(
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'sk-endpoint-test',
          model: 'claude-opus-4-6',
        },
        implementerProfiles: {
          default: 'review',
          profiles: {
            review: {
              kind: 'shell',
              command: process.execPath,
              args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`],
              model: 'inline-shell',
            },
          },
        },
      }),
    );
  }

  function inlineRun(
    input: Readonly<{
      project: string;
      stateDir: string;
      config: ReturnType<typeof inlineShellConfig>;
      interaction: 'interactive' | 'headless';
      allowRepoRunners?: boolean | undefined;
      onTieredApproval?: PreparationPolicy['onTieredApproval'] | undefined;
    }>,
  ) {
    return prepareExecution({
      projectDir: input.project,
      feature: 'inline runner admission',
      effectiveConfig: input.config,
      signal: new AbortController().signal,
      policy: {
        purpose: 'new-workflow',
        interaction: input.interaction,
        unverifiedAuth: 'denied',
        allowRepoRunners: input.allowRepoRunners ?? false,
        allowHooks: true,
        stateDir: input.stateDir,
        ...(input.onTieredApproval !== undefined && { onTieredApproval: input.onTieredApproval }),
      },
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({
          report: readyReport(input.project),
          config: input.config,
        }),
        prepareNewSession: () => preparedSession(input.project, 'inline-runner-session'),
      },
    });
  }

  function preparationCheck(report: ReadinessReport, id: string) {
    return report.sections
      .find((section) => section.id === 'runners')
      ?.checks.find((check) => check.id === id);
  }

  it('refuses a config-declared command that this machine never confirmed', async () => {
    const project = projectDir();
    const sentinel = join(project, 'inline-runner-ran');

    const outcome = await inlineRun({
      project,
      stateDir: join(project, 'runner-state'),
      config: inlineShellConfig(sentinel),
      interaction: 'headless',
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(
      preparationCheck(outcome.report, 'runners.preparation.implementer.review'),
    ).toMatchObject({
      severity: 'blocker',
      details: [
        'Project config declares a shell runner command that this machine has not trusted.',
      ],
      fix: 'Run SPLITBRIEF in a terminal and confirm the runner disclosure, or pass --allow-repo-runners to grant it for this run only.',
    });
    expect(existsSync(sentinel)).toBe(false);
  });

  it('names an absent command instead of reporting it as untrusted', async () => {
    const project = projectDir();
    const config = ConfigSchema.parse(
      makeConfig({
        planner: {
          kind: 'shell',
          command: join(project, 'no-such-runner'),
          model: 'inline-shell',
        },
      }),
    );

    const outcome = await inlineRun({
      project,
      stateDir: join(project, 'runner-state'),
      config,
      interaction: 'headless',
      allowRepoRunners: true,
    });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(preparationCheck(outcome.report, 'runners.preparation.planner')).toMatchObject({
      details: [
        'Project config declares a shell runner command that does not exist on this machine.',
      ],
      fix: 'Install the command or correct its path in .splitbrief/config.yaml, then retry.',
    });
  });

  it('discloses the resolved command and reuses the confirmed receipt without re-prompting', async () => {
    const project = projectDir();
    const stateDir = join(project, 'runner-state');
    const config = inlineShellConfig(join(project, 'inline-runner-ran'));
    const requests: string[] = [];

    const confirmed = await inlineRun({
      project,
      stateDir,
      config,
      interaction: 'interactive',
      onTieredApproval: async (request) => {
        requests.push(request.actionDescription);
        return CONFIRMED;
      },
    });

    expect(confirmed.kind).toBe('prepared');
    if (confirmed.kind !== 'prepared') return;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(`Executable: ${JSON.stringify(process.execPath)}`);
    expect(requests[0]).toContain('Working directory: Project directory');
    expect(requests[0]).toContain('Environment access: Declared environment references only');
    expect(confirmed.execution.gates).toContainEqual(
      expect.objectContaining({
        kind: 'shell',
        slot: { role: 'implementer', profile: 'review' },
        command: { kind: 'validated-config' },
      }),
    );
    expect(existsSync(resolveCustomRunnerTrustFile(stateDir))).toBe(true);

    const reused = await inlineRun({ project, stateDir, config, interaction: 'headless' });
    expect(reused.kind).toBe('prepared');
  });

  it('does not carry a receipt to another checkout of the same config', async () => {
    const granted = projectDir();
    const stateDir = join(granted, 'runner-state');
    const config = inlineShellConfig(join(granted, 'inline-runner-ran'));

    await inlineRun({
      project: granted,
      stateDir,
      config,
      interaction: 'interactive',
      onTieredApproval: async () => CONFIRMED,
    });
    const copied = projectDir();
    const outcome = await inlineRun({
      project: copied,
      stateDir,
      config,
      interaction: 'headless',
    });

    expect(outcome.kind).toBe('blocked');
  });
});

describe('prepareExecution availability probe scope', () => {
  async function probedRoles(purpose: 'new-workflow' | 'spec'): Promise<unknown> {
    const project = projectDir();
    const config = makeConfig({
      planner: { kind: 'shell', command: 'node', model: 'local-shell' },
    });
    const probe = vi.fn<typeof probeRunnerAvailability>(async () => []);

    await prepareExecution({
      projectDir: project,
      feature: 'probe scope',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy(purpose),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async (options) => {
          await options.probeRunnerAvailability?.({ config });
          return { report: readyReport(project), config };
        },
        probeRunnerAvailability: probe,
        prepareNewSession: () => preparedSession(project, `probe-scope-${purpose}`),
        newPreparationId: () => `preparation-${purpose}`,
      },
    });

    return probe.mock.calls[0]?.[0]?.roles;
  }

  it('probes planner, implementer and reviewer for a workflow start', async () => {
    expect(await probedRoles('new-workflow')).toEqual(['planner', 'implementer', 'reviewer']);
  });

  it('probes only the planner for a spec preparation, which never calls the implementer', async () => {
    expect(await probedRoles('spec')).toEqual(['planner']);
  });
});

describe('prepareReviewExecution', () => {
  const reviewPolicy = (): Extract<PreparationPolicy, { purpose: 'review' }> => ({
    purpose: 'review',
    interaction: 'headless',
    unverifiedAuth: 'denied',
    allowRepoRunners: true,
    allowHooks: true,
  });

  function liveSessionReport(project: string): ReadinessReport {
    return {
      generatedAt: '2026-09-11T09:00:00.000Z',
      projectDir: project,
      status: 'blocked',
      counts: { ok: 1, info: 0, warning: 0, blocker: 1 },
      nextAction: {
        kind: 'clean-or-isolate-repo',
        label: 'Clear the session',
        reason: 'A session is live.',
      },
      sections: [
        {
          id: 'runners',
          title: 'Runners',
          checks: [{ id: 'runners.configured', severity: 'ok', summary: 'Configured' }],
        },
        {
          id: 'repo',
          title: 'Repository',
          checks: [
            {
              id: 'repo.active-session-live',
              severity: 'blocker',
              summary: 'Active session live-one is still live.',
              fix: 'Run `splitbrief resume` or clear .splitbrief/active.',
              nextAction: 'clean-or-isolate-repo',
              metadata: { sessionId: 'live-one', live: true },
            },
          ],
        },
      ],
      metadata: {},
    };
  }

  const reviewConfig = () =>
    makeConfig({
      planner: { kind: 'cli', tool: 'codex' },
      implementer: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
      },
    });

  const reviewDeps = (report: ReadinessReport): Partial<PrepareExecutionDependencies> => {
    const config = reviewConfig();
    return {
      collectArgVectorPreflightChecks: async () => [],
      collectReadiness: async () => ({ report, config }),
      detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
      resolveCliExecutableAliases: async () => ({
        command: 'codex',
        executable,
        usedFallback: false,
      }),
      newPreparationId: () => 'preparation-review',
    };
  };

  it('admits the review seat alone and mints no session', async () => {
    const project = projectDir();
    const prepareSession = vi.fn(() => preparedSession(project, 'never-created'));

    const outcome = await prepareReviewExecution({
      projectDir: project,
      effectiveConfig: reviewConfig(),
      signal: new AbortController().signal,
      policy: reviewPolicy(),
      deps: { ...reviewDeps(readyReport(project)), prepareNewSession: prepareSession },
    });

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    expect(outcome.execution.purpose).toBe('review');
    expect(outcome.execution.gates).toHaveLength(1);
    expect(outcome.execution.gates[0]?.slot).toEqual({ role: 'reviewer' });
    expect(prepareSession).not.toHaveBeenCalled();
    for (const path of noArtifactPaths(project)) expect(existsSync(path)).toBe(false);
  });

  it('reports a live session instead of refusing a read-only review', async () => {
    const project = projectDir();

    const outcome = await prepareReviewExecution({
      projectDir: project,
      effectiveConfig: reviewConfig(),
      signal: new AbortController().signal,
      policy: reviewPolicy(),
      deps: reviewDeps(liveSessionReport(project)),
    });

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    const live = outcome.execution.report.sections
      .find((section) => section.id === 'repo')
      ?.checks.find((check) => check.id === 'repo.active-session-live');
    expect(live?.severity).toBe('info');
    expect(outcome.execution.report.status).not.toBe('blocked');
  });

  it('leaves the same live session blocking a workflow start', async () => {
    const project = projectDir();
    const config = reviewConfig();

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'start beside a live session',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: liveSessionReport(project), config }),
        prepareNewSession: () => preparedSession(project, 'never-created'),
      },
    });

    expect(outcome.kind).toBe('blocked');
  });
});
describe('a seat left on auto', () => {
  it('prepares the model the tool has selected on this host while the config keeps auto', async () => {
    const project = projectDir();
    const home = projectDir();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-6-astra"', 'utf8');
    vi.stubEnv('HOME', home);
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        apiBase: 'https://api.example.test/v1',
        apiKey: 'sk-endpoint-test',
        model: 'claude-opus-4-6',
      },
      implementer: { kind: 'cli', tool: 'codex', model: 'auto' },
    });

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'resolve the host model selection',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
        resolveCliExecutableAliases: async () => ({
          command: 'codex',
          executable,
          usedFallback: false,
        }),
        prepareNewSession: () => preparedSession(project, 'auto-model-session'),
      },
    });

    expect(outcome.kind).toBe('prepared');
    if (outcome.kind !== 'prepared') return;
    expect(outcome.execution.config.implementer).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-6-astra',
    });
    expect(outcome.execution.gates).toContainEqual(
      expect.objectContaining({
        slot: { role: 'implementer', profile: 'default' },
        effectiveModel: 'gpt-6-astra',
      }),
    );
    expect(outcome.execution.sourceConfig.implementer).toMatchObject({ model: 'auto' });
    expect(config.implementer).toMatchObject({ model: 'auto' });
  });
});

describe('the model list a CLI route is read against', () => {
  const LOCAL_ROUTE = { kind: 'cli', tool: 'opencode', model: 'ollama/llama3' } as const;

  /** OpenCode serving `ollama/llama3`; it stores a credential only when `providerAuth` names one. */
  function opencodeSeats(
    config: Parameters<typeof makeConfig>[0],
    evidence: Partial<RunnerEvidence> = {},
  ) {
    const detect = vi.fn<PrepareExecutionDependencies['detectRunnerEvidence']>(
      async ({ context, includeCatalog }) => ({
        ...freshCliEvidence(context),
        runner: { id: 'opencode', kind: 'cli', locality: 'local', enabled: 'enabled' },
        auth: 'missing',
        providerAuth: { kind: 'empty' },
        ...evidence,
        ...(includeCatalog === true && {
          catalog: { kind: 'success', value: [{ id: 'ollama/llama3' }] },
        }),
      }),
    );
    const pending = collectRunnerAdmissionChecks({
      routeCatalogs: new Map(),
      projectDir: projectDir(),
      config: makeConfig(config),
      interaction: 'headless',
      deps: { detectRunnerEvidence: detect },
    });
    const listReads = (): number =>
      detect.mock.calls.filter(([input]) => input.includeCatalog === true).length;
    return { pending, listReads };
  }

  it('reads one tool list once for two seats of that tool', async () => {
    const { pending, listReads } = opencodeSeats({
      planner: LOCAL_ROUTE,
      implementer: LOCAL_ROUTE,
    });

    const checks = await pending;

    expect(listReads()).toBe(1);
    expect(checks.filter((check) => check.severity === 'blocker')).toEqual([]);
  });

  it('reads no list when a stored credential covers the route', async () => {
    const { pending, listReads } = opencodeSeats(
      { planner: LOCAL_ROUTE },
      {
        auth: 'verified',
        providerAuth: {
          kind: 'read',
          facts: [{ id: 'ollama', provider: 'Ollama', source: 'api' }],
        },
      },
    );

    await pending;

    expect(listReads()).toBe(0);
  });

  it('reads no list for a seat the tool refuses on another fact', async () => {
    const { pending, listReads } = opencodeSeats(
      { planner: LOCAL_ROUTE },
      {
        compatibility: { kind: 'incompatible', installedVersion: '0.0.1', testedVersion: '9.9.9' },
      },
    );

    const checks = await pending;

    expect(listReads()).toBe(0);
    expect(checks[0]).toMatchObject({
      runnerCause: { tool: 'opencode', cause: 'incompatible-version' },
    });
  });
});
