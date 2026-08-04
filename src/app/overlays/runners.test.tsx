import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig, loadConfig, writeConfig } from '../../core/config/load/io.js';
import type { Config } from '../../core/schemas/config.js';
import type { ScopedCliCatalogAttempt } from '../../engine/detection/cli-catalog-outcomes.js';
import type { DetectionServiceResult } from '../../engine/detection/service.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { ToolModelPicker } from './runners.js';

const ESC = '\u001B';
const ARROW_DOWN = `${ESC}[B`;

async function openContractChoice(ui: ReturnType<typeof renderFeature>) {
  await vi.waitFor(() => {
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('run a custom planner command');
    expect(frame).toContain('saved only on final ⏎');
  });
  await flushEffects();
  ui.stdin.write('\r'); // Enter on the launcher opens the contract choice
  await vi.waitFor(() => {
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Output command');
    expect(frame).toContain('Direct-write agent');
  });
}

async function openCustomCommand(ui: ReturnType<typeof renderFeature>) {
  await openContractChoice(ui);
  await flushEffects();
  ui.stdin.write('\r'); // confirm the preselected contract
  await vi.waitFor(() => {
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Command to run');
    expect(frame).toContain('esc back to contract');
  });
}

describe('ToolModelPicker custom-command input', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'shell', command: 'custom-planner' } }),
    });
  });

  it('keeps the text input on Escape under a foreign overlay, then walks back one step', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    await openCustomCommand(ui);

    overlayStore.open('command-palette');
    await flushEffects();

    ui.stdin.write(ESC); // ignored while the palette is on top
    await tick(20);
    expect(ui.lastFrame()).toContain('Command to run'); // still in the text-input view

    overlayStore.close();
    await flushEffects();

    ui.stdin.write(ESC); // now reaches the picker and returns to the contract chooser
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('Command to run'); // left the text-input view
      expect(frame).toContain('Output command'); // back on the contract chooser
      expect(frame).toContain('Direct-write agent');
    });

    await flushEffects();
    ui.stdin.write(ESC); // one more step back reaches the tool list
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('Output command');
      expect(frame).toContain('Tools'); // back on the two-column picker view
      expect(frame).toContain('Models');
    });
    ui.unmount();
  });

  it('shows both contracts with distinct permission copy before the command input', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    await openContractChoice(ui);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Output command');
    expect(frame).toContain("read from the command's stdout");
    expect(frame).toContain('no direct writes');
    expect(frame).toContain('Direct-write agent');
    expect(frame).toContain('the files it writes, not stdout');
    expect(frame).toContain('written directly to your tree');
    ui.unmount();
  });

  it('saves the chosen direct-write contract as an agent command', async () => {
    let saved: Config | undefined;
    const ui = renderFeature(
      <ToolModelPicker
        role="planner"
        onConfirm={(updated) => {
          saved = updated;
        }}
      />,
    );
    await tick(20);
    await openContractChoice(ui);

    await flushEffects();
    ui.stdin.write(ARROW_DOWN); // move from the shell contract to the agent contract
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(ui.lastFrame() ?? '').toContain('Command to run');
    });
    await flushEffects();
    ui.stdin.write('\r'); // submit the prefilled configured command
    await vi.waitFor(() => {
      expect(saved?.planner).toMatchObject({ kind: 'agent', command: 'custom-planner' });
    });
    ui.unmount();
  });

  it('returns to the tool list when the contract choice is dismissed', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    await openContractChoice(ui);

    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('Output command');
      expect(frame).toContain('Tools');
      expect(frame).toContain('Models');
    });
    ui.unmount();
  });

  it('preserves the typed draft when stepping back to the contract chooser and forward again', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    await openCustomCommand(ui);

    for (const ch of 'zz') {
      await flushEffects();
      ui.stdin.write(ch);
      await flushEffects();
    }

    await flushEffects();
    ui.stdin.write(ESC); // back one step to the chooser
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('Command to run');
      expect(frame).toContain('Output command');
    });

    await flushEffects();
    ui.stdin.write('\r'); // forward again to the command step
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Command to run');
      expect(frame).toContain('zz'); // the draft survived the round trip
    });
    ui.unmount();
  });
});

const catalogContexts = {
  readiness: 'runners-readiness',
  modelsDev: 'runners-models-dev',
  cliModels: 'runners-cli-models',
};

function publishOpenCodePlannerModels(models: readonly string[]): void {
  const attempts: ScopedCliCatalogAttempt[] = [
    {
      connection: { role: 'planner', tool: 'opencode', contextKey: 'planner-opencode-context' },
      outcome: { kind: 'success', value: models.map((id) => ({ id })) },
    },
  ];
  const request = detectionStore.beginRefresh({ contexts: catalogContexts });
  const result: DetectionServiceResult = {
    providers: [],
    cliTools: [],
    catalog: null,
    cliModels: attempts,
    generation: 1,
    outcomes: {
      readiness: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'readiness',
          contextKey: catalogContexts.readiness,
          generation: 1,
          requestId: 1,
          fetchedAt: 100,
          validatedAt: 100,
          stale: false,
          value: { providers: [], cliTools: [] },
        },
      },
      modelsDev: {
        kind: 'not-run',
        source: 'models-dev',
        contextKey: catalogContexts.modelsDev,
        reason: 'uninitialized',
      },
      cliModels: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'cli-models',
          contextKey: catalogContexts.cliModels,
          generation: 1,
          requestId: 1,
          fetchedAt: 100,
          validatedAt: 100,
          stale: false,
          value: attempts,
        },
      },
    },
  };
  expect(detectionStore.publish({ result, request })).toBe(true);
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

describe('ToolModelPicker provider choice', () => {
  let projectDir: string;
  let initialPlanner: Config['planner'];

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    projectDir = createTempDir('runners-provider-choice');
    writeConfig(projectDir, createDefaultConfig());
    configStore.load(projectDir);
    initialPlanner = loadConfig(projectDir).config.planner;
    publishOpenCodePlannerModels([
      'openrouter/deepseek-v4-flash',
      'anthropic/deepseek-v4-flash',
      'openrouter/deepseek-v4-flash-free',
    ]);
    detectionStore.setDetection({
      providers: [],
      cliTools: [
        cliDetectionFor('ready', 'opencode', {
          providerAuth: [{ provider: 'Anthropic', source: 'oauth' }],
        }),
      ],
    });
    overlayStore.open('planner-picker');
  });

  afterEach(() => {
    configStore.__testReset();
    cleanupTempDir(projectDir);
  });

  async function openProviderChoice(ui: ReturnType<typeof renderFeature>) {
    await flushEffects();
    ui.stdin.write('opencode'); // narrow the tool list to OpenCode
    await flushEffects();
    ui.stdin.write('\r'); // select the tool and focus the model column
    await flushEffects();
    ui.stdin.write('deepseek'); // narrow to the colliding bare id
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain('DeepSeek V4 Flash');
    });
    await flushEffects();
    ui.stdin.write('\r'); // Enter on the merged row opens the provider choice
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(frame).toContain('⏎ choose');
      expect(frame).toContain('openrouter');
      expect(frame).toContain('anthropic');
    });
  }

  it('opens the provider choice on a multi-provider row and saves the qualified id', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await openProviderChoice(ui);

    // Opening the choice saved nothing yet.
    expect(loadConfig(projectDir).config.planner).toEqual(initialPlanner);

    await flushEffects();
    ui.stdin.write('\r'); // choose the focused provider through the existing save path
    await vi.waitFor(() => {
      const planner = loadConfig(projectDir).config.planner;
      expect(planner).toMatchObject({ kind: 'cli', tool: 'opencode' });
      expect(planner.model).toMatch(/^(?:openrouter|anthropic)\/deepseek-v4-flash$/);
    });
    ui.unmount();
  });

  it('esc returns to the model list with nothing saved', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await openProviderChoice(ui);

    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(frame).not.toContain('⏎ choose');
      expect(frame).toContain('Tools');
      expect(frame).toContain('Models');
    });
    expect(loadConfig(projectDir).config.planner).toEqual(initialPlanner);
    ui.unmount();
  });

  it('saves a single-provider model directly without the overlay', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await flushEffects();
    ui.stdin.write('opencode');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('free'); // narrow to the single-provider free variant
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain('DeepSeek V4 Flash Free');
    });
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(loadConfig(projectDir).config.planner).toMatchObject({
        kind: 'cli',
        tool: 'opencode',
        model: 'openrouter/deepseek-v4-flash-free',
      });
    });
    expect(ui.frames.some((frame) => frame.includes('⏎ choose'))).toBe(false);
    ui.unmount();
  });
});

describe('ToolModelPicker discovery state', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
  });

  it('shows the initializing panel during cold discovery and reveals the picker on publish', async () => {
    detectionStore.beginRefresh({ contexts: catalogContexts });
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    expect(frameText(ui)).toContain('Initializing your tools…');
    expect(frameText(ui)).not.toContain('Tools');

    publishOpenCodePlannerModels(['openrouter/deepseek-v4-flash']);
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(frame).not.toContain('Initializing your tools…');
      expect(frame).toContain('Tools');
      expect(frame).toContain('Models');
    });
    ui.unmount();
  });

  it('labels the picker as refreshing during a warm background refresh', async () => {
    publishOpenCodePlannerModels(['openrouter/deepseek-v4-flash']);
    detectionStore.beginRefresh({ contexts: catalogContexts });
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    const frame = frameText(ui);
    expect(frame).toContain('Refreshing your tools…');
    expect(frame).toContain('Tools');
    expect(frame).not.toContain('Initializing your tools…');
    ui.unmount();
  });
});
