import { describe, expect, it } from 'vitest';
import { modelRowLanes } from './lane-policy.js';

describe('modelRowLanes', () => {
  it('renders no models.dev rows for a confirmed native CLI list', () => {
    expect(modelRowLanes({ providerId: 'codex', hasRuntimeList: true })).toEqual({
      modelsDev: false,
      bundled: false,
      claudeCodeOptions: false,
    });
  });

  it('falls back to both catalog lanes when no native list has ever landed', () => {
    expect(modelRowLanes({ providerId: 'codex', hasRuntimeList: false })).toEqual({
      modelsDev: true,
      bundled: true,
      claudeCodeOptions: false,
    });
  });

  it('gives claude-code its alias lane and never a models.dev row lane', () => {
    const lanes = { modelsDev: false, bundled: true, claudeCodeOptions: true };

    expect(modelRowLanes({ providerId: 'claude-code', hasRuntimeList: false })).toEqual(lanes);
    expect(modelRowLanes({ providerId: 'claude-code', hasRuntimeList: true })).toEqual(lanes);
  });

  it('gives copilot a bundled-only lane, never mixed with models.dev', () => {
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

  it('reopens the models.dev lane while the user is browsing the catalog', () => {
    expect(
      modelRowLanes({ providerId: 'claude-code', hasRuntimeList: false, browseCatalog: true }),
    ).toMatchObject({ modelsDev: true });
    expect(
      modelRowLanes({ providerId: 'codex', hasRuntimeList: true, browseCatalog: true }),
    ).toMatchObject({ modelsDev: true });
  });
});
