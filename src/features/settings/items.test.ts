import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS, type SettingDef } from '../../core/settings/catalog.js';
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
  it('opens with the crew diagram, then the settings in section order', () => {
    const config = makeConfig();
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });

    expect(items.slice(0, 3).map((item) => [item.kind, item.key])).toEqual([
      ['crew', 'seat:plan'],
      ['crew', 'seat:build'],
      ['crew', 'seat:review'],
    ]);
    expect(items.slice(0, 3).map(settingsItemSection)).toEqual(Array(3).fill('Crew'));

    const settingSections = items.slice(3).map(settingsItemSection);
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
    expect(settingsItemFilterText(itemAt(items, 'workflow.approve'))).toBe(
      'plan approval workflow',
    );
  });
});
