import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { buildSettingsItems, type SettingsItem } from './items.js';
import { settingsListWindow } from './list-window.js';

const items = buildSettingsItems({ config: makeConfig(), defs: SETTINGS_DEFS, cliTools: [] });

function itemAt(key: string): SettingsItem {
  const item = items.find((candidate) => candidate.key === key);
  if (item === undefined) throw new Error(`no ${key} item`);
  return item;
}

describe('settingsListWindow', () => {
  it('pins the crew rows at the head of the list', () => {
    expect(settingsListWindow({ items, rowBudget: 40, verdict: false }).pinnedHead).toBe(3);
  });

  it('spends a blank row between sections from 18 list rows on', () => {
    const gap = (rowBudget: number) =>
      settingsListWindow({ items, rowBudget, verdict: false }).section.gapBetweenSections;

    expect([gap(17), gap(18)]).toEqual([false, true]);
  });

  it('hangs the verdict line under the REVIEW seat only while the crew block shows it', () => {
    const shown = settingsListWindow({ items, rowBudget: 40, verdict: true }).decorations;
    const hidden = settingsListWindow({ items, rowBudget: 40, verdict: false }).decorations;

    expect([shown.after(itemAt('seat:review')), shown.after(itemAt('seat:plan'))]).toEqual([
      true,
      false,
    ]);
    expect(hidden.after(itemAt('seat:review'))).toBe(false);
  });

  it('counts a page in rows of the list, not in section headers or blank rows', () => {
    const listWindow = settingsListWindow({ items, rowBudget: 40, verdict: false });
    const tuning = items.filter((item) => item.kind === 'setting' && item.def.section === 'Tuning');

    expect(listWindow.pageSize({ filtered: items, selectedIndex: 0 })).toBe(items.length);
    expect(listWindow.pageSize({ filtered: tuning, selectedIndex: 0 })).toBe(tuning.length);
  });

  it('acts on the last row of the list when the cursor sits on it', () => {
    const listWindow = settingsListWindow({ items, rowBudget: 40, verdict: false });

    expect(listWindow.canActOnIndex(items, items.length - 1)).toBe(true);
  });

  it('acts on no row while the list has no row to show, and scrolls to the cursor otherwise', () => {
    const testCommand = items.indexOf(itemAt('validation.testCommand'));
    const actsAt = (rowBudget: number) =>
      settingsListWindow({ items, rowBudget, verdict: false }).canActOnIndex(items, testCommand);

    expect([actsAt(0), actsAt(4)]).toEqual([false, true]);
  });
});
