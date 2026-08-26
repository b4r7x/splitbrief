import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFS, SETTINGS_SECTIONS } from './catalog.js';
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
  it('hides temperature/timeout for a non-api implementer', () => {
    const cliConfig = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet' },
    });
    const cliDefs = SETTINGS_DEFS.filter((def) => def.appliesTo?.(cliConfig) ?? true);
    const apiDefs = SETTINGS_DEFS.filter((def) => def.appliesTo?.(createDefaultConfig()) ?? true);

    expect(apiDefs.some((def) => def.id === 'implementer.temperature')).toBe(true);
    expect(apiDefs.some((def) => def.id === 'implementer.timeout')).toBe(true);
    expect(cliDefs.some((def) => def.id === 'implementer.temperature')).toBe(false);
    expect(cliDefs.some((def) => def.id === 'implementer.timeout')).toBe(false);
  });

  it('offers one context-length def whose label follows the implementer kind', () => {
    const cliConfig = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet' },
    });
    const contextDefs = SETTINGS_DEFS.filter((def) => def.id === 'implementer.contextLength');
    const [contextDef] = contextDefs;

    expect(contextDefs).toHaveLength(1);
    expect(contextDef?.readLabel?.(createDefaultConfig())).toBe('Context length');
    expect(contextDef?.readLabel?.(cliConfig)).toBe('Prompt budget');
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

describe('SETTINGS_DEFS workflow.mode description', () => {
  it('reports one planner call for instant and never claims zero', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.mode');
    expect(def).toBeDefined();
    expect(def?.description).toMatch(/instant \(1,/);
    expect(def?.description).not.toContain('0 calls');
  });
});

describe('SETTINGS_DEFS sections', () => {
  it('leaves no seat-owned rows behind', () => {
    const seatPrefixes = ['planner.', 'reviewer.', 'implementer.kind', 'implementer.model'];

    for (const def of SETTINGS_DEFS) {
      expect(seatPrefixes.some((prefix) => def.id.startsWith(prefix))).toBe(false);
    }
  });

  it('places every def in a catalogued section and keeps them in that order', () => {
    const positions = SETTINGS_DEFS.map((def) => SETTINGS_SECTIONS.indexOf(def.section));

    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('gives every def a unique id', () => {
    const ids = SETTINGS_DEFS.map((def) => def.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
