import { describe, expect, it } from 'vitest';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../providers/api-provider-catalog.js';
import { IMPLEMENTER_CLI_TOOL_IDS, PLANNER_CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';
import { ImplementerConfigSchema } from './implementer-config.js';
import { PlannerConfigSchema } from './planner-config.js';
import { ConfigSchema } from './config.js';
import { createDefaultConfig } from '../config/load/io.js';
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
