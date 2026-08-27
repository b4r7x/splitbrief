import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../core/config/load/io.js';
import type { Config } from '../../core/schemas/config.js';
import { listCustomCommandConsumers, readRoleCustomCommandCatalog } from './custom-catalog.js';

const reviewDefinition = {
  label: 'Review changes',
  contract: 'output' as const,
  executable: './tools/review',
  argv: ['--json'],
  outputFormat: 'jsonl' as const,
  idleWarnMs: 4_000,
  idleKillMs: 8_000,
  env: ['REVIEW_TOKEN'],
};

function catalogConfig(): Config {
  return {
    ...createDefaultConfig(),
    customCommands: { review: reviewDefinition },
    planner: {
      kind: 'shell',
      command: './tools/review',
      args: ['--json'],
      outputFormat: 'jsonl',
      idleWarnMs: 4_000,
      idleKillMs: 8_000,
      env: ['REVIEW_TOKEN'],
      model: 'planner-model',
    },
    implementer: {
      kind: 'shell',
      command: './tools/review',
      args: ['--json'],
      outputFormat: 'jsonl',
      idleWarnMs: 4_000,
      idleKillMs: 8_000,
      env: ['REVIEW_TOKEN'],
      model: 'implementer-model',
    },
    implementerProfiles: {
      default: 'default-review',
      profiles: {
        'default-review': {
          kind: 'shell',
          command: './tools/review',
          args: ['--json'],
          outputFormat: 'jsonl',
          idleWarnMs: 4_000,
          idleKillMs: 8_000,
          env: ['REVIEW_TOKEN'],
          model: 'default-model',
          label: 'Default review',
        },
        dormant: {
          kind: 'shell',
          command: './tools/review',
          args: ['--json'],
          outputFormat: 'jsonl',
          idleWarnMs: 4_000,
          idleKillMs: 8_000,
          env: ['REVIEW_TOKEN'],
          model: 'dormant-model',
        },
        diverged: {
          kind: 'shell',
          command: './tools/review',
          args: ['--json'],
          outputFormat: 'jsonl',
          idleWarnMs: 4_000,
          idleKillMs: 8_000,
          env: ['OTHER_TOKEN'],
          model: 'diverged-model',
        },
      },
    },
  };
}

describe('role custom command catalogs', () => {
  it('reads the reviewer catalog selection from the reviewer block, not the planner', () => {
    const config: Config = {
      ...catalogConfig(),
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
    };

    expect(readRoleCustomCommandCatalog(config, 'reviewer').selectedId).toBeUndefined();
    expect(
      readRoleCustomCommandCatalog({ ...config, reviewer: catalogConfig().planner }, 'reviewer')
        .selectedId,
    ).toBe('review');
  });

  it('lists one shared catalog for both roles and highlights by the full normalized tuple', () => {
    const config = catalogConfig();
    const planner = readRoleCustomCommandCatalog(config, 'planner');
    const implementer = readRoleCustomCommandCatalog(config, 'implementer');

    expect(planner.configured).toEqual(implementer.configured);
    expect(planner.selectedId).toBe('review');
    expect(implementer.selectedId).toBe('review');
    const configured = planner.configured[0];
    expect(configured).toBeDefined();
    expect(config.planner.kind).toBe('shell');
    if (configured === undefined || config.planner.kind !== 'shell') return;
    expect(
      readRoleCustomCommandCatalog(
        { ...config, planner: { ...config.planner, env: ['OTHER_TOKEN'] } },
        'planner',
      ).selectedId,
    ).not.toBe('review');
  });

  it('does not select configured commands for non-command runners', () => {
    const runner: Config['planner'] = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'test',
    };

    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { review: reviewDefinition },
      planner: runner,
    };

    expect(readRoleCustomCommandCatalog(config, 'planner').selectedId).toBeUndefined();
  });

  it('counts the reviewer as a consumer of the command it runs', () => {
    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { review: reviewDefinition },
      reviewer: catalogConfig().planner,
    };

    expect(listCustomCommandConsumers(config, reviewDefinition)).toEqual([
      {
        id: 'reviewer',
        role: 'reviewer',
        label: 'Reviewer',
        isDefaultProfile: false,
      },
    ]);
  });

  it('reports every exact planner, default, and dormant consumer but excludes divergence', () => {
    expect(listCustomCommandConsumers(catalogConfig(), reviewDefinition)).toEqual([
      {
        id: 'planner',
        role: 'planner',
        label: 'Planner',
        isDefaultProfile: false,
      },
      {
        id: 'implementer',
        role: 'implementer',
        label: 'Default implementer',
        isDefaultProfile: true,
      },
      {
        id: 'implementerProfiles.default-review',
        role: 'implementer',
        label: 'Default review',
        profileName: 'default-review',
        isDefaultProfile: true,
      },
      {
        id: 'implementerProfiles.dormant',
        role: 'implementer',
        label: 'Implementer profile dormant',
        profileName: 'dormant',
        isDefaultProfile: false,
      },
    ]);
  });
});
