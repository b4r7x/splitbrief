import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { glyph } from '../../lib/glyphs.js';
import { ContractChoiceOverlay } from './contract-choice-overlay.js';

const ARROW_DOWN = '\u001B[B';

describe('ContractChoiceOverlay', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: true });
  });

  it('shows both contracts with their distinct permission copy', async () => {
    const ui = renderFeature(
      <ContractChoiceOverlay role="implementer" initialKind={undefined} onChoose={() => {}} />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Custom command');
    expect(frame).toContain('implementer');
    expect(frame).toContain('Output command');
    expect(frame).toContain("read from the command's stdout");
    expect(frame).toContain('no direct writes');
    expect(frame).toContain('Direct-write agent');
    expect(frame).toContain('the files it writes, not stdout');
    expect(frame).toContain('written directly to your tree');
    ui.unmount();
  });

  it('confirms the output contract by default and the agent contract after arrow-down', async () => {
    const chosen: string[] = [];
    const ui = renderFeature(
      <ContractChoiceOverlay
        role="planner"
        initialKind={undefined}
        onChoose={(kind) => chosen.push(kind)}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => expect(chosen).toEqual(['shell']));

    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(chosen).toEqual(['shell', 'agent']));
    ui.unmount();
  });

  it('preselects the configured contract', async () => {
    const chosen: string[] = [];
    const ui = renderFeature(
      <ContractChoiceOverlay
        role="planner"
        initialKind="agent"
        onChoose={(kind) => chosen.push(kind)}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => expect(chosen).toEqual(['agent']));
    ui.unmount();
  });

  it('marks the configured contract with a check', async () => {
    const ui = renderFeature(
      <ContractChoiceOverlay
        role="planner"
        initialKind="shell"
        configuredKind="agent"
        onChoose={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(`agent ${glyph('check')}`);
    expect(frame).not.toContain(`shell ${glyph('check')}`);
    ui.unmount();
  });

  it('fits 18 rows at 60 columns and ends the content on a card row', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const ui = renderFeature(
      <ContractChoiceOverlay role="planner" initialKind={undefined} onChoose={() => {}} />,
      { cols: 60, rows: 18 },
    );
    await tick(20);

    const lines = (ui.lastFrame() ?? '').split('\n');
    const top = lines.findIndex((line) => line.includes('\u256D'));
    const bottom = lines.findLastIndex((line) => line.includes('\u2570'));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom - top + 1).toBeLessThanOrEqual(18);

    const hint = lines.findIndex((line) => line.includes('continue'));
    // OverlayPanel already spaces the hint by one row, so the card block ends two rows above it.
    expect(lines[hint - 1]?.replace(/[\u2502\u256D\u256E\u2570\u256F]/g, '').trim()).toBe('');
    expect(lines[hint - 2]).toContain('written directly to your tree');
    ui.unmount();
  });

  it('names the reviewer seat and takes input while the reviewer picker is open', async () => {
    overlayStore.open('reviewer-picker');
    const chosen: string[] = [];
    const ui = renderFeature(
      <ContractChoiceOverlay
        role="reviewer"
        initialKind={undefined}
        onChoose={(kind) => chosen.push(kind)}
      />,
    );
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('reviewer');
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(chosen).toEqual(['shell']));
    ui.unmount();
  });
});
