import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { REMOVED_COMMANDS } from '../../core/runtime/commands/types.js';
import { buildSettingsItems, type SettingsItem } from './items.js';
import { helpTextRows, settingsHelpLines } from './help.js';

function itemAt(items: readonly SettingsItem[], key: string): SettingsItem {
  const item = items.find((candidate) => candidate.key === key);
  if (item === undefined) throw new Error(`no ${key} item`);
  return item;
}

const config = makeConfig();
const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });

function linesFor(key: string) {
  return settingsHelpLines(itemAt(items, key), config);
}

describe('settingsHelpLines', () => {
  it('explains the plan seat', () => {
    expect(linesFor('seat:plan')).toEqual([
      { text: expect.stringContaining('writes every Task Brief') },
    ]);
  });

  it.each([
    ['end', 'Reads the whole diff once after the last task'],
    ['task', 'Reads the diff after every task'],
  ] as const)('explains the review seat under review: %s', (review, text) => {
    const reviewConfig = makeConfig({ workflow: { review } });

    expect(settingsHelpLines(itemAt(items, 'seat:review'), reviewConfig)).toEqual([
      { text: expect.stringContaining(text) },
    ]);
  });

  describe('under REVIEW None', () => {
    const noneConfig = makeConfig({ reviewer: 'none' });

    it('says that no seat reviews the run', () => {
      expect(settingsHelpLines(itemAt(items, 'seat:review'), noneConfig)).toEqual([
        { text: 'REVIEW is None: no seat reviews this run.' },
      ]);
    });

    it('leads a read-only row with the reason it is read-only', () => {
      expect(settingsHelpLines(itemAt(items, 'validation.endChecks'), noneConfig)[0]).toEqual({
        text: 'Read-only while REVIEW is None: no review runs.',
      });
    });

    it('shows only the reason on a read-only row', () => {
      expect(settingsHelpLines(itemAt(items, 'validation.endChecks'), noneConfig)).toEqual([
        { text: 'Read-only while REVIEW is None: no review runs.' },
      ]);
    });
  });

  it.each(['plan', 'build', 'review'])(
    'explains the %s fallback within two 60-column rows',
    (seat) => {
      const lines = linesFor(`fallback:${seat}`);

      expect(lines).toEqual([
        {
          text: 'Takes the seat once per run when its tool is signed out or out of quota. None pauses the run and asks.',
        },
      ]);
      expect(helpTextRows(lines, 60).length).toBeLessThanOrEqual(2);
    },
  );

  it('reads a boolean row straight off its definition', () => {
    expect(linesFor('validation.endChecks')).toEqual([
      {
        text: 'SPLITBRIEF runs the project gate the plan names before the final review. When off, a fix brief does not run the reviewer check it answers.',
      },
    ]);
  });

  it('reads a string row straight off its definition', () => {
    expect(linesFor('validation.testCommand')).toEqual([
      { text: "The command the planner's test checks run (auto = the stack's own)" },
    ]);
  });

  it('leaves a one-sided bound off the line', () => {
    expect(linesFor('implementer.contextLength')).toEqual([
      {
        text: 'Stop a brief above this limit. With auto, the tool manages context.',
      },
    ]);
  });

  it('lists the isolation choices by their labels', () => {
    expect(linesFor('workflow.isolation')).toEqual([
      { text: 'Where the build seat writes its changes; worktree by default' },
      { text: 'worktree · staged copy · your checkout' },
    ]);
  });

  it('lists the review cadence choices by their option names', () => {
    expect(linesFor('workflow.review')).toEqual([
      { text: 'When the review seat reads the diff: once at the end, or after every brief' },
      { text: 'end · task' },
    ]);
  });

  it('never points a help line at a command the merge deleted', () => {
    for (const item of items) {
      for (const line of settingsHelpLines(item, config)) {
        const commands = line.text.match(/(?<![\w.])\/[a-z-]+/g) ?? [];
        for (const removed of Object.keys(REMOVED_COMMANDS)) {
          expect(commands).not.toContain(removed);
        }
      }
    }
  });
});
