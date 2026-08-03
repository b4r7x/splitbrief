import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_EXEC_WAIT_MS,
  installClipboardExecFixture,
  readClipboardExecCalls,
  resetClipboardExecFixture,
  restoreClipboardExecFixture,
} from '#testing/helpers/clipboard-exec-fixture.js';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { configStore } from '../../stores/project/config.js';
import type { CliToolDetection } from '../../core/discovery/detection.js';
import { detectionStore } from '../../stores/project/detection.js';
import { routerStore } from '../../stores/navigation/router.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { ToolModelPicker } from '../overlays/runners.js';
import { configPath, loadConfig } from '../../core/config/load/io.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { SetupScreen } from './setup.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';

const ENTER = '\r';
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
const ORIGINAL_TERM = process.env['TERM'];
const ORIGINAL_LANG = process.env['LANG'];
const ORIGINAL_STDOUT_IS_TTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function cliDetection(tool: CliToolDetection['tool'], ready: boolean): CliToolDetection {
  return cliDetectionFor(ready ? 'ready' : 'unavailable', tool);
}

const INSTALLED_RUNNERS = {
  cliTools: [cliDetection('claude-code', true), cliDetection('codex', true)],
  providers: [],
} satisfies Parameters<typeof detectionStore.setDetection>[0];

async function chooseRunner(
  ui: ReturnType<typeof renderFeature>,
  runnerId: 'claude-code' | 'codex',
): Promise<void> {
  await flushEffects();
  ui.stdin.write(runnerId);
  await flushEffects();
  ui.stdin.write(ENTER);
  await flushEffects();
  ui.stdin.write(ENTER);
  await flushEffects();
}

describe('SetupScreen', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    routerStore.init({ screen: 'setup' });
    overlayStore.reset();
    terminalSizeStore.reset();
    _resetMouseZones();
    installClipboardExecFixture();
    resetClipboardExecFixture();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    terminalSizeStore.reset();
    restoreClipboardExecFixture();
    if (ORIGINAL_PLATFORM) Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
    else Reflect.deleteProperty(process, 'platform');
    if (ORIGINAL_TERM === undefined) delete process.env['TERM'];
    else process.env['TERM'] = ORIGINAL_TERM;
    if (ORIGINAL_LANG === undefined) delete process.env['LANG'];
    else process.env['LANG'] = ORIGINAL_LANG;
    if (ORIGINAL_STDOUT_IS_TTY) {
      Object.defineProperty(process.stdout, 'isTTY', ORIGINAL_STDOUT_IS_TTY);
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('renders the de-boxed no-planners panel with Splitbrief branding', async () => {
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('SPLITBRIEF compiles task briefs');
    expect(frame).toContain('No planner detected');
    expect(frame).toContain('re-run');
    expect(frame).toContain('npm i -g @anthropic-ai/claude-code');
    expect(frame).toContain('npm i -g @openai/codex');
    expect(frame).toContain('esc quit');
    expect(frame).not.toContain('╭');
    expect(frame).not.toContain('│');

    ui.unmount();
  });

  it('shows the no-planners screen when no planner-capable CLI is ready', async () => {
    detectionStore.setDetection({
      cliTools: [cliDetection('claude-code', false), cliDetection('codex', false)],
      providers: [],
    });

    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('No planner detected');

    ui.unmount();
  });

  it('renders the planner picker with the full step label when a planner-capable CLI is ready', async () => {
    detectionStore.setDetection({
      cliTools: [cliDetection('claude-code', true), cliDetection('codex', false)],
      providers: [],
    });

    const ui = renderFeature(
      <SetupScreen renderToolPicker={({ stepLabel }) => <Text>{stepLabel}</Text>} />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('No planner detected');
    expect(frame).toContain('Choose planner · 1 of 2');

    ui.unmount();
  });

  it('copies the focused install command on y when no overlay is open', async () => {
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await flushEffects();

    ui.stdin.write('y');
    await tick();

    await vi.waitFor(() => {
      expect(readClipboardExecCalls().at(-1)?.stdin).toBe('npm i -g @anthropic-ai/claude-code');
    }, CLIPBOARD_EXEC_WAIT_MS);

    ui.unmount();
  });

  it('does not process keys behind an open overlay (no exit, no copy)', async () => {
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    overlayStore.open('settings');
    await flushEffects();

    ui.stdin.write('\x1b');
    await flushEffects();
    ui.stdin.write('y');
    await tick(20);

    expect(readClipboardExecCalls()).toHaveLength(0);
    expect(ui.lastFrame() ?? '').toContain('No planner detected');

    ui.unmount();
  });

  it('keeps the clicked install action selected across resize and copies that action', async () => {
    forceUnicodeGlyphs();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await tick(20);

    collectClickableZones({ cols: 120, rows: 40 }).get('setup-install:codex')?.();
    await tick(50);

    expect(ui.lastFrame() ?? '').toContain('▌ npm i -g @openai/codex');

    terminalSizeStore.__testReset({ cols: 80, rows: 16 });
    await flushEffects();
    expect(ui.lastFrame() ?? '').not.toContain('npm i -g @openai/codex');

    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('▌ npm i -g @openai/codex');

    collectClickableZones({ cols: 120, rows: 40 }).get('setup-copy')?.();
    await tick();

    await vi.waitFor(() => {
      expect(readClipboardExecCalls().at(-1)?.stdin).toBe('npm i -g @openai/codex');
    }, CLIPBOARD_EXEC_WAIT_MS);

    ui.unmount();
  });

  it('keeps planner confirmation reachable after a real config save rejection', async () => {
    await withTempDir('setup-invalid', async (projectDir) => {
      configStore.load(projectDir);
      writeFileSync(join(projectDir, SPLITBRIEF_DIR), 'blocks the canonical config directory');
      detectionStore.setDetection(INSTALLED_RUNNERS);
      routerStore.init({ screen: 'setup', onComplete: 'home' });
      terminalSizeStore.__testReset({ cols: 80, rows: 24 });

      const ui = renderFeature(
        <SetupScreen
          renderToolPicker={({ role, stepLabel, onConfirm, onCancel }) => (
            <ToolModelPicker
              role={role}
              stepLabel={stepLabel}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          )}
        />,
      );
      await flushEffects();
      await chooseRunner(ui, 'claude-code');

      expect(feedbackStore.get()).toMatchObject({
        isError: true,
        message: expect.stringContaining('Failed to save config'),
      });
      expect(ui.lastFrame() ?? '').toContain('Choose planner · 1 of 2');
      expect(ui.lastFrame() ?? '').toContain('⏎ confirm');

      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();
      expect(feedbackStore.get().isError).toBe(true);
      expect(routerStore.get().screen).toBe('setup');

      ui.unmount();
    });
  });

  it('resets the real picker between roles and completes to workflow with canonical config', async () => {
    await withTempDir('setup-complete', async (projectDir) => {
      configStore.load(projectDir);
      detectionStore.setDetection(INSTALLED_RUNNERS);
      routerStore.init({
        screen: 'setup',
        onComplete: 'workflow',
        feature: 'Keep setup behavior',
        plannerContext: 'Use the selected planner',
        allowRepoRunners: true,
      });
      terminalSizeStore.__testReset({ cols: 80, rows: 24 });

      const ui = renderFeature(
        <SetupScreen
          renderToolPicker={({ role, stepLabel, onConfirm, onCancel }) => (
            <ToolModelPicker
              role={role}
              stepLabel={stepLabel}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          )}
        />,
      );
      await flushEffects();
      await chooseRunner(ui, 'claude-code');

      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('Choose model · 2 of 2');
      });

      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('Implementer');
      expect(frame).toContain('Choose model · 2 of 2');
      expect(frame).toContain('Ollama · api');
      expect(frame).toContain('Start o…');
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
      expect(frame.split('\n').every((line) => getTerminalCellWidth(line) <= 80)).toBe(true);

      await flushEffects();
      ui.stdin.write('\u001b');
      await flushEffects();
      expect(ui.lastFrame() ?? '').toContain('Choose planner · 1 of 2');

      await chooseRunner(ui, 'claude-code');
      await chooseRunner(ui, 'codex');

      await vi.waitFor(() => {
        expect(routerStore.get()).toMatchObject({
          screen: 'workflow',
          feature: 'Keep setup behavior',
          plannerContext: 'Use the selected planner',
          allowRepoRunners: true,
        });
      });
      expect(configPath(projectDir)).toBe(join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE));
      expect(existsSync(configPath(projectDir))).toBe(true);
      expect(readdirSync(join(projectDir, SPLITBRIEF_DIR))).toEqual([CONFIG_FILE]);

      const persisted = loadConfig(projectDir).config;
      expect(persisted).toMatchObject({
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'codex' },
      });

      ui.unmount();
    });
  });

  it('does not copy a hidden install command on y at a compact height', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 4, isSmall: false });
    const ui = renderFeature(<SetupScreen renderToolPicker={() => null} />);
    await flushEffects();

    ui.stdin.write('\u001b[B');
    await flushEffects();
    ui.stdin.write('y');
    await tick(20);

    expect(readClipboardExecCalls()).toHaveLength(0);
    ui.unmount();
  });
});
