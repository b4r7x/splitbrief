import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readDoc(name: string): string {
  return readFileSync(new URL(`../../docs/${name}.md`, import.meta.url), 'utf-8');
}

describe('input context contracts', () => {
  it.each(['FEATURES', 'TROUBLESHOOTING'])(
    '%s distinguishes plain-send and /steer refusals',
    (name) => {
      const doc = readDoc(name);
      expect(doc).toMatch(/plain send[^\n]*keeps[^\n]*draft/i);
      expect(doc).toMatch(/\/steer[^\n]*clears[^\n]*draft[^\n]*history[^\n]*↑/);
    },
  );

  it('documents the reconstructed input of freeform compaction', () => {
    const doc = readDoc('SUBSYSTEMS');
    expect(doc).toMatch(/Freeform compaction[^\n]*planner conversation/);
    expect(doc).toMatch(/previous summary[^\n]*user message/);
    expect(doc).toMatch(/implementer output[^\n]*pending queued messages/);
    expect(doc).toMatch(/file bodies[^\n]*state\.json/);
  });
});
