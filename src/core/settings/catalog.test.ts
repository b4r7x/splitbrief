import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFS } from './catalog.js';
import { createDefaultConfig } from '../config/load/io.js';
import { getConfigValue } from '../config/accessors/values.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

// Settings whose dot-path is structurally valid but intentionally has no default
// value. They read as `undefined` on a fresh config, so a non-undefined assertion
// would spuriously fail. A typo'd id would not be in this set and still fail below.
const OPTIONAL_WITHOUT_DEFAULT = new Set([
  'implementer.contextLength',
  'implementer.timeout',
  'validation.testCommand',
]);

describe('SETTINGS_DEFS id resolution', () => {
  const config = createDefaultConfig();

  for (const def of SETTINGS_DEFS) {
    if (def.readValue) continue;
    if (OPTIONAL_WITHOUT_DEFAULT.has(def.id)) continue;
    it(`resolves "${def.id}" via getConfigValue`, () => {
      expect(getConfigValue(config, def.id)).not.toBeUndefined();
    });
  }
});

describe('SETTINGS_DEFS numeric bounds', () => {
  it('keeps implementer timeout aligned with the positive runner schema', () => {
    const timeout = SETTINGS_DEFS.find((def) => def.id === 'implementer.timeout');

    expect(timeout).toMatchObject({ kind: 'number', min: 1 });
  });
});

describe('SETTINGS_DEFS applicability', () => {
  it('temperature/timeout defs hidden for non-api implementer; exactly one contextLength def visible per kind', () => {
    const apiConfig = createDefaultConfig();
    const cliConfig = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet' },
    });
    const apiDefs = SETTINGS_DEFS.filter((def) => def.appliesTo?.(apiConfig) ?? true);
    const cliDefs = SETTINGS_DEFS.filter((def) => def.appliesTo?.(cliConfig) ?? true);
    const apiContextDefs = apiDefs.filter((def) => def.id === 'implementer.contextLength');
    const cliContextDefs = cliDefs.filter((def) => def.id === 'implementer.contextLength');

    expect(apiDefs.some((def) => def.id === 'implementer.temperature')).toBe(true);
    expect(apiDefs.some((def) => def.id === 'implementer.timeout')).toBe(true);
    expect(cliDefs.some((def) => def.id === 'implementer.temperature')).toBe(false);
    expect(cliDefs.some((def) => def.id === 'implementer.timeout')).toBe(false);
    expect(apiContextDefs.map((def) => def.label)).toEqual(['Context length']);
    expect(cliContextDefs.map((def) => def.label)).toEqual(['Prompt budget']);
  });
});

describe('SETTINGS_DEFS dead settings', () => {
  it('does not expose the no-op sessions.scope setting', () => {
    expect(SETTINGS_DEFS.some((def) => def.id === 'sessions.scope')).toBe(false);
  });
});

describe('SETTINGS_DEFS workflow compaction', () => {
  it('includes compaction format in workflow settings', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.compactionFormat');
    expect(def).toMatchObject({
      kind: 'enum',
      options: ['auto', 'freeform', 'structured'],
    });
  });
});
