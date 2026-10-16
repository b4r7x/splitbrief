import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { loadConfig } from '../../core/config/load/io.js';
import { deriveFallbackRows, type FallbackRow } from '../../core/crew/fallback.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { deriveCrewRows } from '../../core/crew/rows.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { crewActivate, crewVerdict, fallbackActivate } from './rows.js';

const PRESET: CrewPreset = {
  id: 'claude-crew-codex-review',
  label: 'Claude crew, Codex review',
  description: 'Claude Code plans and builds; Codex reviews the diff from another lab.',
  seats: {
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: { kind: 'cli', tool: 'opencode' },
    reviewer: { kind: 'cli', tool: 'codex' },
  },
};

function currentConfig(): Config {
  const config = configStore.get().config;
  if (config === null) throw new Error('Config was not loaded.');
  return config;
}

describe('crew row activation', () => {
  beforeEach(() => {
    overlayStore.reset();
    pickerViewStore.reset();
  });

  it('opens a seat row with a real model, expands it and lands the token', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' },
    });
    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');

    expect(crewActivate({ target: { kind: 'crew', row: plan }, config })).toEqual({
      kind: 'opened',
    });
    expect(overlayStore.get()).toMatchObject({ active: 'planner-picker' });
    expect(overlayStore.get().focus).toBe('seat:plan:effort');
    expect(pickerViewStore.get().expandedModelId).toBe('claude-sonnet-4');
  });

  it('opens the expanded row on the effort the seat already runs', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
    });
    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');

    crewActivate({ target: { kind: 'crew', row: plan }, config });

    expect(pickerViewStore.get()).toMatchObject({ expandedModelId: 'opus', effortDraft: 'max' });
  });

  it('opens the reviewer picker for the review seat row with its own token', () => {
    const config = makeConfig();
    const review = deriveCrewRows({ config }).find((row) => row.id === 'review');
    if (review === undefined) throw new Error('No review seat row.');

    expect(crewActivate({ target: { kind: 'crew', row: review }, config })).toEqual({
      kind: 'opened',
    });
    expect(overlayStore.get()).toMatchObject({ active: 'reviewer-picker' });
    expect(overlayStore.get().focus).toBe('seat:review:effort');
  });

  it('opens an auto seat with the token and no expand', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
    });
    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');

    expect(crewActivate({ target: { kind: 'crew', row: plan }, config })).toEqual({
      kind: 'opened',
    });
    expect(overlayStore.get().focus).toBe('seat:plan:effort');
    expect(pickerViewStore.get().expandedModelId).toBeNull();
  });

  it('a claude-code seat carrying the legacy default alias behaves the same as auto', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'default' },
    });
    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');

    expect(crewActivate({ target: { kind: 'crew', row: plan }, config })).toEqual({
      kind: 'opened',
    });
    expect(pickerViewStore.get().expandedModelId).toBeNull();
  });

  it('a seat with no model field at all opens with the token and no expand', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'opencode' },
    });
    const build = deriveCrewRows({ config }).find((row) => row.id === 'build');
    if (build === undefined) throw new Error('No build seat row.');

    expect(crewActivate({ target: { kind: 'crew', row: build }, config })).toEqual({
      kind: 'opened',
    });
    expect(pickerViewStore.get().expandedModelId).toBeNull();
    expect(overlayStore.get().focus).toBe('seat:build:effort');
  });
});

describe('cross-lab verdict', () => {
  it('reads the verdict from the build and review seats', () => {
    const crossLab = crewVerdict(
      deriveCrewRows({
        config: makeConfig({
          planner: { kind: 'cli', tool: 'claude-code' },
          implementer: { kind: 'cli', tool: 'claude-code' },
          reviewer: { kind: 'cli', tool: 'codex' },
        }),
      }),
    );

    expect(crossLab).toBe('cross-lab');
  });

  it('stays silent while either lab is undetermined', () => {
    expect(crewVerdict(deriveCrewRows({ config: makeConfig() }))).toBeUndefined();
  });
});

describe('crew preset application', () => {
  beforeEach(() => {
    configStore.reset();
    feedbackStore.reset();
    overlayStore.reset();
  });

  it('writes every seat the preset names in a single save', async () => {
    await withTempDir('crew-preset-apply', async (projectDir) => {
      configStore.load(projectDir);
      const save = vi.spyOn(configStore, 'save');

      const applied = crewActivate({
        target: { kind: 'preset', preset: PRESET },
        config: currentConfig(),
      });

      expect(applied).toMatchObject({ kind: 'applied' });
      await vi.waitFor(() => {
        expect(feedbackStore.get()).toMatchObject({
          isError: false,
          message: `Saved ${PRESET.label} to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
        });
      });
      expect(save).toHaveBeenCalledOnce();

      const persisted = loadConfig(projectDir).config;
      expect(persisted.planner).toMatchObject({ kind: 'cli', tool: 'claude-code' });
      expect(resolveImplementerProfiles(persisted).defaultProfile.config).toMatchObject({
        kind: 'cli',
        tool: 'opencode',
      });
      expect(persisted.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });
    });
  });

  it('leaves the review seat inherited when the preset omits a reviewer', async () => {
    await withTempDir('crew-preset-inherit', async (projectDir) => {
      configStore.load(projectDir);
      const seated = await configStore.save({
        ...currentConfig(),
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
        reviewer: { kind: 'cli', tool: 'codex' },
      });
      expect(seated.ok).toBe(true);

      const preset: CrewPreset = {
        id: 'claude-plan-opencode-build',
        label: 'Claude plan, OpenCode build',
        description: 'Claude Code plans and reviews; OpenCode executes the briefs.',
        seats: {
          planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
          implementer: { kind: 'cli', tool: 'opencode' },
        },
      };

      const applied = crewActivate({ target: { kind: 'preset', preset }, config: currentConfig() });
      expect(applied).toMatchObject({ kind: 'applied' });

      await vi.waitFor(() => {
        expect(loadConfig(projectDir).config.reviewer).toBeUndefined();
      });
      expect(loadConfig(projectDir).config.planner).toEqual(preset.seats.planner);
    });
  });

  it('surfaces a save failure and leaves the configuration untouched', async () => {
    await withTempDir('crew-preset-blocked', async (projectDir) => {
      configStore.load(projectDir);
      writeFileSync(join(projectDir, SPLITBRIEF_DIR), 'blocks the canonical config directory');
      const before = currentConfig();

      crewActivate({ target: { kind: 'preset', preset: PRESET }, config: before });

      await vi.waitFor(() => {
        expect(feedbackStore.get()).toMatchObject({ isError: true });
      });
      expect(currentConfig()).toEqual(before);
    });
  });
});

describe('fallback row activation', () => {
  beforeEach(() => {
    overlayStore.reset();
    pickerViewStore.reset();
  });

  function fallbackRow(config: Config, id: FallbackRow['id']): FallbackRow {
    const row = deriveFallbackRows({ config, cliTools: [] }).find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`No ${id} fallback row.`);
    return row;
  }

  it.each<{ label: string; fallback: FallbackRow['fallback'] }>([
    { label: 'None', fallback: undefined },
    { label: 'a tool', fallback: { tool: 'codex' } },
    {
      label: 'a model',
      fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
    },
  ])('returns to the BUILD fallback row after opening on $label', ({ fallback }) => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', fallback },
    });
    overlayStore.open('settings');

    fallbackActivate({ row: fallbackRow(config, 'build'), config });
    overlayStore.close();

    expect(overlayStore.get()).toMatchObject({ active: 'settings', focus: 'fallback:build' });
  });

  it("opens the seat's fallback picker on the fallback's model and level", () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
        effort: 'max',
        fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
      },
    });

    fallbackActivate({ row: fallbackRow(config, 'build'), config });

    expect(overlayStore.get()).toMatchObject({
      active: 'implementer-fallback-picker',
      focus: 'seat:build:effort',
    });
    expect(pickerViewStore.get()).toMatchObject({
      expandedModelId: 'gpt-5-codex',
      effortDraft: 'high',
    });
  });

  it('opens on the None row with nothing drafted when the seat sets no fallback', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
    });

    fallbackActivate({ row: fallbackRow(config, 'plan'), config });

    expect(overlayStore.get()).toMatchObject({ active: 'planner-fallback-picker' });
    expect(overlayStore.get().focus).toBeUndefined();
    expect(pickerViewStore.get().expandedModelId).toBeNull();
  });

  it('opens the review fallback picker for an inherited review seat, never the planner one', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
    });

    fallbackActivate({ row: fallbackRow(config, 'review'), config });

    expect(overlayStore.get()).toMatchObject({
      active: 'reviewer-fallback-picker',
      focus: 'tool:codex',
    });
  });

  it.each(['auto', 'default'])('focuses the tool for an automatic fallback model %s', (model) => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'codex',
        model: 'gpt-5',
        fallback: { tool: 'claude-code', model },
      },
    });

    fallbackActivate({ row: fallbackRow(config, 'plan'), config });

    expect(overlayStore.get()).toMatchObject({
      active: 'planner-fallback-picker',
      focus: 'tool:claude-code',
    });
    expect(pickerViewStore.get().expandedModelId).toBeNull();
  });

  it('drafts the fallback variant when the tool spends its level on a variant', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        fallback: { tool: 'opencode', model: 'openai/gpt-5.6', variant: 'high' },
      },
    });

    fallbackActivate({ row: fallbackRow(config, 'plan'), config });

    expect(overlayStore.get().focus).toBe('seat:plan:effort');
    expect(pickerViewStore.get()).toMatchObject({
      expandedModelId: 'openai/gpt-5.6',
      effortDraft: 'high',
    });
  });
});

describe('crew presets keep each seat fallback', () => {
  beforeEach(() => {
    configStore.reset();
    feedbackStore.reset();
    overlayStore.reset();
  });

  it('changes the seats and keeps the fallback every seat had', async () => {
    await withTempDir('crew-preset-fallback', async (projectDir) => {
      configStore.load(projectDir);
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', fallback: { tool: 'codex' } },
        implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'claude-code' } },
        reviewer: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'opencode' } },
      });

      const applied = crewActivate({ target: { kind: 'preset', preset: PRESET }, config });
      if (applied.kind !== 'applied') throw new Error('The preset was not applied.');

      expect(applied.config.planner).toMatchObject({
        tool: 'claude-code',
        fallback: { tool: 'codex' },
      });
      expect(resolveImplementerProfiles(applied.config).defaultProfile.config).toMatchObject({
        tool: 'opencode',
        fallback: { tool: 'claude-code' },
      });
      expect(applied.config.reviewer).toMatchObject({
        tool: 'codex',
        fallback: { tool: 'opencode' },
      });
      await vi.waitFor(() => {
        expect(feedbackStore.get().message).toBe(
          `Saved ${PRESET.label} to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
        );
      });
    });
  });

  it("gives a review seat the preset creates the planner's fallback it inherited", async () => {
    await withTempDir('crew-preset-fallback-review', async (projectDir) => {
      configStore.load(projectDir);
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'opencode' } },
      });

      const applied = crewActivate({ target: { kind: 'preset', preset: PRESET }, config });
      if (applied.kind !== 'applied') throw new Error('The preset was not applied.');

      expect(applied.config.reviewer).toMatchObject({
        tool: 'codex',
        fallback: { tool: 'opencode' },
      });
      await vi.waitFor(() => {
        expect(feedbackStore.get().message).toBe(
          `Saved ${PRESET.label} to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
        );
      });
    });
  });

  it('keeps None when preset blocks carry other fallback choices', async () => {
    await withTempDir('crew-preset-fallback-none', async (projectDir) => {
      configStore.load(projectDir);
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'codex' },
        reviewer: { kind: 'cli', tool: 'claude-code' },
      });
      const preset: CrewPreset = {
        ...PRESET,
        seats: {
          planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
          implementer: { kind: 'cli', tool: 'opencode', fallback: { tool: 'claude-code' } },
          reviewer: { kind: 'cli', tool: 'codex', fallback: { tool: 'opencode' } },
        },
      };

      const applied = crewActivate({ target: { kind: 'preset', preset }, config });
      if (applied.kind !== 'applied') throw new Error('The preset was not applied.');

      expect(applied.config.planner).not.toHaveProperty('fallback');
      expect(applied.config.implementer).not.toHaveProperty('fallback');
      expect(applied.config.reviewer).not.toHaveProperty('fallback');
      expect(preset.seats.planner.fallback).toEqual({ tool: 'codex' });
      expect(preset.seats.implementer.fallback).toEqual({ tool: 'claude-code' });
      expect(preset.seats.reviewer?.fallback).toEqual({ tool: 'opencode' });
      await vi.waitFor(() => {
        expect(feedbackStore.get().message).toBe(
          `Saved ${PRESET.label} to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
        );
      });
    });
  });

  it('makes REVIEW inherit PLAN and its fallback when the preset omits a reviewer', async () => {
    await withTempDir('crew-preset-fallback-inherit', async (projectDir) => {
      configStore.load(projectDir);
      const config = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
        reviewer: { kind: 'cli', tool: 'codex', fallback: { tool: 'opencode' } },
      });
      const preset: CrewPreset = {
        ...PRESET,
        seats: { planner: PRESET.seats.planner, implementer: PRESET.seats.implementer },
      };

      const applied = crewActivate({ target: { kind: 'preset', preset }, config });
      if (applied.kind !== 'applied') throw new Error('The preset was not applied.');

      expect(applied.config.reviewer).toBeUndefined();
      const review = deriveFallbackRows({ config: applied.config, cliTools: [] }).find(
        (row) => row.id === 'review',
      );
      expect(review).toMatchObject({ inherited: true, fallback: { tool: 'codex' } });
      await vi.waitFor(() => {
        expect(feedbackStore.get().message).toBe(
          `Saved ${PRESET.label} to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
        );
      });
    });
  });
});
