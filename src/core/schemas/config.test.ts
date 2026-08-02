import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../config/load/io.js';
import {
  API_PROVIDER_CATALOG,
  FORBIDDEN_API_PROVIDER_IDS,
  IMPLEMENTER_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../providers/api-provider-catalog.js';
import { ConfigSchema } from './config.js';
import { ImplementerApiProviderIdSchema, PlannerApiProviderIdSchema } from './enums.js';

const validConfig = createDefaultConfig();

function issuesFor(input: unknown) {
  const result = ConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues;
}

function hasIssueAtPath(issues: ReturnType<typeof issuesFor>, path: string): boolean {
  return issues.some((issue) => issue.path.join('.') === path);
}

describe('ConfigSchema user config contracts', () => {
  it('validates palette custom actions users can invoke from the command palette', () => {
    const valid = ConfigSchema.safeParse({
      ...validConfig,
      palette: {
        customActions: [{ id: 'open-docs', label: 'Open docs', command: '/docs' }],
      },
    });
    expect(valid.success).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          palette: {
            customActions: [{ id: '', label: 'Open docs', command: '/docs' }],
          },
        }),
        'palette.customActions.0.id',
      ),
    ).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          palette: {
            customActions: [{ id: 'open-docs', label: 'Open docs', command: 'docs' }],
          },
        }),
        'palette.customActions.0.command',
      ),
    ).toBe(true);
  });

  it('rejects unknown approval tiers before they can change write approvals', () => {
    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          approval: { tiers: { write_out_of_scope: 'always' } },
        }),
        'approval.tiers.write_out_of_scope',
      ),
    ).toBe(true);
  });

  it('defaults workflow compaction format and rejects unknown formats', () => {
    expect(
      ConfigSchema.parse({
        ...validConfig,
        workflow: { ...validConfig.workflow, compactionFormat: undefined },
      }).workflow.compactionFormat,
    ).toBe('auto');

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          workflow: { ...validConfig.workflow, compactionFormat: 'markdown' },
        }),
        'workflow.compactionFormat',
      ),
    ).toBe(true);
  });

  it('requires escalation.intermediateModel when intermediateProvider is set', () => {
    expect(
      ConfigSchema.safeParse({
        ...validConfig,
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-chat' },
      }).success,
    ).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          escalation: { intermediateProvider: 'deepseek' },
        }),
        'escalation.intermediateModel',
      ),
    ).toBe(true);
  });

  it('validates implementer profile names and default profile references', () => {
    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          implementerProfiles: {
            default: 'missing-profile',
            profiles: {
              'local-qwen': {
                kind: 'api',
                provider: 'ollama',
                service: 'ollama',
                offering: 'local',
                apiBase: 'http://localhost:11434/v1',
                model: 'qwen2.5-coder:7b',
              },
            },
          },
        }),
        'implementerProfiles.default',
      ),
    ).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          implementerProfiles: {
            profiles: {
              'Local Qwen': {
                kind: 'api',
                provider: 'ollama',
                service: 'ollama',
                offering: 'local',
                apiBase: 'http://localhost:11434/v1',
                model: 'qwen2.5-coder:7b',
              },
            },
          },
        }),
        'implementerProfiles.profiles.Local Qwen',
      ),
    ).toBe(true);

    expect(
      hasIssueAtPath(
        issuesFor({
          ...validConfig,
          implementerProfiles: { profiles: {} },
        }),
        'implementerProfiles.profiles',
      ),
    ).toBe(true);
  });
});

function implementerOnlyApiProviderIds() {
  const plannerIds = new Set<string>(PLANNER_API_PROVIDER_IDS);
  return IMPLEMENTER_API_PROVIDER_IDS.filter((id) => !plannerIds.has(id));
}

function apiRunnerForProvider(provider: string) {
  const descriptor = API_PROVIDER_CATALOG[provider as keyof typeof API_PROVIDER_CATALOG];
  const apiBase =
    descriptor.endpointPolicy.kind === 'loopback'
      ? descriptor.endpointPolicy.defaultBaseURL
      : descriptor.endpointPolicy.kind === 'fixed-origin'
        ? descriptor.endpointPolicy.baseURL
        : 'https://example.test/v1';
  return {
    kind: 'api' as const,
    provider: descriptor.id,
    service: descriptor.service,
    offering: descriptor.offering,
    apiBase,
    model: 'explicit-model',
  };
}

describe('ConfigSchema API role admission', () => {
  it('derives planner and implementer API enums from the admitted catalog', () => {
    expect(PlannerApiProviderIdSchema.options).toEqual(PLANNER_API_PROVIDER_IDS);
    expect(ImplementerApiProviderIdSchema.options).toEqual(IMPLEMENTER_API_PROVIDER_IDS);

    for (const id of Object.keys(API_PROVIDER_CATALOG)) {
      const descriptor = API_PROVIDER_CATALOG[id as keyof typeof API_PROVIDER_CATALOG];
      if (descriptor.roles.some((role) => role === 'planner')) {
        expect(PlannerApiProviderIdSchema.safeParse(id).success).toBe(true);
      } else {
        expect(PlannerApiProviderIdSchema.safeParse(id).success).toBe(false);
      }
      if (descriptor.roles.some((role) => role === 'implementer')) {
        expect(ImplementerApiProviderIdSchema.safeParse(id).success).toBe(true);
      }
    }
  });

  it('rejects every implementer-only API provider on planner configs', () => {
    for (const provider of implementerOnlyApiProviderIds()) {
      expect(
        ConfigSchema.safeParse({
          ...validConfig,
          planner: apiRunnerForProvider(provider),
        }).success,
      ).toBe(false);
    }
  });

  it('accepts every catalog-admitted planner API provider', () => {
    for (const provider of PLANNER_API_PROVIDER_IDS) {
      expect(
        ConfigSchema.safeParse({
          ...validConfig,
          planner: apiRunnerForProvider(provider),
        }).success,
      ).toBe(true);
    }
  });

  it('accepts every catalog-admitted implementer API provider', () => {
    for (const provider of IMPLEMENTER_API_PROVIDER_IDS) {
      expect(
        ConfigSchema.safeParse({
          ...validConfig,
          implementer: apiRunnerForProvider(provider),
        }).success,
      ).toBe(true);
    }
  });

  it('excludes forbidden and deferred provider IDs from role tuples', () => {
    const admittedIds = new Set<string>([
      ...PlannerApiProviderIdSchema.options,
      ...ImplementerApiProviderIdSchema.options,
    ]);

    for (const id of FORBIDDEN_API_PROVIDER_IDS) {
      expect(admittedIds.has(id)).toBe(false);
      expect(PlannerApiProviderIdSchema.safeParse(id).success).toBe(false);
      expect(ImplementerApiProviderIdSchema.safeParse(id).success).toBe(false);
    }

    expect(admittedIds.has('mimo-token-plan')).toBe(false);
    expect(admittedIds.has('mistral')).toBe(false);
    expect(admittedIds.has('gemini')).toBe(false);
    expect(admittedIds.has('siliconflow')).toBe(false);
  });
});

describe('ConfigSchema API identity', () => {
  it('requires an explicit service/offering on API runners', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      implementer: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5:7b',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['implementer.service', 'implementer.offering']),
    );
  });

  it.each([1, 2, 4])('rejects config version %s', (version) => {
    expect(ConfigSchema.safeParse({ ...validConfig, version }).success).toBe(false);
  });
});
