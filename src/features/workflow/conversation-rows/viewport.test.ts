import { describe, expect, it } from 'vitest';
import { splitConversationViewport } from './viewport.js';

describe('splitConversationViewport', () => {
  it('gives the whole viewport to the transcript when there is no chrome to reserve', () => {
    const split = splitConversationViewport({
      viewportHeight: 10,
      sections: [],
      pendingTaskCount: 0,
    });
    expect(split.transcriptViewportHeight).toBe(10);
    expect(split.queuedRows).toBe(0);
    expect(split.completedRows).toBe(0);
  });
});
