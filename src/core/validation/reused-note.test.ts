import { describe, expect, it } from 'vitest';
import { reusedNote } from './reused-note.js';

describe('reusedNote', () => {
  const ranAt = new Date(2026, 9, 28, 11, 53).toISOString();

  it('names the clock of the reused run on the same day', () => {
    expect(reusedNote(ranAt, new Date(2026, 9, 28, 14, 2).getTime())).toBe('reused, ran 11:53');
  });

  it('dates the reused run on a later day', () => {
    expect(reusedNote(ranAt, new Date(2026, 9, 29, 9, 0).getTime())).toBe(
      'reused, ran Oct 28, 11:53',
    );
  });
});
