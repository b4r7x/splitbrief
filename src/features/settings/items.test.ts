import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS, type SettingDef } from '../../core/settings/catalog.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import {
  resolveCrewDisplayNames,
  resolveSeatDisplayName,
} from '../../engine/providers/model/display-names.js';
import {
  buildSettingsItems,
  settingsItemFilterText,
  settingsItemSection,
  type SettingsItem,
} from './items.js';

function itemAt(items: readonly SettingsItem[], key: string): SettingsItem {
  const item = items.find((candidate) => candidate.key === key);
  if (item === undefined) throw new Error(`no ${key} item`);
  return item;
}

describe('buildSettingsItems', () => {
  it('opens with the crew diagram, then the fallbacks, then the settings in section order', () => {
    const config = makeConfig();
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });

    expect(items.slice(0, 6).map((item) => [item.kind, item.key])).toEqual([
      ['crew', 'seat:plan'],
      ['crew', 'seat:build'],
      ['crew', 'seat:review'],
      ['fallback', 'fallback:plan'],
      ['fallback', 'fallback:build'],
      ['fallback', 'fallback:review'],
    ]);
    expect(items.slice(0, 3).map(settingsItemSection)).toEqual(Array(3).fill('Crew'));
    expect(items.slice(3, 6).map(settingsItemSection)).toEqual(Array(3).fill('Fallback'));

    const settingSections = items.slice(6).map(settingsItemSection);
    expect(settingSections.filter((section, at) => section !== settingSections[at - 1])).toEqual([
      'Tuning',
      'Workflow',
      'Validation',
    ]);
  });

  it('drops the settings that do not apply to the current config', () => {
    const skipped: SettingDef = {
      id: 'test.skipped',
      label: 'Skipped',
      section: 'Tuning',
      description: 'never applies',
      kind: 'boolean',
      appliesTo: () => false,
    };
    const items = buildSettingsItems({ config: makeConfig(), defs: [skipped], cliTools: [] });

    expect(items.some((item) => item.key === 'test.skipped')).toBe(false);
  });
});

describe('settingsItemFilterText', () => {
  it('carries a crew row key with its row words, and a setting label with its section', () => {
    const items = buildSettingsItems({ config: makeConfig(), defs: SETTINGS_DEFS, cliTools: [] });
    const seatText = settingsItemFilterText(itemAt(items, 'seat:plan'));

    expect(seatText.startsWith('seat:plan ')).toBe(true);
    expect(seatText).toBe(seatText.toLowerCase());
    expect(settingsItemFilterText(itemAt(items, 'workflow.approve'))).toBe(
      'plan approval workflow',
    );
  });
});

describe('fallback items', () => {
  it('uses the same catalog name for every crew seat and its fallback', () => {
    const runner = {
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-6-luna',
      fallback: { tool: 'codex', model: 'gpt-6-luna' },
    } as const;
    const config = makeConfig({ planner: runner, implementer: runner });
    const cache = makeModelCacheAccessor({
      providerModels: { codex: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
    });
    const items = buildSettingsItems({
      config,
      defs: [],
      cliTools: [],
      displayNames: resolveCrewDisplayNames(config, cache),
      seatDisplayName: (seat, role) => resolveSeatDisplayName(seat, role, cache),
    });

    for (const id of ['plan', 'build', 'review']) {
      const crew = itemAt(items, `seat:${id}`);
      const fallback = itemAt(items, `fallback:${id}`);
      expect(crew.kind === 'crew' && crew.row.seat.model).toBe('OpenAI Codex CLI · GPT-6-Luna');
      expect(fallback.kind === 'fallback' && fallback.row.identity).toBe(
        crew.kind === 'crew' && crew.row.seat.model,
      );
    }
  });

  it('derives the fallback rows from the config of record and the detection it is given', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', fallback: { tool: 'opencode' } },
    });
    const build = itemAt(buildSettingsItems({ config, defs: [], cliTools: [] }), 'fallback:build');

    expect(build).toMatchObject({
      kind: 'fallback',
      row: { id: 'build', fallback: { tool: 'opencode' }, note: 'not installed' },
    });
  });

  it('keeps the three fallback rows under a fallback filter', () => {
    const items = buildSettingsItems({ config: makeConfig(), defs: SETTINGS_DEFS, cliTools: [] });
    const matching = items.filter((item) => settingsItemFilterText(item).includes('fallback'));

    expect(matching.map((item) => item.key)).toEqual([
      'fallback:plan',
      'fallback:build',
      'fallback:review',
    ]);
  });
});
