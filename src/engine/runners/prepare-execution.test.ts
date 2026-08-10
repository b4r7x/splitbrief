import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { CliExecutableReceiptSchema } from '../../core/discovery/detection.js';
import type { RunnerEvidence } from '../../core/discovery/runner-evidence.js';
import type { ReadinessReport } from '../../core/readiness/types.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import { ConfigSchema } from '../../core/schemas/config.js';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import {
  readActiveRecord,
  reactivateExistingSession,
  writeActive,
} from '../../core/sessions/lifecycle.js';
import { runnerDiscoveryContextKey } from '../detection/detect.js';
import { resolveCustomRunnerTrustFile } from './custom-trust.js';
import { prepareCustomRunnerAdmission } from './custom-admission.js';
import type { probeRunnerAvailability } from './probe-availability.js';
import {
  prepareExecution,
  type PreparationPolicy,
  type PrepareExecutionInput,
} from './prepare-execution.js';

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

afterEach(() => {
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
        provider: 'anthropic',
        service: 'anthropic',
        offering: 'payg',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
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

describe('prepareExecution', () => {
  it('checks planner and every configured profile and derives report and gates from each result', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      implementerProfiles: {
        default: 'api',
        profiles: {
          api: {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen2.5-coder:7b',
          },
          sdk: { kind: 'agent-sdk', apiKey: 'sdk-secret', model: 'claude-sonnet-4-5' },
          shell: { kind: 'shell', command: 'node', model: 'local-shell' },
          agent: { kind: 'agent', command: 'node', model: 'local-agent' },
        },
      },
      escalation: {
        enabled: true,
        intermediateProvider: 'ollama',
        intermediateModel: 'qwen2.5-coder:14b',
      },
    });
    const prepareSession = vi.fn(() => preparedSession(project, 'prepared-session'));

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'prepare every runner',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('new-workflow'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) => freshCliEvidence(context),
        isAgentSdkAvailable: async () => true,
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
    expect(outcome.execution.gates).toHaveLength(6);
    expect(outcome.execution.gates.map((gate) => [gate.slot, gate.kind])).toEqual([
      [{ role: 'planner' }, 'cli'],
      [{ role: 'implementer', profile: 'agent' }, 'agent'],
      [{ role: 'implementer', profile: 'api' }, 'api'],
      [{ role: 'implementer', profile: 'sdk' }, 'agent-sdk'],
      [{ role: 'implementer', profile: 'shell' }, 'shell'],
      [{ role: 'intermediate' }, 'api'],
    ]);
    expect(
      outcome.execution.report.sections
        .find((section) => section.id === 'runners')
        ?.checks.filter((check) => check.id.startsWith('runners.preparation.')),
    ).toHaveLength(6);
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
      summary: 'OpenAI Codex CLI is installed, trusted, compatible, and authenticated.',
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
      planner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
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

  it('reactivates absent and same-session legacy or v1 state but refuses another session', async () => {
    for (const prior of ['absent', 'legacy', 'v1', 'different'] as const) {
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
      if (prior === 'different') {
        writeActive({ projectDir: project, sessionId: 'another-session' });
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

      if (prior === 'different') {
        expect(outcome.kind).toBe('failed');
        expect(readActiveRecord(project)).toEqual(before);
        continue;
      }
      expect(outcome.kind).toBe('prepared');
      if (outcome.kind !== 'prepared') continue;
      expect(outcome.execution.session).toMatchObject({
        kind: 'existing',
        ref: existingSession,
        active: { version: 1, sessionId: existingSession.sessionId },
      });
      expect(readActiveRecord(project)).toEqual({
        kind: 'v1',
        receipt: outcome.execution.session.active,
      });
      if (before?.kind === 'v1') {
        expect(outcome.execution.session.active.generation).not.toBe(before.receipt.generation);
      }
    }
  });

  it('prepares only the planner for spec execution', async () => {
    const project = projectDir();
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
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

    const outcome = await prepareExecution({
      projectDir: project,
      feature: 'unauthenticated planner',
      effectiveConfig: config,
      signal: new AbortController().signal,
      policy: policy('spec'),
      deps: {
        collectArgVectorPreflightChecks: async () => [],
        collectReadiness: async () => ({ report: readyReport(project), config }),
        detectRunnerEvidence: async ({ context }) => ({
          ...freshCliEvidence(context),
          credential: 'absent',
          auth: 'missing',
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
    expect(check).toMatchObject({ severity: 'blocker' });
    // "Review the configured runner" sends the user back to a config that
    // looks right; the gate knows exactly which credential is missing.
    expect(check?.fix).toContain('No codex session credential');
    expect(check?.fix).toContain('Sign in to codex');
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
    expect(check?.details).toContain(
      'Fresh CLI evidence denied admission: authentication-unverified.',
    );
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
          provider: 'anthropic',
          service: 'anthropic',
          offering: 'payg',
          apiBase: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-test',
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
          provider: 'anthropic',
          service: 'anthropic',
          offering: 'payg',
          apiBase: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-test',
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
    expect(requests[0]).toContain(
      'Environment access: Inherits the full SPLITBRIEF process environment, including credentials',
    );
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

  it('probes planner and implementer for a workflow start', async () => {
    expect(await probedRoles('new-workflow')).toEqual(['planner', 'implementer']);
  });

  it('probes only the planner for a spec preparation, which never calls the implementer', async () => {
    expect(await probedRoles('spec')).toEqual(['planner']);
  });
});
