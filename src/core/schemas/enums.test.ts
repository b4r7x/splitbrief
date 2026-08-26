import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PROVIDER_CATALOG,
  IMPLEMENTER_API_PROVIDER_IDS,
  KNOWN_API_PROVIDER_IDS,
  LOCAL_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
  REMOTE_API_PROVIDER_IDS,
} from '../providers/api-provider-catalog.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS as CATALOG_CLI_TOOL_IDS,
  EXCLUDED_CLI_TOOL_IDS,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../runners/cli-tool-catalog.js';
import { PlannerConfigSchema } from './planner-config.js';
import {
  CliToolIdSchema,
  ImplementerApiProviderIdSchema,
  ImplementerCliToolIdSchema,
  IsolationStrategySchema,
  META_PROVIDER_IDS,
  PLANNER_TOOL_IDS,
  PROVIDER_IDS,
  WorkflowModeSchema,
  PlannerApiProviderIdSchema,
  PlannerCliToolIdSchema,
} from './enums.js';

function implementerOnlyApiProviderIds() {
  const plannerIds = new Set<string>(PLANNER_API_PROVIDER_IDS);
  return IMPLEMENTER_API_PROVIDER_IDS.filter((id) => !plannerIds.has(id));
}

function implementerOnlyCliToolIds(): string[] {
  return IMPLEMENTER_CLI_TOOL_IDS.filter((id) => !PLANNER_CLI_TOOL_IDS.includes(id));
}

const SYNTHETIC_IMPLEMENTER_ONLY_TOOL = 'synthetic-implementer-cli';

// The admitted catalog is currently all-roles, so the implementer-only branch of the role
// projection only executes against an injected descriptor.
function mockCatalogWithImplementerOnlyTool(): void {
  vi.doMock('../runners/cli-tool-catalog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../runners/cli-tool-catalog.js')>();
    const roles: Record<string, readonly string[]> = Object.fromEntries([
      ...Object.entries(actual.CLI_TOOL_CATALOG).map(([id, descriptor]) => [id, descriptor.roles]),
      [SYNTHETIC_IMPLEMENTER_ONLY_TOOL, ['implementer']],
    ]);
    const ids = Object.keys(roles);
    return {
      ...actual,
      CLI_TOOL_IDS: ids,
      PLANNER_CLI_TOOL_IDS: ids.filter((id) => roles[id]?.includes('planner')),
      IMPLEMENTER_CLI_TOOL_IDS: ids.filter((id) => roles[id]?.includes('implementer')),
    };
  });
}

describe('runner role enums', () => {
  it('builds CLI schemas from catalog-owned identities and roles', () => {
    expect(CliToolIdSchema.options).toEqual(CATALOG_CLI_TOOL_IDS);
    expect(PlannerCliToolIdSchema.options).toEqual(PLANNER_CLI_TOOL_IDS);
    expect(ImplementerCliToolIdSchema.options).toEqual(IMPLEMENTER_CLI_TOOL_IDS);
  });

  it('builds API schemas from catalog-owned identities and roles', () => {
    const descriptor = { id: 'ollama', roles: ['implementer'] } as const;

    expect(PlannerApiProviderIdSchema.options).toEqual(PLANNER_API_PROVIDER_IDS);
    expect(ImplementerApiProviderIdSchema.options).toEqual(IMPLEMENTER_API_PROVIDER_IDS);
    expect(PlannerApiProviderIdSchema.safeParse(descriptor.id).success).toBe(false);
    expect(ImplementerApiProviderIdSchema.safeParse(descriptor.id).success).toBe(true);
  });

  it('derives planner and provider tuples from catalog role admission', () => {
    expect(PLANNER_TOOL_IDS).toEqual([
      ...PLANNER_CLI_TOOL_IDS,
      ...PLANNER_API_PROVIDER_IDS,
      ...META_PROVIDER_IDS,
    ]);
    expect(PROVIDER_IDS).toEqual([
      ...CATALOG_CLI_TOOL_IDS,
      ...REMOTE_API_PROVIDER_IDS,
      ...LOCAL_API_PROVIDER_IDS,
      ...META_PROVIDER_IDS,
    ]);

    for (const id of CATALOG_CLI_TOOL_IDS) {
      const roles = CLI_TOOL_CATALOG[id].roles;
      if (roles.includes('planner')) {
        expect(PLANNER_CLI_TOOL_IDS).toContain(id);
        expect(PLANNER_TOOL_IDS).toContain(id);
      } else {
        expect(PLANNER_CLI_TOOL_IDS).not.toContain(id);
        expect(PLANNER_TOOL_IDS).not.toContain(id);
      }
      if (roles.includes('implementer')) {
        expect(IMPLEMENTER_CLI_TOOL_IDS).toContain(id);
        expect(PROVIDER_IDS).toContain(id);
      }
    }

    for (const id of KNOWN_API_PROVIDER_IDS) {
      const roles: readonly string[] = API_PROVIDER_CATALOG[id].roles;
      if (roles.includes('planner')) {
        expect(PLANNER_TOOL_IDS).toContain(id);
      } else {
        expect(PLANNER_TOOL_IDS).not.toContain(id);
      }
      if (roles.includes('implementer')) {
        expect(PROVIDER_IDS).toContain(id);
      }
    }

    for (const id of implementerOnlyApiProviderIds()) {
      expect(PLANNER_TOOL_IDS).not.toContain(id);
      expect(PlannerApiProviderIdSchema.safeParse(id).success).toBe(false);
    }

    for (const id of implementerOnlyCliToolIds()) {
      expect(PROVIDER_IDS).toContain(id);
      expect(PLANNER_TOOL_IDS).not.toContain(id);
      expect(PlannerCliToolIdSchema.safeParse(id).success).toBe(false);
      expect(ImplementerCliToolIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('keeps excluded and not-admitted CLI IDs out of every runtime tuple', () => {
    const admittedIds = new Set<string>([
      ...CATALOG_CLI_TOOL_IDS,
      ...PLANNER_CLI_TOOL_IDS,
      ...IMPLEMENTER_CLI_TOOL_IDS,
      ...PROVIDER_IDS,
      ...PLANNER_TOOL_IDS,
    ]);

    for (const id of EXCLUDED_CLI_TOOL_IDS) {
      expect(admittedIds.has(id)).toBe(false);
    }
    expect('cursor' in CLI_TOOL_CATALOG).toBe(false);
    expect('antigravity' in CLI_TOOL_CATALOG).toBe(false);
    expect(admittedIds.has('cursor')).toBe(false);
    expect(admittedIds.has('antigravity')).toBe(false);
    expect(PlannerCliToolIdSchema.safeParse('cursor').success).toBe(false);
    expect(ImplementerCliToolIdSchema.safeParse('cursor').success).toBe(false);
  });

  it('rejects every admitted implementer-only ID at the planner schema boundary', () => {
    for (const provider of implementerOnlyApiProviderIds()) {
      expect(
        PlannerConfigSchema.safeParse({
          kind: 'api',
          provider,
          service: provider,
          offering: 'local',
          apiBase: provider === 'ollama' ? 'http://localhost:11434/v1' : 'http://localhost:1234/v1',
          model: 'local-model',
        }).success,
      ).toBe(false);
    }

    for (const tool of implementerOnlyCliToolIds()) {
      expect(
        PlannerConfigSchema.safeParse({
          kind: 'cli',
          tool,
          model: 'explicit-model',
        }).success,
      ).toBe(false);
    }
  });
});

describe('synthetic implementer-only CLI descriptor', () => {
  afterEach(() => {
    vi.doUnmock('../runners/cli-tool-catalog.js');
    vi.resetModules();
  });

  it('is admitted as an implementer identity and refused as a planner identity', async () => {
    vi.resetModules();
    mockCatalogWithImplementerOnlyTool();
    const enums = await import('./enums.js');

    expect(enums.PROVIDER_IDS).toContain(SYNTHETIC_IMPLEMENTER_ONLY_TOOL);
    expect(enums.PLANNER_TOOL_IDS).not.toContain(SYNTHETIC_IMPLEMENTER_ONLY_TOOL);
    expect(enums.PlannerCliToolIdSchema.safeParse(SYNTHETIC_IMPLEMENTER_ONLY_TOOL).success).toBe(
      false,
    );
    expect(
      enums.ImplementerCliToolIdSchema.safeParse(SYNTHETIC_IMPLEMENTER_ONLY_TOOL).success,
    ).toBe(true);
  });
});

describe('WorkflowModeSchema', () => {
  it.each(['instant', 'quick', 'standard', 'speckit'])('accepts "%s"', (input) => {
    expect(WorkflowModeSchema.parse(input)).toBe(input);
  });
  it.each(['full', 'spec-kit', 'bogus', ''])('rejects "%s"', (input) => {
    expect(WorkflowModeSchema.safeParse(input).success).toBe(false);
  });
});

describe('IsolationStrategySchema', () => {
  it.each(['worktree', 'staged-copy'])('accepts "%s"', (input) => {
    expect(IsolationStrategySchema.parse(input)).toBe(input);
  });
  it.each(['clone', 'none', 'bogus', ''])('rejects "%s"', (input) => {
    expect(IsolationStrategySchema.safeParse(input).success).toBe(false);
  });
});
