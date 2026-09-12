import { describe, expect, it } from 'vitest';
import { CLI_TOOL_IDS } from '../../../core/runners/cli-tool-catalog.js';
import { modelRowLanes } from './lane-policy.js';

describe('modelRowLanes', () => {
  it('renders no models.dev rows for a confirmed native CLI list', () => {
    expect(modelRowLanes({ providerId: 'codex', hasRuntimeList: true })).toEqual({
      modelsDev: false,
      bundled: false,
      claudeCodeOptions: false,
    });
  });

  it('falls back to the bundled lane when no native list has ever landed', () => {
    expect(modelRowLanes({ providerId: 'codex', hasRuntimeList: false })).toEqual({
      modelsDev: false,
      bundled: true,
      claudeCodeOptions: false,
    });
  });

  it('gives claude-code its alias lane and never a models.dev row lane', () => {
    const lanes = { modelsDev: false, bundled: true, claudeCodeOptions: true };

    expect(modelRowLanes({ providerId: 'claude-code', hasRuntimeList: false })).toEqual(lanes);
    expect(modelRowLanes({ providerId: 'claude-code', hasRuntimeList: true })).toEqual(lanes);
  });

  it("lets copilot's own listing replace both catalog lanes, and restores them without one", () => {
    expect(modelRowLanes({ providerId: 'copilot', hasRuntimeList: true })).toEqual({
      modelsDev: false,
      bundled: false,
      claudeCodeOptions: false,
    });
    expect(modelRowLanes({ providerId: 'copilot', hasRuntimeList: false })).toEqual({
      modelsDev: false,
      bundled: true,
      claudeCodeOptions: false,
    });
  });

  it('keeps the models.dev lane for an API runner', () => {
    expect(modelRowLanes({ providerId: 'ollama', hasRuntimeList: false })).toEqual({
      modelsDev: true,
      bundled: true,
      claudeCodeOptions: false,
    });
  });

  it('browsing never reopens the models.dev lane for a CLI tool', () => {
    expect(
      modelRowLanes({ providerId: 'claude-code', hasRuntimeList: false, browseCatalog: true }),
    ).toMatchObject({ modelsDev: false });
    expect(
      modelRowLanes({ providerId: 'codex', hasRuntimeList: true, browseCatalog: true }),
    ).toMatchObject({ modelsDev: false });
    expect(
      modelRowLanes({ providerId: 'ollama', hasRuntimeList: false, browseCatalog: true }),
    ).toMatchObject({ modelsDev: true });
  });

  it.each(CLI_TOOL_IDS)(
    'never offers models.dev rows for a CLI tool id in any state',
    (providerId) => {
      for (const hasRuntimeList of [true, false]) {
        for (const browseCatalog of [undefined, true]) {
          const lanes = modelRowLanes({ providerId, hasRuntimeList, browseCatalog });
          expect(lanes.modelsDev).toBe(false);
        }
      }
    },
  );
});
