import { useState } from 'react';
import { Text } from 'ink';
import { useInput } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { TwoColumnPicker } from './two-column-picker/picker.js';
import { usePickerCatalog } from './use-picker-catalog.js';
import type { PickerOption } from './model-catalog/options.js';
import type { ConfiguredProviderRuntime } from '../../engine/detection/provider-outcomes.js';

function seedDetections() {
  detectionStore.setDetection({
    cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
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
        models: [{ id: 'anthropic-only-model', contextLength: 200000 }],
      },
    ],
  });
  modelCacheStore.setProviderModels('ollama', [{ id: 'ollama-only-model', contextLength: 8192 }]);
  modelCacheStore.setProviderModels('anthropic', [
    { id: 'anthropic-only-model', contextLength: 200000 },
  ]);
}

function CatalogProbe({
  role,
  selectedItemId,
}: {
  role: 'planner' | 'implementer';
  selectedItemId?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 0, selectedItemId ?? null);

  return (
    <Text>
      {role}:{catalog.currentItem?.id ?? 'none'}:{catalog.currentModel ?? 'none'}
    </Text>
  );
}

function ModelListProbe({ toolId }: { toolId: string }) {
  const catalog = usePickerCatalog('implementer', 0, toolId);

  return (
    <Text>
      {catalog.currentItem?.id}:{catalog.rightModels.map((model) => model.id).join(',')}
    </Text>
  );
}

function ControlledCatalogPicker({ role }: { role: 'planner' | 'implementer' }) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const catalog = usePickerCatalog(role, 0, selectedItemId);

  return (
    <TwoColumnPicker<PickerOption, (typeof catalog.rightModels)[number]>
      title="Picker"
      leftProps={{
        items: catalog.items,
        getKey: (item) => item.id,
        isDisabled: (item) => !item.available && item.kind !== 'custom-command',
        initialIndex: catalog.initialLeftIdx,
        renderRow: (item) => <Text>{item.displayName}</Text>,
      }}
      rightProps={{
        items: catalog.rightModels,
        getKey: (model) => model.id,
        renderRow: (model) => <Text>{model.id}</Text>,
        onLeftChange: (item) => setSelectedItemId(item.id),
      }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

function KeyboardCatalogProbe({ role }: { role: 'planner' | 'implementer' }) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const catalog = usePickerCatalog(role, 0, selectedItemId);
  const toolIds = catalog.items
    .filter((item) => item.available || item.kind === 'custom-command')
    .map((item) => item.id);
  const currentToolIndex = Math.max(0, toolIds.indexOf(catalog.selectedItemId ?? ''));

  useInput((_input, key) => {
    if (!key.downArrow || toolIds.length === 0) return;
    const nextIndex = (currentToolIndex + 1) % toolIds.length;
    setSelectedItemId(toolIds[nextIndex] ?? null);
  });

  return (
    <Text>
      {catalog.currentItem?.id ?? 'none'}:
      {catalog.rightModels.map((model) => model.id).join(',') || 'none'}
    </Text>
  );
}

describe('usePickerCatalog', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    _resetMouseZones();
  });

  it.each(['auto', 'AUTO', undefined])(
    'canonicalizes a CLI planner model of %j onto the Auto row',
    async (model) => {
      configStore.__testReset({
        projectDir: '/tmp/project',
        config: makeConfig({
          planner: { kind: 'cli', tool: 'codex', ...(model === undefined ? {} : { model }) },
        }),
      });
      seedDetections();

      const ui = renderFeature(<CatalogProbe role="planner" selectedItemId="codex" />);
      await tick(20);

      expect(ui.lastFrame()).toContain('planner:codex:auto');
      ui.unmount();
    },
  );

  it('keeps the configured model off a tool the user is only browsing', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'auto' } }),
    });
    seedDetections();

    const ui = renderFeature(<CatalogProbe role="planner" selectedItemId="claude-code" />);
    await tick(20);

    expect(ui.lastFrame()).toContain('planner:claude-code:none');
    ui.unmount();
  });

  it('reports the persisted model regardless of the browsed tool, and only counts confirmed models as detected', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'auto' } }),
    });
    seedDetections();

    function PersistedProbe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('planner', 0, toolId);
      return (
        <Text>
          {catalog.persistedModel ?? 'none'}|{catalog.discoveredModelCount}|
          {catalog.rightModels.length}
        </Text>
      );
    }

    const ui = renderFeature(<PersistedProbe toolId="claude-code" />);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame.startsWith('auto|')).toBe(true);
    const [, discovered] = frame.split('|');
    expect(Number(discovered)).toBe(0);
    ui.unmount();
  });

  it('projects a role-scoped stale catalog as stale and excludes it from the detected count', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'openai',
          apiBase: 'https://api.openai.example/v1',
          model: 'planner-last-confirmed-model',
        },
      }),
    });
    const plannerRuntime: ConfiguredProviderRuntime = {
      connection: { role: 'planner', provider: 'openai', contextKey: 'planner-context' },
      state: 'stale',
      catalog: 'populated',
      models: [{ id: 'planner-last-confirmed-model' }],
      fetchedAt: 1,
      validatedAt: 2,
      failure: 'timeout',
      diagnostic: 'Configured provider catalog refresh did not complete.',
    };
    const implementerRuntime: ConfiguredProviderRuntime = {
      connection: { role: 'implementer', provider: 'openai', contextKey: 'implementer-context' },
      state: 'fresh',
      catalog: 'populated',
      models: [{ id: 'implementer-confirmed-model' }],
      fetchedAt: 1,
      validatedAt: 2,
    };
    detectionStore.setDetection({
      cliTools: [],
      providers: [],
      providerOutcomes: [plannerRuntime, implementerRuntime],
    });
    let projection:
      | Readonly<{
          model: ReturnType<typeof usePickerCatalog>['rightModels'][number] | undefined;
          detected: number;
          counts: ReturnType<typeof usePickerCatalog>['modelCounts'];
        }>
      | undefined;

    function Probe() {
      const catalog = usePickerCatalog('planner', 0, 'openai');
      projection = {
        model: catalog.rightModels.find((model) => model.id === 'planner-last-confirmed-model'),
        detected: catalog.discoveredModelCount,
        counts: catalog.modelCounts,
      };
      return <Text>projection</Text>;
    }

    const ui = renderFeature(<Probe />);

    expect(projection).toEqual({
      model: expect.objectContaining({
        membership: 'stale',
        isStale: true,
        isDetected: false,
      }),
      detected: 0,
      counts: expect.objectContaining({
        confirmed: 0,
        stale: 1,
        custom: 0,
      }),
    });
    expect(projection?.model?.id).not.toBe('implementer-confirmed-model');

    detectionStore.setDetection({
      cliTools: [],
      providers: [],
      providerOutcomes: [
        {
          connection: plannerRuntime.connection,
          state: 'fresh',
          catalog: 'populated',
          models: [{ id: 'planner-last-confirmed-model' }],
          fetchedAt: 3,
          validatedAt: 3,
        },
        implementerRuntime,
      ],
    });
    ui.rerender(<Probe />);
    expect(projection).toEqual({
      model: expect.objectContaining({ membership: 'confirmed', isDetected: true }),
      detected: 1,
      counts: expect.objectContaining({ confirmed: 1, stale: 0 }),
    });

    detectionStore.setDetection({
      cliTools: [],
      providers: [],
      providerOutcomes: [
        {
          connection: plannerRuntime.connection,
          state: 'fresh',
          catalog: 'empty',
          models: [],
          fetchedAt: 4,
          validatedAt: 4,
        },
        implementerRuntime,
      ],
    });
    ui.rerender(<Probe />);
    expect(projection).toEqual({
      model: undefined,
      detected: 0,
      counts: expect.objectContaining({ confirmed: 0, stale: 0 }),
    });
    ui.unmount();
  });

  it('does not carry current tool selection from planner to implementer', async () => {
    const ui = renderFeature(<CatalogProbe role="planner" selectedItemId="claude-code" />);
    await tick(20);
    expect(ui.lastFrame()).toContain('planner:claude-code');

    ui.rerender(<CatalogProbe role="implementer" />);
    await tick(20);

    expect(ui.lastFrame()).toContain('implementer:ollama:qwen2.5-coder:7b');
    expect(ui.lastFrame()).not.toContain('claude-code');
    ui.unmount();
  });

  it('displays the default implementer profile instead of the stale top-level implementer', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        implementerProfiles: {
          default: 'local-qwen',
          profiles: {
            'local-qwen': {
              kind: 'api',
              provider: 'ollama',
              apiBase: 'http://localhost:11434/v1',
              model: 'qwen2.5-coder:7b',
            },
          },
        },
      }),
    });

    const ui = renderFeature(<CatalogProbe role="implementer" />);
    await tick(20);

    expect(ui.lastFrame()).toContain('implementer:ollama:qwen2.5-coder:7b');
    ui.unmount();
  });

  it('derives right models in the same render as the selected tool', () => {
    seedDetections();
    const frames: string[] = [];
    function Probe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('implementer', 0, toolId);
      frames.push(catalog.rightModels.map((model) => model.id).join(','));
      return <ModelListProbe toolId={toolId} />;
    }

    const ui = renderFeature(<Probe toolId="ollama" />);
    expect(frames.at(-1)).toContain('ollama-only-model');
    expect(frames.at(-1)).not.toContain('anthropic-only-model');

    ui.rerender(<Probe toolId="anthropic" />);
    expect(frames.at(-1)).toContain('anthropic-only-model');
    expect(frames.at(-1)).not.toContain('ollama-only-model');
    ui.unmount();
  });

  it('rapid tool selection never shows previous-tool model ids', async () => {
    seedDetections();
    const frames: string[] = [];
    function Probe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('implementer', 0, toolId);
      frames.push(catalog.rightModels.map((model) => model.id).join('|') || 'empty');
      return <Text>{catalog.currentItem?.id}</Text>;
    }

    const ui = renderFeature(<Probe toolId="ollama" />);
    const toolSequence = ['anthropic', 'ollama', 'anthropic', 'ollama'] as const;
    for (const toolId of toolSequence) {
      ui.rerender(<Probe toolId={toolId} />);
    }

    const anthropicMarker = 'anthropic-only-model';
    const ollamaMarker = 'ollama-only-model';
    // A leaked previous-tool model shows up as a frame carrying both tools' ids.
    for (const frame of frames) {
      expect(frame.includes(anthropicMarker) && frame.includes(ollamaMarker)).toBe(false);
    }
    expect(frames.at(-1)).toContain(ollamaMarker);
    expect(frames.at(-1)).not.toContain(anthropicMarker);
    ui.unmount();
  });

  it('keyboard target changes update models without a previous-tool model frame', async () => {
    seedDetections();
    const frames: string[] = [];
    function Probe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('implementer', 0, toolId);
      frames.push(
        `${catalog.currentItem?.id}:${catalog.rightModels.map((model) => model.id).join(',')}`,
      );
      return <Text>{frames.at(-1)}</Text>;
    }

    const ui = renderFeature(<Probe toolId="ollama" />);
    ui.rerender(<Probe toolId="anthropic" />);
    ui.rerender(<Probe toolId="ollama" />);

    expect(frames).not.toContain(
      frames.find((frame) => frame.startsWith('anthropic:') && frame.includes('ollama-only-model')),
    );
    expect(frames).not.toContain(
      frames.find((frame) => frame.startsWith('ollama:') && frame.includes('anthropic-only-model')),
    );
    ui.unmount();
  });

  it('mouse target changes update models without a previous-tool model frame', async () => {
    seedDetections();
    const ui = renderFeature(<ControlledCatalogPicker role="implementer" />);
    await flushEffects();

    const zones = collectClickableZones({ cols: 140, rows: 40 });
    zones.get('runner-left:anthropic')?.();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('anthropic-only-model');
      expect(ui.lastFrame()).not.toContain('ollama-only-model');
    });

    zones.get('runner-left:ollama')?.();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('ollama-only-model');
      expect(ui.lastFrame()).not.toContain('anthropic-only-model');
    });
    ui.unmount();
  });

  it('arrow-key selection updates models without a previous-tool model frame', async () => {
    seedDetections();
    const ui = renderFeature(<KeyboardCatalogProbe role="implementer" />);
    await flushEffects();
    const initial = ui.lastFrame() ?? '';

    await flushEffects();
    ui.stdin.write('\u001B[B');
    await flushEffects();

    const next = ui.lastFrame() ?? '';
    if (initial.includes('ollama-only-model')) {
      expect(next).not.toContain('ollama-only-model');
    } else if (initial.includes('anthropic-only-model')) {
      expect(next).not.toContain('anthropic-only-model');
    }
    expect(next).not.toBe(initial);
    ui.unmount();
  });
});
