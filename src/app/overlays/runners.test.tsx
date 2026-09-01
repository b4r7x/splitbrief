import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { loadConfig, writeConfig } from '../../core/config/load/io.js';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import type { Config } from '../../core/schemas/config.js';
import type { CliToolDetection } from '../../core/discovery/detection.js';
import type { ScopedCliCatalogAttempt } from '../../engine/detection/cli-catalog-outcomes.js';
import type { DetectionServiceResult } from '../../engine/detection/service.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { listRowLead } from '../../components/list-row.js';
import { glyph } from '../../lib/glyphs.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { hydrateDetectionIntoStores } from '../../stores/discovery/detection-adapter.js';
import { ToolModelPicker } from './runners.js';

// The merged row is expanded only while both of its route ids are on screen;
// collapsed it shows a route count instead.
const showsBothRoutes = (frame: string) =>
  frame.includes('openrouter') && frame.includes('anthropic');

const ESC = '\u001B';
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;

async function openContractChoice(ui: ReturnType<typeof renderFeature>) {
  await vi.waitFor(() => {
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Run your own command in the planner seat.');
    expect(frame).toContain('Nothing is saved until you confirm');
  });
  await flushEffects();
  ui.stdin.write('\r'); // Enter on the launcher opens the contract choice
  // The launcher card names both contracts too, so only the chooser's own
  // ledger clauses tell the two views apart.
  await vi.waitFor(() => {
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain("read from the command's stdout");
    expect(frame).toContain('written directly to your tree');
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
      expect(frame).toContain("read from the command's stdout"); // back on the contract chooser
      expect(frame).toContain('written directly to your tree');
    });

    await flushEffects();
    ui.stdin.write(ESC); // one more step back reaches the tool list
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain("read from the command's stdout");
      expect(frame).toContain('Tools'); // back on the two-column picker view
      expect(frame).toContain('Claude Code CLI'); // the tool rows are listed again
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
    const projectDir = createTempDir('runners-agent-contract');
    writeConfig(projectDir, makeConfig({ planner: { kind: 'shell', command: 'custom-planner' } }));
    configStore.load(projectDir);
    const ui = renderFeature(<ToolModelPicker role="planner" />);
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
      expect(loadConfig(projectDir).config.planner).toMatchObject({
        kind: 'agent',
        command: 'custom-planner',
      });
    });
    ui.unmount();
    cleanupTempDir(projectDir);
  });

  it('returns to the tool list when the contract choice is dismissed', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);
    await openContractChoice(ui);

    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain("read from the command's stdout");
      expect(frame).toContain('Tools');
      expect(frame).toContain('Claude Code CLI');
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
      expect(frame).toContain("read from the command's stdout");
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

const CHECK = glyph('check', 'unicode');

/** The model rows live in the panel cell the Models header opens. */
function modelColumnLines(frame: string): string[] {
  const cellRows = frame.split('\n').map((line) => line.split('│'));
  const column = cellRows
    .find((cells) => cells.some((cell) => cell.trim() === 'Models'))
    ?.findIndex((cell) => cell.trim() === 'Models');
  if (column === undefined || column < 0) return [];
  return cellRows
    .map((cells) => cells[column] ?? '')
    .filter((cell) => cell.trimStart().startsWith('· '));
}

function checkedModelLines(frame: string): string[] {
  return modelColumnLines(frame).filter((line) => line.includes(CHECK));
}

describe('ToolModelPicker provider routes', () => {
  let projectDir: string;
  let initialPlanner: Config['planner'];

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    projectDir = createTempDir('runners-provider-routes');
    writeConfig(projectDir, createDefaultConfig());
    configStore.load(projectDir);
    initialPlanner = loadConfig(projectDir).config.planner;
    overlayStore.open('planner-picker');
  });

  // The models lane publishes an empty tool list, so the detected tool has to be
  // re-stated after it; seeding in the other order leaves OpenCode undetected.
  function seedOpenCode(providerAuth: CliToolDetection['providerAuth']) {
    publishOpenCodePlannerModels([
      'openrouter/deepseek-v4-flash',
      'anthropic/deepseek-v4-flash',
      'openrouter/deepseek-v4-flash-free',
    ]);
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'opencode', { providerAuth })],
    });
  }

  const signedInToAnthropic = {
    kind: 'read',
    facts: [{ provider: 'Anthropic', source: 'oauth' }],
  } as const;

  // Signed in, but to neither of the merged row's two routes.
  const signedInToGroq = { kind: 'read', facts: [{ provider: 'Groq', source: 'api' }] } as const;

  afterEach(() => {
    configStore.__testReset();
    cleanupTempDir(projectDir);
  });

  async function focusMergedModelRow(ui: ReturnType<typeof renderFeature>) {
    await flushEffects();
    ui.stdin.write('opencode'); // narrow the tool list to OpenCode
    await flushEffects();
    ui.stdin.write('\r'); // select the tool and focus the model column
    await flushEffects();
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain('DeepSeek V4 Flash');
    });
    // Auto is focused first; one down is the merged DeepSeek row. Filtering
    // there instead would hide the route rows the expansion has to reveal.
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(frame).toContain(`${listRowLead('active')}DeepSeek V4 Flash`);
      expect(frame).not.toContain(`${listRowLead('active')}DeepSeek V4 Flash Free`);
    });
    await flushEffects();
  }

  it('confirms the one signed-in route without expanding the merged row', async () => {
    seedOpenCode(signedInToAnthropic);
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await focusMergedModelRow(ui);

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(loadConfig(projectDir).config.planner).toMatchObject({
        kind: 'cli',
        tool: 'opencode',
        model: 'anthropic/deepseek-v4-flash',
      });
    });
    expect(ui.frames.map(stripAnsiStyles).some(showsBothRoutes)).toBe(false);
    ui.unmount();
  });

  it('expands to the route rows when neither route is signed in, then saves the chosen one', async () => {
    seedOpenCode(signedInToGroq);
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await focusMergedModelRow(ui);

    ui.stdin.write('\r'); // Enter on the merged row expands its routes
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(frame).toContain('openrouter');
      expect(frame).toContain('anthropic');
    });
    // Expanding saved nothing yet.
    expect(loadConfig(projectDir).config.planner).toEqual(initialPlanner);

    await flushEffects();
    ui.stdin.write('\r'); // confirm the focused route
    await vi.waitFor(() => {
      const planner = loadConfig(projectDir).config.planner;
      expect(planner).toMatchObject({ kind: 'cli', tool: 'opencode' });
      expect(planner.model).toMatch(/^(?:openrouter|anthropic)\/deepseek-v4-flash$/);
    });
    ui.unmount();
  });

  it('esc collapses the expanded routes with nothing saved', async () => {
    seedOpenCode(signedInToGroq);
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await focusMergedModelRow(ui);

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(showsBothRoutes(frameText(ui))).toBe(true);
    });

    await flushEffects();
    ui.stdin.write(ESC);
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(showsBothRoutes(frame)).toBe(false);
      expect(frame).toContain('Tools');
      expect(frame).toContain('Models');
    });
    expect(loadConfig(projectDir).config.planner).toEqual(initialPlanner);
    ui.unmount();
  });

  it('saves a single-route model directly without expanding', async () => {
    seedOpenCode(signedInToAnthropic);
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
    expect(ui.frames.map(stripAnsiStyles).some(showsBothRoutes)).toBe(false);
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
    expect(frameText(ui)).toContain('Waking your crew…');
    expect(frameText(ui)).not.toContain('Tools');

    publishOpenCodePlannerModels(['openrouter/deepseek-v4-flash']);
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(frame).not.toContain('Waking your crew…');
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
    expect(frame).toContain('refreshing…');
    expect(frame).toContain('Tools');
    expect(frame).not.toContain('Waking your crew…');
    ui.unmount();
  });

  it('replaces the stale rows of a hydrated foreign-context snapshot when the live lanes land', async () => {
    forceUnicodeGlyphs();
    const configB = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-6-codex' },
    });
    configStore.__testReset({ projectDir: '/tmp/project', config: configB });

    // Startup hydrates and refreshes under one set of contexts — the ones
    // derived from the config now loaded — while the record on disk was
    // written under another config's context and carries that run's
    // generation.
    const currentContexts = {
      readiness: 'config-b-readiness',
      modelsDev: 'config-b-models-dev',
      cliModels: 'config-b-cli-models',
    };
    const tools = [cliDetectionFor('ready', 'codex'), cliDetectionFor('ready', 'opencode')];

    hydrateDetectionIntoStores({
      detection: detectionStore,
      contexts: currentContexts,
      foreignContext: true,
      snapshot: {
        contextKey: 'config-a-readiness',
        fetchedAt: 100,
        validatedAt: 100,
        generation: 3,
        requestId: 3,
        providers: [],
        cliTools: tools,
        cliCatalogs: [
          { role: 'planner', tool: 'codex', models: [{ id: 'gpt-5-codex' }], probedAt: 100 },
        ],
      },
    });

    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);

    // Warm start: the foreign record's rows are on screen, marked stale.
    const frameBefore = frameText(ui);
    expect(frameBefore).not.toContain('Waking your crew…');
    expect(frameBefore).toContain('Tools');
    expect(frameBefore).toContain('Codex CLI');
    expect(frameBefore).toContain('OpenCode CLI');
    expect(frameBefore).toContain('GPT-5 Codex');

    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await flushEffects();

    await vi.waitFor(() => {
      expect(frameText(ui)).toContain(`${listRowLead('active')}OpenCode CLI`);
    });

    const request = detectionStore.beginRefresh({ contexts: currentContexts });
    await flushEffects();
    await tick(20);

    const frameDuring = frameText(ui);
    expect(frameDuring).not.toContain('Waking your crew…');
    expect(frameDuring).toContain('refreshing…');
    expect(frameDuring).toContain(`${listRowLead('active')}OpenCode CLI`);

    const freshAttempts: ScopedCliCatalogAttempt[] = [
      {
        connection: { role: 'planner', tool: 'codex', contextKey: 'config-b-codex' },
        outcome: { kind: 'success', value: [{ id: 'gpt-6-codex' }] },
      },
    ];
    // A fresh process counts its own lanes from 1 — below the generation the
    // remembered record was written under.
    const freshResult: DetectionServiceResult = {
      providers: [],
      cliTools: tools,
      catalog: null,
      cliModels: freshAttempts,
      generation: 1,
      outcomes: {
        readiness: {
          kind: 'fresh',
          origin: 'request',
          snapshot: {
            source: 'readiness',
            contextKey: currentContexts.readiness,
            generation: 1,
            requestId: 1,
            fetchedAt: 200,
            validatedAt: 200,
            stale: false,
            value: { providers: [], cliTools: tools },
          },
        },
        modelsDev: {
          kind: 'not-run',
          source: 'models-dev',
          contextKey: currentContexts.modelsDev,
          reason: 'uninitialized',
        },
        cliModels: {
          kind: 'fresh',
          origin: 'request',
          snapshot: {
            source: 'cli-models',
            contextKey: currentContexts.cliModels,
            generation: 1,
            requestId: 1,
            fetchedAt: 200,
            validatedAt: 200,
            stale: false,
            value: freshAttempts,
          },
        },
      },
    };
    expect(detectionStore.publish({ result: freshResult, request })).toBe(true);

    await vi.waitFor(() => {
      const frameAfter = frameText(ui);
      expect(frameAfter).not.toContain('Waking your crew…');
      expect(frameAfter).not.toContain('refreshing…');
      // The cursor never moved and the picker never remounted.
      expect(frameAfter).toContain(`${listRowLead('active')}OpenCode CLI`);
    });

    // Back on the browsed tool, the landed lane has replaced its stale models.
    await flushEffects();
    ui.stdin.write(ARROW_UP);
    await vi.waitFor(() => {
      const frameAfter = frameText(ui);
      expect(frameAfter).toContain(`${listRowLead('active')}OpenAI Codex CLI`);
      expect(frameAfter).toContain('GPT-6 Codex');
      expect(frameAfter).not.toContain('GPT-5 Codex');
    });

    ui.unmount();
  });
});

describe('ToolModelPicker model catalog', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } }),
    });
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
    });
  });

  it('enriches the configured Claude Code alias when the models.dev lane lands, without adding catalog rows', async () => {
    const ui = renderFeature(<ToolModelPicker role="planner" />);
    await tick(20);

    const before = checkedModelLines(frameText(ui));
    expect(before).toHaveLength(1);
    expect(before.join('')).toContain('Opus');
    const aliasRowCount = modelColumnLines(frameText(ui)).length;

    modelCacheStore.hydrateModelsDevCatalog({
      catalog: {
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5' },
            'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
          },
        },
      },
      fetchedAt: 100,
      validatedAt: 100,
    });

    // The alias is the row; models.dev only tells it what it is called.
    await vi.waitFor(() => {
      expect(checkedModelLines(frameText(ui)).join('')).toContain('Claude Opus 5');
    });

    const after = checkedModelLines(frameText(ui));
    expect(after).toHaveLength(1);
    expect(modelColumnLines(frameText(ui))).toHaveLength(aliasRowCount);
    ui.unmount();
  });
});
