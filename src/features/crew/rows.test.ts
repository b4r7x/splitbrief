import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { loadConfig } from '../../core/config/load/io.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { deriveCrewRows } from '../../core/crew/rows.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { crewActivate, crewVerdict } from './rows.js';

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
          message: expect.stringContaining(PRESET.label),
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
