import { describe, expect, it } from 'vitest';
import { formatRejectRunMessage, rejectRunFeedback, runRejectFacts } from './messages.js';

const SAVED = '.splitbrief/sessions/run-1/reverted/2026-10-16T21-37-07-873Z';

describe('formatRejectRunMessage', () => {
  it('counts what a clean reject put back with real plurals and names the saved folder', () => {
    const facts = runRejectFacts({
      status: 'rejected',
      snapshotId: '2026-10-16T21-37-07-873Z',
      restoredPaths: ['README.md'],
      deletedPaths: ['lib/lerp.mjs', 'test/lerp.test.mjs'],
      conflictedPaths: [],
      missingSnapshotFiles: [],
      savedTo: SAVED,
    });
    const message = formatRejectRunMessage(facts);

    expect(message).toBe(
      `Put back 1 replaced file, removed 2 created files. The replaced files are saved in ${SAVED}.`,
    );
    expect(message).not.toContain('(s)');
    expect(rejectRunFeedback(facts)).toEqual({
      message: 'Run rejected · the transcript names what it put back',
      isError: false,
    });
  });

  it('names five paths left as you changed them, counts the rest, and keeps the run open', () => {
    const facts = runRejectFacts({
      status: 'rejected',
      snapshotId: 'snap-3',
      restoredPaths: [],
      deletedPaths: ['src/z.ts'],
      conflictedPaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'],
      missingSnapshotFiles: ['m.ts'],
      savedTo: SAVED,
    });
    const message = formatRejectRunMessage(facts);

    expect(message).toBe(
      `Removed 1 created file. 7 files left as you changed them: a.ts · b.ts · c.ts · d.ts · e.ts · +2 more. 1 file had no saved copy to put back. The replaced files are saved in ${SAVED}. The run stays open, so you can reject it again.`,
    );
    expect(message).not.toContain('f.ts');
    expect(message).not.toContain('snap-3');
    expect(rejectRunFeedback(facts)).toEqual({
      message: 'Run rejected in part · the transcript names what it left',
      isError: true,
    });
  });

  it('speaks of one file left as it', () => {
    expect(
      formatRejectRunMessage({
        restored: ['a.mjs', 'b.mjs', 'c.mjs'],
        removed: [],
        conflicted: ['lib/clamp.mjs'],
        missing: 0,
      }),
    ).toBe(
      'Put back 3 replaced files. 1 file left as you changed it: lib/clamp.mjs. The run stays open, so you can reject it again.',
    );
  });
});
