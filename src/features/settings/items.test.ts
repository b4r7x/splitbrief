import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS, type SettingDef } from '../../core/settings/catalog.js';
import {
  buildSettingsItems,
  settingsItemDescription,
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
  it('opens with the crew diagram, then the settings in section order', () => {
    const config = makeConfig();
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });

    expect(items.slice(0, 5).map((item) => [item.kind, item.key])).toEqual([
      ['crew', 'seat:plan'],
      ['crew', 'effort:plan'],
      ['crew', 'seat:build'],
      ['crew', 'escalate'],
      ['crew', 'seat:review'],
    ]);
    expect(items.slice(0, 5).map(settingsItemSection)).toEqual(Array(5).fill('Crew'));

    const settingSections = items.slice(5).map(settingsItemSection);
    expect(settingSections.filter((section, at) => section !== settingSections[at - 1])).toEqual([
      'Tuning',
      'Validation',
      'Workflow',
      'Appearance',
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
    const items = buildSettingsItems({ config: makeConfig(), defs: [skipped] });

    expect(items.some((item) => item.key === 'test.skipped')).toBe(false);
  });
});

describe('settingsItemFilterText', () => {
  it('carries a crew row key with its row words, and a setting label with its section', () => {
    const items = buildSettingsItems({ config: makeConfig(), defs: SETTINGS_DEFS });
    const seatText = settingsItemFilterText(itemAt(items, 'seat:plan'));

    expect(seatText.startsWith('seat:plan ')).toBe(true);
    expect(seatText).toBe(seatText.toLowerCase());
    expect(settingsItemFilterText(itemAt(items, 'theme'))).toBe('theme appearance');
  });
});

describe('settingsItemDescription', () => {
  it('explains the plan seat and the escalation row', () => {
    const config = makeConfig();
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });

    expect(settingsItemDescription({ item: itemAt(items, 'seat:plan'), config })).toContain(
      'compiles every brief',
    );
    expect(settingsItemDescription({ item: itemAt(items, 'escalate'), config })).toContain(
      'escalates to before the planner takes over',
    );
  });

  it('tells an inherited effort row apart from an editable one', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4', effort: 'high' },
    });
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });

    expect(settingsItemDescription({ item: itemAt(items, 'effort:review'), config })).toContain(
      "Inherited with the planner's setup",
    );
    expect(settingsItemDescription({ item: itemAt(items, 'effort:plan'), config })).not.toContain(
      'Inherited',
    );
  });

  it('reads a setting row straight off its definition', () => {
    const config = makeConfig();
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });
    const theme = SETTINGS_DEFS.find((def) => def.id === 'theme');

    expect(settingsItemDescription({ item: itemAt(items, 'theme'), config })).toBe(
      theme?.description,
    );
  });
});
