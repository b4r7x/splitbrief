import { describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { PresetRow } from './preset-row.js';

const PRESET: CrewPreset = {
  id: 'claude-crew-codex-review',
  label: 'Claude crew, Codex review',
  description: 'Claude Code plans and builds; Codex reviews the diff from another lab.',
  seats: {
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: { kind: 'cli', tool: 'opencode' },
    reviewer: { kind: 'cli', tool: 'codex' },
  },
};

describe('crew preset row', () => {
  it('shows each offered crew with the seats it fills', async () => {
    const ui = renderFeature(<PresetRow presets={[PRESET]} selected={PRESET.id} width={72} />, {
      cols: 80,
      rows: 24,
    });
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    expect(frame).toContain(PRESET.label);
    expect(frame).toContain('Claude Code plans');
  });
});
