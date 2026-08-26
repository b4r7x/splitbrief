import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Text, useInput } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { pickerCatalog, realPickerOption } from '#testing/helpers/runner-picker.js';
import { createDefaultConfig, writeConfig } from '../../core/config/load/io.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { API_PROVIDER_CATALOG } from '../../core/providers/api-provider-catalog.js';
import { glyph } from '../../lib/glyphs.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { RunnerPickerOption } from './model-catalog/options.js';
import { ProviderAuthOverlay } from './provider-auth-overlay.js';
import { failureCopy, type ProviderKeyValidation } from './provider-auth.js';
import { usePickerActions, type PickerActionDeps } from './use-picker-actions.js';
import type { PickerCatalog } from './use-picker-catalog.js';

const KEY = 'sk-test-秘密のキー-ключ-🔑-0123456789abcdef';

function minimalCatalog(item: RunnerPickerOption): PickerCatalog {
  return pickerCatalog({
    items: [item],
    rightModels: [],
    currentItem: item,
    selectedItemId: item.id,
    initialLeftIdx: 0,
    focusModels: false,
    roleLabel: 'Planner',
    currentModel: undefined,
    persistedModel: undefined,
    modelCounts: { confirmed: 0, stale: 0, suggestions: 0, bundled: 0, custom: 0 },
    catalogDiagnostic: undefined,
    currentCommand: undefined,
    currentCommandKind: undefined,
    customModels: [],
    discovery: { cold: false, refreshing: false },
    setCurrentItem: () => {},
  });
}

function AuthHarness({
  item,
  deps,
}: {
  item: RunnerPickerOption;
  deps: Partial<PickerActionDeps>;
}) {
  const view = pickerViewStore.use((s) => s.view);
  const actions = usePickerActions({ role: 'planner', catalog: minimalCatalog(item), deps });
  useInput(
    (_input, key) => {
      if (key.escape) actions.closeOverlay();
    },
    { isActive: view.kind === 'provider-auth' },
  );
  if (view.kind !== 'provider-auth') return <Text>picker-view</Text>;
  return (
    <ProviderAuthOverlay
      role="planner"
      item={item}
      onSubmit={(value) => void actions.submitProviderKey(value)}
    />
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await tick(10);
  }
}

describe('ProviderAuthOverlay', () => {
  let projectDir: string;
  const item = realPickerOption('planner', 'openai');
  const configPath = () => join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    projectDir = createTempDir('provider-auth-overlay');
    writeConfig(projectDir, createDefaultConfig());
    configStore.load(projectDir);
    pickerViewStore.open({ kind: 'provider-auth' }, 0);
  });

  afterEach(() => {
    configStore.__testReset();
    cleanupTempDir(projectDir);
  });

  it('renders mask glyphs for a long multi-byte paste and never shows the raw key', async () => {
    const ui = renderFeature(
      <ProviderAuthOverlay role="planner" item={item} onSubmit={() => {}} />,
    );
    await flushEffects();

    ui.stdin.write(KEY);
    await flushEffects();

    const dot = glyph('stageDone');
    expect(ui.lastFrame()).toContain(dot.repeat(5));
    for (const frame of ui.frames) {
      expect(frame).not.toContain(KEY);
      expect(frame).not.toContain('秘密のキー');
    }
    expect(ui.lastFrame()).toContain('OpenAI API key');
    ui.unmount();
  });

  it('leads the hint with its keys at the 60-column floor', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const ui = renderFeature(
      <ProviderAuthOverlay role="planner" item={item} onSubmit={() => {}} />,
      {
        cols: 60,
        rows: 18,
      },
    );
    await flushEffects();

    const hintRow = ui
      .lastFrame()
      .split('\n')
      .find((row) => row.includes('validate & save'));
    expect(hintRow?.replace(/^[│\s]+/, '').startsWith('⏎')).toBe(true);
    expect(hintRow).toContain('esc');
    ui.unmount();
  });

  it('persists nothing on esc: the config file stays byte-identical', async () => {
    const before = readFileSync(configPath());
    let validateCalls = 0;
    const deps: Partial<PickerActionDeps> = {
      validateKey: async () => {
        validateCalls += 1;
        return { kind: 'valid', models: [] };
      },
    };
    const ui = renderFeature(<AuthHarness item={item} deps={deps} />);
    await flushEffects();

    ui.stdin.write('sk-typed-then-abandoned');
    await flushEffects();
    ui.stdin.write('\u001B');
    await flushEffects();

    expect(ui.lastFrame()).toContain('picker-view');
    expect(validateCalls).toBe(0);
    expect(Buffer.compare(before, readFileSync(configPath()))).toBe(0);
    ui.unmount();
  });

  it('validates before persisting, then saves a 0600 config that stores the key and selects the runner', async () => {
    let refreshCalls = 0;
    const deps: Partial<PickerActionDeps> = {
      validateKey: async (): Promise<ProviderKeyValidation> => ({
        kind: 'valid',
        models: [{ id: 'gpt-5-mini' }],
      }),
      refreshDetection: async () => {
        refreshCalls += 1;
      },
    };
    const ui = renderFeature(<AuthHarness item={item} deps={deps} />);
    await flushEffects();

    ui.stdin.write(KEY);
    await flushEffects();
    ui.stdin.write('\r');
    await waitFor(() => feedbackStore.get().message?.includes('key saved') ?? false);

    const feedback = feedbackStore.get().message ?? '';
    expect(feedback).toContain('Planner set to: OpenAI');
    expect(feedback).toContain(`key saved to ${SPLITBRIEF_DIR}/${CONFIG_FILE}`);
    expect(feedback).not.toContain('warning');
    expect(feedback).not.toContain(KEY);

    const raw = readFileSync(configPath(), 'utf8');
    expect(raw).toContain(KEY);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(configStore.get().config?.planner).toMatchObject({
      kind: 'api',
      provider: 'openai',
      apiKey: KEY,
    });
    expect(refreshCalls).toBe(1);
    for (const frame of ui.frames) {
      expect(frame).not.toContain(KEY);
    }
    ui.unmount();
  });

  it('warns in the feedback line when the first key save finds .gitignore not covering .splitbrief/', async () => {
    writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n');
    const deps: Partial<PickerActionDeps> = {
      validateKey: async (): Promise<ProviderKeyValidation> => ({ kind: 'valid', models: [] }),
      refreshDetection: async () => {},
    };
    const ui = renderFeature(<AuthHarness item={item} deps={deps} />);
    await flushEffects();

    ui.stdin.write(KEY);
    await flushEffects();
    ui.stdin.write('\r');
    await waitFor(() => feedbackStore.get().message?.includes('key saved') ?? false);

    expect(feedbackStore.get().message).toContain(
      `warning: .gitignore did not cover ${SPLITBRIEF_DIR}/`,
    );
    ui.unmount();
  });

  it('keeps the overlay open and the config untouched when the provider rejects the key', async () => {
    const before = readFileSync(configPath());
    const deps: Partial<PickerActionDeps> = {
      validateKey: async (): Promise<ProviderKeyValidation> => ({
        kind: 'invalid',
        failure: 'invalid-credential',
      }),
    };
    const ui = renderFeature(<AuthHarness item={item} deps={deps} />);
    await flushEffects();

    ui.stdin.write(KEY);
    await flushEffects();
    ui.stdin.write('\r');
    await waitFor(() => feedbackStore.get().isError);

    expect(feedbackStore.get().message).toBe(
      failureCopy('invalid-credential', API_PROVIDER_CATALOG.openai),
    );
    expect(feedbackStore.get().message).not.toContain(KEY);
    expect(Buffer.compare(before, readFileSync(configPath()))).toBe(0);
    expect(ui.lastFrame()).toContain('OpenAI API key');
    for (const frame of ui.frames) {
      expect(frame).not.toContain(KEY);
    }
    ui.unmount();
  });
});
