import { describe, it, expect } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { buildSettingsItems } from './items.js';
import { matchesFilter, validateNumber, displayValue } from './presentation.js';
import { glyph } from '../../lib/glyphs.js';

function getDef(id: string) {
  const def = SETTINGS_DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Missing setting definition: ${id}`);
  return def;
}

describe('displayValue', () => {
  it('shows raw value for defs without formatValue', () => {
    const def = getDef('validation.testCommand');
    expect(displayValue(def, 'npm test')).toBe('npm test');
  });

  it('shows ✓ for true and off for false booleans', () => {
    const def = getDef('validation.typecheck');
    expect(displayValue(def, true)).toBe(glyph('check'));
    expect(displayValue(def, false)).toBe('off');
  });

  it('— stays the default for unset fields without an unsetLabel', () => {
    const def = getDef('validation.testCommand');
    expect(displayValue(def, undefined)).toBe('—');
    expect(displayValue(def, null)).toBe('—');
  });

  it('auto (256K) when value equals detectedContextLength', () => {
    expect(
      displayValue(getDef('implementer.contextLength'), 256_000, {
        detectedContextLength: 256_000,
      }),
    ).toBe('auto (256K)');
  });

  it('unsetLabel fallbacks for timeout and contextLength', () => {
    expect(displayValue(getDef('implementer.timeout'), null)).toBe('auto (idle kill 30m)');
    expect(displayValue(getDef('implementer.contextLength'), undefined)).toBe('auto');
  });
});

describe('matchesFilter', () => {
  const items = buildSettingsItems({ config: makeConfig(), defs: SETTINGS_DEFS });
  const matching = (query: string): readonly string[] =>
    items.filter((item) => matchesFilter(item, query)).map((item) => item.key);

  it('reaches a seat and its own effort row by the seat word, never another seat', () => {
    const matched = matching('plan');
    expect(matched).toEqual(expect.arrayContaining(['seat:plan', 'effort:plan']));
    expect(matched).not.toContain('seat:build');
  });

  it('reaches a setting by its label, and nothing else', () => {
    expect(matching('temp')).toEqual(['implementer.temperature']);
  });

  it('reaches settings by their section name', () => {
    expect(matching('Workflow')).toEqual(
      items
        .filter((item) => item.kind === 'setting' && item.def.section === 'Workflow')
        .map((item) => item.key),
    );
  });
});

describe('validateNumber', () => {
  it('rejects non-numeric', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('abc', def)).toBeNull();
  });

  it('rejects out of range', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('-1', def)).toBeNull();
    expect(validateNumber('99', def)).toBeNull();
  });

  it('rejects empty numeric buffers', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('', def)).toBeNull();
    expect(validateNumber('   ', def)).toBeNull();
  });

  it('accepts valid integer', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('5', def)).toBe(5);
  });

  it('rejects non-integer for integer fields', () => {
    const def = getDef('workflow.maxRetries');
    expect(validateNumber('3.5', def)).toBeNull();
  });

  it('accepts schema-valid context windows beyond the old 131072 cap', () => {
    const def = getDef('implementer.contextLength');
    expect(validateNumber('200000', def)).toBe(200000);
    expect(validateNumber('1000000', def)).toBe(1000000);
  });
});
