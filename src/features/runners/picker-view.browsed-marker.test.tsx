import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { cliTool, makeActions, pickerCatalog, zeroCounts } from '#testing/helpers/runner-picker.js';
import { glyph } from '../../lib/glyphs.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { ModelOption } from './model-catalog/recency.js';
import { PickerView } from './picker-view.js';
import type { PickerCatalog } from './use-picker-catalog.js';

// The browsed marker differs from the active bar by color alone, so the frames
// this file reads have to carry their SGR codes.
const savedForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (savedForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = savedForceColor;
});

const codex = cliTool({ id: 'codex', displayName: 'OpenAI Codex CLI', isCurrent: true });
const claudeCode = cliTool({ id: 'claude-code', displayName: 'Claude Code' });
const models: ModelOption[] = [
  { id: 'gpt-5', displayName: 'GPT-5' },
  { id: 'gpt-5-mini', displayName: 'GPT-5 mini' },
];

function browsableCatalog(): PickerCatalog {
  return pickerCatalog({
    items: [codex, claudeCode],
    rightModels: models,
    currentItem: codex,
    selectedItemId: codex.id,
    roleLabel: 'Planner',
    currentModel: 'gpt-5',
    persistedModel: 'gpt-5',
    modelCounts: { ...zeroCounts, confirmed: 2 },
  });
}

const liveBar = glyph('liveBar', 'unicode');

function lineFor(frame: string, label: string): string {
  return frame.split('\n').find((line) => line.includes(label)) ?? '';
}

/** The SGR parameters the row paints its bar with: accent when active, dim when browsed. */
function leadColorOf(line: string): string | undefined {
  const before = line.split(`m${liveBar}`)[0];
  return before?.split('\u001B[').at(-1);
}

describe('PickerView browsed tool marker', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    overlayStore.reset();
  });

  it.each([
    ['the right arrow', '\u001B[C'],
    ['enter', '\r'],
  ])(
    'keeps a dim marker on the browsed tool row once %s opens the models column',
    async (_name, key) => {
      const ui = renderFeature(
        <PickerView role="planner" catalog={browsableCatalog()} actions={makeActions()} />,
      );
      await flushEffects();

      const activeLine = lineFor(ui.lastFrame() ?? '', 'OpenAI Codex CLI');
      expect(stripAnsiStyles(activeLine)).toContain(`${liveBar} OpenAI Codex CLI`);

      ui.stdin.write(key);
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      const browsedLine = lineFor(frame, 'OpenAI Codex CLI');
      // Same cells, different ink: the bar stays, painted dim instead of accent.
      expect(stripAnsiStyles(browsedLine)).toBe(stripAnsiStyles(activeLine));
      expect(browsedLine).not.toBe(activeLine);
      expect(leadColorOf(browsedLine)).not.toBe(leadColorOf(activeLine));
      // The configured ✓ is untouched by the marker.
      expect(stripAnsiStyles(browsedLine)).toContain(glyph('check', 'unicode'));
      // The cursor itself moved to the models column, onto the configured model.
      const modelLine =
        frame.split('\n').find((line) => line.includes('GPT-5') && !line.includes('mini')) ?? '';
      expect(stripAnsiStyles(modelLine)).toContain(`${liveBar} GPT-5`);

      ui.unmount();
    },
  );

  it('restores the active bar when the left arrow returns to the tools column', async () => {
    const ui = renderFeature(
      <PickerView role="planner" catalog={browsableCatalog()} actions={makeActions()} />,
    );
    await flushEffects();
    const activeLine = lineFor(ui.lastFrame() ?? '', 'OpenAI Codex CLI');

    ui.stdin.write('\u001B[C');
    await flushEffects();
    const browsedLine = lineFor(ui.lastFrame() ?? '', 'OpenAI Codex CLI');
    expect(stripAnsiStyles(browsedLine)).toContain(`${liveBar} OpenAI Codex CLI`);
    expect(leadColorOf(browsedLine)).not.toBe(leadColorOf(activeLine));

    ui.stdin.write('\u001B[D');
    await flushEffects();
    expect(lineFor(ui.lastFrame() ?? '', 'OpenAI Codex CLI')).toBe(activeLine);

    ui.unmount();
  });
});
