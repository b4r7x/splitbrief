import { useState } from 'react';
import { Text } from 'ink';
import { useInput } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { TwoColumnPicker } from './two-column-picker/picker.js';
import { seatAxisFocus, seatAxisFocusSeat } from '../../core/navigation/types.js';
import { usePickerCatalog } from './use-picker-catalog.js';
import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { PICKER_ROLE_SEAT_IDS, type ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import type { PickerOption } from './model-catalog/options.js';
import type { RightRow } from './model-catalog/rows.js';
import type { ModelOption } from './model-catalog/recency.js';
import type { ConfiguredProviderRuntime } from '../../engine/detection/provider-outcomes.js';
import { CATALOG_SUGGESTION_MEMBERSHIP } from '../../engine/providers/model/catalog.js';

/** The models behind the rows the picker actually renders. */
function rowModels(rows: readonly RightRow[]) {
  return rows.filter((row) => row.kind === 'model').map((row) => row.model);
}

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
        provider: 'lm-studio',
        available: true,
        isLocal: true,
        models: [{ id: 'lm-studio-only-model', contextLength: 200000 }],
      },
    ],
  });
  modelCacheStore.setProviderModels('ollama', [{ id: 'ollama-only-model', contextLength: 8192 }]);
  modelCacheStore.setProviderModels('lm-studio', [
    { id: 'lm-studio-only-model', contextLength: 200000 },
  ]);
}

const CODEX_MODELS_DEV = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-5-codex': { id: 'gpt-5-codex', name: 'GPT-5 Codex', release_date: '2026-01-01' },
      'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', release_date: '2025-11-01' },
      'gpt-4.5-preview': {
        id: 'gpt-4.5-preview',
        name: 'GPT-4.5 Preview',
        release_date: '2025-09-01',
      },
      'o3-mini': { id: 'o3-mini', name: 'o3 Mini', release_date: '2025-08-01' },
    },
  },
};

/** codex with a confirmed native list, so models.dev stays metadata-only. */
function publishConfirmedCodexList() {
  const request = detectionStore.beginRefresh({
    contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
  });
  detectionStore.publish({
    request,
    result: {
      providers: [],
      cliTools: [cliDetectionFor('ready', 'codex')],
      catalog: CODEX_MODELS_DEV,
      cliModels: [
        {
          connection: { tool: 'codex', contextKey: 'c' },
          outcome: { kind: 'success', value: [{ id: 'gpt-5-codex' }] },
        },
      ],
      generation: 1,
    },
  });
}

let capturedRightRows: RightRow[] = [];

function RowsProbe() {
  capturedRightRows = usePickerCatalog('planner', 0, 'codex').rightRows;
  return <Text>rows</Text>;
}

function OllamaRowsProbe() {
  capturedRightRows = usePickerCatalog('implementer', 0, 'ollama').rightRows;
  return <Text>rows</Text>;
}

function CatalogProbe({
  role,
  selectedItemId,
}: {
  role: ActiveRunnerRole;
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
      {catalog.currentItem?.id}:
      {rowModels(catalog.rightRows)
        .map((model) => model.id)
        .join(',')}
    </Text>
  );
}

function CurrentSelectionProbe({ role }: { role: ActiveRunnerRole }) {
  const catalog = usePickerCatalog(role, 0, null);
  const current = catalog.items.find((item) => item.isCurrent);

  return (
    <Text>
      {catalog.roleLabel}|{current?.id ?? 'none'}|{catalog.persistedModel ?? 'none'}
    </Text>
  );
}

function ControlledCatalogPicker({ role }: { role: 'planner' | 'implementer' }) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const catalog = usePickerCatalog(role, 0, selectedItemId);

  return (
    <TwoColumnPicker<PickerOption, ModelOption>
      title="Picker"
      leftProps={{
        items: catalog.items,
        getKey: (item) => item.id,
        isDisabled: (item) => !item.available && item.kind !== 'custom-command',
        initialIndex: catalog.initialLeftIdx,
        renderRow: (item) => <Text>{item.displayName}</Text>,
      }}
      rightProps={{
        items: rowModels(catalog.rightRows),
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
      {rowModels(catalog.rightRows)
        .map((model) => model.id)
        .join(',') || 'none'}
    </Text>
  );
}

describe('usePickerCatalog', () => {
  beforeEach(() => {
    capturedRightRows = [];
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    pickerViewStore.reset();
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

  it('shows each planner-tier seat its own selection when the reviewer differs from the planner', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'planner-model' },
        reviewer: { kind: 'cli', tool: 'claude-code', model: 'reviewer-model' },
      }),
    });
    seedDetections();

    const reviewer = renderFeature(<CurrentSelectionProbe role="reviewer" />);
    await tick(20);
    expect(reviewer.lastFrame()).toContain(
      `${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS.reviewer]}|claude-code|reviewer-model`,
    );
    reviewer.unmount();

    const planner = renderFeature(<CurrentSelectionProbe role="planner" />);
    await tick(20);
    expect(planner.lastFrame()).toContain(
      `${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS.planner]}|codex|planner-model`,
    );
    planner.unmount();
  });

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
          {catalog.persistedModel ?? 'none'}|{catalog.modelCounts.confirmed}|
          {rowModels(catalog.rightRows).length}
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
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'implementer-last-confirmed-model',
        },
      }),
    });
    const implementerRuntime: ConfiguredProviderRuntime = {
      connection: { role: 'implementer', provider: 'ollama', contextKey: 'implementer-context' },
      state: 'stale',
      catalog: 'populated',
      models: [{ id: 'implementer-last-confirmed-model' }],
      fetchedAt: 1,
      validatedAt: 2,
      failure: 'timeout',
      diagnostic: 'Configured provider catalog refresh did not complete.',
    };
    const plannerRuntime: ConfiguredProviderRuntime = {
      connection: { role: 'planner', provider: 'ollama', contextKey: 'planner-context' },
      state: 'fresh',
      catalog: 'populated',
      models: [{ id: 'planner-confirmed-model' }],
      fetchedAt: 1,
      validatedAt: 2,
    };
    detectionStore.setDetection({
      cliTools: [],
      providers: [],
      providerOutcomes: [implementerRuntime, plannerRuntime],
    });
    let projection:
      | Readonly<{
          model: ModelOption | undefined;
          detected: number;
          counts: ReturnType<typeof usePickerCatalog>['modelCounts'];
        }>
      | undefined;

    function Probe() {
      const catalog = usePickerCatalog('implementer', 0, 'ollama');
      projection = {
        model: rowModels(catalog.rightRows).find(
          (model) => model.id === 'implementer-last-confirmed-model',
        ),
        detected: catalog.modelCounts.confirmed,
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
    expect(projection?.model?.id).not.toBe('planner-confirmed-model');

    detectionStore.setDetection({
      cliTools: [],
      providers: [],
      providerOutcomes: [
        {
          connection: implementerRuntime.connection,
          state: 'fresh',
          catalog: 'populated',
          models: [{ id: 'implementer-last-confirmed-model' }],
          fetchedAt: 3,
          validatedAt: 3,
        },
        plannerRuntime,
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
          connection: implementerRuntime.connection,
          state: 'fresh',
          catalog: 'empty',
          models: [],
          fetchedAt: 4,
          validatedAt: 4,
        },
        plannerRuntime,
      ],
    });
    ui.rerender(<Probe />);
    // An empty catalog drops the model from every lane, so the only row left
    // naming it is the recovery row the configured selection earns.
    expect(projection).toEqual({
      model: expect.objectContaining({ membership: 'custom' }),
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
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.com/v1',
          model: 'custom-endpoint-model',
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
      frames.push(
        rowModels(catalog.rightRows)
          .map((model) => model.id)
          .join(','),
      );
      return <ModelListProbe toolId={toolId} />;
    }

    const ui = renderFeature(<Probe toolId="ollama" />);
    expect(frames.at(-1)).toContain('ollama-only-model');
    expect(frames.at(-1)).not.toContain('lm-studio-only-model');

    ui.rerender(<Probe toolId="lm-studio" />);
    expect(frames.at(-1)).toContain('lm-studio-only-model');
    expect(frames.at(-1)).not.toContain('ollama-only-model');
    ui.unmount();
  });

  it('rapid tool selection never shows previous-tool model ids', async () => {
    seedDetections();
    const frames: string[] = [];
    function Probe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('implementer', 0, toolId);
      frames.push(
        `${catalog.currentItem?.id}:${
          rowModels(catalog.rightRows)
            .map((model) => model.id)
            .join('|') || 'empty'
        }`,
      );
      return <Text>{frames.at(-1)}</Text>;
    }

    const ui = renderFeature(<Probe toolId="ollama" />);
    const toolSequence = ['lm-studio', 'ollama', 'lm-studio', 'ollama'] as const;
    for (const toolId of toolSequence) {
      ui.rerender(<Probe toolId={toolId} />);
    }

    const lmStudioMarker = 'lm-studio-only-model';
    const ollamaMarker = 'ollama-only-model';
    // A leaked previous-tool model shows up as a frame carrying both tools' ids,
    // or as a frame pairing one tool with the other tool's models.
    for (const frame of frames) {
      expect(frame.includes(lmStudioMarker) && frame.includes(ollamaMarker)).toBe(false);
    }
    expect(frames.some((frame) => frame.startsWith('lm-studio:'))).toBe(true);
    expect(frames.filter((frame) => frame.startsWith('lm-studio:'))).not.toContainEqual(
      expect.stringContaining(ollamaMarker),
    );
    expect(frames.filter((frame) => frame.startsWith('ollama:'))).not.toContainEqual(
      expect.stringContaining(lmStudioMarker),
    );
    expect(frames.at(-1)).toMatch(/^ollama:/);
    expect(frames.at(-1)).toContain(ollamaMarker);
    expect(frames.at(-1)).not.toContain(lmStudioMarker);
    ui.unmount();
  });

  it('mouse target changes update models without a previous-tool model frame', async () => {
    seedDetections();
    const ui = renderFeature(<ControlledCatalogPicker role="implementer" />);
    await flushEffects();

    const zones = collectClickableZones({ cols: 140, rows: 40 });
    zones.get('runner-left:lm-studio')?.();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('lm-studio-only-model');
      expect(ui.lastFrame()).not.toContain('ollama-only-model');
    });

    zones.get('runner-left:ollama')?.();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('ollama-only-model');
      expect(ui.lastFrame()).not.toContain('lm-studio-only-model');
    });
    ui.unmount();
  });

  it('re-derives the axis values from the option draft the store is holding', async () => {
    // The hook is the only path from the store's draft to a rendered axis value:
    // the rows come back from `buildRightRows`, not from a fixture.
    const zeta = [
      { id: 'zeta-low' },
      { id: 'zeta-high' },
      { id: 'zeta-max' },
      { id: 'zeta-low-fast' },
      { id: 'zeta-high-fast' },
      { id: 'zeta-max-fast' },
    ];
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'zeta-high',
        },
      }),
    });
    detectionStore.setDetection({
      cliTools: [],
      providers: [{ provider: 'ollama', available: true, isLocal: true, models: zeta }],
    });
    modelCacheStore.setProviderModels('ollama', zeta);
    pickerViewStore.expand('zeta-high', 'zeta-high');

    function AxisProbe() {
      const catalog = usePickerCatalog('implementer', 0, 'ollama');
      return (
        <Text>
          {catalog.rightRows
            .filter((row) => row.kind === 'axis')
            .map((row) => `${row.axis}=${row.value}`)
            .join(',') || 'no-axis-rows'}
        </Text>
      );
    }

    const ui = renderFeature(<AxisProbe />);
    await tick(20);
    expect(ui.lastFrame()).toContain('effort=high,fast=off');

    pickerViewStore.setOptionDraftId('zeta-max-fast');
    await tick(20);
    expect(ui.lastFrame()).toContain('effort=max,fast=on');
    ui.unmount();
  });

  it('raises no effort axis on an api seat, whose channel has no field to write one', async () => {
    // The provider publishes a ladder, but an api seat drops the level on save, so
    // offering one here would draft a value the commit cannot keep.
    const zeta = [{ id: 'zeta', nativeReasoningEfforts: ['low', 'high'] }];
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'zeta',
        },
      }),
    });
    detectionStore.setDetection({
      cliTools: [],
      providers: [{ provider: 'ollama', available: true, isLocal: true, models: zeta }],
    });
    modelCacheStore.setProviderModels('ollama', zeta);
    pickerViewStore.expand('zeta');

    function LadderProbe() {
      const catalog = usePickerCatalog('implementer', 0, 'ollama');
      return (
        <Text>
          {catalog.rightRows
            .filter((row) => row.kind === 'axis')
            .map((row) => row.axis)
            .join(',') || 'no-axis-rows'}
        </Text>
      );
    }

    const ui = renderFeature(<LadderProbe />);
    await tick(20);

    expect(ui.lastFrame()).toContain('no-axis-rows');
    ui.unmount();
  });

  it('passes the drafted variant through to the row builder', async () => {
    // The variant axis is synthetic: nothing in the model id spells it, so the model's
    // own published ladder raises the row and the store's draft puts a value on it.
    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
    });
    detectionStore.publish({
      request,
      result: {
        providers: [],
        cliTools: [cliDetectionFor('ready', 'opencode')],
        catalog: {},
        cliModels: [
          {
            connection: { tool: 'opencode', contextKey: 'c' },
            outcome: {
              kind: 'success',
              value: [{ id: 'anthropic/claude-sonnet-4', nativeReasoningEfforts: ['high', 'max'] }],
            },
          },
        ],
        generation: 1,
      },
    });
    pickerViewStore.expand('anthropic/claude-sonnet-4', undefined, 'max');

    let variantRow: Extract<RightRow, { kind: 'axis' }> | undefined;
    function VariantProbe() {
      const catalog = usePickerCatalog('planner', 0, 'opencode');
      variantRow = catalog.rightRows.find(
        (row): row is Extract<RightRow, { kind: 'axis' }> =>
          row.kind === 'axis' && row.axis === 'effort',
      );
      return <Text>{catalog.effortDraft ?? 'none'}</Text>;
    }

    const ui = renderFeature(<VariantProbe />);
    await tick(20);

    expect(ui.lastFrame()).toContain('max');
    expect(variantRow).toMatchObject({ axis: 'effort', value: 'max' });

    pickerViewStore.setEffortDraft('high');
    await tick(20);

    expect(variantRow).toMatchObject({ axis: 'effort', value: 'high' });
    ui.unmount();
  });

  it('arrow-key selection updates models without a previous-tool model frame', async () => {
    seedDetections();
    const ui = renderFeature(<KeyboardCatalogProbe role="implementer" />);
    await flushEffects();
    const initial = ui.lastFrame() ?? '';
    expect(initial).toContain('ollama:');
    expect(initial).toContain('ollama-only-model');

    await flushEffects();
    ui.stdin.write('\u001B[B');
    await flushEffects();

    const next = ui.lastFrame() ?? '';
    expect(next).toContain('codex:');
    expect(next).not.toContain('ollama-only-model');
    ui.unmount();
  });

  it('replaces the bundled fallback with the native list and never shows models.dev rows', async () => {
    modelCacheStore.hydrateModelsDevCatalog({
      catalog: CODEX_MODELS_DEV,
      fetchedAt: 100,
      validatedAt: 100,
    });
    detectionStore.setDetection({
      cliTools: [cliDetectionFor('ready', 'codex')],
      providers: [],
    });

    let catalogSnapshot: ReturnType<typeof usePickerCatalog> | undefined;
    function CodexCatalogProbe() {
      catalogSnapshot = usePickerCatalog('planner', 0, 'codex');
      return (
        <Text>
          {rowModels(catalogSnapshot.rightRows)
            .map((m) => m.id)
            .join(',')}
        </Text>
      );
    }

    const ui = renderFeature(<CodexCatalogProbe />);
    await tick(20);

    // Before the probe the column falls back to the bundled table. A CLI tool never renders
    // models.dev rows (REQ-B08), so the hydrated catalog contributes none of its ids.
    const preProbeRows = rowModels(catalogSnapshot?.rightRows ?? []);
    const preProbeIds = preProbeRows.map((model) => model.id);
    expect(preProbeRows.some((model) => model.membership === 'bundled-suggestion')).toBe(true);
    for (const catalogOnlyId of ['gpt-4o', 'gpt-4.5-preview', 'o3-mini']) {
      expect(preProbeIds, catalogOnlyId).not.toContain(catalogOnlyId);
    }
    expect(preProbeRows.filter((m) => m.membership === 'confirmed')).toHaveLength(0);
    expect(preProbeRows.filter((m) => m.membership === CATALOG_SUGGESTION_MEMBERSHIP)).toHaveLength(
      0,
    );

    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
    });
    detectionStore.publish({
      request,
      result: {
        providers: [],
        cliTools: [cliDetectionFor('ready', 'codex')],
        catalog: null,
        cliModels: [
          {
            connection: { tool: 'codex', contextKey: 'c' },
            outcome: { kind: 'success', value: [{ id: 'gpt-5-codex' }] },
          },
        ],
        generation: 1,
      },
    });
    await tick(20);

    const postProbeRows = rowModels(catalogSnapshot?.rightRows ?? []);
    const postProbeIds = postProbeRows.map((model) => model.id);

    expect(postProbeIds).toContain('gpt-5-codex');
    expect(postProbeIds).not.toContain('gpt-4o');
    expect(postProbeIds).not.toContain('gpt-4.5-preview');
    expect(postProbeIds).not.toContain('o3-mini');

    const confirmedRows = postProbeRows.filter((row) => row.membership === 'confirmed');
    expect(confirmedRows).toHaveLength(1);
    expect(confirmedRows[0]?.id).toBe('gpt-5-codex');
    expect(confirmedRows[0]?.isDetected).toBe(true);
    expect(
      postProbeRows.filter((row) => row.membership === CATALOG_SUGGESTION_MEMBERSHIP),
    ).toHaveLength(0);

    ui.unmount();
  });

  it('offers no browse-catalog row when the configured model is merely missing from the list', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.6-retired' },
      }),
    });
    publishConfirmedCodexList();

    const ui = renderFeature(<RowsProbe />);
    await tick(20);

    expect(capturedRightRows.some((row) => row.kind === 'action')).toBe(false);
    ui.unmount();
  });

  it('offers the browse-catalog row where browsing widens: an api runner whose bundled row the live lane hides', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
        },
      }),
    });
    detectionStore.setDetection({
      cliTools: [],
      providers: [{ provider: 'ollama', available: true, isLocal: true, models: [] }],
    });
    modelCacheStore.hydrateModelsDevCatalog({
      catalog: {
        ollama: { id: 'ollama', models: { 'llama-9': { id: 'llama-9', name: 'Llama 9' } } },
      },
      fetchedAt: 1,
      validatedAt: 1,
    });

    const ui = renderFeature(<OllamaRowsProbe />);
    await tick(20);

    expect(rowModels(capturedRightRows).map((model) => model.id)).not.toContain('qwen3-coder:30b');
    expect(capturedRightRows.at(-1)).toMatchObject({ kind: 'action', action: 'browse-catalog' });

    pickerViewStore.setBrowseCatalog(true);
    await tick(20);

    expect(rowModels(capturedRightRows).map((model) => model.id)).toContain('qwen3-coder:30b');
    expect(capturedRightRows.some((row) => row.kind === 'action')).toBe(false);
    ui.unmount();
  });

  it('keeps a cli tool on its native rows once the catalog is being browsed', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.6-retired' },
      }),
    });
    publishConfirmedCodexList();

    const ui = renderFeature(<RowsProbe />);
    await tick(20);
    const narrowModelCount = rowModels(capturedRightRows).length;

    pickerViewStore.setBrowseCatalog(true);
    await tick(20);

    // Browsing retires the escape row. It reopens no lane for a CLI tool: its rows are its own
    // listing plus the bundled table, and models.dev is not a lane it ever reads (REQ-B08).
    expect(capturedRightRows.some((row) => row.kind === 'action')).toBe(false);
    expect(rowModels(capturedRightRows).length).toBe(narrowModelCount);
    ui.unmount();
  });
});

describe('usePickerCatalog right-column entry point', () => {
  let seen: {
    lane: string;
    leftId: string | undefined;
    rightId: string | undefined;
    rightIndex: number;
    rowIds: string[];
  } | null = null;

  function EntryProbe() {
    const catalog = usePickerCatalog('planner', 0, null);
    const row = catalog.rightRows[catalog.initialRightIndex];
    seen = {
      lane: catalog.catalogLane,
      leftId: catalog.items[catalog.initialLeftIdx]?.id,
      rightId: row?.kind === 'model' ? row.model.id : undefined,
      rightIndex: catalog.initialRightIndex,
      rowIds: catalog.rightRows.map((r) => (r.kind === 'model' ? r.model.id : `#${r.kind}`)),
    };
    return <Text>probe</Text>;
  }

  beforeEach(() => {
    seen = null;
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.5' },
      }),
    });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    pickerViewStore.reset();
    seedDetections();
  });

  it('reports the models.dev lane as pending until a catalog lands', () => {
    const ui = renderFeature(<EntryProbe />);

    expect(seen?.lane).toBe('pending');
    ui.unmount();
  });

  it('opens on the persisted model rather than the first row', () => {
    const ui = renderFeature(<EntryProbe />);

    // The Auto row is pinned at 0 and the bundled aliases follow it, so a
    // persisted model can only be reached by an index the hook computed.
    expect(seen?.rowIds[0]).toBe('auto');
    expect(seen?.rightIndex).toBeGreaterThan(0);
    expect(seen?.rowIds[seen.rightIndex]).toBe('gpt-5.5');
    expect(seen?.rightId).toBe('gpt-5.5');
    ui.unmount();
  });

  it('opens on the recovery row when the persisted model is not in the catalog', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'a-model-no-catalog-lists' },
      }),
    });
    const ui = renderFeature(<EntryProbe />);

    expect(seen?.rowIds[seen.rightIndex]).toBe('a-model-no-catalog-lists');
    ui.unmount();
  });

  // A 126-row CLI catalog is the case the pinned Auto row and the section
  // headers make hard: the configured model sits deep in the list.
  const PERSISTED_KILO_MODEL = 'kilo/model-100';
  const KILO_MODELS = Array.from(
    { length: 126 },
    (_, index) => `kilo/model-${String(index).padStart(3, '0')}`,
  );

  it('opens on the persisted model inside a 126-row CLI catalog', () => {
    detectionStore.reset();
    modelCacheStore.reset();
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'kilo-code', model: PERSISTED_KILO_MODEL },
      }),
    });
    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
    });
    detectionStore.publish({
      request,
      result: {
        providers: [],
        cliTools: [cliDetectionFor('ready', 'kilo-code')],
        catalog: {},
        cliModels: [
          {
            connection: { tool: 'kilo-code', contextKey: 'c' },
            outcome: { kind: 'success', value: KILO_MODELS.map((id) => ({ id })) },
          },
        ],
        generation: 1,
      },
    });

    const ui = renderFeature(<EntryProbe />);

    expect(seen?.rowIds).toContain(PERSISTED_KILO_MODEL);
    expect(seen?.rightIndex).toBeGreaterThan(0);
    expect(seen?.rowIds[seen.rightIndex]).toBe(PERSISTED_KILO_MODEL);
    ui.unmount();
  });

  it('opens on the tool the overlay focus names', () => {
    overlayStore.setFocus('tool:codex');
    const ui = renderFeature(<EntryProbe />);

    expect(seen?.leftId).toBe('codex');
    ui.unmount();
  });
});

describe('usePickerCatalog seat-axis landing', () => {
  let landing: {
    rightIndex: number;
    rowKind: string | undefined;
    axisName: string | undefined;
    modelId: string | undefined;
    focusModels: boolean;
    axisIndex: number;
    modelIndex: number;
  } | null = null;

  function AxisProbe() {
    const catalog = usePickerCatalog('planner', 0, null);
    const row = catalog.rightRows[catalog.initialRightIndex];
    landing = {
      rightIndex: catalog.initialRightIndex,
      rowKind: row?.kind,
      axisName: row?.kind === 'axis' ? row.axis : undefined,
      modelId: row?.kind === 'model' ? row.model.id : undefined,
      focusModels: catalog.focusModels,
      axisIndex: catalog.rightRows.findIndex((r) => r.kind === 'axis' && r.axis === 'effort'),
      modelIndex: catalog.rightRows.findIndex(
        (r) => r.kind === 'model' && r.model.id === catalog.currentModel,
      ),
    };
    return <Text>probe</Text>;
  }

  beforeEach(() => {
    landing = null;
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
      }),
    });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    pickerViewStore.reset();
    seedDetections();
  });

  it('lands on the effort axis when the token names this picker seat', () => {
    pickerViewStore.expand('opus');
    overlayStore.setFocus(seatAxisFocus('plan'));
    const ui = renderFeature(<AxisProbe />);

    expect(landing?.axisIndex).toBeGreaterThanOrEqual(0);
    expect(landing?.rightIndex).toBe(landing?.axisIndex);
    expect(landing?.rowKind).toBe('axis');
    expect(landing?.axisName).toBe('effort');
    expect(landing?.focusModels).toBe(true);
    ui.unmount();
  });

  it('falls back to the persisted model row when there is no axis row', () => {
    overlayStore.setFocus(seatAxisFocus('plan'));
    const ui = renderFeature(<AxisProbe />);

    expect(landing?.axisIndex).toBe(-1);
    expect(landing?.rowKind).toBe('model');
    expect(landing?.modelId).toBe('opus');
    expect(landing?.rightIndex).toBe(landing?.modelIndex);
    expect(landing?.focusModels).toBe(true);
    ui.unmount();
  });

  it('a token naming another seat changes nothing', () => {
    pickerViewStore.expand('opus');
    overlayStore.setFocus(seatAxisFocus('build'));
    const ui = renderFeature(<AxisProbe />);

    expect(landing?.axisIndex).toBeGreaterThanOrEqual(0);
    expect(landing?.rightIndex).not.toBe(landing?.axisIndex);
    expect(landing?.rightIndex).toBe(landing?.modelIndex);
    expect(landing?.rowKind).toBe('model');
    expect(landing?.modelId).toBe('opus');
    expect(landing?.focusModels).toBe(false);
    ui.unmount();
  });

  it('a token that merely ends in :effort changes nothing', () => {
    pickerViewStore.expand('opus');
    // 'effort:plan' is Settings' own crew-row key, not this grammar.
    overlayStore.setFocus('effort:plan');
    const ui = renderFeature(<AxisProbe />);

    expect(landing?.axisIndex).toBeGreaterThanOrEqual(0);
    expect(landing?.rightIndex).not.toBe(landing?.axisIndex);
    expect(landing?.rightIndex).toBe(landing?.modelIndex);
    expect(landing?.rowKind).toBe('model');
    expect(landing?.focusModels).toBe(false);
    ui.unmount();
  });

  it('the helpers spell and parse one grammar', () => {
    expect(seatAxisFocus('plan')).toBe('seat:plan:effort');
    expect(seatAxisFocusSeat('seat:plan:effort')).toBe('plan');
    expect(seatAxisFocusSeat('seat:build:effort')).toBe('build');
  });

  it('the helpers reject every token that is not ours', () => {
    expect(seatAxisFocusSeat(undefined)).toBeUndefined();
    expect(seatAxisFocusSeat('effort:plan')).toBeUndefined();
    expect(seatAxisFocusSeat('tool:claude-code')).toBeUndefined();
    expect(seatAxisFocusSeat('seat:plan')).toBeUndefined();
    expect(seatAxisFocusSeat('seat::effort')).toBeUndefined();
  });
});
