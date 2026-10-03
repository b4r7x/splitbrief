import { describe, expect, it } from 'vitest';
import { makeConfig as makeBaseConfig } from '#testing/helpers/factories/config.js';
import { buildReadinessReport } from './build.js';
import type { BuildReadinessReportInput } from './build.js';
import type { Config } from '../../schemas/config.js';
import { deriveCliReadiness } from '../../schemas/readiness.js';

function makeConfig(overrides: Parameters<typeof makeBaseConfig>[0] = {}) {
  const implementer = overrides.implementer;
  return makeBaseConfig({
    ...overrides,
    implementer:
      implementer?.kind !== undefined && implementer.kind !== 'api'
        ? implementer
        : { service: 'ollama', offering: 'local', ...implementer },
  });
}

function cliReadiness(auth: 'authenticated' | 'unauthenticated' = 'authenticated') {
  return deriveCliReadiness({
    tool: 'claude-code',
    enabled: true,
    installation: 'installed',
    executable: {
      path: '/usr/local/bin/claude',
      fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
    },
    trust: 'trusted',
    installedVersion: '2.0.0',
    testedVersion: '2.0.0',
    compatibility: 'compatible',
    auth,
    probedAt: 1,
  });
}

function baseInput(overrides: Partial<BuildReadinessReportInput> = {}): BuildReadinessReportInput {
  return {
    projectDir: '/tmp/project',
    config: makeConfig(),
    configLoad: {
      state: 'loaded',
      path: '/tmp/project/.splitbrief/config.yaml',
      warnings: [],
    },
    packageScripts: {
      packageJsonExists: true,
      scripts: { test: 'vitest run' },
    },
    repo: {
      isGitRepo: true,
      hasCommits: true,
      dirtyFiles: [],
      untrackedFiles: [],
    },
    cliReadiness: [cliReadiness()],
    ...overrides,
  };
}

function allCheckIds(input: BuildReadinessReportInput): string[] {
  return buildReadinessReport(input).sections.flatMap((section) =>
    section.checks.map((check) => check.id),
  );
}

function readyInput(overrides: Partial<BuildReadinessReportInput> = {}): BuildReadinessReportInput {
  return baseInput({
    config: makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'example-llm',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
        model: 'acme/reasoner-1',
        contextLength: 128_000,
      },
    }),
    ...overrides,
  });
}

describe('readiness checks', () => {
  it('blocks start when a configured CLI has no probe result', () => {
    const report = buildReadinessReport(
      baseInput({
        config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
        cliReadiness: [],
      }),
    );

    expect(report.status).toBe('blocked');
    expect(
      report.sections
        .flatMap((section) => section.checks)
        .find((check) => check.id === 'runners.cli.claude-code.readiness'),
    ).toMatchObject({
      severity: 'blocker',
      metadata: { status: 'unverified', executablePath: null },
    });
  });

  it('blocks start when a configured CLI probe reports missing required authentication', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    const report = buildReadinessReport(
      baseInput({
        config,
        cliReadiness: [cliReadiness('unauthenticated')],
      }),
    );

    expect(report.status).toBe('blocked');
    expect(report.nextAction.kind).toBe('prepare-runner');
    expect(
      report.sections
        .flatMap((section) => section.checks)
        .find((check) => check.id === 'runners.cli.claude-code.readiness'),
    ).toMatchObject({ severity: 'blocker', metadata: { auth: 'unauthenticated' } });
  });

  it('reports ready for a clean project with valid config, context, and npm test script', () => {
    const report = buildReadinessReport(readyInput());
    const availability = report.sections
      .flatMap((section) => section.checks)
      .find((check) => check.id === 'runners.availability');

    expect(report.status).toBe('ready');
    expect(report.counts.warning).toBe(0);
    expect(availability?.severity).toBe('info');
  });

  it('blocks when config is missing and selects run init', () => {
    const input = baseInput({
      config: undefined,
      configLoad: {
        state: 'missing',
        path: '/tmp/project/.splitbrief/config.yaml',
        warnings: [],
      },
    });
    const report = buildReadinessReport(input);

    expect(report.status).toBe('blocked');
    expect(report.nextAction.kind).toBe('run-init');
    expect(allCheckIds(input)).toContain('config.missing');
  });

  it('warns for missing context length without blocking start', () => {
    const configWithDefaults = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
    });
    const implementerWithoutContext = { ...configWithDefaults.implementer };
    delete implementerWithoutContext.contextLength;
    const config = { ...configWithDefaults, implementer: implementerWithoutContext };

    const input = baseInput({ config });
    const report = buildReadinessReport(input);

    expect(report.status).toBe('ready-with-warnings');
    expect(report.nextAction.kind).toBe('continue');
    expect(
      report.sections
        .flatMap((section) => section.checks)
        .find((check) => check.id === 'context.implementer.missing')?.severity,
    ).toBe('warning');
    expect(allCheckIds(input)).toEqual(
      expect.arrayContaining(['context.planner.missing', 'context.implementer.missing']),
    );
  });

  it('reports the plan approval and no workflow mode, whatever mode the config still names', () => {
    const base = makeConfig({ workflow: { approve: 'none' } });
    const report = buildReadinessReport(
      baseInput({ config: { ...base, workflow: { ...base.workflow, mode: 'speckit' } } }),
    );

    const section = report.sections.find((candidate) => candidate.id === 'workflow');
    expect(section?.title).toBe('Workflow');
    expect(section?.checks.map((check) => check.summary)).toEqual(['Plan approval: none.']);
    expect(report.sections.some((candidate) => candidate.id === 'mode')).toBe(false);
    expect(report.metadata).toEqual(expect.objectContaining({ approve: 'none' }));
    expect(report.metadata).not.toHaveProperty('mode');
  });

  it('says a headless run approves the plan card unattended, at the default approve level', () => {
    const report = buildReadinessReport(
      baseInput({ config: makeConfig({ workflow: { approve: 'plan' } }), interaction: 'headless' }),
    );
    const checks = report.sections.flatMap((section) => section.checks);

    expect(checks.find((check) => check.id === 'approval.resolved')?.summary).toBe(
      'Plan approval: plan; a headless run approves the plan card unattended.',
    );
    expect(
      checks.find((check) => check.id === 'runners.planner.trust-boundary')?.details,
    ).toContain('Approval automation: plan approval is auto-approved.');
  });

  it('asks every config for the same 32000-token context floor', () => {
    const base = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', contextLength: 24_000 },
    });
    const report = buildReadinessReport(
      baseInput({ config: { ...base, workflow: { ...base.workflow, mode: 'quick' } } }),
    );

    const planner = report.sections
      .flatMap((section) => section.checks)
      .find((check) => check.id === 'context.planner.tight');
    expect(planner?.metadata).toMatchObject({ recommendedMinimum: 32_000 });
  });

  it('reports missing profile cost tier and inferred write mode as non-blocking info', () => {
    const config: Config = {
      ...makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'example-llm',
          offering: 'payg',
          apiBase: 'https://api.example.test/v1',
          model: 'acme/reasoner-1',
          contextLength: 128_000,
        },
      }),
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
            contextLength: 32768,
          },
        },
      },
    };

    const report = buildReadinessReport(baseInput({ config }));
    const checks = report.sections.flatMap((section) => section.checks);

    expect(report.status).toBe('ready');
    expect(
      checks.find((check) => check.id === 'runners.implementer.profile-writes-files-inferred'),
    ).toMatchObject({
      severity: 'info',
      metadata: { profile: 'local-qwen', writesFiles: 'extracted-code' },
    });
  });

  it('warns when validation is disabled and the npm test script is missing', () => {
    const config = makeConfig({
      validation: {
        typecheck: false,
        lint: false,
        test: true,
        testCommand: 'npm run verify',
      },
    });

    const input = baseInput({
      config,
      packageScripts: {
        packageJsonExists: true,
        scripts: { test: 'vitest run' },
      },
    });
    const report = buildReadinessReport(input);

    expect(report.status).toBe('ready-with-warnings');
    expect(allCheckIds(input)).toEqual(
      expect.arrayContaining(['validation.disabled', 'validation.test-script-missing']),
    );
  });

  it('warns for dirty repositories and blocks live active sessions', () => {
    const input = baseInput({
      repo: {
        isGitRepo: true,
        hasCommits: true,
        dirtyFiles: ['src/a.ts'],
        untrackedFiles: ['scratch.txt'],
        activeSession: '2026-04-28-live',
        activeSessionLive: true,
      },
    });
    const report = buildReadinessReport(input);

    expect(report.status).toBe('blocked');
    expect(report.nextAction.kind).toBe('clean-or-isolate-repo');
    expect(allCheckIds(input)).toEqual(
      expect.arrayContaining(['repo.dirty-worktree', 'repo.active-session-live']),
    );
  });

  it('summarizes implementer profiles when present', () => {
    const implementerProfiles: Config['implementerProfiles'] = {
      default: 'local-qwen',
      profiles: {
        'local-qwen': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
          contextLength: 32768,
          capabilities: { writesFiles: 'extracted-code' },
        },
      },
    };
    const config = {
      ...makeConfig(),
      implementerProfiles,
    };

    const report = buildReadinessReport(baseInput({ config }));
    const profileCheck = report.sections
      .flatMap((section) => section.checks)
      .find((check) => check.id === 'runners.implementer.default');

    expect(profileCheck?.summary).toContain('local-qwen');
    expect(profileCheck?.metadata).toMatchObject({
      defaultProfile: 'local-qwen',
      writeMode: 'extracted-code',
    });
  });
});
