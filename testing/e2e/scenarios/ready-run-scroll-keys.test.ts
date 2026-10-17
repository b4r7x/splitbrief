import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { mountShowDiffEditor } from '#testing/helpers/show-diff-editor.js';

const SHIFT_UP = '\x1b[1;2A';
const SHIFT_DOWN = '\x1b[1;2B';

it('shift+up/down scrolls a ready run without moving the Apply / Show diff / Discard cursor', async () => {
  const fixture = await mountShowDiffEditor({
    editor: 'cursor',
    exitCode: 0,
    fullscreen: true,
    viewport: { cols: 100, rows: 30 },
  });
  const { child, screen, rawIo, statePath, before, projectDir } = fixture;
  try {
    await fixture.waitForText('Describe your feature');
    child.write('/sessions');
    await fixture.waitForText('/sessions');
    await delay(PROMPT_TYPEAHEAD_GRACE_MS);
    child.write('\r');
    await fixture.waitForText('Sessions · 1');
    await delay(PROMPT_TYPEAHEAD_GRACE_MS);
    child.write('\r');
    await fixture.waitForText('Ready to apply');
    // Net two rows up: had a shift press moved the 3-row cursor, ↓ ⏎ would land on Discard.
    for (const key of [SHIFT_UP, SHIFT_UP, SHIFT_DOWN, SHIFT_UP]) {
      child.write(key);
      await delay(50);
    }
    child.write('\x1b[B');
    await delay(PROMPT_TYPEAHEAD_GRACE_MS);
    child.write('\r');
    await fixture.waitForRedraw();
    await vi.waitFor(() => {
      expect(fixture.editorStarted(), rawIo()).toBe(true);
      expect(screen()).toContain('run.patch open in cursor.');
    });
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(readFileSync(join(projectDir, 'greeting.txt'), 'utf8')).toBe('hello\n');
    fixture.quit();
    await vi.waitFor(() => expect(screen()).toContain('Ready to apply'));
    expect(screen()).not.toContain('Discarded');
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  } finally {
    await fixture.unmount();
  }
});
