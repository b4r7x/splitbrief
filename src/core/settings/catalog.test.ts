import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFS } from './catalog.js';
import { createDefaultConfig } from '../config/load/io.js';
import { getConfigValue } from '../config/accessors/values.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { getProviderDisplayName } from '../providers/catalog.js';

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

describe('SETTINGS_DEFS workflow.mode description', () => {
  it('reports one planner call for instant and never claims zero', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'workflow.mode');
    expect(def).toBeDefined();
    expect(def?.description).toMatch(/instant \(1,/);
    expect(def?.description).not.toContain('0 calls');
  });
});

describe('SETTINGS_DEFS reviewer section', () => {
  it('exposes Tool, Model and Effort rows pointing at /reviewer', () => {
    const reviewer = SETTINGS_DEFS.filter((def) => def.section === 'Reviewer');

    expect(reviewer.map((def) => def.label)).toEqual(['Tool', 'Model', 'Effort']);
    for (const def of reviewer) {
      expect(def.description).toContain('/reviewer');
    }
  });

  it('reads the tool as the planner marked inherited until a reviewer is configured', () => {
    const tool = SETTINGS_DEFS.find((def) => def.section === 'Reviewer' && def.label === 'Tool');
    const inherited = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    const configured = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'codex' },
    });

    expect(tool?.readValue?.(inherited)).toContain(getProviderDisplayName('claude-code'));
    expect(tool?.readValue?.(inherited)).toContain('inherited');
    expect(tool?.readValue?.(configured)).toBe(getProviderDisplayName('codex'));
  });

  it('marks an inherited model the same way as an inherited tool', () => {
    const model = SETTINGS_DEFS.find((def) => def.section === 'Reviewer' && def.label === 'Model');
    const inherited = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } });
    const configured = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
    });

    expect(model?.readValue?.(inherited)).toContain('inherited');
    expect(model?.readValue?.(configured)).not.toContain('inherited');
  });

  it('keeps all three rows on offer when no reviewer block is configured', () => {
    const inherited = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    const applicable = SETTINGS_DEFS.filter((def) => def.appliesTo?.(inherited) ?? true);

    expect(applicable.filter((def) => def.section === 'Reviewer').map((def) => def.label)).toEqual([
      'Tool',
      'Model',
      'Effort',
    ]);
  });

  it('marks an inherited effort the same way as an inherited tool', () => {
    const effort = SETTINGS_DEFS.find(
      (def) => def.section === 'Reviewer' && def.label === 'Effort',
    );
    const inherited = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', effort: 'high' },
    });
    const configured = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', effort: 'high' },
      reviewer: { kind: 'cli', tool: 'codex', effort: 'low' },
    });

    expect(effort?.readValue?.(inherited)).toContain('high');
    expect(effort?.readValue?.(inherited)).toContain('inherited');
    expect(effort?.readValue?.(configured)).toBe('low');
  });
});
