import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { CliProviderAuthFact } from '../../core/discovery/detection.js';
import { detectionStore } from '../../stores/project/detection.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { ModelOption } from './model-catalog/recency.js';
import { ProviderChoiceOverlay } from './provider-choice-overlay.js';

const ARROW_DOWN = '\u001B[B';

const KILO_FACTS: readonly CliProviderAuthFact[] = [
  { provider: 'GitHub Copilot', source: 'oauth' },
];

const MERGED_MODEL: ModelOption = {
  id: 'github-copilot/deepseek-v4-flash',
  membership: 'confirmed',
  variants: [
    {
      fullId: 'github-copilot/deepseek-v4-flash',
      providerPrefix: 'github-copilot',
      tag: 'copilot',
    },
    { fullId: 'openrouter/deepseek-v4-flash', providerPrefix: 'openrouter', tag: 'openrouter' },
    { fullId: 'kilo/gemini/deepseek-v4-flash', providerPrefix: 'kilo/gemini', tag: 'gemini' },
  ],
};

function setKiloDetection(providerAuth?: readonly CliProviderAuthFact[]) {
  detectionStore.setDetection({
    providers: [],
    cliTools: [
      providerAuth === undefined
        ? cliDetectionFor('ready', 'kilo-code')
        : cliDetectionFor('ready', 'kilo-code', { providerAuth }),
    ],
  });
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

describe('ProviderChoiceOverlay', () => {
  const item = realPickerOption('planner', 'kilo-code');

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: true });
  });

  it('lists one row per provider with honest auth glyphs and remediation copy', async () => {
    setKiloDetection(KILO_FACTS);
    const ui = renderFeature(
      <ProviderChoiceOverlay role="planner" item={item} model={MERGED_MODEL} onChoose={() => {}} />,
    );
    await tick(20);

    const frame = frameText(ui);
    expect(frame).toContain('DeepSeek V4 Flash');
    expect(frame).toContain('planner');
    const lines = frame.split('\n');
    const configuredLines = lines.filter((line) => line.includes('●'));
    expect(configuredLines).toHaveLength(1);
    expect(configuredLines[0]).toContain('copilot');
    expect(frame).toContain('copilot signed in (oauth)');
    expect(lines.filter((line) => line.includes('○'))).toHaveLength(2);
    expect(frame).toContain('openrouter needs sign-in · kilo auth login openrouter');
    expect(frame).toContain('requires a Kilo account: kilo auth login');
    ui.unmount();
  });

  it('chooses the focused provider on Enter, including a needs-sign-in one', async () => {
    setKiloDetection(KILO_FACTS);
    const chosen: string[] = [];
    const ui = renderFeature(
      <ProviderChoiceOverlay
        role="planner"
        item={item}
        model={MERGED_MODEL}
        onChoose={(fullId) => chosen.push(fullId)}
      />,
    );
    await flushEffects();

    ui.stdin.write('\r');
    await vi.waitFor(() => expect(chosen).toEqual(['github-copilot/deepseek-v4-flash']));

    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() =>
      expect(chosen).toEqual(['github-copilot/deepseek-v4-flash', 'kilo/gemini/deepseek-v4-flash']),
    );
    ui.unmount();
  });

  it('claims nothing when the oracle could not be read and says how to retry', async () => {
    setKiloDetection(undefined);
    const ui = renderFeature(
      <ProviderChoiceOverlay role="planner" item={item} model={MERGED_MODEL} onChoose={() => {}} />,
    );
    await tick(20);

    const frame = frameText(ui);
    expect(frame).toContain('copilot');
    expect(frame).toContain('openrouter');
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('○');
    expect(frame).not.toContain('needs sign-in');
    expect(frame).not.toContain('signed in');
    expect(frame).toContain('auth state unknown — could not read kilo auth list');
    ui.unmount();
  });
});
