import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { loadConfig } from '../../core/config/load/io.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { CrewOverlay } from './crew.js';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';
const OSC_LEAD = '\u001b]';
const HOSTILE_ERROR = 'Failed to save config: \u001b]0;pwned\u0007oops';
const ESC = '\u001b';

function readyCrewTools() {
  detectionStore.setDetection({
    providers: [],
    cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
  });
}

describe('crew overlay', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    feedbackStore.reset();
    overlayStore.reset();
    terminalSizeStore.__testReset({ cols: 100, rows: 40 });
    overlayStore.open('crew');
  });

  it('shows every seat in workflow order', async () => {
    const ui = renderFeature(<CrewOverlay />);
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    const plan = frame.indexOf('PLAN');
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(frame.indexOf('BUILD')).toBeGreaterThan(plan);
    expect(frame.indexOf('REVIEW')).toBeGreaterThan(frame.indexOf('BUILD'));
  });

  it('opens the picker of the focused seat and keeps crew underneath it', async () => {
    const ui = renderFeature(<CrewOverlay />);
    await flushEffects();

    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('reviewer-picker');
    });
    ui.unmount();

    expect(overlayStore.get().stack.map((entry) => entry.type)).toEqual(['crew']);
  });

  it('closes on escape', async () => {
    const ui = renderFeature(<CrewOverlay />);
    await flushEffects();

    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('none');
    });
    ui.unmount();
  });

  it('applies the focused preset to every seat', async () => {
    await withTempDir('crew-overlay-preset', async (projectDir) => {
      configStore.load(projectDir);
      readyCrewTools();

      const ui = renderFeature(<CrewOverlay />);
      await flushEffects();

      ui.stdin.write(UP);
      await flushEffects();
      ui.stdin.write(UP);
      await flushEffects();
      ui.stdin.write(ENTER);
      await vi.waitFor(() => {
        const persisted = loadConfig(projectDir).config;
        expect(persisted.planner).toMatchObject({ kind: 'cli', tool: 'claude-code' });
        expect(persisted.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });
      });
      ui.unmount();
    });
  });
  it('returns to the seat it left when the picker closes', async () => {
    const ui = renderFeature(<CrewOverlay />);
    await flushEffects();

    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('reviewer-picker');
    });
    ui.unmount();
    overlayStore.close();

    const reopened = renderFeature(<CrewOverlay />);
    await flushEffects();
    reopened.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(overlayStore.get().active).toBe('reviewer-picker');
    });
    reopened.unmount();
  });

  it('reports a failed preset apply in its own panel', async () => {
    configStore.__testReset({
      projectDir: '/crew-overlay-unwritable/project',
      config: makeConfig(),
    });
    readyCrewTools();

    const ui = renderFeature(<CrewOverlay />);
    await flushEffects();
    ui.stdin.write(UP);
    await flushEffects();
    ui.stdin.write(UP);
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Failed to save config');
    });
    ui.unmount();
  });

  it('never applies a preset that the viewport is too short to show', async () => {
    await withTempDir('crew-overlay-hidden-preset', async (projectDir) => {
      const viewport = { cols: 60, rows: 18 };
      terminalSizeStore.__testReset(viewport);
      configStore.__testReset({
        projectDir,
        config: makeConfig({
          escalation: {
            enabled: true,
            intermediateProvider: 'deepseek',
            intermediateModel: 'deepseek-chat',
          },
        }),
      });
      readyCrewTools();
      feedbackStore.setError('save failed');
      overlayStore.setFocus('preset:claude-crew-codex-review');

      const ui = renderFeature(<CrewOverlay />, viewport);
      await flushEffects();

      ui.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('planner-picker');
      });
      ui.unmount();

      expect(configStore.get().config?.reviewer).toBeUndefined();
      expect(loadConfig(projectDir).config.reviewer).toBeUndefined();
    });
  });

  it('keeps the panel closed at 60x18 with a configured reviewer and an escalation branch', async () => {
    const viewport = { cols: 60, rows: 18 };
    terminalSizeStore.__testReset(viewport);
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        reviewer: { kind: 'cli', tool: 'codex' },
        escalation: {
          enabled: true,
          intermediateProvider: 'deepseek',
          intermediateModel: 'deepseek-chat',
        },
      }),
    });
    readyCrewTools();

    const ui = renderFeature(<CrewOverlay />, viewport);
    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    ui.unmount();

    expect(lines.length).toBeLessThanOrEqual(viewport.rows);
    expect(lines.join('\n')).toContain('REVIEW');
    expect(lines[lines.length - 1]).not.toMatch(/[A-Za-z]/);
  });

  it('keeps a long error to one line at 60x18 without clipping the frame', async () => {
    const viewport = { cols: 60, rows: 18 };
    terminalSizeStore.__testReset(viewport);
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex' },
        escalation: {
          enabled: true,
          intermediateProvider: 'deepseek',
          intermediateModel: 'deepseek-chat',
        },
      }),
    });
    readyCrewTools();
    feedbackStore.setError(
      'Failed to save config: EACCES permission denied while writing splitbrief.yaml in this project',
    );

    const ui = renderFeature(<CrewOverlay />, viewport);
    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '');
    ui.unmount();

    expect(lines.length).toBeLessThanOrEqual(viewport.rows);
    expect(lines[lines.length - 1]).not.toMatch(/[A-Za-z]/);
    expect(lines.filter((line) => line.includes('Failed to save config'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('splitbrief.yaml');
  });

  it('strips terminal control sequences from a save error', async () => {
    readyCrewTools();
    feedbackStore.setError(HOSTILE_ERROR);

    const ui = renderFeature(<CrewOverlay />);
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    ui.unmount();

    expect(frame).not.toContain(OSC_LEAD);
    expect(frame).not.toContain('pwned');
    expect(frame).toContain('Failed to save config');
  });
});
