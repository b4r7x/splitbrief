import { describe, expect, it } from 'vitest';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  LOCAL_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
  REMOTE_API_PROVIDER_IDS,
} from '../providers/api-provider-catalog.js';
import {
  CLI_TOOL_IDS as CATALOG_CLI_TOOL_IDS,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../runners/cli-tool-catalog.js';
import {
  API_PROVIDER_IDS,
  CLI_TOOL_IDS,
  ImplementerApiProviderIdSchema,
  ImplementerCliToolIdSchema,
  LOCAL_PROVIDER_IDS,
  normalizeLegacyMode,
  PlannerApiProviderIdSchema,
  PlannerCliToolIdSchema,
} from './enums.js';
import type { ImplementerCliToolId, PlannerCliToolId } from './enums.js';

function retainPlannerCliType(id: PlannerCliToolId): PlannerCliToolId {
  return id;
}

function retainImplementerCliType(id: ImplementerCliToolId): ImplementerCliToolId {
  return id;
}

describe('runner role enums', () => {
  it('builds CLI schemas from catalog-owned identities and roles', () => {
    expect(CLI_TOOL_IDS).toBe(CATALOG_CLI_TOOL_IDS);
    expect(PlannerCliToolIdSchema.options).toEqual(PLANNER_CLI_TOOL_IDS);
    expect(ImplementerCliToolIdSchema.options).toEqual(IMPLEMENTER_CLI_TOOL_IDS);
    expect(retainPlannerCliType('claude-code')).toBe('claude-code');
    expect(retainImplementerCliType('codex')).toBe('codex');
  });

  it('builds API schemas from catalog-owned identities and roles', () => {
    const descriptor = { id: 'ollama', roles: ['implementer'] } as const;

    expect(API_PROVIDER_IDS).toBe(REMOTE_API_PROVIDER_IDS);
    expect(LOCAL_PROVIDER_IDS).toBe(LOCAL_API_PROVIDER_IDS);
    expect(PlannerApiProviderIdSchema.options).toEqual(PLANNER_API_PROVIDER_IDS);
    expect(ImplementerApiProviderIdSchema.options).toEqual(IMPLEMENTER_API_PROVIDER_IDS);
    expect(PlannerApiProviderIdSchema.safeParse(descriptor.id).success).toBe(false);
    expect(ImplementerApiProviderIdSchema.safeParse(descriptor.id).success).toBe(true);
  });
});

describe('normalizeLegacyMode', () => {
  it.each([
    ['instant', 'instant'],
    ['quick', 'quick'],
    ['standard', 'standard'],
    ['speckit', 'speckit'],
    ['full', 'speckit'],
    ['spec-kit', 'speckit'],
  ])('normalizes "%s" → "%s"', (input, expected) => {
    expect(normalizeLegacyMode(input)).toBe(expected);
  });
  it('returns null for unknown values', () => {
    expect(normalizeLegacyMode('bogus')).toBeNull();
    expect(normalizeLegacyMode('')).toBeNull();
  });
});
