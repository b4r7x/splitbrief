import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import {
  __testResetProbeActivity,
  trackProbe,
  trackToolCheck,
} from '../../engine/probe-activity.js';
import { ToolRollCall } from './tool-roll-call.js';

function rowOf(frame: string, displayName: string): string {
  return frame.split('\n').find((line) => line.includes(displayName)) ?? '';
}

describe('ToolRollCall', () => {
  let gate: PromiseWithResolvers<void>;

  beforeEach(() => {
    forceUnicodeGlyphs();
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    __testResetProbeActivity();
    gate = Promise.withResolvers<void>();
  });

  afterEach(() => {
    gate.resolve();
    vi.useRealTimers();
    __testResetProbeActivity();
  });

  it('shows no probe text on a checked row while another lane still probes the tool', async () => {
    await trackToolCheck('opencode', () => Promise.resolve());
    void trackToolCheck('codex', () => gate.promise);
    void trackProbe({ tool: 'opencode', check: 'model list' }, () => gate.promise);
    vi.setSystemTime(12_000);

    const ui = renderFeature(<ToolRollCall />);
    const row = rowOf(stripAnsiStyles(ui.lastFrame()), 'OpenCode CLI');
    expect(row).toContain('✓');
    expect(row).not.toContain('model list');
    ui.unmount();
  });

  it('shows the slow probe on a row that is still checking', async () => {
    void trackToolCheck('kilo-code', () => gate.promise);
    void trackProbe({ tool: 'kilo-code', check: 'version' }, () => gate.promise);
    vi.setSystemTime(14_000);

    const ui = renderFeature(<ToolRollCall />);
    expect(rowOf(stripAnsiStyles(ui.lastFrame()), 'Kilo Code CLI')).toContain('version 14s');
    ui.unmount();
  });

  it('stops the spinner once every row is checked', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: 0 });
    await trackToolCheck('codex', () => Promise.resolve());

    const ui = renderFeature(<ToolRollCall />);
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
    ui.unmount();
  });
});
