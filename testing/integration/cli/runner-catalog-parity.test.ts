import { describe, expect, it } from 'vitest';
import {
  API_PROVIDER_CATALOG,
  IMPLEMENTER_API_PROVIDER_IDS,
  KNOWN_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../../../src/core/providers/api-provider-catalog.js';
import { FORBIDDEN_API_PROVIDER_IDS } from '../../../src/core/providers/api-provider-verdicts.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  EXCLUDED_CLI_TOOL_IDS,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
  cliToolSupportsRole,
} from '../../../src/core/runners/cli-tool-catalog.js';
import {
  ImplementerApiProviderIdSchema,
  ImplementerCliToolIdSchema,
  META_PROVIDER_IDS,
  PlannerApiProviderIdSchema,
  PlannerCliToolIdSchema,
} from '../../../src/core/schemas/enums.js';
import { KNOWN_PROVIDERS } from '../../../src/engine/providers/registry.js';
import {
  CLI_IMPLEMENTER_ADAPTERS,
  CLI_PLANNER_ADAPTERS,
  lookupCliImplementerAdapter,
  lookupCliPlannerAdapter,
} from '../../../src/engine/runners/cli-tools/registry.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type RunnerPickerDescriptor,
} from '../../../src/features/runners/model-catalog/options.js';

type RunnerRole = 'planner' | 'implementer';

// Written out rather than derived: a catalog `roles` edit must break this file,
// which a filter over the same catalog could never do.
const ADMITTED_IDS: Readonly<Record<RunnerRole, Readonly<{ cli: string[]; api: string[] }>>> = {
  planner: {
    cli: ['claude-code', 'codex', 'opencode', 'aider', 'copilot', 'kilo-code', 'cursor'],
    api: ['ollama-cloud', 'anthropic', 'openrouter', 'deepseek', 'openai', 'groq', 'together'],
  },
  implementer: {
    cli: ['claude-code', 'codex', 'opencode', 'aider', 'copilot', 'kilo-code', 'cursor'],
    api: [
      'ollama',
      'ollama-cloud',
      'lm-studio',
      'anthropic',
      'openrouter',
      'deepseek',
      'openai',
      'groq',
      'together',
    ],
  },
};

function pickerIdsForRole(role: RunnerRole): string[] {
  return buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    { cliTools: [], providers: [] },
    undefined,
  ).map((item) => item.id);
}

function admittedFirstClassIds(): Set<string> {
  return new Set<string>([
    ...CLI_TOOL_IDS,
    ...PLANNER_CLI_TOOL_IDS,
    ...IMPLEMENTER_CLI_TOOL_IDS,
    ...KNOWN_API_PROVIDER_IDS,
    ...PLANNER_API_PROVIDER_IDS,
    ...IMPLEMENTER_API_PROVIDER_IDS,
    ...PlannerCliToolIdSchema.options,
    ...ImplementerCliToolIdSchema.options,
    ...PlannerApiProviderIdSchema.options,
    ...ImplementerApiProviderIdSchema.options,
    ...META_PROVIDER_IDS,
    ...Object.keys(CLI_PLANNER_ADAPTERS),
    ...Object.keys(CLI_IMPLEMENTER_ADAPTERS),
    ...Object.keys(KNOWN_PROVIDERS),
    ...assemblePickerDescriptors().map((entry) =>
      entry.kind === 'cli' || entry.kind === 'api' ? entry.descriptor.id : entry.kind,
    ),
  ]);
}

const EXCLUDED_FIRST_CLASS_IDS = [...EXCLUDED_CLI_TOOL_IDS, ...FORBIDDEN_API_PROVIDER_IDS] as const;

describe('runner catalog parity by role', () => {
  it('keeps CLI catalog, schema, and registry keys aligned per role', () => {
    expect(Object.keys(CLI_TOOL_CATALOG)).toEqual([...CLI_TOOL_IDS]);
    expect(PlannerCliToolIdSchema.options).toEqual([...PLANNER_CLI_TOOL_IDS]);
    expect(ImplementerCliToolIdSchema.options).toEqual([...IMPLEMENTER_CLI_TOOL_IDS]);
    expect(Object.keys(CLI_PLANNER_ADAPTERS)).toEqual([...PLANNER_CLI_TOOL_IDS]);
    expect(Object.keys(CLI_IMPLEMENTER_ADAPTERS)).toEqual([...IMPLEMENTER_CLI_TOOL_IDS]);
    expect([...PLANNER_CLI_TOOL_IDS]).toEqual(ADMITTED_IDS.planner.cli);
    expect([...IMPLEMENTER_CLI_TOOL_IDS]).toEqual(ADMITTED_IDS.implementer.cli);
    expect(CLI_TOOL_IDS.filter((id) => cliToolSupportsRole(id, 'planner'))).toEqual(
      ADMITTED_IDS.planner.cli,
    );
    expect(CLI_TOOL_IDS.filter((id) => cliToolSupportsRole(id, 'implementer'))).toEqual(
      ADMITTED_IDS.implementer.cli,
    );

    for (const id of PLANNER_CLI_TOOL_IDS) {
      const adapter = CLI_PLANNER_ADAPTERS[id];
      expect(adapter.role).toBe('planner');
      expect(adapter.descriptor.id).toBe(id);
      expect(CLI_TOOL_CATALOG[id].roles).toContain('planner');
      expect(lookupCliPlannerAdapter(id)).toBe(adapter);
    }

    for (const id of IMPLEMENTER_CLI_TOOL_IDS) {
      const adapter = CLI_IMPLEMENTER_ADAPTERS[id];
      expect(adapter.role).toBe('implementer');
      expect(adapter.descriptor.id).toBe(id);
      expect(CLI_TOOL_CATALOG[id].roles).toContain('implementer');
      expect(lookupCliImplementerAdapter(id)).toBe(adapter);
    }
  });

  it('keeps API catalog, schema, and registry keys aligned per role', () => {
    expect(Object.keys(API_PROVIDER_CATALOG)).toEqual([...KNOWN_API_PROVIDER_IDS]);
    expect(Object.keys(KNOWN_PROVIDERS).toSorted()).toEqual(
      Object.keys(API_PROVIDER_CATALOG).toSorted(),
    );
    expect(PlannerApiProviderIdSchema.options).toEqual([...PLANNER_API_PROVIDER_IDS]);
    expect(ImplementerApiProviderIdSchema.options).toEqual([...IMPLEMENTER_API_PROVIDER_IDS]);
    expect([...PLANNER_API_PROVIDER_IDS]).toEqual(ADMITTED_IDS.planner.api);
    expect([...IMPLEMENTER_API_PROVIDER_IDS]).toEqual(ADMITTED_IDS.implementer.api);

    for (const id of KNOWN_API_PROVIDER_IDS) {
      expect(KNOWN_PROVIDERS[id]).toBeDefined();
      expect(API_PROVIDER_CATALOG[id].id).toBe(id);
      for (const role of ['planner', 'implementer'] as const) {
        expect((API_PROVIDER_CATALOG[id].roles as readonly RunnerRole[]).includes(role)).toBe(
          ADMITTED_IDS[role].api.includes(id),
        );
      }
    }
  });

  it('projects catalog identities into picker options by role without duplicates', () => {
    const descriptors = assemblePickerDescriptors();
    const descriptorCliIds = descriptors
      .filter(
        (
          entry,
        ): entry is {
          kind: 'cli';
          descriptor: (typeof CLI_TOOL_CATALOG)[keyof typeof CLI_TOOL_CATALOG];
        } => {
          return entry.kind === 'cli';
        },
      )
      .map((entry) => entry.descriptor.id);
    const descriptorApiIds = descriptors
      .filter(
        (
          entry,
        ): entry is {
          kind: 'api';
          descriptor: (typeof API_PROVIDER_CATALOG)[keyof typeof API_PROVIDER_CATALOG];
        } => {
          return entry.kind === 'api';
        },
      )
      .map((entry) => entry.descriptor.id);

    expect(descriptorCliIds).toEqual([...CLI_TOOL_IDS]);
    expect(descriptorApiIds).toEqual([...KNOWN_API_PROVIDER_IDS]);
    expect(new Set(descriptorCliIds).size).toBe(descriptorCliIds.length);
    expect(new Set(descriptorApiIds).size).toBe(descriptorApiIds.length);

    for (const role of ['planner', 'implementer'] as const) {
      const pickerIds = pickerIdsForRole(role);
      expect(new Set(pickerIds).size).toBe(pickerIds.length);

      const expectedCliIds = ADMITTED_IDS[role].cli;
      const expectedApiIds = ADMITTED_IDS[role].api;
      const expectedMetaIds = ['custom-command', 'agent-sdk'];

      for (const id of expectedCliIds) {
        expect(pickerIds).toContain(id);
      }
      for (const id of expectedApiIds) {
        expect(pickerIds).toContain(id);
      }
      for (const id of expectedMetaIds) {
        expect(pickerIds).toContain(id);
      }
      expect(pickerIds.filter((id) => id === 'custom-command')).toHaveLength(1);
      expect(pickerIds).not.toContain('shell');
      expect(pickerIds).not.toContain('agent');

      const implementerOnlyCli = IMPLEMENTER_CLI_TOOL_IDS.filter(
        (id) => !PLANNER_CLI_TOOL_IDS.includes(id),
      );
      const implementerOnlyApi = IMPLEMENTER_API_PROVIDER_IDS.filter(
        (id) => !(PLANNER_API_PROVIDER_IDS as readonly string[]).includes(id),
      );

      if (role === 'planner') {
        for (const id of implementerOnlyCli) {
          expect(pickerIds).not.toContain(id);
        }
        for (const id of implementerOnlyApi) {
          expect(pickerIds).not.toContain(id);
        }
      } else {
        for (const id of implementerOnlyCli) {
          expect(pickerIds).toContain(id);
        }
        for (const id of implementerOnlyApi) {
          expect(pickerIds).toContain(id);
        }
      }
    }
  });

  it('keeps a synthetic implementer-only CLI descriptor out of the planner picker', () => {
    // Every admitted CLI tool serves both roles today, so the implementer-only projection
    // branch only executes against an injected descriptor.
    const entry: RunnerPickerDescriptor = {
      kind: 'cli',
      descriptor: { ...CLI_TOOL_CATALOG.codex, roles: ['implementer'] },
    };

    expect(
      buildPickerOptions('planner', [entry], { cliTools: [], providers: [] }, undefined),
    ).toEqual([]);
    expect(
      buildPickerOptions('implementer', [entry], { cliTools: [], providers: [] }, undefined).map(
        (option) => option.id,
      ),
    ).toEqual(['codex']);
  });

  it('rejects unsupported CLI role lookups before spawn', () => {
    const implementerOnlyCli = IMPLEMENTER_CLI_TOOL_IDS.filter(
      (id) => !PLANNER_CLI_TOOL_IDS.includes(id),
    );

    for (const id of implementerOnlyCli) {
      expect(() => lookupCliPlannerAdapter(id)).toThrow(/has no planner configuration/);
    }

    for (const id of EXCLUDED_FIRST_CLASS_IDS) {
      expect(() => lookupCliPlannerAdapter(id)).toThrow(/has no planner configuration/);
      expect(() => lookupCliImplementerAdapter(id)).toThrow(/has no implementer configuration/);
    }
  });
});

describe('first-class exclusion guard', () => {
  it('keeps every excluded CLI and provider ID absent from catalog, schema, registry, and picker', () => {
    const admittedIds = admittedFirstClassIds();

    for (const id of EXCLUDED_FIRST_CLASS_IDS) {
      expect(admittedIds.has(id)).toBe(false);
      expect(id in CLI_TOOL_CATALOG).toBe(false);
      expect(id in API_PROVIDER_CATALOG).toBe(false);
      expect(id in CLI_PLANNER_ADAPTERS).toBe(false);
      expect(id in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
      expect(KNOWN_PROVIDERS).not.toHaveProperty(id);
      expect(PlannerCliToolIdSchema.safeParse(id).success).toBe(false);
      expect(ImplementerCliToolIdSchema.safeParse(id).success).toBe(false);
      expect(PlannerApiProviderIdSchema.safeParse(id).success).toBe(false);
      expect(ImplementerApiProviderIdSchema.safeParse(id).success).toBe(false);
      expect(pickerIdsForRole('planner')).not.toContain(id);
      expect(pickerIdsForRole('implementer')).not.toContain(id);
    }
  });

  it('keeps Cursor in first-class surfaces', () => {
    const admittedIds = admittedFirstClassIds();

    expect(admittedIds.has('cursor')).toBe(true);
    expect('cursor' in CLI_TOOL_CATALOG).toBe(true);
    expect('cursor' in CLI_PLANNER_ADAPTERS).toBe(true);
    expect('cursor' in CLI_IMPLEMENTER_ADAPTERS).toBe(true);
    expect(PlannerCliToolIdSchema.safeParse('cursor').success).toBe(true);
    expect(ImplementerCliToolIdSchema.safeParse('cursor').success).toBe(true);
    expect(pickerIdsForRole('planner')).toContain('cursor');
    expect(pickerIdsForRole('implementer')).toContain('cursor');
  });

  it('keeps Antigravity out of first-class surfaces', () => {
    const admittedIds = admittedFirstClassIds();

    expect(admittedIds.has('antigravity')).toBe(false);
    expect('antigravity' in CLI_TOOL_CATALOG).toBe(false);
    expect('antigravity' in CLI_PLANNER_ADAPTERS).toBe(false);
    expect('antigravity' in CLI_IMPLEMENTER_ADAPTERS).toBe(false);
    expect(PlannerCliToolIdSchema.safeParse('antigravity').success).toBe(false);
    expect(ImplementerCliToolIdSchema.safeParse('antigravity').success).toBe(false);
    expect(pickerIdsForRole('planner')).not.toContain('antigravity');
    expect(pickerIdsForRole('implementer')).not.toContain('antigravity');
  });
});
