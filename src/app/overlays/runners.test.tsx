import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { PINNED_CLAUDE_CODE_OPTIONS } from '#testing/helpers/factories/model-cache.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { loadConfig, writeConfig } from '../../core/config/load/io.js';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import type { Config } from '../../core/schemas/config.js';
import type { CliToolDetection } from '../../core/discovery/detection/tool.js';
import { deriveFallbackRows } from '../../core/crew/fallback.js';
import { deriveCrewRows } from '../../core/crew/rows.js';
import { crewActivate, fallbackActivate } from '../../features/crew/rows.js';
import {
  defaultPickerEffectDeps,
  type PickerEffectDeps,
} from '../../features/runners/picker/use-actions.js';
import type { ScopedCliCatalogAttempt } from '../../engine/detection/cli-catalog-outcomes.js';
import type {
  DetectionService,
  DetectionServiceResult,
} from '../../engine/detection/service/types.js';
import {
  detectionContextsForCurrentConfig,
  refreshDetectionForCurrentConfig,
} from '../../engine/detection/store-publication.js';
import type { DiscoveryRefreshSummary } from '../../core/runtime/commands/types.js';
import { refreshPickerDetection } from '../../features/runners/refresh-detection.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { type ConfigSaveResult, configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/discovery/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { listRowLead } from '../../components/list-row/lead.js';
import { glyph } from '../../lib/glyphs.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { hydrateDetectionIntoStores } from '../../stores/discovery/detection-adapter.js';
import { ToolModelPicker } from './runners.js';

// The merged row is expanded only while both of its route rows are on screen,
// each on its own branch; collapsed it shows the merged id and a route count.
const onARouteBranch = (frame: string, provider: string) =>
  frame.includes(`${glyph('treeBranch')}${glyph('divider')} ${provider}`) ||
  frame.includes(`${glyph('treeLast')}${glyph('divider')} ${provider}`);
const showsBothRoutes = (frame: string) =>
  onARouteBranch(frame, 'openrouter') && onARouteBranch(frame, 'anthropic');

const ESC = '\u001B';
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;
const ARROW_RIGHT = `${ESC}[C`;
const ARROW_LEFT = `${ESC}[D`;

const SAVED: ConfigSaveResult = {
  kind: 'saved',
  ok: true,
  revision: {
    rawSha256: 'runners-overlay-fixture',
    fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
  },
  ignoreRuleAdded: false,
};

/**
 * `resetAllStores()` drops the Claude option pin, and the reader memoises the operator's own
 * `~/.claude.json`, so every picker describe pins again right after the reset: no test in this
 * file reads the host's account cache, and the pinned rows are the rows the picker paints.
 */
function resetPickerStores(): void {
  resetAllStores();
  modelCacheStore.__testSetClaudeCodeModelOptions(PINNED_CLAUDE_CODE_OPTIONS);
}

const catalogContexts = {
  readiness: 'runners-readiness',
  modelsDev: 'runners-models-dev',
  cliModels: 'runners-cli-models',
};

function publishOpenCodePlannerModels(models: readonly string[]): void {
  const attempts: ScopedCliCatalogAttempt[] = [
    {
      connection: { tool: 'opencode', contextKey: 'planner-opencode-context' },
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

/**
 * The model rows live in the panel cell the Models header opens, under its filter (`›`) and
 * add-custom (`+`) rows.
 */
function modelColumnLines(frame: string): string[] {
  const cellRows = frame.split('\n').map((line) => line.split('│'));
  const header = cellRows.findIndex((cells) => cells.some((cell) => cell.trim() === 'Models'));
  if (header < 0) return [];
  const column = cellRows[header]?.findIndex((cell) => cell.trim() === 'Models') ?? -1;
  return cellRows
    .slice(header + 1)
    .map((cells) => cells[column] ?? '')
    .filter((cell) => cell.trim() !== '' && !/^\s*[›+]/u.test(cell));
}

function checkedModelLines(frame: string): string[] {
  return modelColumnLines(frame).filter((line) => line.includes(CHECK));
}

describe('ToolModelPicker focus changes', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig(),
    });
    detectionStore.setDetection({
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      providers: [],
    });
  });

  it('moves the mounted picker to a new tool and clears omitted focus without self-stacking', async () => {
    const request = detectionStore.beginRefresh({ contexts: catalogContexts });
    detectionStore.publish({
      request,
      result: {
        providers: [],
        cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
        catalog: null,
        cliModels: [
          {
            connection: { tool: 'codex', contextKey: catalogContexts.cliModels },
            outcome: { kind: 'success', value: [{ id: 'c4-codex-model' }] },
          },
        ],
        generation: 1,
      },
    });
    overlayStore.open('planner-picker', 'tool:claude-code');
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />, {
      cols: 120,
      rows: 40,
    });
    await flushEffects();
    expect(frameText(ui)).toContain(`${listRowLead('context')}Claude Code CLI`);
    expect(frameText(ui)).toContain('Sonnet 5');

    ui.stdin.write(ARROW_LEFT);
    await flushEffects();
    ui.stdin.write('Claude');
    await flushEffects();
    expect(frameText(ui)).toContain(`${listRowLead('active')}Claude Code CLI`);

    overlayStore.setExclusive(true);
    const before = overlayStore.get();
    overlayStore.open('planner-picker', 'tool:claude-code');
    await flushEffects();
    expect(overlayStore.get()).toBe(before);
    expect(frameText(ui)).toContain(`${listRowLead('active')}Claude Code CLI`);

    overlayStore.open('planner-picker', 'tool:codex');
    await flushEffects();
    expect(frameText(ui)).toContain(`${listRowLead('context')}OpenAI Codex CLI`);
    expect(frameText(ui)).not.toContain('Sonnet 5');
    expect(frameText(ui)).toContain('C4 Codex Model');
    expect(overlayStore.get()).toEqual({
      active: 'planner-picker',
      focus: 'tool:codex',
      exclusive: true,
      stack: [],
    });
    overlayStore.open('planner-picker');
    await flushEffects();
    expect(frameText(ui)).toContain(`${listRowLead('active')}Claude Code CLI`);
    expect(frameText(ui)).toContain('Sonnet 5');
    expect(frameText(ui)).not.toContain('C4 Codex Model');
    expect(overlayStore.get()).toEqual({
      active: 'planner-picker',
      focus: undefined,
      exclusive: true,
      stack: [],
    });

    ui.stdin.write(ESC);
    await flushEffects();
    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('moves an open picker from its tool cursor to the crew seat effort axis', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'high' },
    });
    configStore.__testReset({ config });
    overlayStore.open('planner-picker');
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />, {
      cols: 120,
      rows: 40,
    });
    await flushEffects();
    expect(frameText(ui)).toContain(`${listRowLead('active')}Claude Code CLI`);

    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');
    overlayStore.setExclusive(true);
    crewActivate({ target: { kind: 'crew', row: plan }, config });
    await flushEffects();

    expect(
      modelColumnLines(frameText(ui)).some(
        (line) => line.includes(glyph('liveBar')) && line.includes('effort'),
      ),
    ).toBe(true);
    expect(overlayStore.get()).toEqual({
      active: 'planner-picker',
      focus: 'seat:plan:effort',
      exclusive: true,
      stack: [],
    });
    ui.unmount();
  });
});

describe('ToolModelPicker provider routes', () => {
  let projectDir: string;
  let initialPlanner: Config['planner'];

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
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
  function seedOpenCode(
    providerAuth: CliToolDetection['providerAuth'],
    models: readonly string[] = [
      'openrouter/deepseek-v4-flash',
      'anthropic/deepseek-v4-flash',
      'openrouter/deepseek-v4-flash-free',
    ],
  ) {
    publishOpenCodePlannerModels(models);
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'opencode', { providerAuth })],
    });
  }

  const signedInToAnthropic = {
    kind: 'read',
    facts: [{ provider: 'Anthropic', source: 'oauth' }],
  } as const;

  // Signed in to neither route's provider: the tool's own listing is what vouches for both.
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

  // OpenCode lists its own gateway route before its account is signed in, so only one of the
  // merged row's two routes can call.
  it('confirms the one signed-in route without expanding the merged row', async () => {
    seedOpenCode(signedInToAnthropic, [
      'opencode/deepseek-v4-flash',
      'anthropic/deepseek-v4-flash',
      'openrouter/deepseek-v4-flash-free',
    ]);
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
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

  it('expands to the route rows when two routes can call, then saves the chosen one', async () => {
    seedOpenCode(signedInToGroq);
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
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
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
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
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await flushEffects();
    ui.stdin.write('opencode');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('free'); // narrow to the single-provider free variant
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain('openrouter/deepseek-v4-flash-free');
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
    resetPickerStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
  });

  it('shows the initializing panel during cold discovery and reveals the picker on publish', async () => {
    detectionStore.beginRefresh({ contexts: catalogContexts });
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await tick(20);
    expect(frameText(ui)).toContain('Checking your tools…');
    expect(frameText(ui)).not.toContain('Tools');

    publishOpenCodePlannerModels(['openrouter/deepseek-v4-flash']);
    await vi.waitFor(() => {
      const frame = frameText(ui);
      expect(frame).not.toContain('Checking your tools…');
      expect(frame).toContain('Tools');
      expect(frame).toContain('Install Claude Code CLI, then ctrl+r.');
      expect(frame).not.toContain('Models');
    });
    ui.unmount();
  });

  it('labels the picker as refreshing during a warm background refresh', async () => {
    publishOpenCodePlannerModels(['openrouter/deepseek-v4-flash']);
    detectionStore.beginRefresh({ contexts: catalogContexts });
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await tick(20);
    const frame = frameText(ui);
    expect(frame).toContain('refreshing…');
    expect(frame).toContain('Tools');
    expect(frame).not.toContain('Checking your tools…');
    ui.unmount();
  });

  it('merges live models and removes foreign-context rows only after two missing reads', async () => {
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
        cliCatalogs: [{ tool: 'codex', models: [{ id: 'gpt-5-codex' }], probedAt: 100 }],
      },
    });

    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await tick(20);

    // Warm start: the foreign record's rows are on screen, marked stale.
    const frameBefore = frameText(ui);
    expect(frameBefore).not.toContain('Checking your tools…');
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
    expect(frameDuring).not.toContain('Checking your tools…');
    expect(frameDuring).toContain('refreshing…');
    expect(frameDuring).toContain(`${listRowLead('active')}OpenCode CLI`);

    const freshAttempts: ScopedCliCatalogAttempt[] = [
      {
        connection: { tool: 'codex', contextKey: 'config-b-codex' },
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
      expect(frameAfter).not.toContain('Checking your tools…');
      expect(frameAfter).not.toContain('refreshing…');
      // The cursor never moved and the picker never remounted.
      expect(frameAfter).toContain(`${listRowLead('active')}OpenCode CLI`);
    });

    // The first live read merges new models and retains remembered rows as stale.
    await flushEffects();
    ui.stdin.write(ARROW_UP);
    await vi.waitFor(() => {
      const frameAfter = frameText(ui);
      expect(frameAfter).toContain(`${listRowLead('active')}OpenAI Codex CLI`);
      expect(frameAfter).toContain('GPT-6 Codex');
      expect(frameAfter).toMatch(/GPT-5 Codex[^\n]*Stale/);
    });

    const secondRequest = detectionStore.beginRefresh({ contexts: currentContexts });
    expect(
      detectionStore.publish({
        request: secondRequest,
        result: {
          providers: [],
          cliTools: tools,
          catalog: null,
          cliModels: freshAttempts,
          generation: 2,
        },
      }),
    ).toBe(true);

    await vi.waitFor(() => {
      const frameAfter = frameText(ui);
      expect(frameAfter).not.toContain('Checking your tools…');
      expect(frameAfter).not.toContain('refreshing…');
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
    resetPickerStores();
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

  it('keeps the configured Claude Code alias when the models.dev lane lands', async () => {
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
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
            'claude-opus-5-5': {
              id: 'claude-opus-5-5',
              name: 'Claude Opus 5.5',
              limit: { context: 1_000_000 },
            },
            'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
          },
        },
      },
      fetchedAt: 100,
      validatedAt: 100,
    });

    await tick(20);

    const after = checkedModelLines(frameText(ui));
    expect(after).toHaveLength(1);
    expect(after.join('')).toContain('Opus 5.5');
    expect(after.join('')).not.toContain('Claude Opus 5.5');
    expect(modelColumnLines(frameText(ui))).toHaveLength(aliasRowCount);
    ui.unmount();
  });

  it('renders the pinned Claude options instead of the operator account cache', async () => {
    // The fixture every describe in this file pins after `resetAllStores()`, read back at the
    // seam the picker itself reads.
    expect(modelCacheStore.getClaudeCodeModelOptions()).toEqual(PINNED_CLAUDE_CODE_OPTIONS);

    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await tick(20);

    // The probe row can only come from the pin: no bundled model answers to its id, and the
    // reader would have served the operator's own account cache instead.
    const frame = frameText(ui);
    expect(modelColumnLines(frame).join('\n')).toContain('Pinned Probe');
    // The colliding id folded into the bundled Sonnet row rather than adding a second row.
    expect(frame).not.toContain('Pinned Sonnet');
    ui.unmount();
  });

  const MAX_SEAT = makeConfig({
    planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
  });

  function openFromPlanCrewRow(saveConfig = defaultPickerEffectDeps.saveConfig) {
    configStore.__testReset({ projectDir: '/tmp/project', config: MAX_SEAT });
    const plan = deriveCrewRows({ config: MAX_SEAT }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');
    crewActivate({ target: { kind: 'crew', row: plan }, config: MAX_SEAT });
    return renderFeature(
      <ToolModelPicker
        slot="seat"
        role="planner"
        deps={{ ...defaultPickerEffectDeps, saveConfig }}
      />,
    );
  }

  const effortAxisLine = (ui: ReturnType<typeof renderFeature>) =>
    frameText(ui)
      .split('\n')
      .find((line) => line.includes(`${glyph('divider')} effort`));

  /** The value the focused effort row carries: the axis name's own metadata cell, exactly. */
  const effortAxisValue = (ui: ReturnType<typeof renderFeature>) =>
    effortAxisLine(ui)?.match(/\beffort\s+(\S+)/)?.[1];

  it('opens on the effort the seat runs when its crew row expanded the model', async () => {
    const ui = openFromPlanCrewRow();
    await tick(20);

    // The crew row opened the seat's own model expansion on the level it runs; the cursor sits on
    // that expansion's effort axis, so Space steps the drafted level only from there.
    expect(pickerViewStore.get()).toMatchObject({ expandedModelId: 'opus', effortDraft: 'max' });
    expect(effortAxisValue(ui)).toBe('max');
    ui.stdin.write(' ');
    await flushEffects();
    expect(pickerViewStore.get().effortDraft).not.toBe('max');
    ui.unmount();
  });

  it('reads and saves the seat effort again after the cursor leaves the tool and returns', async () => {
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    });
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async () => SAVED);
    const ui = openFromPlanCrewRow(saveConfig);
    await tick(20);

    for (const key of [ARROW_LEFT, ARROW_DOWN, ARROW_UP, ARROW_RIGHT]) {
      ui.stdin.write(key);
      await tick(20);
    }
    // Returning to the seat's tool re-reads its level on the axis, and Enter commits the row the
    // cursor landed on: the saved planner names the model and the effort that row read.
    expect(effortAxisValue(ui)).toBe('max');

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(saveConfig.mock.calls.at(-1)?.[0].planner).toMatchObject({
        kind: 'cli',
        tool: 'claude-code',
        model: 'opus',
        effort: 'max',
      });
    });
    ui.unmount();
  });
});

describe('ToolModelPicker on a saved model with nothing to open', () => {
  const CUSTOM = 'zz-custom-model';

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'cursor')],
    });
  });

  const customRowLine = (frame: string) =>
    modelColumnLines(frame).find((line) => line.includes('Zz Custom Model'));
  const footerLine = (frame: string) =>
    frame.split('\n').find((line) => line.includes('↑↓ select'));

  /** The row reads closed, the keys read as on any row that confirms, and one ⏎ saves. */
  async function expectOneEnterSaves(
    ui: ReturnType<typeof renderFeature>,
    saveConfig: Mock<PickerEffectDeps['saveConfig']>,
  ) {
    await vi.waitFor(() => {
      expect(customRowLine(frameText(ui))).toContain(glyph('liveBar'));
    });
    const frame = frameText(ui);
    expect(customRowLine(frame)).not.toContain(glyph('disclosureOpen'));
    expect(footerLine(frame)).toContain('⏎ confirm');
    expect(footerLine(frame)).toContain('esc cancel');

    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(saveConfig).toHaveBeenCalledTimes(1);
    });
  }

  it('saves the seat on one ⏎ from the crew row', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'cursor', model: CUSTOM } });
    configStore.__testReset({ projectDir: '/tmp/project', config });
    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');
    crewActivate({ target: { kind: 'crew', row: plan }, config });
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async () => SAVED);
    const ui = renderFeature(
      <ToolModelPicker
        slot="seat"
        role="planner"
        deps={{ ...defaultPickerEffectDeps, saveConfig }}
      />,
    );

    await expectOneEnterSaves(ui, saveConfig);
    expect(saveConfig.mock.calls[0]?.[0].planner).toMatchObject({
      kind: 'cli',
      tool: 'cursor',
      model: CUSTOM,
    });
    ui.unmount();
  });

  it('saves the fallback on one ⏎ from the fallback row', async () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'opus',
        fallback: { tool: 'cursor', model: CUSTOM },
      },
    });
    configStore.__testReset({ projectDir: '/tmp/project', config });
    const plan = deriveFallbackRows({ config, cliTools: detectionStore.get().cliTools }).find(
      (row) => row.id === 'plan',
    );
    if (plan === undefined) throw new Error('No plan fallback row.');
    fallbackActivate({ row: plan, config });
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async () => SAVED);
    const ui = renderFeature(
      <ToolModelPicker
        slot="fallback"
        role="planner"
        deps={{ ...defaultPickerEffectDeps, saveConfig }}
      />,
    );

    await expectOneEnterSaves(ui, saveConfig);
    expect(saveConfig.mock.calls[0]?.[0].planner).toMatchObject({
      fallback: { tool: 'cursor', model: CUSTOM },
    });
    ui.unmount();
  });
});

describe('ToolModelPicker custom model entry', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
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

  it('offers custom models and saves a typed model without offering custom commands', async () => {
    const projectDir = createTempDir('picker-custom-model-save');
    const modelId = 'claude-custom-fixture';
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } });
    writeConfig(projectDir, config);
    configStore.load(projectDir);
    overlayStore.open('planner-picker', 'tool:claude-code');
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);

    try {
      await flushEffects();
      expect.soft(frameText(ui)).not.toContain('+ Add custom command');
      ui.stdin.write(ARROW_RIGHT);
      await flushEffects();
      ui.stdin.write(modelId);
      await vi.waitFor(() =>
        expect(frameText(ui)).toContain(`${listRowLead('active')}+ Add custom model…`),
      );
      await flushEffects();
      ui.stdin.write('\r');
      await vi.waitFor(() => expect(frameText(ui)).toContain('Model id for Claude Code CLI'));
      await flushEffects();
      ui.stdin.write(modelId);
      await vi.waitFor(() => expect(frameText(ui)).toContain(modelId));
      await flushEffects();
      ui.stdin.write('\r');

      await vi.waitFor(() =>
        expect(loadConfig(projectDir).config.planner).toMatchObject({
          kind: 'cli',
          tool: 'claude-code',
          model: modelId,
        }),
      );
    } finally {
      ui.unmount();
      cleanupTempDir(projectDir);
    }
  });

  it("offers the seat's own tool ids, not another tool's", async () => {
    pickerViewStore.open({ kind: 'custom-model' });
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await tick(20);
    const frame = frameText(ui);

    expect(frame).toContain('Custom model · PLAN');
    expect(frame).toContain('Model id for Claude Code CLI');
    expect(frame).toMatch(/e\.g\. claude-[a-z0-9-]+/);
    expect(frame).not.toContain('llama3.3');
    expect(frame).not.toContain('qwen3-coder');
    ui.unmount();
  });

  it.each([
    { slot: 'seat', title: 'Custom model' },
    { slot: 'fallback', title: 'Custom fallback model' },
  ] as const)('names the $slot slot in the BUILD entry title', async ({ slot, title }) => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-6-sol',
          fallback: { tool: 'codex', model: 'gpt-6-astra' },
        },
      }),
    });
    detectionStore.setDetection({ providers: [], cliTools: [cliDetectionFor('ready', 'codex')] });
    overlayStore.open(slot === 'fallback' ? 'implementer-fallback-picker' : 'implementer-picker');
    pickerViewStore.open({ kind: 'custom-model' });
    const ui = renderFeature(<ToolModelPicker slot={slot} role="implementer" />);
    await tick(20);

    expect(frameText(ui)).toContain(`${title} · BUILD`);
    ui.unmount();
  });

  it.each([false, true])(
    'shows the REVIEW fallback inheritance notice only without its own block (own block: %s)',
    async (ownReviewer) => {
      const reviewer = {
        kind: 'cli' as const,
        tool: 'claude-code' as const,
        model: 'opus',
        fallback: { tool: 'codex', model: 'gpt-6-astra' },
      };
      configStore.__testReset({
        projectDir: '/tmp/project',
        config: makeConfig({ planner: reviewer, ...(ownReviewer ? { reviewer } : {}) }),
      });
      detectionStore.setDetection({ providers: [], cliTools: [cliDetectionFor('ready', 'codex')] });
      overlayStore.open('reviewer-fallback-picker');
      pickerViewStore.open({ kind: 'custom-model' });
      const ui = renderFeature(<ToolModelPicker slot="fallback" role="reviewer" />);
      await tick(20);
      const notice = 'REVIEW = PLAN · saving here gives REVIEW its own seat';

      expect(frameText(ui).includes(notice)).toBe(!ownReviewer);
      expect(frameText(ui)).toContain('Custom fallback model · REVIEW');
      ui.stdin.write('custom-model-'.repeat(12));
      await tick(20);
      expect(frameText(ui).includes(notice)).toBe(!ownReviewer);
      ui.unmount();
    },
  );
});

describe('ToolModelPicker leaving a text-output shell seat', () => {
  let projectDir: string;
  // The seat the e2e and PTY harnesses run: a configured command whose stdout is plain text.
  const shellPlanner = {
    kind: 'shell',
    command: 'true',
    outputFormat: 'text',
    model: 'shell',
    contextLength: 32_768,
  } as const;

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    projectDir = createTempDir('runners-shell-seat');
    writeConfig(projectDir, { ...createDefaultConfig(), planner: shellPlanner });
    configStore.load(projectDir);
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
    });
  });

  afterEach(() => {
    configStore.__testReset();
    cleanupTempDir(projectDir);
  });

  function openFromPlanCrewRow(deps: PickerEffectDeps = defaultPickerEffectDeps) {
    const config = loadConfig(projectDir).config;
    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');
    crewActivate({ target: { kind: 'crew', row: plan }, config });
    return renderFeature(<ToolModelPicker slot="seat" role="planner" deps={deps} />);
  }

  // Tool, then the Sonnet row, whose Enter opens its effort axis, whose Enter commits.
  // `beforeConfirm` runs with the effort row focused, before that last Enter saves.
  async function chooseClaudeSonnet(
    ui: ReturnType<typeof renderFeature>,
    beforeConfirm?: () => void,
  ) {
    const active = listRowLead('active');
    const steps: readonly (readonly [string, string])[] = [
      ['Claude Code', `${active}Claude Code CLI`],
      ['\r', 'Sonnet 5'],
      [ARROW_DOWN, `${active}Sonnet 5`],
      ['\r', `${glyph('divider')} effort`],
    ];
    await flushEffects();
    for (const [key, shown] of steps) {
      ui.stdin.write(key);
      await vi.waitFor(() => {
        expect(frameText(ui)).toContain(shown);
      });
      await flushEffects();
    }
    beforeConfirm?.();
    ui.stdin.write('\r');
  }

  it('commits the new tool and model and drops the shell-only fields', async () => {
    const ui = openFromPlanCrewRow();
    await chooseClaudeSonnet(ui);

    await vi.waitFor(() => {
      expect(loadConfig(projectDir).config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
      });
      expect(feedbackStore.get()).toMatchObject({
        message: 'Saved PLAN · Claude Code CLI · Sonnet 5.5 to .splitbrief/config.yaml',
        severity: 'info',
      });
    });
    ui.unmount();
  });

  it('shows a refused save in the picker, which the overlay would otherwise hide', async () => {
    let attempts = 0;
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async (updated) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          kind: 'failure',
          ok: false,
          error: new Error('Failed to save config to .splitbrief/config.yaml'),
        };
      }
      return defaultPickerEffectDeps.saveConfig(updated);
    });
    const ui = openFromPlanCrewRow({ ...defaultPickerEffectDeps, saveConfig });
    await flushEffects();
    ui.stdin.write('Claude Code');
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain('Claude Code CLI');
    });
    await flushEffects();
    ui.stdin.write('\r'); // select the tool; the cursor lands on the auto row
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain('Claude Code CLI chooses the model');
    });
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(frameText(ui)).toContain('Failed to save config');
    });
    // The refusal lands inside the picker rather than closing it: the overlay is still up and
    // the disk still holds the seat the refused save would have replaced.
    expect(overlayStore.get().active).toBe('planner-picker');
    expect(loadConfig(projectDir).config.planner).toMatchObject(shellPlanner);
    expect(saveConfig).toHaveBeenCalledTimes(1);

    // The cursor never left the refused row: the retried Enter saves its automatic selection.
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(loadConfig(projectDir).config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'auto',
      });
      expect(overlayStore.get().active).toBe('none');
    });
    expect(saveConfig).toHaveBeenCalledTimes(2);
    ui.unmount();
  });

  it('names a failed save on an axis confirm instead of dropping it', async () => {
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async () => {
      throw new Error('disk is read-only');
    });
    const ui = openFromPlanCrewRow({ ...defaultPickerEffectDeps, saveConfig });
    await chooseClaudeSonnet(ui);

    await vi.waitFor(() => {
      expect(feedbackStore.get()).toMatchObject({
        message: 'disk is read-only',
        severity: 'error',
      });
    });
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(loadConfig(projectDir).config.planner).toMatchObject(shellPlanner);
    ui.unmount();
  });

  it('saves once when Enter lands again while the first save is still in flight', async () => {
    const barrier = Promise.withResolvers<void>();
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async (updated) => {
      await barrier.promise;
      return defaultPickerEffectDeps.saveConfig(updated);
    });
    const ui = openFromPlanCrewRow({ ...defaultPickerEffectDeps, saveConfig });
    try {
      await chooseClaudeSonnet(ui); // the trailing Enter starts the first save
      await vi.waitFor(() => {
        expect(saveConfig).toHaveBeenCalledTimes(1);
      });
      await flushEffects();

      ui.stdin.write('\r'); // Enter again on the same effort row, first save still pending
      await flushEffects();

      // A picker that holds the in-flight confirm starts no second save here.
      expect(saveConfig).toHaveBeenCalledTimes(1);

      // The row the user confirmed is still the drafted state under the pending save: its model
      // expansion has not been torn down, and the overlay stays up until the port settles.
      expect(pickerViewStore.get().expandedModelId).toBe('sonnet');
      expect(overlayStore.get().active).toBe('planner-picker');

      barrier.resolve();
      await vi.waitFor(() => {
        expect(overlayStore.get().active).toBe('none');
      });

      expect(saveConfig).toHaveBeenCalledTimes(1);
      expect(saveConfig.mock.calls[0]?.[0].planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
      });
      // The deferred port ran the real compare-and-swap, so the choice is on disk.
      expect(loadConfig(projectDir).config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
      });
      expect(feedbackStore.get()).toMatchObject({
        message: 'Saved PLAN · Claude Code CLI · Sonnet 5.5 to .splitbrief/config.yaml',
        severity: 'info',
      });
    } finally {
      // An assertion above must not leave the port pending or the tree mounted.
      barrier.resolve();
      await Promise.allSettled(saveConfig.mock.results.map((result) => result.value));
      await flushEffects();
      ui.unmount();
    }
  });

  it('reports an external config change and keeps the external bytes', async () => {
    const ui = openFromPlanCrewRow();
    let externalBytes = '';
    await chooseClaudeSonnet(ui, () => {
      externalBytes = writeConfig(
        projectDir,
        makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'haiku' } }),
      );
    });

    await vi.waitFor(() => {
      // The picker states the conflict where the overlay cannot hide it.
      expect(frameText(ui)).toContain('Config changed on disk');
      expect(feedbackStore.get()).toMatchObject({
        message: 'Config changed on disk. SPLITBRIEF loaded it; make your change again.',
        severity: 'error',
      });
    });
    expect(overlayStore.get().active).toBe('planner-picker');
    expect(configStore.get().config?.planner).toMatchObject({ model: 'haiku' });
    // The refused save left the bytes the other writer put on disk.
    expect(readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8')).toBe(
      externalBytes,
    );
    expect(loadConfig(projectDir).config.planner).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'haiku',
    });
    ui.unmount();
  });

  it('keeps the first error until the focused axis retries through the real port', async () => {
    let attempts = 0;
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async (updated) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          kind: 'failure',
          ok: false,
          error: new Error('the config directory is read-only'),
        };
      }
      return defaultPickerEffectDeps.saveConfig(updated);
    });
    const ui = openFromPlanCrewRow({ ...defaultPickerEffectDeps, saveConfig });
    await chooseClaudeSonnet(ui); // the first save, which this control refuses

    await vi.waitFor(() => {
      expect(feedbackStore.get()).toMatchObject({
        message: 'Failed to save config: the config directory is read-only',
        severity: 'error',
      });
    });
    // The refusal stands while the same effort row keeps the focus.
    await flushEffects();
    expect(frameText(ui)).toContain('Failed to save config');
    expect(overlayStore.get().active).toBe('planner-picker');
    expect(loadConfig(projectDir).config.planner).toMatchObject(shellPlanner);
    expect(saveConfig).toHaveBeenCalledTimes(1);

    await flushEffects();
    ui.stdin.write('\r'); // retry the same focused effort row

    await vi.waitFor(() => {
      expect(loadConfig(projectDir).config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'sonnet',
      });
      expect(overlayStore.get().active).toBe('none');
    });
    expect(saveConfig).toHaveBeenCalledTimes(2);
    expect(feedbackStore.get()).toMatchObject({
      message: 'Saved PLAN · Claude Code CLI · Sonnet 5.5 to .splitbrief/config.yaml',
      severity: 'info',
    });
    ui.unmount();
  });
});

// The seat a live check could not leave: written by hand, so its keys are camelCase, with an
// absolute script outside the project and no model. The save deleted `output_format` and left the
// file's `outputFormat` beside `kind: cli`, which validation refused.
describe('ToolModelPicker leaving a hand-written shell seat', () => {
  let projectDir: string;
  let outside: string;

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    outside = createTempDir('runners-limit-planner');
    const script = join(outside, 'limit-planner.sh');
    writeFileSync(script, '#!/bin/sh\ncat >/dev/null; exit 1\n', { mode: 0o755 });
    projectDir = createTempDir('runners-hand-written-seat');
    mkdirSync(join(projectDir, '.splitbrief'));
    writeFileSync(
      join(projectDir, '.splitbrief', 'config.yaml'),
      [
        'version: 3',
        'planner:',
        '  kind: shell',
        `  command: ${script}`,
        '  outputFormat: text',
        'implementer:',
        '  kind: cli',
        '  tool: claude-code',
        '  model: haiku',
        'validation:',
        '  end_checks: false',
        'workflow:',
        '  approve: plan',
        '',
      ].join('\n'),
    );
    configStore.load(projectDir);
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
    });
  });

  afterEach(() => {
    configStore.__testReset();
    cleanupTempDir(projectDir);
    cleanupTempDir(outside);
  });

  it('saves the Claude Code auto row the crew row opened it on', async () => {
    const config = loadConfig(projectDir).config;
    const plan = deriveCrewRows({ config }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');
    crewActivate({ target: { kind: 'crew', row: plan }, config });
    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain(`${listRowLead('active')}Claude Code CLI`);
    });
    await flushEffects();
    ui.stdin.write('\r'); // the tool; the cursor lands on the auto row
    await vi.waitFor(() => {
      expect(frameText(ui)).toContain(`${listRowLead('active')}auto`);
    });
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(loadConfig(projectDir).config.planner).toEqual({
        kind: 'cli',
        tool: 'claude-code',
        model: 'auto',
      });
    });
    const written = readFileSync(join(projectDir, '.splitbrief', 'config.yaml'), 'utf8');
    expect(written).not.toMatch(/output_?[fF]ormat/);
    expect(written).not.toContain('command:');
    expect(feedbackStore.get().severity).toBe('info');
    ui.unmount();
  });
});

describe('ToolModelPicker after a hand edit of config.yaml', () => {
  let projectDir = '';

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 36, isSmall: false });
    projectDir = createTempDir('picker-hand-edit');
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
    });
  });

  afterEach(() => cleanupTempDir(projectDir));

  it('checks the model the edit names when the picker opens', async () => {
    const withPlanner = (model: string): Config => ({
      ...createDefaultConfig(),
      planner: { kind: 'cli', tool: 'claude-code', model },
    });
    writeConfig(projectDir, withPlanner('sonnet'));
    configStore.load(projectDir);
    writeConfig(projectDir, withPlanner('opus'));

    const ui = renderFeature(<ToolModelPicker slot="seat" role="planner" />);
    await tick(20);

    const checked = checkedModelLines(frameText(ui)).join('');
    expect(checked).toContain('Opus');
    expect(checked).not.toContain('Sonnet');
    ui.unmount();
  });
});

describe('ToolModelPicker on a tool that is not ready', () => {
  const VIEWPORT = { cols: 120, rows: 36 };
  const PLAN_SEAT = makeConfig({
    planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
  });
  const NO_MODELS_YET = 'Its models show here when it is ready.';

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetPickerStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
  });

  afterEach(() => _resetMouseZones());

  const cursorText = (ui: ReturnType<typeof renderFeature>) =>
    frameText(ui)
      .split('\n')
      .filter((line) => line.includes(glyph('liveBar')))
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n');

  /** Opens the PLAN seat picker the way Settings does: the model column holds the keys. */
  async function openOnEffort(
    cliTools: CliToolDetection[],
    refresh: PickerEffectDeps['refresh'] = defaultPickerEffectDeps.refresh,
  ) {
    configStore.__testReset({ projectDir: '/tmp/project', config: PLAN_SEAT });
    detectionStore.setDetection({ providers: [], cliTools });
    const plan = deriveCrewRows({ config: PLAN_SEAT }).find((row) => row.id === 'plan');
    if (plan === undefined) throw new Error('No plan seat row.');
    crewActivate({ target: { kind: 'crew', row: plan }, config: PLAN_SEAT });
    const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async () => SAVED);
    const ui = renderFeature(
      <ToolModelPicker
        slot="seat"
        role="planner"
        deps={{ ...defaultPickerEffectDeps, refresh, saveConfig }}
      />,
      VIEWPORT,
    );
    await vi.waitFor(() => expect(cursorText(ui)).toContain('▌ └─ effort max'));
    await flushEffects();
    return { ui, saveConfig };
  }

  async function clickTool(ui: ReturnType<typeof renderFeature>, id: string, row: string) {
    const click = collectClickableZones(VIEWPORT).get(`runner-left:${id}`);
    if (click === undefined) throw new Error(`no click zone runner-left:${id}`);
    click();
    await vi.waitFor(() => expect(cursorText(ui)).toContain(`▌ ${row}`));
    await flushEffects();
  }

  /**
   * ⏎, then ↓. The keys run in order, so once ↓ has moved the tool cursor to `nextRow`, ⏎ has
   * already made any save it was going to make.
   */
  async function enterThenDown(
    ui: ReturnType<typeof renderFeature>,
    saveConfig: Mock<PickerEffectDeps['saveConfig']>,
    nextRow: string,
  ) {
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() =>
      expect({
        saves: saveConfig.mock.calls.map(([config]) => config.planner),
        overlay: overlayStore.get().active,
        cursor: cursorText(ui),
      }).toEqual({
        saves: [],
        overlay: 'planner-picker',
        cursor: expect.stringContaining(`▌ ${nextRow}`),
      }),
    );
  }

  it('saves nothing on ⏎ after a click on a tool that reads Unavailable', async () => {
    const { ui, saveConfig } = await openOnEffort([
      cliDetectionFor('ready', 'claude-code'),
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('unavailable', 'command-code'),
    ]);

    await clickTool(ui, 'command-code', 'Command Code CLI');
    expect(frameText(ui)).toContain(NO_MODELS_YET);
    await enterThenDown(ui, saveConfig, 'Cursor Agent CLI');
    ui.unmount();
  });

  it('saves nothing on ⏎ after a click on a tool that reads Needs sign-in', async () => {
    const { ui, saveConfig } = await openOnEffort([
      cliDetectionFor('ready', 'claude-code'),
      cliDetectionFor('unauthenticated', 'codex'),
    ]);

    await clickTool(ui, 'codex', 'OpenAI Codex CLI');
    expect(cursorText(ui)).toContain('Needs sign-in');
    expect(frameText(ui)).toContain(NO_MODELS_YET);
    await enterThenDown(ui, saveConfig, 'Command Code CLI');
    ui.unmount();
  });

  it('saves nothing on ⏎ after the tool under the model column turns not ready', async () => {
    const { ui, saveConfig } = await openOnEffort([
      cliDetectionFor('ready', 'claude-code'),
      cliDetectionFor('ready', 'codex'),
    ]);
    await clickTool(ui, 'codex', 'OpenAI Codex CLI');
    expect(frameText(ui)).not.toContain(NO_MODELS_YET);

    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('unavailable', 'codex')],
    });
    await vi.waitFor(() => expect(frameText(ui)).toContain(NO_MODELS_YET));
    await flushEffects();
    await enterThenDown(ui, saveConfig, 'OpenCode CLI');
    ui.unmount();
  });

  const AUTO_ROW = '▌ auto tool decides';
  const ASTRA_ROW = '▌ GPT-6-Astra ▾';
  const modelCursorOf = (frame: string) =>
    modelColumnLines(stripAnsiStyles(frame))
      .filter((line) => line.includes(glyph('liveBar')))
      .map((line) => line.replace(/\s+/g, ' ').trim());
  /** The frames since `start` whose model column has no cursor on `row`. */
  const framesOffRow = (ui: ReturnType<typeof renderFeature>, start: number, row: string) =>
    ui.frames
      .slice(start)
      .map(modelCursorOf)
      .filter((cursor) => cursor.length !== 1 || cursor[0] !== row);

  it('keeps the keys on the model column of a ready tool when another tool turns Needs sign-in', async () => {
    const { ui, saveConfig } = await openOnEffort([
      cliDetectionFor('ready', 'claude-code'),
      cliDetectionFor('ready', 'codex'),
    ]);
    await clickTool(ui, 'codex', 'OpenAI Codex CLI');
    expect(modelCursorOf(ui.lastFrame())).toEqual([AUTO_ROW]);
    const start = ui.frames.length;

    detectionStore.setDetection({
      providers: [],
      cliTools: [
        cliDetectionFor('unauthenticated', 'claude-code'),
        cliDetectionFor('ready', 'codex'),
      ],
    });
    await vi.waitFor(() => expect(frameText(ui)).toContain('Needs sign-in'));
    await flushEffects();

    expect(ui.frames.length).toBeGreaterThan(start);
    expect(framesOffRow(ui, start, AUTO_ROW)).toEqual([]);
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => expect(modelCursorOf(ui.lastFrame())).toEqual([ASTRA_ROW]));
    expect(saveConfig).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('keeps the keys on the model column of a ready tool in every frame of a ctrl+r refresh', async () => {
    const cliTools = [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')];
    const detected: DetectionServiceResult = {
      providers: [],
      cliTools,
      catalog: null,
      cliModels: [],
    };
    // The startup check has landed, as it has for a user who opens Settings: a refresh is warm.
    const startup = detectionStore.beginRefresh({
      contexts: detectionContextsForCurrentConfig({
        config: PLAN_SEAT,
        projectDir: '/tmp/project',
      }),
    });
    expect(detectionStore.publish({ result: detected, request: startup })).toBe(true);
    const result = Promise.withResolvers<DetectionServiceResult>();
    const refreshDetection = vi.fn<DetectionService['refreshDetection']>(() => result.promise);
    const service: DetectionService = {
      shutdown: async () => {},
      loadDetection: () => result.promise,
      refreshDetection,
    };
    const summaries: DiscoveryRefreshSummary[] = [];
    const refresh: PickerEffectDeps['refresh'] = (projectDir) =>
      refreshPickerDetection(projectDir, async () => {
        const summary = await refreshDetectionForCurrentConfig({
          service,
          publication: detectionStore,
          getCurrent: () => ({ config: PLAN_SEAT, projectDir }),
        });
        summaries.push(summary);
        return summary;
      });
    const { ui, saveConfig } = await openOnEffort(cliTools, refresh);
    await clickTool(ui, 'codex', 'OpenAI Codex CLI');
    expect(modelCursorOf(ui.lastFrame())).toEqual([AUTO_ROW]);
    const start = ui.frames.length;

    ui.stdin.write('\u0012');
    await vi.waitFor(() => expect(refreshDetection).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(frameText(ui)).toContain('refreshing…'));
    result.resolve(detected);
    await vi.waitFor(() =>
      expect(summaries).toEqual([expect.objectContaining({ published: true })]),
    );
    await vi.waitFor(() => expect(frameText(ui)).not.toContain('refreshing…'));
    await flushEffects();

    expect(ui.frames.slice(start).some((frame) => frame.includes('refreshing…'))).toBe(true);
    expect(framesOffRow(ui, start, AUTO_ROW)).toEqual([]);
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => expect(modelCursorOf(ui.lastFrame())).toEqual([ASTRA_ROW]));
    expect(saveConfig).not.toHaveBeenCalled();
    ui.unmount();
  });
});
