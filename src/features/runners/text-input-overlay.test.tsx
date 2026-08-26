import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { SOFT_SEP } from '../../components/separators.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { glyph } from '../../lib/glyphs.js';
import { ContractRecap, StepIndicator } from './contract-chip.js';
import { TextInputOverlay } from './text-input-overlay.js';

function panelHeight(frame: string): number {
  const lines = frame.split('\n');
  const top = lines.findIndex((line) => line.includes('╭'));
  const bottom = lines.findLastIndex((line) => line.includes('╰'));
  return bottom - top + 1;
}

function panelWidth(frame: string): number {
  const top = frame.split('\n').find((line) => line.includes('╭')) ?? '';
  return top.trimEnd().length - top.indexOf('╭');
}

describe('TextInputOverlay', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
  });

  it('ignores typing and Enter while a foreign overlay is open, then accepts them once it closes', async () => {
    overlayStore.open('command-palette');
    const submitted: string[] = [];
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        label="Command to run"
        placeholder="cmd"
        onSubmit={(value) => {
          submitted.push(value);
        }}
      />,
    );
    await flushEffects();

    ui.stdin.write('abc');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('abc');

    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(submitted).toEqual([]);

    overlayStore.close();
    await flushEffects();

    ui.stdin.write('hello');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(submitted).toEqual(['hello']);
    ui.unmount();
  });

  it('renders one panel with a rounded input frame, accent prompt, and dim footer', async () => {
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        label="Command to run"
        placeholder="cmd"
        examples={['my-tool']}
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame.split('╭').length - 1).toBe(2);
    expect(frame).toContain('Custom command');
    expect(frame).toContain('planner');
    expect(frame).toContain(`${glyph('prompt')} `);
    expect(frame).toContain(`⏎ save${SOFT_SEP}esc back`);
    expect(frame).toContain('e.g. my-tool');
    ui.unmount();
  });

  it('keeps the panel height fixed while a long command word-wraps to more input rows', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        label="Command to run"
        placeholder="cmd"
        helper="prompt on stdin"
        examples={['my-planner --json']}
        rows={1}
        maxRows={3}
        onSubmit={() => {}}
      />,
    );
    await tick(20);
    const initialFrame = ui.lastFrame() ?? '';
    const initialHeight = panelHeight(initialFrame);
    expect(initialFrame).toContain('prompt on stdin');
    expect(initialFrame).toContain('e.g. my-planner --json');

    // Three 40-cell words: each fits an input row alone, no two fit together
    // (81 cells) in the ~64-cell input row, so the draft renders as three rows.
    await flushEffects();
    ui.stdin.write(`${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}`);
    await tick(20);
    await flushEffects();

    const grownFrame = ui.lastFrame() ?? '';
    expect(grownFrame).not.toContain('prompt on stdin');
    expect(grownFrame).not.toContain('e.g. my-planner --json');
    expect(panelHeight(grownFrame)).toBe(initialHeight);
    ui.unmount();
  });

  it('keeps the contract recap on one truncating row when it outgrows the panel', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 30, isSmall: true });
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        recap={<ContractRecap tier="direct" />}
        label="Command to run"
        placeholder="cmd"
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    // The roomy panel is 56 wide at 60 cols, so the recap has 50 inner cells for
    // a 51-cell digest: it stays on one row and only the tail is dropped.
    const rows = (ui.lastFrame() ?? '').split('\n');
    expect(rows.filter((row) => row.includes('DIRECT'))).toHaveLength(1);
    expect(rows.some((row) => row.includes('stdout ignored'))).toBe(false);
    ui.unmount();
  });

  it('shows the full contract recap digest where the panel is wide enough', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        recap={<ContractRecap tier="output" />}
        label="Command to run"
        placeholder="cmd"
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    const bar = glyph('liveBar');
    const arrow = glyph('connectorHandoff');
    expect(ui.lastFrame() ?? '').toContain(
      `${bar}  OUTPUT  ${arrow} result from stdout${SOFT_SEP}no direct writes`,
    );
    ui.unmount();
  });

  it('is 84 cells wide at 120x40', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom model"
        role="planner"
        label="Model id for Ollama"
        placeholder="e.g. llama3.3:latest"
        examples={['llama3.3:70b', 'anthropic/claude-3-opus', 'deepseek/deepseek-chat']}
        onSubmit={() => {}}
      />,
    );
    await tick(20);

    expect(panelWidth(ui.lastFrame() ?? '')).toBe(84);
    ui.unmount();
  });

  it('drops the examples and stays inside 18 rows at 60x18 with a three-row draft', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const ui = renderFeature(
      <TextInputOverlay
        title="Custom command"
        role="planner"
        stepIndicator={<StepIndicator active="command" />}
        recap={<ContractRecap tier="output" />}
        label="Command to run"
        placeholder="cmd"
        helper="prompt on stdin"
        examples={['my-planner --json']}
        rows={1}
        maxRows={3}
        onSubmit={() => {}}
      />,
    );
    await tick(20);
    await flushEffects();
    ui.stdin.write(`${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}`);
    await tick(20);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('e.g. my-planner --json');
    expect(frame).not.toContain('prompt on stdin');
    expect(panelHeight(frame)).toBeLessThanOrEqual(18);
    ui.unmount();
  });
});
