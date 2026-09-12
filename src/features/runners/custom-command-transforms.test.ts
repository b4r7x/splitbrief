import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { writeConfig } from '../../core/config/load/io.js';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import { readCustomCommandCatalog } from '../../core/config/custom-command-catalog.js';
import { fromYaml } from '../../core/config/load/transform.js';
import { ConfigSchema } from '../../core/schemas/config.js';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import {
  addCustomCommand,
  deleteCustomCommand,
  editCustomCommand,
  persistSynthesizedCustomCommand,
  previewCustomCommandEdit,
  selectCustomCommand,
} from './custom-command-transforms.js';

function namedImplementerProfileConfig(): Config {
  return ConfigSchema.parse(
    fromYaml(
      YAML.parse(`
version: 3
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: cli
  tool: codex
  model: legacy-model
implementer_profiles:
  default: active-cloud
  profiles:
    active-cloud:
      kind: api
      provider: lm-studio
      service: lm-studio
      offering: local
      api_base: http://localhost:1234/v1
      api_key: env:PATH
      model: existing-model
      custom_models:
        - existing-model
      label: Active cloud
      cost_tier: cheap
    dormant-local:
      kind: cli
      tool: codex
      model: dormant-model
validation:
  typecheck: true
  lint: true
  test: true
workflow:
  max_retries: 3
  compaction_format: auto
`),
    ),
  );
}

const catalogDefinition = {
  label: 'Review changes',
  contract: 'output' as const,
  executable: './tools/review',
  argv: ['--json'],
  outputFormat: 'jsonl' as const,
  idleWarnMs: 4_000,
  idleKillMs: 8_000,
  env: ['REVIEW_TOKEN'],
};

describe('custom command catalog transforms', () => {
  it('adds and selects only the initiating role, then selects the shared definition for the other role', () => {
    const before = namedImplementerProfileConfig();
    const dormant = before.implementerProfiles?.profiles['dormant-local'];
    const added = addCustomCommand({
      config: before,
      role: 'planner',
      id: 'review',
      definition: catalogDefinition,
    });
    expect(added.kind).toBe('added');
    if (added.kind !== 'added') return;
    const plannerAdded = added.config;

    expect(plannerAdded.customCommands).toEqual({ review: catalogDefinition });
    expect(plannerAdded.planner).toMatchObject({
      kind: 'shell',
      command: './tools/review',
      args: ['--json'],
      env: ['REVIEW_TOKEN'],
    });
    expect(plannerAdded.implementer).toEqual(before.implementer);
    expect(plannerAdded.implementerProfiles).toEqual(before.implementerProfiles);

    const selected = selectCustomCommand({
      config: plannerAdded,
      role: 'implementer',
      id: 'review',
    });
    expect(selected.kind).toBe('selected');
    if (selected.kind !== 'selected') return;
    expect(selected.config.planner).toEqual(plannerAdded.planner);
    expect(selected.config.implementer).toMatchObject({
      kind: 'shell',
      command: './tools/review',
      model: 'existing-model',
      env: ['REVIEW_TOKEN'],
    });
    expect(selected.config.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'shell',
      command: './tools/review',
      model: 'existing-model',
      label: 'Active cloud',
      costTier: 'cheap',
    });
    expect(selected.config.implementerProfiles?.profiles['dormant-local']).toEqual(dormant);
  });

  it('refuses a duplicate ID without replacing the catalog or orphaning its consumers', () => {
    const oldDefinition = {
      label: 'Shared review',
      contract: 'output' as const,
      executable: './tools/old-review',
    };
    const otherDefinition = {
      label: 'Other command',
      contract: 'direct' as const,
      executable: './tools/other',
    };
    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { shared: oldDefinition, other: otherDefinition },
      planner: { kind: 'shell', command: './tools/old-review', model: 'planner-model' },
      implementer: {
        kind: 'shell',
        command: './tools/old-review',
        model: 'implementer-model',
      },
    };
    const before = structuredClone(config);
    const collision = addCustomCommand({
      config,
      role: 'planner',
      id: 'shared',
      definition: {
        label: 'Replacement',
        contract: 'direct',
        executable: './tools/replacement',
      },
    });

    expect(collision).toEqual({ kind: 'already-exists', id: 'shared' });
    expect('config' in collision).toBe(false);
    expect(config).toEqual(before);

    const preview = previewCustomCommandEdit(config, 'shared');
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') return;
    expect(preview.consumers.map(({ id }) => id)).toEqual(['planner', 'implementer']);
    const edited = editCustomCommand({
      config,
      id: 'shared',
      definition: {
        label: 'Replacement',
        contract: 'direct',
        executable: './tools/replacement',
      },
    });
    expect(edited.kind).toBe('edited');
    if (edited.kind !== 'edited') return;
    expect(edited.config.customCommands?.other).toEqual(otherDefinition);
    expect(edited.config.planner).toMatchObject({
      kind: 'agent',
      command: './tools/replacement',
    });
    expect(edited.config.implementer).toMatchObject({
      kind: 'agent',
      command: './tools/replacement',
    });
  });

  it('previews and updates every exact consumer while preserving a diverged profile', () => {
    const matchingRunner = {
      kind: 'shell' as const,
      command: './tools/review',
      args: ['--json'],
      outputFormat: 'jsonl' as const,
      idleWarnMs: 4_000,
      idleKillMs: 8_000,
      env: ['REVIEW_TOKEN'],
    };
    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { review: catalogDefinition },
      planner: { ...matchingRunner, model: 'planner-model' },
      implementer: { ...matchingRunner, model: 'implementer-model' },
      implementerProfiles: {
        default: 'default-review',
        profiles: {
          'default-review': {
            ...matchingRunner,
            model: 'default-model',
            label: 'Default review',
          },
          dormant: { ...matchingRunner, model: 'dormant-model' },
          diverged: {
            ...matchingRunner,
            env: ['OTHER_TOKEN'],
            model: 'diverged-model',
          },
        },
      },
    };
    const preview = previewCustomCommandEdit(config, 'review');
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') return;
    expect(preview.consumers.map(({ id }) => id)).toEqual([
      'planner',
      'implementer',
      'implementerProfiles.default-review',
      'implementerProfiles.dormant',
    ]);

    const replacement = {
      ...catalogDefinition,
      label: 'Apply review',
      contract: 'direct' as const,
      executable: './tools/apply-review',
      env: ['APPLY_TOKEN'],
    };
    const result = editCustomCommand({ config, id: 'review', definition: replacement });
    expect(result.kind).toBe('edited');
    if (result.kind !== 'edited') return;
    expect(result.consumers).toEqual(preview.consumers);
    expect(result.config.customCommands?.review).toEqual(replacement);
    expect(result.config.planner).toMatchObject({
      kind: 'agent',
      command: './tools/apply-review',
      model: 'planner-model',
      env: ['APPLY_TOKEN'],
    });
    expect(result.config.implementerProfiles?.profiles.dormant).toMatchObject({
      kind: 'agent',
      command: './tools/apply-review',
      model: 'dormant-model',
    });
    expect(result.config.implementerProfiles?.profiles.diverged).toEqual(
      config.implementerProfiles?.profiles.diverged,
    );
  });

  it('refuses deletion of a command only the reviewer runs', () => {
    const added = addCustomCommand({
      config: createDefaultConfig(),
      role: 'reviewer',
      id: 'review',
      definition: catalogDefinition,
    });
    expect(added.kind).toBe('added');
    if (added.kind !== 'added') return;

    expect(deleteCustomCommand(added.config, 'review')).toMatchObject({
      kind: 'blocked',
      consumers: [expect.objectContaining({ id: 'reviewer' })],
    });
  });

  it('refuses active deletion and removes the top-level block after deleting the final unused row', () => {
    const added = addCustomCommand({
      config: createDefaultConfig(),
      role: 'planner',
      id: 'review',
      definition: catalogDefinition,
    });
    expect(added.kind).toBe('added');
    if (added.kind !== 'added') return;
    const blocked = deleteCustomCommand(added.config, 'review');
    expect(blocked).toMatchObject({
      kind: 'blocked',
      consumers: [expect.objectContaining({ id: 'planner' })],
    });

    const unused: Config = {
      ...createDefaultConfig(),
      customCommands: { review: catalogDefinition },
    };
    const deleted = deleteCustomCommand(unused, 'review');
    expect(deleted.kind).toBe('deleted');
    if (deleted.kind !== 'deleted') return;
    expect('customCommands' in deleted.config).toBe(false);
  });

  it('blocks deletion of a reviewer-bound command and re-points the reviewer on edit', () => {
    const definition = {
      label: 'Review',
      contract: 'output' as const,
      executable: './tools/review',
    };
    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { review: definition },
      reviewer: { kind: 'shell', command: './tools/review', model: 'reviewer-model' },
    };

    expect(deleteCustomCommand(config, 'review')).toMatchObject({
      kind: 'blocked',
      consumers: [expect.objectContaining({ id: 'reviewer' })],
    });

    const edited = editCustomCommand({
      config,
      id: 'review',
      definition: { ...definition, executable: './tools/review-v2' },
    });
    expect(edited.kind).toBe('edited');
    if (edited.kind !== 'edited') return;
    expect(edited.config.reviewer).toMatchObject({ kind: 'shell', command: './tools/review-v2' });
    expect(edited.config.planner).toEqual(config.planner);
  });

  it('persists a safe synthesized row only through the explicit transform and never persists unsafe material', () => {
    const safeConfig: Config = {
      ...createDefaultConfig(),
      planner: { kind: 'shell', command: './tools/review', args: ['--json'] },
    };
    const safeCatalog = readCustomCommandCatalog(safeConfig);
    const safe = safeCatalog.legacy.find((entry) => entry.kind === 'safe');
    expect(safeConfig.customCommands).toBeUndefined();
    expect(safe?.kind).toBe('safe');
    if (safe?.kind !== 'safe') return;

    const persisted = persistSynthesizedCustomCommand({
      config: safeConfig,
      role: 'planner',
      id: 'legacy-review',
      entry: safe,
    });
    expect(persisted.kind).toBe('added');
    if (persisted.kind !== 'added') return;
    expect(persisted.config.customCommands?.['legacy-review']).toMatchObject({
      contract: 'output',
      executable: './tools/review',
      argv: ['--json'],
    });

    const secret = 'ghp_this_must_not_be_persisted';
    const unsafeConfig: Config = {
      ...createDefaultConfig(),
      planner: { kind: 'shell', command: './tools/review', args: [`--token=${secret}`] },
    };
    const unsafeCatalog = readCustomCommandCatalog(unsafeConfig);
    expect(unsafeCatalog.legacy).toEqual([
      expect.objectContaining({ kind: 'unsafe', opaqueId: expect.any(String) }),
    ]);
    expect(JSON.stringify(unsafeCatalog)).not.toContain(secret);
    expect(unsafeConfig.customCommands).toBeUndefined();
  });

  it('survives the accepted config transaction and a fresh store reload', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-t025-'));
    try {
      writeConfig(projectDir, createDefaultConfig());
      configStore.load(projectDir);
      const current = configStore.get().config;
      expect(current).not.toBeNull();
      if (current === null) return;
      const added = addCustomCommand({
        config: current,
        role: 'planner',
        id: 'review',
        definition: catalogDefinition,
      });
      expect(added.kind).toBe('added');
      if (added.kind !== 'added') return;
      await expect(configStore.save(added.config)).resolves.toMatchObject({
        kind: 'saved',
        ok: true,
      });

      configStore.__testReset();
      configStore.load(projectDir);
      expect(configStore.get().config?.customCommands?.review).toEqual(catalogDefinition);
      expect(configStore.get().config?.planner).toMatchObject({
        kind: 'shell',
        command: './tools/review',
        env: ['REVIEW_TOKEN'],
      });
    } finally {
      configStore.__testReset();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
