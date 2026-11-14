import { beforeEach, describe, expect, it } from 'vitest';
import { diffEventKey } from '../../../core/sections/events.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { makeDiffReadCounter } from '#testing/helpers/events/implementer.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import * as readRowActions from './read-row-actions.js';

const diffReads = makeDiffReadCounter();

beforeEach(() => {
  resetAllStores();
  terminalSizeStore.__testReset({ cols: 120, rows: 40 });
  diffReads.reset();
});

describe('readLatestDiffKey', () => {
  it('reads the latest diff toggle of a long transcript from the row model, and reads no step again', () => {
    const latest = diffReads.done('+ latest', 399);
    const events = [
      ...Array.from({ length: 399 }, (_, index) => diffReads.done(`+ line ${index}`, index)),
      latest,
    ];
    eventsStore.__testReset({ events });
    readConversationScrollSnapshot();
    diffReads.reset();

    expect(readRowActions.readLatestDiffKey?.()).toBe(diffEventKey(latest, 399));
    expect(diffReads.count()).toBe(0);

    const newest = diffReads.done('+ newest', 400);
    eventsStore.__testReset({ events: [...events, newest] });
    expect(readRowActions.readLatestDiffKey?.()).toBe(diffEventKey(newest, 400));
    diffReads.reset();
    readConversationScrollSnapshot();
    expect(diffReads.count()).toBe(0);
  });
});
