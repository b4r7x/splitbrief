import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { routerStore } from '../../stores/navigation/router.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { SetupScreen } from './setup.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

describe('SetupScreen', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    routerStore.init({ screen: 'setup' });
    overlayStore.reset();
    _resetMouseZones();
    installClipboardExecFixture();
    resetClipboardExecFixture();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    restoreClipboardExecFixture();
  });

  it('renders the de-boxed no-planners panel with lowercase voice', async () => {
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('no planner detected');
    // The guidance sentence reflows inside the restored OverlayPanel frame, so "re-run" and "init:"
    // can land on separate wrapped lines; assert the phrase that stays intact.
    expect(frame).toContain('re-run');
    expect(frame).toContain('npm i -g @anthropic-ai/claude-code');
    expect(frame).toContain('npm i -g @openai/codex');
    expect(frame).toContain('esc quit');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('│');

    ui.unmount();
  });

  it('shows the no-planners screen when only the always-available shell planner is detected', async () => {
    detectionStore.setDetection({
      planners: [
        { tool: 'claude-code', type: 'cli', available: false, description: 'Claude Code' },
        { tool: 'shell', type: 'shell', available: true, description: 'Custom command' },
      ],
      implementers: [],
    });

    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('no planner detected');

    ui.unmount();
  });

  it('renders the planner picker with a lowercase step label when a non-shell planner is available', async () => {
    detectionStore.setDetection({
      planners: [
        { tool: 'claude-code', type: 'cli', available: true, description: 'Claude Code' },
        { tool: 'shell', type: 'shell', available: true, description: 'Custom command' },
      ],
      implementers: [],
    });

    const ui = renderFeature(
      <SetupScreen renderToolPicker={({ stepLabel }) => <Text>{stepLabel}</Text>} />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('no planner detected');
    expect(frame).toContain('choose planner · 1 of 2');

    ui.unmount();
  });

  it('copies the focused install command on y when no overlay is open', async () => {
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    ui.stdin.write('y');
    await tick();

    await vi.waitFor(() => {
      expect(readClipboardExecCalls().at(-1)?.stdin).toBe('npm i -g @anthropic-ai/claude-code');
    });

    ui.unmount();
  });

  it('does not process keys behind an open overlay (no exit, no copy)', async () => {
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    overlayStore.open('settings');
    await tick();

    ui.stdin.write('\x1b'); // escape must not quit while the overlay owns input
    ui.stdin.write('y'); // y must not copy while the overlay owns input
    await tick(20);

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(ui.lastFrame() ?? '').toContain('no planner detected');

    ui.unmount();
  });

  it('focuses a clicked install command row and copies it via the y-copy click zone', async () => {
    forceUnicodeGlyphs();
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    collectClickableZones({ cols: 120, rows: 50 }).get('setup-install:1')?.();
    await tick(50);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('▌ npm i -g @openai/codex');

    collectClickableZones({ cols: 120, rows: 50 }).get('setup-copy')?.();
    await tick();

    await vi.waitFor(() => {
      expect(readClipboardExecCalls().at(-1)?.stdin).toBe('npm i -g @openai/codex');
    });

    ui.unmount();
  });

  it('does not copy a hidden install command on y at a compact height', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 4, isSmall: false });
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    ui.stdin.write('\u001b[B');
    ui.stdin.write('y');
    await tick(20);

    expect(readClipboardExecCalls()).toHaveLength(0);
    ui.unmount();
  });
});
