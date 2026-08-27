import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { glyph } from '../../../lib/glyphs.js';
import { FramePanel } from './frame-panel.js';

describe('FramePanel', () => {
  let ui: ReturnType<typeof renderFeature> | null = null;

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    ui = null;
  });

  afterEach(() => {
    ui?.unmount();
  });

  it('renders a single border, the dir/base title, and children below the divider', () => {
    ui = renderFeature(
      <FramePanel filePath="specs/session-1/spec.md" width={40} height={8}>
        <Text>BODY_CONTENT</Text>
      </FramePanel>,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('◇');
    expect(frame).toContain('specs/session-1/');
    expect(frame).toContain('spec.md');
    expect(frame).toContain(glyph('divider', 'unicode'));
    expect(frame).toContain('BODY_CONTENT');

    const lines = frame.split('\n');
    const rule = glyph('divider', 'unicode');
    const titleRow = lines.findIndex((l) => l.includes('spec.md'));
    const bodyRow = lines.findIndex((l) => l.includes('BODY_CONTENT'));
    // The interior divider sits strictly between the title and the children.
    const dividerRow = lines.findIndex((l, i) => i > titleRow && i < bodyRow && l.includes(rule));
    expect(titleRow).toBeGreaterThanOrEqual(0);
    expect(dividerRow).toBeGreaterThan(titleRow);
    expect(bodyRow).toBeGreaterThan(dividerRow);
  });

  it('floors the inner width at 1 for a tiny width', () => {
    ui = renderFeature(
      <FramePanel filePath="a/b.md" width={2} height={6}>
        <Text>X</Text>
      </FramePanel>,
    );
    const rule = glyph('divider', 'unicode');
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const dividerRow = lines.slice(1, -1).find((l) => l.includes(rule));
    expect(dividerRow).toBeDefined();
    expect(dividerRow?.split(rule).length).toBe(2);
  });
});
