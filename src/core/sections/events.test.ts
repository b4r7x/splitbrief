import { describe, it, expect } from 'vitest';
import { diffEventKey } from './events.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';

describe('diffEventKey', () => {
  it('gives two same-timestamp diffs distinct keys from their global render index', () => {
    const ts = 1234;
    const first = makeImplementerGenerate({ status: 'done', diff: '+ a', ts });
    const second = makeImplementerGenerate({ status: 'done', diff: '+ b', ts });

    expect(diffEventKey(first, 0)).not.toBe(diffEventKey(second, 1));
  });
});
