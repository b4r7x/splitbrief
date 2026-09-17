import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { ToolModelPicker } from '../../app/overlays/runners.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import type { ProviderCatalogOutcome } from '../../engine/providers/types.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import {
  LocalConnectionForm,
  localConnectionModelRows,
  localConnectionProvider,
  type LocalConnectionProbe,
  type LocalConnectionProbeInput,
  type LocalConnectionSave,
} from './local-connection-form.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';

const CTRL_U = '\x15';
const DOWN = '\u001b[B';
const ESC = '\u001b';
const ENTER = '\r';

const OLLAMA_DEFAULT = 'http://localhost:11434/v1';
const SECOND_SERVER = 'http://localhost:11435/v1';
const SEAT_MODEL = 'qwen2.5-coder:7b';

function listing(models: readonly DetectedModel[]): ProviderCatalogOutcome {
  return {
    kind: 'success',
    source: 'provider-runtime',
    provider: 'ollama',
    isLocal: true,
    credential: 'not-required',
    catalog: models.length === 0 ? 'empty' : 'populated',
    models,
  };
}

function refusal(
  failure: 'offline' | 'invalid-credential' | 'malformed',
  diagnostic: string,
): ProviderCatalogOutcome {
  return {
    kind: 'failed',
    source: 'provider-runtime',
    provider: 'ollama',
    isLocal: true,
    credential: 'not-required',
    failure,
    diagnostic,
  };
}

function plannerOnOllama() {
  return makeConfig({
    planner: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: OLLAMA_DEFAULT,
      model: 'qwen2.5-coder:7b',
    },
  });
}

/**
 * Types a whole value into the focused field. `MultilineInput` suppresses input for
 * 50ms after a line kill (the multi-byte guard), so the value follows the wait.
 */
async function retype(ui: { stdin: { write: (data: string) => void } }, value: string) {
  ui.stdin.write(CTRL_U);
  await flushEffects();
  await tick(60);
  ui.stdin.write(value);
  await flushEffects();
}

describe('localConnectionProvider', () => {
  it('opens the form for a local server the picker cannot list, and for nothing else', () => {
    const offline = { ...realPickerOption('planner', 'ollama'), available: false };
    expect(localConnectionProvider(offline)).toBe('ollama');
    expect(localConnectionProvider({ ...offline, available: true })).toBeUndefined();
    expect(
      localConnectionProvider({ ...realPickerOption('planner', 'codex'), available: false }),
    ).toBeUndefined();
  });
});

describe('localConnectionModelRows', () => {
  it('keeps a configured model the catalog does not carry instead of taking the first one', () => {
    const rows = localConnectionModelRows({
      seatModel: 'qwen2.5-coder:7b',
      catalog: [{ id: 'gemma3:27b' }, { id: 'deepseek-coder-v2:16b' }],
      probed: true,
    });

    expect(rows.map((row) => row.id)).toEqual([
      'qwen2.5-coder:7b',
      'gemma3:27b',
      'deepseek-coder-v2:16b',
    ]);
    expect(rows[0]?.state).toBe('not in this catalog');
  });

  it('separates the exact id from the label and states what the server said about loading', () => {
    const rows = localConnectionModelRows({
      seatModel: undefined,
      catalog: [
        {
          id: 'qwen/qwen3-coder-30b',
          displayName: 'Qwen3 Coder 30B',
          runtime: { loadState: 'loaded', observedAt: 1 },
        },
        { id: 'mistral:7b', runtime: { loadState: 'not-loaded', observedAt: 1 } },
        { id: 'gpt-oss-20b-mxfp4' },
      ],
      probed: true,
    });

    expect(rows[0]).toEqual({
      id: 'qwen/qwen3-coder-30b',
      label: 'Qwen3 Coder 30B',
      state: 'loaded',
    });
    expect(rows[1]?.state).toBe('not loaded');
    // No runtime record is an absent answer, so the row claims availability and no more.
    expect(rows[2]?.state).toBe('listed');
  });

  it('calls an unproven selection unknown after a failed check and not-checked before one', () => {
    const before = localConnectionModelRows({
      seatModel: 'qwen2.5-coder:7b',
      catalog: undefined,
      probed: false,
    });
    const after = localConnectionModelRows({
      seatModel: 'qwen2.5-coder:7b',
      catalog: undefined,
      probed: true,
    });

    expect(before[0]?.state).toBe('not checked');
    expect(after[0]?.state).toBe('unknown');
  });
});

describe('LocalConnectionForm', () => {
  let projectDir = '';

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'local-connection-test-'));
    configStore.__testReset({ projectDir, config: plannerOnOllama() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    feedbackStore.reset();
    pickerViewStore.reset();
    terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function openPicker() {
    overlayStore.open('planner-picker', 'tool:ollama');
    pickerViewStore.open({ kind: 'local-connection', provider: 'ollama' });
    return renderFeature(<ToolModelPicker role="planner" />, { cols: 100, rows: 30 });
  }

  /** The form alone, on the seat's configured connection, with a probe the test owns. */
  function openForm(
    check: LocalConnectionProbe,
    options?: { model?: string; onSave?: (input: LocalConnectionSave) => void },
  ) {
    return renderFeature(
      <LocalConnectionForm
        role="planner"
        provider="ollama"
        seat={{
          apiBase: OLLAMA_DEFAULT,
          ...(options?.model === undefined ? {} : { model: options.model }),
        }}
        check={check}
        onSave={options?.onSave ?? (() => {})}
      />,
    );
  }

  it('edits the address of an unreachable server and leaves the config alone when cancelled', async () => {
    const before = JSON.stringify(configStore.get().config);
    const ui = openPicker();
    await flushEffects();
    expect(ui.lastFrame()).toContain(OLLAMA_DEFAULT);

    await retype(ui, SECOND_SERVER);
    expect(ui.lastFrame()).toContain(SECOND_SERVER);

    ui.stdin.write(ESC);
    await flushEffects();

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(pickerViewStore.get().view.kind).toBe('picker');
    ui.unmount();
  });

  it('persists a confirmed port on the chosen seat alone', async () => {
    const ui = openPicker();
    await flushEffects();

    await retype(ui, SECOND_SERVER);
    // Address → Token → Check → the seat's own model row.
    for (const key of [DOWN, DOWN, DOWN]) {
      ui.stdin.write(key);
      await flushEffects();
    }
    ui.stdin.write(ENTER);

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({
        kind: 'api',
        provider: 'ollama',
        apiBase: SECOND_SERVER,
        model: 'qwen2.5-coder:7b',
      });
    });
    expect(configStore.get().config?.reviewer).toBeUndefined();
    expect(configStore.get().config?.implementer).not.toMatchObject({ apiBase: SECOND_SERVER });
    ui.unmount();
  });

  it('invokes no probe, and no network, while editing and cancelling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const check = vi.fn<LocalConnectionProbe>(async () => listing([]));
    const ui = openForm(check, { model: SEAT_MODEL });
    await flushEffects();

    await retype(ui, SECOND_SERVER);
    ui.stdin.write(DOWN);
    await flushEffects();

    expect(check).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    ui.unmount();
  });

  it('asks the catalog for the drafted address and lists what it answered', async () => {
    const calls: LocalConnectionProbeInput[] = [];
    const check: LocalConnectionProbe = async (input) => {
      calls.push(input);
      return listing([{ id: 'gemma3:27b' }, { id: 'qwen2.5-coder:7b' }]);
    };
    const ui = openForm(check, { model: SEAT_MODEL });
    await flushEffects();

    await retype(ui, SECOND_SERVER);
    ui.stdin.write(ENTER);
    await flushEffects();
    await flushEffects();

    expect(calls).toEqual([{ provider: 'ollama', apiBase: SECOND_SERVER }]);
    const frame = ui.lastFrame();
    expect(frame).toContain('Ollama answered');
    expect(frame).toContain('gemma3:27b');
    ui.unmount();
  });

  it('reports an unreadable server response without blaming the address or asking to start it', async () => {
    const ui = openForm(async () => refusal('malformed', 'Expected a model list'), {
      model: SEAT_MODEL,
    });
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    await flushEffects();
    expect(ui.lastFrame()).toContain('Ollama returned an unreadable catalog');
    expect(ui.lastFrame()).toContain('Expected a model list');
    expect(ui.lastFrame()).not.toContain('does not accept this address');
    expect(ui.lastFrame()).not.toContain('ollama serve');
    ui.unmount();
  });

  it('drops a catalog when the address it came from is edited', async () => {
    const ui = openForm(async () => listing([{ id: 'gemma3:27b' }]), { model: SEAT_MODEL });
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    await flushEffects();
    expect(ui.lastFrame()).toContain('gemma3:27b');

    await retype(ui, SECOND_SERVER);

    expect(ui.lastFrame()).not.toContain('gemma3:27b');
    expect(ui.lastFrame()).toContain('Not checked yet');
    ui.unmount();
  });

  it('keeps the newest token check when the previous token answers later', async () => {
    overlayStore.open('planner-picker');
    const pending: Array<{
      input: LocalConnectionProbeInput;
      resolve: (outcome: ProviderCatalogOutcome) => void;
    }> = [];
    const ui = renderFeature(
      <LocalConnectionForm
        role="planner"
        provider="lm-studio"
        seat={{ apiBase: 'http://localhost:1234/v1', apiKey: 'env:TOKEN_A' }}
        check={(input) => new Promise((resolve) => pending.push({ input, resolve }))}
        onSave={() => {}}
      />,
    );
    try {
      await flushEffects();
      ui.stdin.write('\t');
      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();
      await retype(ui, 'env:TOKEN_B');
      ui.stdin.write(ENTER);
      await flushEffects();
      expect(pending.map((entry) => entry.input.apiKey)).toEqual(['env:TOKEN_A', 'env:TOKEN_B']);

      pending[0]?.resolve(listing([{ id: 'old-token-model' }]));
      await flushEffects();
      expect(ui.lastFrame()).not.toContain('old-token-model');
      pending[1]?.resolve(listing([{ id: 'new-token-model' }]));
      await flushEffects();
      expect(ui.lastFrame()).toContain('new-token-model');
      expect(ui.lastFrame()).not.toContain('old-token-model');
    } finally {
      ui.unmount();
    }
  });

  it('refuses an address outside the loopback policy without contacting anything', async () => {
    const check = vi.fn<LocalConnectionProbe>(async () => listing([]));
    const ui = openForm(check);
    await flushEffects();

    await retype(ui, 'http://10.0.0.7:11434/v1');
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(check).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('Address must be a loopback URL');
    ui.unmount();
  });

  it('refuses a token reference the profile policy does not allow, and saves nothing', async () => {
    const check = vi.fn<LocalConnectionProbe>(async () => listing([]));
    const saves: LocalConnectionSave[] = [];
    const ui = openForm(check, { model: SEAT_MODEL, onSave: (input) => saves.push(input) });
    await flushEffects();

    ui.stdin.write(DOWN);
    await flushEffects();
    await retype(ui, 'env:SOMEONES_CLOUD_KEY');
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(check).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('Ollama accepts only env:OLLAMA_LOCAL_API_KEY');

    // The same refusal stands on the model row, so a bad reference cannot be saved past it.
    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    expect(saves).toEqual([]);
    ui.unmount();
  });

  it('reports an unreachable server without asking for a credential', async () => {
    const ui = openForm(async () => refusal('offline', 'connect ECONNREFUSED 127.0.0.1:11434'), {
      model: SEAT_MODEL,
    });
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    await flushEffects();

    const frame = ui.lastFrame();
    expect(frame).toContain('Ollama is not reachable');
    expect(frame).toContain('Run `ollama serve`');
    expect(frame.toLowerCase()).not.toContain('sign in');
    expect(frame).toContain('unknown');
    ui.unmount();
  });

  it('names a rejected token only when the server rejected one', async () => {
    const ui = openForm(async () => refusal('invalid-credential', 'HTTP 401'), {
      model: SEAT_MODEL,
    });
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    await flushEffects();

    const frame = ui.lastFrame();
    expect(frame).toContain('Ollama rejected the token');
    expect(frame).toContain('HTTP 401');
    // The server answered, so the instruction for starting one stands down.
    expect(frame).not.toContain('Run `ollama serve`');
    ui.unmount();
  });
});
