import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { loadConfig } from '../../core/config/load/io.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { applyCrewPreset } from './rows.js';

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

function currentConfig() {
  const config = configStore.get().config;
  if (config === null) throw new Error('Config was not loaded.');
  return config;
}

describe('crew preset application', () => {
  beforeEach(() => {
    configStore.reset();
    feedbackStore.reset();
  });

  it('writes every seat the preset names in a single save', async () => {
    await withTempDir('crew-preset-apply', async (projectDir) => {
      configStore.load(projectDir);
      const save = vi.spyOn(configStore, 'save');

      await expect(applyCrewPreset({ config: currentConfig(), preset: PRESET })).resolves.toBe(
        true,
      );

      expect(save).toHaveBeenCalledOnce();
      expect(feedbackStore.get()).toMatchObject({
        isError: false,
        message: expect.stringContaining(PRESET.label),
      });

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

      await expect(applyCrewPreset({ config: currentConfig(), preset })).resolves.toBe(true);

      const persisted = loadConfig(projectDir).config;
      expect(persisted.reviewer).toBeUndefined();
      expect(persisted.planner).toEqual(preset.seats.planner);
    });
  });

  it('surfaces a save failure and leaves the configuration untouched', async () => {
    await withTempDir('crew-preset-blocked', async (projectDir) => {
      configStore.load(projectDir);
      writeFileSync(join(projectDir, SPLITBRIEF_DIR), 'blocks the canonical config directory');
      const before = currentConfig();

      await expect(applyCrewPreset({ config: before, preset: PRESET })).resolves.toBe(false);

      expect(feedbackStore.get()).toMatchObject({ isError: true });
      expect(currentConfig()).toEqual(before);
    });
  });
});
