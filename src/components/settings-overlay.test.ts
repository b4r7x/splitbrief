import { describe, it, expect } from 'vitest';
import { getConfigValue, applyEdits, SETTINGS_DEFS } from './settings-overlay.js';
import { createDefaultConfig } from '../core/config.js';
import type { Config } from '../types.js';

describe('getConfigValue', () => {
  const config = createDefaultConfig();

  it('reads top-level values', () => {
    expect(getConfigValue(config, 'theme')).toBe('terminal');
    expect(getConfigValue(config, 'shikiTheme')).toBe('github-dark');
  });

  it('reads nested values', () => {
    expect(getConfigValue(config, 'validation.typecheck')).toBe(true);
    expect(getConfigValue(config, 'implementer.temperature')).toBe(0.3);
    expect(getConfigValue(config, 'workflow.maxRetries')).toBe(3);
    expect(getConfigValue(config, 'sessions.scope')).toBe('project');
  });

  it('returns undefined for missing paths', () => {
    expect(getConfigValue(config, 'nonexistent')).toBeUndefined();
    expect(getConfigValue(config, 'validation.nonexistent')).toBeUndefined();
  });
});

describe('applyEdits', () => {
  const config = createDefaultConfig();

  it('applies boolean edits', () => {
    const updated = applyEdits(config, { 'validation.typecheck': false });
    expect(updated.validation.typecheck).toBe(false);
    expect(updated.validation.lint).toBe(true);
  });

  it('applies number edits', () => {
    const updated = applyEdits(config, { 'workflow.maxRetries': 5 });
    expect(updated.workflow.maxRetries).toBe(5);
  });

  it('applies string edits', () => {
    const updated = applyEdits(config, { 'validation.testCommand': 'vitest run' });
    expect(updated.validation.testCommand).toBe('vitest run');
  });

  it('applies top-level edits', () => {
    const updated = applyEdits(config, { 'theme': 'mono' });
    expect(updated.theme).toBe('mono');
  });

  it('applies multiple edits at once', () => {
    const updated = applyEdits(config, {
      'validation.typecheck': false,
      'workflow.maxRetries': 1,
      'theme': 'mono',
    });
    expect(updated.validation.typecheck).toBe(false);
    expect(updated.workflow.maxRetries).toBe(1);
    expect(updated.theme).toBe('mono');
  });

  it('does not mutate original config', () => {
    const original = createDefaultConfig();
    applyEdits(original, { 'validation.typecheck': false });
    expect(original.validation.typecheck).toBe(true);
  });

  it('creates intermediate objects if missing', () => {
    const sparse = { planner: { tool: 'claude-code' } } as unknown as Config;
    const updated = applyEdits(sparse, { 'sessions.scope': 'global' });
    expect((updated as any).sessions.scope).toBe('global');
  });
});

describe('SETTINGS_DEFS', () => {
  it('has 14 settings', () => {
    expect(SETTINGS_DEFS).toHaveLength(14);
  });

  it('covers all sections', () => {
    const sections = new Set(SETTINGS_DEFS.map((d) => d.section));
    expect(sections).toEqual(new Set(['Validation', 'Workflow', 'Appearance', 'Implementer', 'Sessions']));
  });

  it('all enum settings have options', () => {
    const enums = SETTINGS_DEFS.filter((d) => d.kind === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    for (const def of enums) {
      expect(def.options).toBeDefined();
      expect(def.options!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('all number settings have min/max', () => {
    const numbers = SETTINGS_DEFS.filter((d) => d.kind === 'number');
    expect(numbers.length).toBeGreaterThan(0);
    for (const def of numbers) {
      expect(def.min).toBeDefined();
      expect(def.max).toBeDefined();
    }
  });

  it('all settings have unique ids', () => {
    const ids = SETTINGS_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  const OPTIONAL_SETTINGS = new Set(['implementer.timeout']);

  it('all required settings map to valid config paths', () => {
    const config = createDefaultConfig();
    for (const def of SETTINGS_DEFS) {
      if (OPTIONAL_SETTINGS.has(def.id)) continue;
      const value = getConfigValue(config, def.id);
      expect(value, `${def.id} should be defined in default config`).toBeDefined();
    }
  });
});
