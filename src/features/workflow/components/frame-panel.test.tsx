import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { glyph } from '../../../lib/glyphs.js';
import { configStore } from '../../../stores/project/config.js';
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

  it('renders an absolute path under projectDir relative to the project root at a wide width', () => {
    const projectDir = '/workspace/project';
    configStore.__testReset({ projectDir });
    ui = renderFeature(
      <FramePanel
        filePath={`${projectDir}/.splitbrief/sessions/session-1/plan.json`}
        width={80}
        height={8}
      >
        <Text>BODY</Text>
      </FramePanel>,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('.splitbrief/sessions/session-1/plan.json');
  });

  it('shortens the path in the middle at a narrow width and does not start with an ellipsis', () => {
    const projectDir = '/workspace/project';
    configStore.__testReset({ projectDir });
    ui = renderFeature(
      <FramePanel
        filePath={`${projectDir}/.splitbrief/sessions/session-1/plan.json`}
        width={30}
        height={8}
      >
        <Text>BODY</Text>
      </FramePanel>,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('.splitbrief/…/plan.json');
    const lines = frame.split('\n');
    const titleRow = lines.find((l) => l.includes('plan.json')) ?? '';
    expect(titleRow).not.toMatch(/◇\s*…/);
  });

  it('renders a non-path label and a relative path as before when they fit', () => {
    ui = renderFeature(
      <FramePanel filePath="Custom planner artifact" width={40} height={8}>
        <Text>BODY</Text>
      </FramePanel>,
    );
    let frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('Custom planner artifact');

    ui.unmount();
    ui = renderFeature(
      <FramePanel filePath="specs/session-1/spec.md" width={40} height={8}>
        <Text>BODY</Text>
      </FramePanel>,
    );
    frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('specs/session-1/');
    expect(frame).toContain('spec.md');
  });
});
