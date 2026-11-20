import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { makeActions, pickerCatalog, zeroCounts } from '#testing/helpers/runner-picker.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { assemblePickerDescriptors, buildPickerOptions } from '../model-catalog/options.js';
import type { PickerActions } from './use-actions.js';
import { usePickerCatalog } from './use-catalog.js';
import { PickerView } from './view.js';

function ConfiguredSeatPicker({ confirm }: Pick<PickerActions, 'confirm'>) {
  const catalog = usePickerCatalog('planner', 'seat', 0);
  return (
    <PickerView
      slot="seat"
      role="planner"
      catalog={catalog}
      actions={{ ...makeActions(), confirm }}
    />
  );
}

describe('PickerView tool filtering', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    overlayStore.reset();
  });

  it('fits the full tool name beside its status at 80 columns', async () => {
    const viewport = { cols: 80, rows: 24 };
    terminalSizeStore.__testReset(viewport);
    const items = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      { cliTools: [cliDetectionFor('unavailable', 'antigravity')], providers: [] },
      undefined,
    );
    const catalog = pickerCatalog({
      items,
      rightModels: [],
      currentItem: items[0],
      selectedItemId: items[0]?.id,
      roleLabel: 'PLAN',
      modelCounts: zeroCounts,
    });
    const ui = renderFeature(
      <PickerView slot="seat" role="planner" catalog={catalog} actions={makeActions()} />,
      viewport,
    );
    try {
      await flushEffects();
      ui.stdin.write('antigravity');
      await flushEffects();
      expect(stripAnsiStyles(ui.lastFrame())).toMatch(/Google Antigravity CLI +Unavailable/u);
    } finally {
      ui.unmount();
    }
  });

  it('shows no command launcher or preview before or after filtering tools', async () => {
    const items = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      {
        cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
        providers: [],
      },
      undefined,
    );
    const catalog = pickerCatalog({
      items,
      rightModels: [],
      currentItem: items[0],
      selectedItemId: items[0]?.id ?? '',
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
    });
    const ui = renderFeature(
      <PickerView slot="seat" role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    expect(ui.lastFrame()).toContain('Claude Code CLI');
    expect(ui.lastFrame()).toContain('OpenAI Codex CLI');
    expect.soft(ui.lastFrame()).not.toContain('+ Add custom command');
    expect.soft(ui.lastFrame()).not.toContain('Run your own command.');

    ui.stdin.write('cla');
    await flushEffects();

    expect(ui.lastFrame()).toContain('Claude Code CLI');
    expect(ui.lastFrame()).not.toContain('OpenAI Codex CLI');
    expect(ui.lastFrame()).not.toContain('+ Add custom command');
    ui.unmount();
  });

  it.each([
    ['shell', 'output'],
    ['agent', 'direct'],
  ] as const)('shows the saved %s command once and keeps it read-only', async (kind, contract) => {
    const command = './scripts/plan.sh';
    const confirm = vi.fn(async () => {});
    configStore.__testReset({
      config: makeConfig({ planner: { kind, command } }),
    });
    modelCacheStore.reset();
    pickerViewStore.reset();
    overlayStore.open('planner-picker');
    const ui = renderFeature(<ConfiguredSeatPicker confirm={confirm} />);
    try {
      await flushEffects();
      const frame = ui.lastFrame() ?? '';
      const row = frame.split('\n').find((line) => line.includes(`▌ ${contract} · ${command}`));
      expect(row).toContain('✓');
      expect(frame.split(command)).toHaveLength(2);
      expect(frame).not.toMatch(/Add custom command|picks the contract|⏎ add custom/);

      ui.stdin.write('\r');
      await flushEffects();
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
      configStore.__testReset();
      overlayStore.reset();
    }
  });
});
