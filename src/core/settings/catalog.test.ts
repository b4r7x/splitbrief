import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFS, SETTINGS_SECTIONS } from './catalog.js';
import { createDefaultConfig } from '../config/load/defaults.js';
import { getConfigValue } from '../config/accessors/values.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../schemas/config.js';
import { buildSettingsItems } from '../../features/settings/items.js';

// The default config with an API implementer, so the rows that only an API seat shows have a value.
const apiConfig: Config = {
  ...createDefaultConfig(),
  implementer: {
    kind: 'api',
    provider: 'ollama',
    service: 'ollama',
    offering: 'local',
    model: 'qwen3-coder:30b',
    apiBase: 'http://localhost:11434/v1',
    temperature: 0.3,
  },
};

// Settings whose dot-path is structurally valid but intentionally has no default
// value. They read as `undefined` on `apiConfig`, so a non-undefined assertion
// would spuriously fail. A typo'd id would not be in this set and still fail below.
const OPTIONAL_WITHOUT_DEFAULT = new Set(['implementer.contextLength', 'validation.testCommand']);

describe('SETTINGS_DEFS id resolution', () => {
  for (const def of SETTINGS_DEFS) {
    if (def.readValue) continue;
    if (OPTIONAL_WITHOUT_DEFAULT.has(def.id)) continue;
    it(`resolves "${def.id}" via getConfigValue`, () => {
      expect(getConfigValue(apiConfig, def.id)).not.toBeUndefined();
    });
  }
});

describe('SETTINGS_DEFS read-only rows under REVIEW None', () => {
  const REASON = 'Read-only while REVIEW is None: no review runs.';

  it('both rows lock under None', () => {
    const cadence = SETTINGS_DEFS.find((def) => def.id === 'workflow.review');
    const endChecks = SETTINGS_DEFS.find((def) => def.id === 'validation.endChecks');
    expect(cadence).toMatchObject({
      label: 'Review cadence',
      section: 'Workflow',
      kind: 'enum',
      options: ['end', 'task'],
    });
    expect(endChecks?.lockedBy).toBeTypeOf('function');

    const none = makeConfig({ reviewer: 'none' });
    expect(cadence?.lockedBy?.(none)).toBe(REASON);
    expect(endChecks?.lockedBy?.(none)).toBe(REASON);

    for (const config of [makeConfig(), makeConfig({ reviewer: { kind: 'cli', tool: 'codex' } })]) {
      expect(cadence?.lockedBy?.(config)).toBeUndefined();
      expect(endChecks?.lockedBy?.(config)).toBeUndefined();
    }
  });
});

describe('SETTINGS_DEFS Context length', () => {
  it('offers one context-length def whose label follows the implementer kind', () => {
    const cliConfig = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet' },
    });
    const contextDefs = SETTINGS_DEFS.filter((def) => def.id === 'implementer.contextLength');
    const [contextDef] = contextDefs;

    expect(contextDefs).toHaveLength(1);
    expect(contextDef?.readLabel?.(apiConfig)).toBe('Context length');
    expect(contextDef?.readLabel?.(cliConfig)).toBe('Prompt budget');
  });
});

describe('SETTINGS_DEFS dead settings', () => {
  it('does not expose the no-op sessions.scope setting', () => {
    expect(SETTINGS_DEFS.some((def) => def.id === 'sessions.scope')).toBe(false);
  });

  // SPLITBRIEF no longer stages, commits or creates a branch, so a commit strategy or a branch
  // switch is not a choice the config even accepts any more — offering the row would hand the user
  // a value that fails on save. Spend is read in `/usage` on request, not toggled for a main screen
  // that no longer shows a figure.
  it.each([
    'workflow.git.commitStrategy',
    'workflow.git.createBranch',
    'workflow.showSpend',
    'workflow.maxRetries',
  ])('offers no row for the retired %s', (id) => {
    expect(SETTINGS_DEFS.some((def) => def.id === id)).toBe(false);
  });

  it('keeps only the ordinary workflow rows', () => {
    const workflowIds = SETTINGS_DEFS.filter((def) => def.section === 'Workflow').map(
      (def) => def.id,
    );

    expect(workflowIds).toEqual(['workflow.approve', 'workflow.isolation', 'workflow.review']);
  });
});

describe('SETTINGS_DEFS isolation', () => {
  const isolation = SETTINGS_DEFS.find((def) => def.id === 'workflow.isolation');

  it.each([
    ['cli', makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } })],
    ['api', apiConfig],
  ] as const)('offers the isolation choices for a %s build seat', (_kind, config) => {
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });
    expect(items.find((item) => item.key === 'workflow.isolation')).toMatchObject({
      kind: 'setting',
      def: {
        label: 'Isolation',
        section: 'Workflow',
        kind: 'enum',
        options: ['worktree', 'staged-copy', 'none'],
      },
    });
  });

  it('reads an unset isolation as worktree', () => {
    expect(isolation?.readValue?.(makeConfig())).toBe('worktree');
  });
});

describe('SETTINGS_DEFS unset labels', () => {
  it('reads an unset test command as the stack default rather than a dash', () => {
    const def = SETTINGS_DEFS.find((d) => d.id === 'validation.testCommand');

    expect(def?.unsetLabel).toBe('auto');
    expect(def?.description).toContain('auto');
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
