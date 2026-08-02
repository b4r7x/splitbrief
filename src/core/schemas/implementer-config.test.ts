import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../providers/api-provider-catalog.js';
import {
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  type RunnerRole,
} from '../runners/cli-tool-catalog.js';
import { ImplementerConfigSchema } from './implementer-config.js';
import { PlannerConfigSchema } from './planner-config.js';

function implementerOnlyApiProviderIds() {
  const plannerIds = new Set<string>(PLANNER_API_PROVIDER_IDS);
  return IMPLEMENTER_API_PROVIDER_IDS.filter((id) => !plannerIds.has(id));
}

function implementerOnlyCliToolIds(): string[] {
  return IMPLEMENTER_CLI_TOOL_IDS.filter((id) => !PLANNER_CLI_TOOL_IDS.includes(id));
}

const SYNTHETIC_IMPLEMENTER_ONLY_TOOL = 'synthetic-implementer-cli';

// Every admitted CLI tool serves both roles today, so only an injected descriptor exercises
// the implementer-accepted / planner-rejected pair REQ-001 freezes.
function mockCatalogWithImplementerOnlyTool(): void {
  vi.doMock('../runners/cli-tool-catalog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../runners/cli-tool-catalog.js')>();
    type CatalogDescriptor = (typeof actual.CLI_TOOL_CATALOG)[keyof typeof actual.CLI_TOOL_CATALOG];
    type Descriptor = Readonly<Omit<CatalogDescriptor, 'id'> & { id: string }>;
    const descriptor: Descriptor = {
      ...actual.CLI_TOOL_CATALOG.codex,
      id: SYNTHETIC_IMPLEMENTER_ONLY_TOOL,
      roles: ['implementer'],
    };
    const catalog: Record<string, Descriptor> = {
      ...actual.CLI_TOOL_CATALOG,
      [SYNTHETIC_IMPLEMENTER_ONLY_TOOL]: descriptor,
    };
    const ids = Object.keys(catalog);
    return {
      ...actual,
      CLI_TOOL_CATALOG: catalog,
      CLI_TOOL_TRUST: {
        ...actual.CLI_TOOL_TRUST,
        [SYNTHETIC_IMPLEMENTER_ONLY_TOOL]: actual.CLI_TOOL_TRUST.codex,
      },
      CLI_TOOL_IDS: ids,
      PLANNER_CLI_TOOL_IDS: ids.filter((id) => catalog[id]?.roles.includes('planner')),
      IMPLEMENTER_CLI_TOOL_IDS: ids.filter((id) => catalog[id]?.roles.includes('implementer')),
      cliToolSupportsRole: (id: string, role: RunnerRole) =>
        catalog[id]?.roles.includes(role) ?? false,
    };
  });
}

describe('ImplementerConfigSchema', () => {
  it('requires implementers to declare a model', () => {
    const withoutModel = ImplementerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
    });
    expect(withoutModel.success).toBe(false);

    const withModel = ImplementerConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
    });
    expect(withModel.success).toBe(true);
  });

  it('accepts every catalog-admitted implementer CLI tool and API provider', () => {
    for (const tool of IMPLEMENTER_CLI_TOOL_IDS) {
      expect(
        ImplementerConfigSchema.safeParse({
          kind: 'cli',
          tool,
          model: 'explicit-model',
        }).success,
      ).toBe(true);
    }

    for (const provider of implementerOnlyApiProviderIds()) {
      expect(
        ImplementerConfigSchema.safeParse({
          kind: 'api',
          provider,
          service: provider,
          offering: 'local',
          apiBase: provider === 'ollama' ? 'http://localhost:11434/v1' : 'http://localhost:1234/v1',
          model: 'local-model',
        }).success,
      ).toBe(true);
    }
  });

  it('keeps implementer-only CLI IDs out of planner configs', () => {
    for (const tool of implementerOnlyCliToolIds()) {
      expect(
        ImplementerConfigSchema.safeParse({
          kind: 'cli',
          tool,
          model: 'explicit-model',
        }).success,
      ).toBe(true);
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

  it('parses as an implementer runner and fails planner parsing', async () => {
    vi.resetModules();
    mockCatalogWithImplementerOnlyTool();
    const { ImplementerConfigSchema: MockedImplementerSchema } = await import(
      './implementer-config.js'
    );
    const { PlannerConfigSchema: MockedPlannerSchema } = await import('./planner-config.js');

    const runner = {
      kind: 'cli',
      tool: SYNTHETIC_IMPLEMENTER_ONLY_TOOL,
      model: 'explicit-model',
    };

    expect(MockedImplementerSchema.safeParse(runner).success).toBe(true);
    expect(MockedPlannerSchema.safeParse(runner).success).toBe(false);
  });
});
