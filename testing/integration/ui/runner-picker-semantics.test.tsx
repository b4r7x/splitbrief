import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor, cliDetectionsFor } from '#testing/helpers/factories/detection.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { _resetMouseZones } from '../../../src/lib/terminal/mouse-zones.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { modelCacheStore } from '../../../src/stores/discovery/model-cache.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { loadConfig } from '../../../src/core/config/load/io.js';
import {
  CLI_READINESS_STATES,
  type CliToolDetection,
  type ProviderDetection,
} from '../../../src/core/discovery/detection.js';
import {
  IMPLEMENTER_API_PROVIDER_IDS,
  PLANNER_API_PROVIDER_IDS,
} from '../../../src/core/providers/api-provider-catalog.js';
import { getProviderDisplayName } from '../../../src/core/providers/catalog.js';
import { CLI_TOOL_IDS, PLANNER_CLI_TOOL_IDS } from '../../../src/core/runners/cli-tool-catalog.js';
import {
  buildRightModels,
  countModelOptions,
} from '../../../src/features/runners/model-catalog/catalog.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type PickerOption,
} from '../../../src/features/runners/model-catalog/options.js';
import { deriveModelCatalogCapability } from '../../../src/features/runners/model-catalog/posture.js';
import type { ModelOption } from '../../../src/features/runners/model-catalog/recency.js';
import {
  formatBillingLabel,
  formatPickerStatusLabel,
} from '../../../src/features/runners/picker-format.js';
import { PickerView } from '../../../src/features/runners/picker-view.js';
import type { PickerActions } from '../../../src/features/runners/use-picker-actions.js';
import type { PickerCatalog } from '../../../src/features/runners/use-picker-catalog.js';
import { ToolModelPicker } from '../../../src/app/overlays/runners.js';

const ENTER = '\r';
const BACKSPACE = '\u007f';
const ARROW_DOWN = '\u001b[B';
const VIEWPORT = { cols: 140, rows: 40 } as const;

function pickerItem(
  item: Omit<PickerOption, 'modelCapability'> & { modelPolicy: PickerOption['modelPolicy'] },
  automatic = false,
): PickerOption {
  return {
    ...item,
    modelCapability: deriveModelCatalogCapability(item.modelPolicy, automatic),
  };
}

function makeActions(overrides: Partial<PickerActions> = {}): PickerActions {
  return {
    confirm: () => {},
    confirmProviderVariant: async () => {},
    leftChange: () => {},
    deleteRight: () => {},
    chooseContract: () => {},
    customCommand: () => {},
    customModel: () => {},
    openCustomModel: () => {},
    openProviderAuth: () => {},
    submitProviderKey: async () => {},
    closeOverlay: () => {},
    ...overrides,
  };
}

function readyCliDetections(): CliToolDetection[] {
  return cliDetectionsFor('ready', CLI_TOOL_IDS);
}

function readyImplementerDetections(): ProviderDetection[] {
  return IMPLEMENTER_API_PROVIDER_IDS.map((provider) => ({
    provider,
    available: true,
    isLocal: provider === 'ollama' || provider === 'lm-studio',
    hasKey: true,
    models: [{ id: `${provider}-fixture-model`, contextLength: 8192 }],
  }));
}

function seedReadyDetection(): void {
  detectionStore.setDetection({
    cliTools: readyCliDetections(),
    providers: readyImplementerDetections(),
  });
  for (const provider of IMPLEMENTER_API_PROVIDER_IDS) {
    modelCacheStore.setProviderModels(provider, [
      { id: `${provider}-fixture-model`, contextLength: 8192 },
    ]);
  }
}

function leftToolZoneIds(viewport = VIEWPORT): string[] {
  return [...collectClickableZones(viewport).keys()]
    .filter((id) => id.startsWith('runner-left:'))
    .map((id) => id.slice('runner-left:'.length));
}

function rightModelZoneIds(viewport = VIEWPORT): string[] {
  return [...collectClickableZones(viewport).keys()]
    .filter((id) => id.startsWith('runner-right:'))
    .map((id) => id.slice('runner-right:'.length));
}

function catalogForItem(
  role: 'planner' | 'implementer',
  items: PickerOption[],
  item: PickerOption,
  rightModels: ModelOption[] = [],
  focusModels = false,
): PickerCatalog {
  return {
    items,
    rightModels,
    currentItem: item,
    selectedItemId: item.id,
    initialLeftIdx: items.findIndex((candidate) => candidate.id === item.id),
    focusModels,
    roleLabel: role === 'planner' ? 'Planner' : 'Implementer',
    currentModel: item.isCurrent ? rightModels[0]?.id : undefined,
    persistedModel: rightModels[0]?.id,
    discoveredModelCount: rightModels.filter((model) => model.id !== 'auto').length,
    modelCounts: countModelOptions(rightModels),
    catalogDiagnostic: undefined,
    currentCommand: undefined,
    currentCommandKind: undefined,
    customModels: [],
    discovery: { cold: false, refreshing: false },
    setCurrentItem: () => {},
  };
}

async function renderPicker(role: 'planner' | 'implementer') {
  overlayStore.open(role === 'planner' ? 'planner-picker' : 'implementer-picker');
  const ui = renderFeature(<ToolModelPicker role={role} />);
  await flushEffects();
  return ui;
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

describe('runner picker semantics integration', () => {
  beforeEach(() => {
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('role membership and catalog parity', () => {
    it('projects planner and implementer catalogs independently with matching row counts', async () => {
      seedReadyDetection();
      const snapshot = {
        cliTools: detectionStore.get().cliTools,
        providers: detectionStore.get().providers,
        hasApiKeyOverride: () => true,
      };
      const descriptors = assemblePickerDescriptors();
      const plannerCatalog = buildPickerOptions('planner', descriptors, snapshot, undefined);
      const implementerCatalog = buildPickerOptions(
        'implementer',
        descriptors,
        snapshot,
        undefined,
      );

      const plannerUi = await renderPicker('planner');
      const plannerZones = leftToolZoneIds();
      expect(plannerZones).toHaveLength(plannerCatalog.length);
      expect(plannerZones).toEqual(expect.arrayContaining(plannerCatalog.map((item) => item.id)));
      expect(plannerZones).not.toContain('cursor');
      expect(plannerZones).not.toContain('antigravity');
      expect(plannerCatalog.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          'custom-command',
          'agent-sdk',
          ...PLANNER_CLI_TOOL_IDS,
          ...PLANNER_API_PROVIDER_IDS,
        ]),
      );
      plannerUi.unmount();

      const implementerUi = await renderPicker('implementer');
      const implementerZones = leftToolZoneIds();
      expect(implementerZones).toHaveLength(implementerCatalog.length);
      expect(implementerZones).toEqual(
        expect.arrayContaining(implementerCatalog.map((item) => item.id)),
      );
      expect(implementerZones).toContain('ollama');
      expect(implementerZones).toContain('lm-studio');
      expect(implementerZones).not.toContain('cursor');
      expect(implementerZones).not.toContain('antigravity');
      expect(plannerZones).not.toContain('ollama');
      expect(plannerZones).not.toContain('lm-studio');
      expect(implementerCatalog.some((item) => item.id === 'ollama')).toBe(true);
      expect(plannerCatalog.some((item) => item.id === 'ollama')).toBe(false);
      implementerUi.unmount();
    });
  });

  describe('status projection and ink labels', () => {
    for (const state of CLI_READINESS_STATES) {
      it(`maps CLI ${state} to one semantic status label in the picker frame`, async () => {
        const descriptors = assemblePickerDescriptors();
        const options = buildPickerOptions(
          'implementer',
          descriptors,
          { cliTools: [cliDetectionFor(state, 'codex')], providers: [] },
          undefined,
        );
        const codex = options.find((item) => item.id === 'codex');
        expect(codex).toBeDefined();
        if (!codex) return;

        const label = formatPickerStatusLabel(codex.status);
        const ui = renderFeature(
          <PickerView
            role="implementer"
            catalog={catalogForItem('implementer', options, codex, [], true)}
            actions={makeActions()}
          />,
        );
        await flushEffects();
        const frame = frameText(ui);
        if (label) {
          expect(frame).toContain(label);
          expect(codex.status.remediation).toBeTruthy();
        } else {
          expect(codex.status.state).toBe('ready');
          expect(codex.available).toBe(true);
          expect(frame).toContain('OpenAI Codex CLI');
        }
        ui.unmount();
      });
    }

    it('renders API auth and offline semantics from detection-backed picker state', async () => {
      detectionStore.setDetection({
        cliTools: [],
        providers: [
          {
            provider: 'groq',
            available: false,
            isLocal: false,
            hasKey: false,
          },
          {
            provider: 'deepseek',
            available: true,
            isLocal: false,
            hasKey: true,
          },
          {
            provider: 'ollama',
            available: false,
            isLocal: true,
            error: 'Ollama is not running',
          },
        ],
      });

      const ui = await renderPicker('implementer');
      const zones = collectClickableZones(VIEWPORT);
      zones.get('runner-left:groq')?.();
      await flushEffects();
      const frame = frameText(ui);
      expect(frame).toContain('Auth required');
      expect(frame).toContain('GROQ_API_KEY');
      zones.get('runner-left:deepseek')?.();
      await flushEffects();
      expect(frameText(ui)).toContain('Unverified');
      expect(frameText(ui)).toContain('has no passing provider');
      zones.get('runner-left:ollama')?.();
      await flushEffects();
      expect(frameText(ui)).toContain('Unavailable');
      expect(frameText(ui)).toContain('Ollama is not running');
      ui.unmount();
    });
  });

  describe('broken current recovery', () => {
    it('keeps the configured runner visible with remediation and allows replacement', async () => {
      await withTempDir('picker-broken-current', async (projectDir) => {
        configStore.load(projectDir);
        configStore.__testReset({
          projectDir,
          config: makeConfig({
            planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
          }),
        });
        const broken = cliDetectionFor('incompatible', 'claude-code');
        detectionStore.setDetection({
          cliTools: [broken, cliDetectionFor('ready', 'codex')],
          providers: [],
        });

        const ui = await renderPicker('planner');
        const frame = frameText(ui);
        expect(frame).toContain('Claude Code CLI');
        expect(frame).toContain('Incompatible');
        // The byline truncates to the viewport, so match the opening of the
        // producer's own remediation rather than a hand-written copy of it.
        expect(frame).toContain((broken.diagnostic.remediation ?? '').slice(0, 20));
        expect(broken.diagnostic.remediation).toBeTruthy();

        await flushEffects();
        ui.stdin.write('codex');
        await flushEffects();
        ui.stdin.write(ENTER);
        await flushEffects();
        ui.stdin.write(ENTER);
        await flushEffects();

        await vi.waitFor(() => {
          expect(loadConfig(projectDir).config.planner).toMatchObject({
            kind: 'cli',
            tool: 'codex',
          });
        });
        expect(feedbackStore.get().message).toContain('Planner set to');
        ui.unmount();
      });
    });
  });

  describe('model policy semantics', () => {
    it('reflects auto-only, backend-default, and none policies in reachable guidance', async () => {
      const readyPermissions = {
        directWrite: false,
        network: true,
        shell: false,
        automaticApproval: false,
        sandbox: 'none' as const,
      };

      const policies: Array<{
        item: PickerOption;
        headline: string;
        allowsCustom: boolean;
      }> = [
        {
          item: pickerItem({
            id: 'codex',
            displayName: 'OpenAI Codex CLI',
            kind: 'cli',
            roles: ['planner', 'implementer'],
            modelPolicy: 'auto-only',
            billing: 'subscription-included',
            permissions: readyPermissions,
            status: { state: 'ready', remediation: null },
            available: true,
          }),
          headline: 'Model chosen by the tool',
          allowsCustom: false,
        },
        {
          item: pickerItem({
            id: 'kilo-code',
            displayName: 'Kilo Code CLI',
            kind: 'cli',
            roles: ['planner', 'implementer'],
            modelPolicy: 'backend-default',
            billing: 'provider-dependent',
            permissions: readyPermissions,
            status: { state: 'ready', remediation: null },
            available: true,
          }),
          headline: 'Model chosen by the tool',
          allowsCustom: false,
        },
        {
          item: pickerItem({
            id: 'shell',
            displayName: 'Shell',
            kind: 'shell',
            roles: ['planner', 'implementer'],
            modelPolicy: 'none',
            billing: 'unknown',
            permissions: readyPermissions,
            status: { state: 'ready', remediation: null },
            available: true,
          }),
          headline: 'No model selection',
          allowsCustom: false,
        },
      ];

      for (const { item, headline, allowsCustom } of policies) {
        const ui = renderFeature(
          <PickerView
            role="implementer"
            catalog={catalogForItem('implementer', [item], item, [], true)}
            actions={makeActions()}
          />,
        );
        await flushEffects();
        const frame = frameText(ui);
        expect(frame).toContain(headline);
        if (allowsCustom) {
          expect(frame).toContain('Add custom model');
        } else {
          expect(frame).not.toContain('Add custom model');
        }
        ui.unmount();
      }
    });

    it('offers exactly one Auto row alongside the tool-chooses-the-model guidance', async () => {
      const item = pickerItem(
        {
          id: 'codex',
          displayName: 'OpenAI Codex CLI',
          kind: 'cli',
          roles: ['planner', 'implementer'],
          modelPolicy: 'auto-only',
          billing: 'subscription-included',
          permissions: {
            directWrite: false,
            network: true,
            shell: false,
            automaticApproval: false,
            sandbox: 'none',
          },
          status: { state: 'ready', remediation: null },
          available: true,
        },
        true,
      );
      const rightModels = buildRightModels({
        isPlanner: false,
        customModels: [],
        currentItem: item,
      });
      expect(rightModels).toEqual([{ id: 'auto' }]);

      const ui = renderFeature(
        <PickerView
          role="implementer"
          catalog={catalogForItem('implementer', [item], item, rightModels, true)}
          actions={makeActions()}
        />,
      );
      await flushEffects();
      const frame = frameText(ui);
      // One row in the Models column plus the preview line that describes it.
      expect(frame).toContain('Auto');
      expect(frame).not.toContain('Add custom model');
      ui.unmount();

      // The tool-chooses-the-model guidance stays reachable from the tool column.
      const guidanceUi = renderFeature(
        <PickerView
          role="implementer"
          catalog={catalogForItem('implementer', [item], item, rightModels, false)}
          actions={makeActions()}
        />,
      );
      await flushEffects();
      expect(frameText(guidanceUi)).toContain('Model chosen by the tool');
      guidanceUi.unmount();
    });

    it('shows custom-capable empty guidance and discovered model counts independently', async () => {
      const openai = pickerItem({
        id: 'openai',
        displayName: 'OpenAI',
        kind: 'api',
        roles: ['planner', 'implementer'],
        modelPolicy: 'per-call',
        billing: 'api-metered',
        permissions: {
          directWrite: false,
          network: true,
          shell: false,
          automaticApproval: false,
          sandbox: 'none',
        },
        status: { state: 'ready', remediation: null },
        available: true,
      });
      const emptyUi = renderFeature(
        <PickerView
          role="planner"
          catalog={catalogForItem('planner', [openai], openai, [], true)}
          actions={makeActions()}
        />,
      );
      await flushEffects();
      const emptyFrame = frameText(emptyUi);
      expect(emptyFrame).toContain('No models detected');
      expect(emptyFrame).toContain('refresh detection');
      expect(emptyFrame).toContain('Add custom model');
      emptyUi.unmount();

      const discovered = [
        {
          id: 'gpt-4o',
          contextLength: 128_000,
          isDetected: true,
          membership: 'confirmed' as const,
        },
      ];
      const discoveredUi = renderFeature(
        <PickerView
          role="planner"
          catalog={catalogForItem('planner', [openai], openai, discovered, false)}
          actions={makeActions()}
        />,
      );
      await flushEffects();
      const discoveredFrame = frameText(discoveredUi);
      expect(discoveredFrame).toContain('1 model detected');
      expect(discoveredFrame).toContain('GPT-4o');
      discoveredUi.unmount();
    });
  });

  describe('duplicate model identity', () => {
    it('renders one row for merged custom, bundled, and detected model IDs', async () => {
      const codex = buildPickerOptions(
        'planner',
        assemblePickerDescriptors(),
        { cliTools: [cliDetectionFor('ready', 'codex')], providers: [] },
        undefined,
      ).find((item) => item.id === 'codex');
      expect(codex).toBeDefined();
      if (!codex) return;

      const mergedModels = buildRightModels({
        isPlanner: true,
        customModels: ['gpt-5.4'],
        currentItem: codex,
        cache: {
          getModelsDevCatalog: () => null,
          getProviderModels: () => [{ id: 'gpt-5.4' }, { id: 'runtime-only-model' }],
        },
      });
      expect(mergedModels.filter((model) => model.id === 'gpt-5.4')).toHaveLength(1);

      configStore.__testReset({
        projectDir: '/tmp/project',
        config: makeConfig({
          planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4', customModels: ['gpt-5.4'] },
        }),
      });
      detectionStore.setDetection({
        cliTools: [cliDetectionFor('ready', 'codex')],
        providers: [],
      });
      modelCacheStore.setProviderModels('codex', [{ id: 'gpt-5.4' }, { id: 'runtime-only-model' }]);

      const ui = await renderPicker('planner');
      collectClickableZones(VIEWPORT).get('runner-left:codex')?.();
      await vi.waitFor(() => {
        const modelZones = rightModelZoneIds();
        expect(modelZones.filter((id) => id === 'gpt-5.4')).toHaveLength(1);
        expect(modelZones).toContain('runtime-only-model');
      });
      ui.unmount();
    });
  });

  describe('rapid tool selection', () => {
    it('never shows models from the previously selected tool during rapid input', async () => {
      detectionStore.setDetection({
        cliTools: readyCliDetections(),
        providers: [
          {
            provider: 'ollama',
            available: true,
            isLocal: true,
            models: [{ id: 'ollama-only-model', contextLength: 8192 }],
          },
          {
            provider: 'anthropic',
            available: true,
            isLocal: false,
            hasKey: true,
            models: [{ id: 'anthropic-only-model', contextLength: 200_000 }],
          },
        ],
      });
      modelCacheStore.setProviderModels('ollama', [
        { id: 'ollama-only-model', contextLength: 8192 },
      ]);
      modelCacheStore.setProviderModels('anthropic', [
        { id: 'anthropic-only-model', contextLength: 200_000 },
      ]);

      const ui = await renderPicker('implementer');
      const zones = collectClickableZones(VIEWPORT);
      const frames: string[] = [];

      for (const provider of ['anthropic', 'ollama', 'anthropic', 'ollama'] as const) {
        zones.get(`runner-left:${provider}`)?.();
        await flushEffects();
        frames.push(frameText(ui));
      }

      for (let index = 1; index < frames.length; index++) {
        const frame = frames[index] ?? '';
        const previous = frames[index - 1] ?? '';
        if (previous.includes('anthropic-only-model') && frame.includes('ollama')) {
          expect(frame).not.toContain('anthropic-only-model');
        }
        if (previous.includes('ollama-only-model') && frame.includes('anthropic')) {
          expect(frame).not.toContain('ollama-only-model');
        }
      }

      await flushEffects();
      ui.stdin.write(ARROW_DOWN);
      await flushEffects();
      ui.stdin.write(ARROW_DOWN);
      await flushEffects();
      const afterKeys = frameText(ui);
      if (afterKeys.includes('ollama-only-model')) {
        expect(afterKeys).not.toContain('anthropic-only-model');
      }
      ui.unmount();
    });
  });

  describe('persisted selection', () => {
    it('writes the confirmed planner and implementer choices to disk', async () => {
      await withTempDir('picker-persist', async (projectDir) => {
        configStore.load(projectDir);
        detectionStore.setDetection({
          cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
          providers: [
            {
              provider: 'ollama',
              available: true,
              isLocal: true,
              models: [{ id: 'qwen2.5-coder:7b' }],
            },
          ],
        });
        modelCacheStore.setProviderModels('ollama', [
          { id: 'qwen2.5-coder:7b', contextLength: 8192 },
        ]);

        const plannerUi = await renderPicker('planner');
        await flushEffects();
        plannerUi.stdin.write('claude-code');
        await flushEffects();
        plannerUi.stdin.write(ENTER);
        await flushEffects();
        plannerUi.stdin.write(ENTER);
        await flushEffects();
        plannerUi.unmount();

        await vi.waitFor(() => {
          expect(loadConfig(projectDir).config.planner).toMatchObject({
            kind: 'cli',
            tool: 'claude-code',
          });
        });

        const implementerUi = await renderPicker('implementer');
        await flushEffects();
        implementerUi.stdin.write('ollama');
        await flushEffects();
        implementerUi.stdin.write(ENTER);
        await flushEffects();
        implementerUi.stdin.write(ENTER);
        await flushEffects();
        implementerUi.unmount();

        await vi.waitFor(() => {
          expect(loadConfig(projectDir).config.implementer).toMatchObject({
            kind: 'api',
            provider: 'ollama',
          });
          expect(loadConfig(projectDir).config.implementer.model).toBeTruthy();
        });
      });
    });

    it.each([
      { branch: 'printable input', keys: ['codex'] },
      { branch: 'backspace', keys: ['codexz', BACKSPACE] },
    ])('keeps the configured model when a $branch filter re-selects the configured tool', async ({
      keys,
    }) => {
      await withTempDir('picker-filter-model', async (projectDir) => {
        writeConfigYaml(projectDir, {
          planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
        });
        configStore.load(projectDir);
        detectionStore.setDetection({
          cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
          providers: [],
        });

        const ui = await renderPicker('planner');
        for (const keystroke of keys) {
          await flushEffects();
          ui.stdin.write(keystroke);
          await flushEffects();
        }
        expect(frameText(ui)).not.toContain('Claude Code');
        await flushEffects();
        ui.stdin.write(ENTER);
        await flushEffects();
        ui.stdin.write(ENTER);
        await flushEffects();
        ui.unmount();

        expect(loadConfig(projectDir).config.planner).toMatchObject({
          kind: 'cli',
          tool: 'codex',
          model: 'gpt-5.4',
        });
      });
    });
  });

  describe('generic admitted descriptor rendering', () => {
    it('renders every admitted CLI and API descriptor through shared semantic fields', async () => {
      seedReadyDetection();
      const ui = await renderPicker('implementer');
      const frame = frameText(ui);

      const admitted = assemblePickerDescriptors().filter(
        (entry): entry is Extract<typeof entry, { kind: 'cli' | 'api' }> =>
          entry.kind === 'cli' || entry.kind === 'api',
      );

      for (const entry of admitted) {
        if (entry.kind === 'cli') {
          expect(frame).toContain(entry.descriptor.displayName);
          continue;
        }
        expect(frame).toContain(getProviderDisplayName(entry.descriptor.id));
      }

      collectClickableZones(VIEWPORT).get('runner-left:claude-code')?.();
      await flushEffects();
      expect(frameText(ui)).toContain(formatBillingLabel('subscription-included'));

      expect(leftToolZoneIds()).toHaveLength(
        buildPickerOptions(
          'implementer',
          assemblePickerDescriptors(),
          {
            cliTools: detectionStore.get().cliTools,
            providers: detectionStore.get().providers,
            hasApiKeyOverride: () => true,
          },
          undefined,
        ).length,
      );

      ui.unmount();
    });
  });
});
