import { describe, it, expect } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { CLI_PLANNER, crewItems } from '#testing/helpers/settings-items.js';
import { SETTINGS_DEFS, type SettingDef } from '../../core/settings/catalog.js';
import { buildSettingsItems } from './items.js';
import { matchesFilter, validateNumber, displayValue, hintFor } from './presentation.js';
import { glyph } from '../../lib/glyphs.js';

function getDef(id: string) {
  const def = SETTINGS_DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Missing setting definition: ${id}`);
  return def;
}

describe('displayValue', () => {
  it.each([
    ['none', 'your checkout'],
    ['staged-copy', 'staged copy'],
    ['worktree', 'worktree'],
  ] as const)('reads isolation %s as %s', (isolation, label) => {
    const def = getDef('workflow.isolation');
    const config = makeConfig({ workflow: { isolation } });
    expect(displayValue(def, def.readValue?.(config))).toBe(label);
  });

  it('shows the raw value for string defs', () => {
    const def = getDef('validation.testCommand');
    expect(displayValue(def, 'npm test')).toBe('npm test');
  });

  it('shows ✓ for true and off for false booleans', () => {
    const def = getDef('validation.endChecks');
    expect(displayValue(def, true)).toBe(glyph('check'));
    expect(displayValue(def, false)).toBe('off');
  });

  it('— stays the default for unset fields without an unsetLabel', () => {
    const def = getDef('implementer.temperature');
    expect(displayValue(def, undefined)).toBe('—');
    expect(displayValue(def, null)).toBe('—');
  });

  it('shows a set Prompt budget as its number, also when it equals the detected window', () => {
    expect(
      displayValue(getDef('implementer.contextLength'), 256_000, {
        detectedContextLength: 256_000,
      }),
    ).toBe('256000');
  });

  it('shows an unset Prompt budget as auto with the floored detected window', () => {
    const def = getDef('implementer.contextLength');
    expect(displayValue(def, undefined, { detectedContextLength: 1_048_576 })).toBe('auto (1M)');
    expect(displayValue(def, undefined, { detectedContextLength: 262_144 })).toBe('auto (262K)');
  });

  it('describes the Prompt budget as a stop the user sets', () => {
    expect(getDef('implementer.contextLength').description).toBe(
      'Stop a brief that does not fit this many tokens (auto = no stop; the tool handles its own context)',
    );
  });

  it('unsetLabel fallbacks for timeout, contextLength and testCommand', () => {
    expect(displayValue(getDef('implementer.timeout'), null)).toBe('no limit');
    expect(displayValue(getDef('implementer.contextLength'), undefined)).toBe('auto');
    expect(displayValue(getDef('validation.testCommand'), undefined)).toBe('auto');
  });

  it('reads the policy meaning of an unset gate level off the def', () => {
    expect(displayValue(getDef('workflow.approve'), undefined)).toBe('plan');
  });
});

describe('matchesFilter', () => {
  const items = buildSettingsItems({ config: makeConfig(), defs: SETTINGS_DEFS, cliTools: [] });
  const matching = (query: string): readonly string[] =>
    items.filter((item) => matchesFilter(item, query)).map((item) => item.key);

  it('reaches a seat by its seat word, never another seat', () => {
    const matched = matching('plan');
    expect(matched).toEqual(expect.arrayContaining(['seat:plan']));
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
    const def = getDef('implementer.timeout');
    expect(validateNumber('abc', def)).toBeNull();
  });

  it('rejects out of range', () => {
    const def = getDef('implementer.timeout');
    expect(validateNumber('-1', def)).toBeNull();
    expect(validateNumber('0', def)).toBeNull();
  });

  it('rejects empty numeric buffers', () => {
    const def = getDef('implementer.timeout');
    expect(validateNumber('', def)).toBeNull();
    expect(validateNumber('   ', def)).toBeNull();
  });

  it('accepts valid integer', () => {
    const def = getDef('implementer.timeout');
    expect(validateNumber('5', def)).toBe(5);
  });

  it('rejects non-integer for integer fields', () => {
    const def = getDef('implementer.timeout');
    expect(validateNumber('3.5', def)).toBeNull();
  });

  it('accepts schema-valid context windows beyond the old 131072 cap', () => {
    const def = getDef('implementer.contextLength');
    expect(validateNumber('200000', def)).toBe(200000);
    expect(validateNumber('1000000', def)).toBe(1000000);
  });
});

describe('hintFor', () => {
  const enumDef: SettingDef = {
    id: 'workflow.approve',
    label: 'Plan approval',
    section: 'Workflow',
    description: '',
    kind: 'enum',
    options: ['plan', 'none'],
  };

  it('advertises space rather than Enter on a row Enter cannot act on', () => {
    expect(hintFor({ kind: 'setting', def: enumDef, key: enumDef.id })).not.toContain('⏎');
  });

  it("cycles an enum and toggles a boolean, in each row's own word", () => {
    const booleanDef: SettingDef = {
      id: 'test.boolean',
      label: 'Boolean',
      section: 'Workflow',
      description: '',
      kind: 'boolean',
    };
    expect(hintFor({ kind: 'setting', def: enumDef, key: enumDef.id })).toBe('space cycle');
    expect(hintFor({ kind: 'setting', def: booleanDef, key: booleanDef.id })).toBe('space toggle');
  });

  it("advertises '⏎ edit' on a string or number setting row", () => {
    const stringDef: SettingDef = {
      id: 'test.string',
      label: 'String',
      section: 'Workflow',
      description: '',
      kind: 'string',
    };
    const numberDef: SettingDef = {
      id: 'test.number',
      label: 'Number',
      section: 'Workflow',
      description: '',
      kind: 'number',
    };
    expect(hintFor({ kind: 'setting', def: stringDef, key: stringDef.id })).toBe('⏎ edit');
    expect(hintFor({ kind: 'setting', def: numberDef, key: numberDef.id })).toBe('⏎ edit');
  });

  it('cycles the isolation row with space', () => {
    const isolation = SETTINGS_DEFS.find((def) => def.id === 'workflow.isolation');
    expect(isolation && hintFor({ kind: 'setting', def: isolation, key: isolation.id })).toBe(
      'space cycle',
    );
  });

  it("returns '⏎ change seat' on a seat row", () => {
    const config = makeConfig({ planner: CLI_PLANNER });
    const seat = crewItems(config).find((item) => item.key === 'seat:plan');
    expect(seat && hintFor(seat)).toBe('⏎ change seat');
  });

  it("returns '⏎ change fallback' on a fallback row", () => {
    const fallback = crewItems(makeConfig()).find((item) => item.key === 'fallback:build');
    expect(fallback && hintFor(fallback)).toBe('⏎ change fallback');
  });
});
