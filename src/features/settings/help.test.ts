import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { REMOVED_COMMANDS } from '../../core/runtime/commands/types.js';
import { buildSettingsItems, type SettingsItem } from './items.js';
import { CURRENT_MARKER, currentLineBody, settingsHelpLines } from './help.js';

function itemAt(items: readonly SettingsItem[], key: string): SettingsItem {
  const item = items.find((candidate) => candidate.key === key);
  if (item === undefined) throw new Error(`no ${key} item`);
  return item;
}

const items = buildSettingsItems({ config: makeConfig(), defs: SETTINGS_DEFS });

function linesFor(key: string, value?: unknown) {
  return settingsHelpLines({ item: itemAt(items, key), value });
}

describe('settingsHelpLines', () => {
  it('explains the plan seat', () => {
    expect(linesFor('seat:plan')).toEqual([
      { text: expect.stringContaining('writes every Task Brief') },
    ]);
  });

  it('reads a boolean row straight off its definition', () => {
    expect(linesFor('validation.lint')).toEqual([{ text: 'Run linter' }]);
  });

  it('reads a string row straight off its definition', () => {
    expect(linesFor('validation.testCommand')).toEqual([
      { text: "Argv-style test runner command (auto = the stack's own)" },
    ]);
  });

  it('keeps a bounded number range on the line that names it', () => {
    expect(linesFor('workflow.maxRetries')).toEqual([
      { text: 'Max retry attempts per task · 0–10' },
    ]);
  });

  it('leaves a one-sided bound off the line', () => {
    expect(linesFor('implementer.contextLength')).toEqual([
      { text: 'Prompt budget for the build seat (auto = detected from the model)' },
    ]);
  });

  it('spells an ordinary enum as its description and its options', () => {
    expect(linesFor('workflow.compactionFormat')).toEqual([
      { text: 'Summary format for transcript compaction' },
      { text: 'auto · freeform · structured' },
    ]);
  });

  it('prices every mode and marks only the one the config is on', () => {
    expect(linesFor('workflow.mode', 'standard')).toEqual([
      { text: 'quick     1 planning call · 0 gates', current: false },
      { text: 'standard  4 planning calls · 2 gates', current: true },
      { text: 'speckit   6-7 planning calls · 3 gates', current: false },
    ]);
  });

  it('marks no mode when the config is on none of them', () => {
    expect(linesFor('workflow.mode', undefined).some((line) => line.current)).toBe(false);
  });

  it('never points a help line at a command the merge deleted', () => {
    for (const item of items) {
      for (const line of settingsHelpLines({ item, value: undefined })) {
        for (const removed of Object.keys(REMOVED_COMMANDS)) {
          expect(line.text).not.toContain(removed);
        }
      }
    }
  });
});

describe('currentLineBody', () => {
  it('pads the body so the marker lands on the right edge', () => {
    const body = currentLineBody('quick', 20);

    expect(body).toHaveLength(20 - CURRENT_MARKER.length - 1);
    expect(`${body} ${CURRENT_MARKER}`).toHaveLength(20);
  });

  it('gives up the tail of a body too long for its row', () => {
    const body = currentLineBody('a'.repeat(40), 20);

    expect(body).toHaveLength(12);
    expect(body.endsWith('…')).toBe(true);
  });
});
