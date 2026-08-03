import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig, loadConfig, writeConfig } from '../../core/config/load/io.js';
import type { ProviderDetection } from '../../core/discovery/detection.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { ToolModelPicker } from '../../app/overlays/runners.js';
import { failureCopy, validateProviderKey } from './provider-auth.js';

vi.mock('./provider-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider-auth.js')>();
  return { ...actual, validateProviderKey: vi.fn() };
});
vi.mock('../../engine/detection/store-publication.js', () => ({
  refreshDetectionForCurrentConfig: vi.fn(async () => ({})),
}));

const KEY = 'sk-test-secret-0123456789-abcdef';
const ENTER = '\r';
const ESC = '\u001B';

const validateKeyMock = vi.mocked(validateProviderKey);

function providerRow(
  provider: ProviderDetection['provider'],
  extra: Partial<ProviderDetection> = {},
): ProviderDetection {
  return { provider, available: false, isLocal: false, ...extra };
}

async function renderPlannerPicker() {
  overlayStore.open('planner-picker');
  const ui = renderFeature(<ToolModelPicker role="planner" />);
  await flushEffects();
  return ui;
}

async function type(ui: ReturnType<typeof renderFeature>, text: string) {
  await flushEffects();
  ui.stdin.write(text);
  await flushEffects();
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

describe('picker provider auth journey', () => {
  let projectDir: string;
  const configPath = () => join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    projectDir = createTempDir('picker-view-auth');
    writeConfig(projectDir, createDefaultConfig());
    configStore.load(projectDir);
    validateKeyMock.mockReset();
  });

  afterEach(() => {
    configStore.__testReset();
    cleanupTempDir(projectDir);
  });

  it('opens the add-key panel on Enter on an Auth required provider', async () => {
    detectionStore.setDetection({
      cliTools: [],
      providers: [providerRow('openai', { hasKey: false })],
    });
    const ui = await renderPlannerPicker();

    await type(ui, 'openai');
    const pickerFrame = frameText(ui);
    expect(pickerFrame).toContain('Auth required');
    expect(pickerFrame).toContain('⏎ add API key');

    await type(ui, ENTER);
    const panelFrame = frameText(ui);
    expect(panelFrame).toContain('Add API key');
    expect(panelFrame).toContain('OpenAI API key');
    expect(validateKeyMock).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('shows the enum failure copy and persists nothing when the provider rejects the key', async () => {
    validateKeyMock.mockResolvedValue({ kind: 'invalid', failure: 'invalid-credential' });
    detectionStore.setDetection({
      cliTools: [],
      providers: [providerRow('openai', { hasKey: false })],
    });
    const before = readFileSync(configPath());
    const ui = await renderPlannerPicker();

    await type(ui, 'openai');
    await type(ui, ENTER);
    await type(ui, KEY);
    await type(ui, ENTER);
    await vi.waitFor(() => {
      expect(feedbackStore.get().isError).toBe(true);
    });

    expect(feedbackStore.get().message).toBe(
      failureCopy('invalid-credential', API_PROVIDER_CATALOG.openai),
    );
    expect(Buffer.compare(before, readFileSync(configPath()))).toBe(0);
    expect(frameText(ui)).toContain('OpenAI API key');
    for (const frame of ui.frames) {
      expect(frame).not.toContain(KEY);
    }
    ui.unmount();
  });

  it('saves the validated key, selects the provider, and closes the picker', async () => {
    validateKeyMock.mockResolvedValue({ kind: 'valid', models: [{ id: 'gpt-5-mini' }] });
    detectionStore.setDetection({
      cliTools: [],
      providers: [providerRow('openai', { hasKey: false })],
    });
    const ui = await renderPlannerPicker();

    await type(ui, 'openai');
    await type(ui, ENTER);
    await type(ui, KEY);
    await type(ui, ENTER);
    await vi.waitFor(() => {
      expect(feedbackStore.get().message ?? '').toContain('key saved');
    });

    expect(feedbackStore.get().message).toContain('Planner set to: OpenAI');
    expect(loadConfig(projectDir).config.planner).toMatchObject({
      kind: 'api',
      provider: 'openai',
      apiKey: KEY,
    });
    expect(overlayStore.get().active).toBe('none');
    for (const frame of ui.frames) {
      expect(frame).not.toContain(KEY);
    }
    ui.unmount();
  });

  it('keeps Enter a no-op on disabled rows without an auth action', async () => {
    detectionStore.setDetection({
      cliTools: [],
      providers: [
        providerRow('deepseek', { hasKey: true, failure: 'invalid-credential' }),
        providerRow('ollama-cloud', { hasKey: false }),
      ],
    });
    const before = readFileSync(configPath());
    const ui = await renderPlannerPicker();

    for (const query of ['aider', 'deepseek', 'cloud']) {
      await type(ui, query);
      await type(ui, ENTER);
      const frame = frameText(ui);
      expect(frame).toContain('Tools');
      expect(frame).not.toContain('Add API key');
      expect(frame).not.toContain('Replace API key');
      expect(frame).not.toContain('⏎ replace key');
      await type(ui, ESC); // clears the filter, stays in the picker
    }

    expect(Buffer.compare(before, readFileSync(configPath()))).toBe(0);
    expect(overlayStore.get().active).toBe('planner-picker');
    ui.unmount();
  });

  it('renders a rejected env credential as Auth required with a replace-key affordance', async () => {
    detectionStore.setDetection({
      cliTools: [],
      providers: [providerRow('openai', { hasKey: true, failure: 'invalid-credential' })],
    });
    const ui = await renderPlannerPicker();

    await type(ui, 'openai');
    const frame = frameText(ui);
    const openaiLine =
      frame.split('\n').find((line) => line.includes('OpenAI') && !line.includes('Codex')) ?? '';
    expect(openaiLine).toContain('Auth required');
    expect(openaiLine).not.toContain('Unavailable');
    expect(frame).toContain('⏎ replace key');
    // The preview truncates right at panel width; the copy's head must survive.
    expect(frame).toContain('Key found in OPENAI_API_');

    await type(ui, ENTER);
    expect(frameText(ui)).toContain('Replace API key');
    ui.unmount();
  });
});
