import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildReadinessReport } from './checks.js';
import type { BuildReadinessReportInput } from './checks.js';
import type { Config } from '../schemas/config.js';

function baseInput(overrides: Partial<BuildReadinessReportInput> = {}): BuildReadinessReportInput {
  return {
    projectDir: '/tmp/project',
    config: makeConfig(),
    configLoad: {
      state: 'loaded',
      path: '/tmp/project/.diptych/config.yaml',
      warnings: [],
    },
    packageScripts: {
      packageJsonExists: true,
      scripts: { test: 'vitest run' },
    },
    repo: {
      isGitRepo: true,
      dirtyFiles: [],
      untrackedFiles: [],
    },
    ...overrides,
  };
}

function allCheckIds(input: BuildReadinessReportInput): string[] {
  return buildReadinessReport(input).sections.flatMap(section => section.checks.map(check => check.id));
}

function readyInput(overrides: Partial<BuildReadinessReportInput> = {}): BuildReadinessReportInput {
  return baseInput({
    config: makeConfig({
      planner: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
        contextLength: 32768,
      },
    }),
    ...overrides,
  });
}

describe('readiness checks', () => {
  it('reports ready for a clean project with valid config, context, and npm test script', () => {
    const report = buildReadinessReport(readyInput());
    const availability = report.sections
      .flatMap(section => section.checks)
      .find(check => check.id === 'runners.availability');

    expect(report.status).toBe('ready');
    expect(report.counts.warning).toBe(0);
    expect(availability?.severity).toBe('info');
  });

  it('blocks when config is missing and selects run init', () => {
    const report = buildReadinessReport({
      ...baseInput(),
      config: undefined,
      configLoad: {
        state: 'missing',
        path: '/tmp/project/.diptych/config.yaml',
        warnings: [],
      },
    });

    expect(report.status).toBe('blocked');
    expect(report.nextAction.kind).toBe('run-init');
    expect(allCheckIds({
      ...baseInput(),
      config: undefined,
      configLoad: {
        state: 'missing',
        path: '/tmp/project/.diptych/config.yaml',
        warnings: [],
      },
    })).toContain('config.missing');
  });

  it('warns for missing context length without blocking start', () => {
    const configWithDefaults = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
    });
    const implementerWithoutContext = { ...configWithDefaults.implementer };
    delete implementerWithoutContext.contextLength;
    const config = { ...configWithDefaults, implementer: implementerWithoutContext };

    const report = buildReadinessReport(baseInput({ config }));

    expect(report.status).toBe('ready-with-warnings');
    expect(report.nextAction.kind).toBe('continue');
    expect(report.sections
      .flatMap(section => section.checks)
      .find(check => check.id === 'context.implementer.missing')?.severity).toBe('warning');
    expect(allCheckIds(baseInput({ config }))).toEqual(expect.arrayContaining([
      'context.planner.missing',
      'context.implementer.missing',
    ]));
  });

  it('reports missing profile cost tier and inferred write mode as non-blocking info', () => {
    const config: Config = {
      ...makeConfig({
        planner: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen2.5-coder:7b',
          contextLength: 32768,
        },
      }),
      implementerProfiles: {
        default: 'local-qwen',
        profiles: {
          'local-qwen': {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
            contextLength: 32768,
          },
        },
      },
    };

    const report = buildReadinessReport(baseInput({ config }));
    const checks = report.sections.flatMap(section => section.checks);

    expect(report.status).toBe('ready');
    expect(checks.find(check => check.id === 'runners.implementer.profile-cost-tier-missing')).toMatchObject({
      severity: 'info',
      metadata: { profile: 'local-qwen', costTier: null },
    });
    expect(checks.find(check => check.id === 'runners.implementer.profile-writes-files-inferred')).toMatchObject({
      severity: 'info',
      metadata: { profile: 'local-qwen', writesFiles: 'extracted-code' },
    });
  });

  it('treats missing budget as an advisory note, not a run action', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        apiBase: 'https://api.openai.com/v1',
        model: 'gpt-5',
        contextLength: 128_000,
      },
      implementer: { contextLength: 32_768 },
    });

    const report = buildReadinessReport(baseInput({ config }));
    const budget = report.sections
      .flatMap(section => section.checks)
      .find(check => check.id === 'cost.budget-missing');

    expect(budget).toMatchObject({
      severity: 'info',
      summary: 'Budget cap is off for priced or unknown runners.',
    });
    expect(budget?.nextAction).toBeUndefined();
    expect(report.nextAction.kind).toBe('continue');
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

    const report = buildReadinessReport(baseInput({
      config,
      packageScripts: {
        packageJsonExists: true,
        scripts: { test: 'vitest run' },
      },
    }));

    expect(report.status).toBe('ready-with-warnings');
    expect(allCheckIds(baseInput({
      config,
      packageScripts: {
        packageJsonExists: true,
        scripts: { test: 'vitest run' },
      },
    }))).toEqual(expect.arrayContaining([
      'validation.disabled',
      'validation.test-script-missing',
    ]));
  });

  it('warns for dirty repositories and blocks live active sessions', () => {
    const report = buildReadinessReport(baseInput({
      repo: {
        isGitRepo: true,
        dirtyFiles: ['src/a.ts'],
        untrackedFiles: ['scratch.txt'],
        activeSession: '2026-04-28-live',
        activeSessionLive: true,
      },
    }));

    expect(report.status).toBe('blocked');
    expect(report.nextAction.kind).toBe('clean-or-isolate-repo');
    expect(allCheckIds(baseInput({
      repo: {
        isGitRepo: true,
        dirtyFiles: ['src/a.ts'],
        untrackedFiles: ['scratch.txt'],
        activeSession: '2026-04-28-live',
        activeSessionLive: true,
      },
    }))).toEqual(expect.arrayContaining([
      'repo.dirty-worktree',
      'repo.active-session-live',
    ]));
  });

  it('summarizes implementer profiles when present', () => {
    const implementerProfiles: Config['implementerProfiles'] = {
      default: 'local-qwen',
      profiles: {
        'local-qwen': {
          kind: 'api',
          provider: 'ollama',
          model: 'qwen2.5-coder:7b',
          apiBase: 'http://localhost:11434/v1',
          contextLength: 32768,
          costTier: 'local',
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
      .flatMap(section => section.checks)
      .find(check => check.id === 'runners.implementer.default');

    expect(profileCheck?.summary).toContain('local-qwen');
    expect(profileCheck?.metadata).toMatchObject({
      defaultProfile: 'local-qwen',
      costTier: 'local',
      writeMode: 'extracted-code',
    });
  });
});
