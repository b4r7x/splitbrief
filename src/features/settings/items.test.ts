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

    expect(items.slice(0, 6).map((item) => [item.kind, item.key])).toEqual([
      ['crew', 'seat:plan'],
      ['crew', 'effort:plan'],
      ['crew', 'seat:build'],
      ['crew', 'effort:build'],
      ['crew', 'seat:review'],
      ['crew', 'effort:review'],
    ]);
    expect(items.slice(0, 6).map(settingsItemSection)).toEqual(Array(6).fill('Crew'));

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
    expect(settingsItemFilterText(itemAt(items, 'workflow.mode'))).toBe('mode workflow');
  });
});

describe('settingsItemDescription', () => {
  it('explains the plan seat', () => {
    const config = makeConfig();
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });

    expect(settingsItemDescription({ item: itemAt(items, 'seat:plan'), config })).toContain(
      'compiles every brief',
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

  it("names the tool's own variant vocabulary on a variant-channel effort row", () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6-luna' },
    });
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });

    expect(settingsItemDescription({ item: itemAt(items, 'effort:build'), config })).toContain(
      'opencode run --variant',
    );
  });

  it('sends a model-id effort row to the seat picker', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'cursor', model: 'gpt-5.6-luna-high' },
    });
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });

    expect(settingsItemDescription({ item: itemAt(items, 'effort:build'), config })).toContain(
      'spelled by the model id',
    );
  });

  it('reads a setting row straight off its definition', () => {
    const config = makeConfig();
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });
    const mode = SETTINGS_DEFS.find((def) => def.id === 'workflow.mode');

    expect(settingsItemDescription({ item: itemAt(items, 'workflow.mode'), config })).toBe(
      mode?.description,
    );
  });
});
