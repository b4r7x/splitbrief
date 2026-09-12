import { describe, expect, it } from 'vitest';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../providers/api-provider-catalog.js';
import { IMPLEMENTER_CLI_TOOL_IDS, PLANNER_CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';
import {
  ImplementerConfigSchema,
  ImplementerProfileConfigSchema,
  ImplementerProfilesConfigSchema,
} from './implementer-config.js';
import { PlannerConfigSchema } from './planner-config.js';
import { ConfigSchema } from './config.js';
import { createDefaultConfig } from '../config/load/defaults.js';
import { readCustomCommandCatalog } from '../config/custom-command-catalog.js';

function implementerOnlyApiProviderIds() {
  const plannerIds = new Set<string>(PLANNER_API_PROVIDER_IDS);
  return IMPLEMENTER_API_PROVIDER_IDS.filter((id) => !plannerIds.has(id));
}

function implementerOnlyCliToolIds(): string[] {
  return IMPLEMENTER_CLI_TOOL_IDS.filter((id) => !PLANNER_CLI_TOOL_IDS.includes(id));
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
  it('keeps the auto:cheapest marker accepted in the top-level implementer seat block', () => {
    const result = ImplementerConfigSchema.safeParse({
      kind: 'cli',
      tool: 'kilo-code',
      model: 'auto:cheapest',
    });
    expect(result.success).toBe(true);
  });

  it('rejects the auto:cheapest marker on a non-cli implementer seat', () => {
    const seats = [
      {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'auto:cheapest',
      },
      { kind: 'shell', command: './tools/build', model: 'auto:cheapest' },
      { kind: 'agent', command: './tools/apply', model: 'auto:cheapest' },
    ] as const;

    for (const seat of seats) {
      const result = ImplementerConfigSchema.safeParse(seat);
      expect(result.success, seat.kind).toBe(false);
      if (result.success) continue;
      const issue = result.error.issues.find((candidate) => candidate.path[0] === 'model');
      expect(issue?.message).toBe(
        `model "auto:cheapest" routes a cli implementer seat to a priced model; a "${seat.kind}" seat must name a concrete model`,
      );
    }
  });

  it('parses an inline agent and exposes the real persisted catalog independently', () => {
    const implementer = ImplementerConfigSchema.parse({
      kind: 'agent',
      command: './tools/apply',
      args: ['--quiet'],
      model: 'local-agent',
    });
    const config = ConfigSchema.parse({
      ...createDefaultConfig(),
      implementer,
      customCommands: {
        review: {
          label: 'Review changes',
          contract: 'output',
          executable: './tools/review',
          argv: ['--json'],
        },
      },
    });

    expect(config.implementer).toEqual(implementer);
    expect(readCustomCommandCatalog(config).configured).toEqual([
      expect.objectContaining({
        id: 'review',
        contract: 'output',
        executable: './tools/review',
        argv: ['--json'],
      }),
    ]);
    expect(readCustomCommandCatalog(config).legacy).toEqual([
      expect.objectContaining({
        kind: 'safe',
        command: expect.objectContaining({ contract: 'direct', executable: './tools/apply' }),
      }),
    ]);
  });
});

describe('ImplementerProfileConfigSchema', () => {
  const MARKER_ISSUE_MESSAGE =
    'model "auto:cheapest" is the implementer seat\'s auto-routing marker; a profile must name a concrete model';

  it('rejects the auto:cheapest marker inside a cli implementer profile', () => {
    const result = ImplementerProfileConfigSchema.safeParse({
      kind: 'cli',
      tool: 'kilo-code',
      model: 'auto:cheapest',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['model']);
    expect(result.error.issues[0]?.message).toBe(MARKER_ISSUE_MESSAGE);
  });

  it('rejects the auto:cheapest marker inside an api implementer profile', () => {
    const result = ImplementerProfileConfigSchema.safeParse({
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'auto:cheapest',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['model']);
    expect(result.error.issues[0]?.message).toBe(MARKER_ISSUE_MESSAGE);
  });

  it('rejects the marker in a profile however it is cased or padded', () => {
    for (const model of [' auto:cheapest ', 'Auto:Cheapest']) {
      const result = ImplementerProfileConfigSchema.safeParse({
        kind: 'cli',
        tool: 'kilo-code',
        model,
      });
      expect(result.success, model).toBe(false);
      if (result.success) continue;
      expect(result.error.issues[0]?.message).toBe(MARKER_ISSUE_MESSAGE);
    }
  });

  it('still accepts profiles naming a concrete model', () => {
    const result = ImplementerProfileConfigSchema.safeParse({
      kind: 'cli',
      tool: 'kilo-code',
      model: 'kilo/kilo-auto/free',
    });
    expect(result.success).toBe(true);
  });
});

describe('ImplementerProfilesConfigSchema', () => {
  it('still fails when the default names an undefined profile', () => {
    const result = ImplementerProfilesConfigSchema.safeParse({
      default: 'ghost',
      profiles: {
        primary: { kind: 'cli', tool: 'kilo-code', model: 'kilo/kilo-auto/free' },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['default']);
    expect(result.error.issues[0]?.message).toBe(
      'Default implementer profile "ghost" is not defined',
    );
  });
});
