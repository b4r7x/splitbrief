import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../../stores/project/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { detectionStore } from '../../../stores/discovery/detection.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { TwoColumnPicker } from '../two-column-picker/picker.js';
import { seatAxisFocus, seatAxisFocusSeat } from '../../../core/navigation/types.js';
import { usePickerCatalog } from './use-catalog.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { PICKER_ROLE_SEAT_IDS, type ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { PickerOption } from '../model-catalog/options.js';
import { rightRowKey } from '../model-catalog/rows.js';
import { planModelRows } from '../model-catalog/row-plan.js';
import type { RightRow } from '../model-catalog/types.js';
import type { ModelOption } from '../model-catalog/recency.js';
import { CATALOG_SUGGESTION_MEMBERSHIP } from '../../../engine/providers/model/suggestions.js';
import { parseCursorNativeModelCatalog } from '../../../engine/runners/cli-tools/probe/native-catalog/listing.js';
import { parseOpenCodeNativeModelCatalog } from '../../../engine/runners/cli-tools/probe/native-catalog/opencode.js';
import { nativeCliCatalogToDetectedModels } from '../../../engine/runners/cli-tools/probe/native-catalog/entries.js';
import type { NativeCliModelCatalog } from '../../../engine/runners/cli-tools/probe/native-catalog/entries.js';

import { formatModelCatalogGuidance } from './catalog-guidance.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { CLI_TOOL_CATALOG, isCliToolId } from '../../../core/runners/cli-tool/catalog.js';
import { glyph } from '../../../lib/glyphs.js';
import { modelRowModel } from '../tool-row.js';
import { ListRowFixture } from '#testing/helpers/list-row.js';

/** The models behind the rows the picker actually renders. */
function rowModels(rows: readonly RightRow[]) {
  return rows.filter((row) => row.kind === 'model').map((row) => row.model);
}

function seedDetections() {
  detectionStore.setDetection({
    cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
    providers: [],
  });
}

describe('usePickerCatalog fallback slot', () => {
  let catalog: ReturnType<typeof usePickerCatalog> | undefined;

  function FallbackProbe({ role }: { role: ActiveRunnerRole }) {
    catalog = usePickerCatalog(role, 'fallback', 0);
    return <Text>fallback</Text>;
  }

  beforeEach(() => {
    catalog = undefined;
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
    });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    pickerViewStore.reset();
    seedDetections();
  });

  it('lists current None first and only implementer-capable CLI tools after it', () => {
    const ui = renderFeature(<FallbackProbe role="implementer" />);

    expect(catalog?.items[0]).toMatchObject({
      kind: 'no-fallback',
      id: 'no-fallback',
      isCurrent: true,
    });
    expect(catalog?.items.length).toBeGreaterThan(1);
    for (const item of catalog?.items.slice(1) ?? []) {
      expect(item.kind).toBe('cli');
      expect(isCliToolId(item.id)).toBe(true);
      if (isCliToolId(item.id)) {
        expect(CLI_TOOL_CATALOG[item.id].roles).toContain('implementer');
      }
    }
    ui.unmount();
  });

  it('reads the fallback tool and model', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'opus',
          customModels: ['seat-only-model'],
          fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
        },
      }),
    });
    pickerViewStore.expand('gpt-5-codex');
    const ui = renderFeature(<FallbackProbe role="planner" />);

    expect(catalog?.items.find((item) => item.id === 'codex')?.isCurrent).toBe(true);
    expect(catalog?.items.find((item) => item.id === 'claude-code')?.isCurrent).toBe(false);
    expect(catalog?.savedRunner).toEqual({
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-5-codex',
      effort: 'high',
    });
    expect(catalog?.persistedModel).toBe('gpt-5-codex');
    expect(catalog?.customModels).toEqual([]);
    expect(rowModels(catalog?.rightRows ?? []).map((model) => model.id)).toContain('gpt-5-codex');
    ui.unmount();
  });

  it('offers no inherit-planner row for an inherited REVIEW fallback', () => {
    const ui = renderFeature(<FallbackProbe role="reviewer" />);

    expect(catalog?.items.some((item) => item.kind === 'inherit-planner')).toBe(false);
    ui.unmount();
  });

  it('retains the fallback model absent from the catalog without borrowing seat custom models', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          customModels: ['seat-only-model'],
          fallback: { tool: 'codex', model: 'private-codex-model' },
        },
      }),
    });
    const ui = renderFeature(<FallbackProbe role="planner" />);

    const models = rowModels(catalog?.rightRows ?? []).map((model) => model.id);
    expect(models).toContain('private-codex-model');
    expect(models).not.toContain('seat-only-model');
    expect(catalog?.currentModel).toBe('private-codex-model');
    ui.unmount();
  });
});

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

/** Ready Claude Code, Codex and Cursor; Codex and Cursor each list a model the other lacks. */
function publishDisjointCliLists() {
  const request = detectionStore.beginRefresh({
    contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
  });
  detectionStore.publish({
    request,
    result: {
      providers: [],
      cliTools: [
        cliDetectionFor('ready', 'claude-code'),
        cliDetectionFor('ready', 'codex'),
        cliDetectionFor('ready', 'cursor'),
      ],
      catalog: null,
      cliModels: [
        {
          connection: { tool: 'codex', contextKey: 'c' },
          outcome: { kind: 'success', value: [{ id: 'codex-only-model' }] },
        },
        {
          connection: { tool: 'cursor', contextKey: 'c' },
          outcome: { kind: 'success', value: [{ id: 'cursor-only-model' }] },
        },
      ],
      generation: 1,
    },
  });
}

let capturedRightRows: RightRow[] = [];

function RowsProbe() {
  capturedRightRows = usePickerCatalog('planner', 'seat', 0, 'codex').rightRows;
  return <Text>rows</Text>;
}

function CatalogProbe({
  role,
  selectedItemId,
}: {
  role: ActiveRunnerRole;
  selectedItemId?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 'seat', 0, selectedItemId ?? null);

  return (
    <Text>
      {role}:{catalog.currentItem?.id ?? 'none'}:{catalog.currentModel ?? 'none'}
    </Text>
  );
}

function ModelListProbe({ toolId }: { toolId: string }) {
  const catalog = usePickerCatalog('implementer', 'seat', 0, toolId);

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
  const catalog = usePickerCatalog(role, 'seat', 0, null);
  const current = catalog.items.find((item) => item.isCurrent);

  return (
    <Text>
      {catalog.roleLabel}|{current?.id ?? 'none'}|{catalog.persistedModel ?? 'none'}
    </Text>
  );
}

function ControlledCatalogPicker({
  role,
  onFrame,
}: {
  role: 'planner' | 'implementer';
  onFrame?: ((frame: string) => void) | undefined;
}) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const catalog = usePickerCatalog(role, 'seat', 0, selectedItemId);
  const modelIds = rowModels(catalog.rightRows)
    .map((model) => model.id)
    .join('|');
  onFrame?.(`${catalog.currentItem?.id}:${modelIds}`);

  return (
    <TwoColumnPicker<PickerOption, ModelOption>
      title="Picker"
      leftProps={{
        minRowWidth: 28,
        items: catalog.items,
        getKey: (item) => item.id,
        isDisabled: (item) => !item.available,
        initialIndex: catalog.initialLeftIdx,
        rowModel: (item) => ({ name: item.displayName }),
      }}
      rightProps={{
        items: rowModels(catalog.rightRows),
        getKey: (model) => model.id,
        rowModel: (model) => ({ name: model.id }),
        onLeftChange: (item) => setSelectedItemId(item.id),
      }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

function KeyboardCatalogProbe({ role }: { role: 'planner' | 'implementer' }) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const catalog = usePickerCatalog(role, 'seat', 0, selectedItemId);
  const toolIds = catalog.items.filter((item) => item.available).map((item) => item.id);
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

describe('usePickerCatalog the REVIEW None row', () => {
  let catalog: ReturnType<typeof usePickerCatalog> | undefined;

  function ReviewSeatProbe() {
    catalog = usePickerCatalog('reviewer', 'seat', 0);
    return <Text>review seat</Text>;
  }

  function seedSeat(config: ReturnType<typeof makeConfig>) {
    catalog = undefined;
    configStore.__testReset({ projectDir: '/tmp/project', config });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    pickerViewStore.reset();
    seedDetections();
  }

  it('None row and current mark', () => {
    seedSeat(makeConfig({ planner: { kind: 'cli', tool: 'claude-code' }, reviewer: 'none' }));

    const ui = renderFeature(<ReviewSeatProbe />);
    const items = catalog?.items ?? [];

    expect(items.slice(0, 2).map((item) => item.kind)).toEqual(['inherit-planner', 'review-none']);
    expect(items[1]?.displayName).toBe('None');
    expect(items.filter((item) => item.isCurrent === true).map((item) => item.kind)).toEqual([
      'review-none',
    ]);
    ui.unmount();
  });

  it('keeps None and the current inheritance row with a custom planner', () => {
    seedSeat(makeConfig({ planner: { kind: 'shell', command: './plan.sh' } }));

    const ui = renderFeature(<ReviewSeatProbe />);
    const none = catalog?.items.find((item) => item.kind === 'review-none');
    const inherited = catalog?.items.find((item) => item.kind === 'inherit-planner');

    expect(inherited?.isCurrent).toBe(true);
    expect(none?.displayName).toBe('None');
    expect(none?.isCurrent).not.toBe(true);
    ui.unmount();
  });
});

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

  it.each([
    { tool: 'claude-code', expectedModel: 'auto', otherTool: 'codex' },
    { tool: 'codex', expectedModel: 'default', otherTool: 'claude-code' },
  ] as const)(
    'resolves the $tool seat default to $expectedModel and keeps its selection on re-entry',
    async ({ tool, expectedModel, otherTool }) => {
      configStore.__testReset({
        projectDir: '/tmp/project',
        config: makeConfig({ planner: { kind: 'cli', tool, model: 'default' } }),
      });
      seedDetections();
      let catalog: ReturnType<typeof usePickerCatalog> | undefined;
      function SeatProbe({ toolId }: { toolId?: string }) {
        const currentCatalog = usePickerCatalog('planner', 'seat', 0, toolId);
        catalog = currentCatalog;
        return (
          <Box flexDirection="column">
            {currentCatalog.rightRows
              .filter((row) => row.kind === 'model')
              .map((row) => (
                <Box key={row.model.id}>
                  <ListRowFixture
                    width={80}
                    {...modelRowModel({
                      row,
                      isCursor: false,
                      currentModel: currentCatalog.currentModel,
                      auth: {
                        providerAuth: currentCatalog.providerAuth,
                        catalog: currentCatalog.toolCatalog,
                        tool: undefined,
                      },
                      plan: planModelRows({ rows: [row], width: 80, providerId: undefined }),
                    })}
                  />
                </Box>
              ))}
          </Box>
        );
      }

      const ui = renderFeature(<SeatProbe />);
      try {
        await flushEffects();
        expect(catalog?.currentItem?.id).toBe(tool);
        expect(catalog?.persistedModel).toBe(expectedModel);
        expect(catalog?.currentModel).toBe(expectedModel);
        const models = rowModels(catalog?.rightRows ?? []);
        expect(models.filter((model) => model.id === 'auto')).toHaveLength(1);
        expect(
          ui
            .lastFrame()
            .split('\n')
            .filter((line) => /\bauto\b/.test(line)),
        ).toHaveLength(1);
        expect(models.some((model) => model.id === 'default')).toBe(tool === 'codex');
        const initialRow = catalog?.rightRows[catalog.initialRightIndex];
        expect(initialRow).toMatchObject({ kind: 'model', model: { id: expectedModel } });
        expect(
          ui
            .lastFrame()
            .split('\n')
            .filter((line) => line.includes(glyph('check'))),
        ).toEqual([expect.stringContaining(tool === 'claude-code' ? 'auto' : 'Default')]);

        ui.rerender(<SeatProbe toolId={otherTool} />);
        await flushEffects();
        expect(catalog?.currentItem?.id).toBe(otherTool);
        expect(catalog?.persistedModel).toBe(expectedModel);
        expect(catalog?.currentModel).toBeUndefined();
        expect(ui.lastFrame()).not.toContain(glyph('check'));
        const seatItem = catalog?.items.find((item) => item.id === tool);
        const reentryIndex = catalog?.resolveRightIndex(seatItem);
        expect(reentryIndex).toBeGreaterThanOrEqual(0);
        if (tool === 'claude-code') expect(reentryIndex).toBe(0);

        ui.rerender(<SeatProbe toolId={tool} />);
        await flushEffects();
        expect(catalog?.initialRightIndex).toBe(reentryIndex);
        expect(catalog?.rightRows[catalog.initialRightIndex]).toMatchObject({
          kind: 'model',
          model: { id: expectedModel },
        });
        expect(catalog?.currentModel).toBe(expectedModel);
        expect(ui.lastFrame()).toContain(glyph('check'));
      } finally {
        ui.unmount();
      }
    },
  );

  it("draws only the effort child under the open model of the seat's own tool", async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
      }),
    });
    seedDetections();
    pickerViewStore.expand('opus');
    function SeatProbe() {
      const catalog = usePickerCatalog('planner', 'seat', 0, 'claude-code');
      return (
        <Box flexDirection="column">
          {catalog.rightRows.map((row) => (
            <Box key={rightRowKey(row)}>
              <ListRowFixture
                width={80}
                {...modelRowModel({
                  row,
                  isCursor: false,
                  currentModel: catalog.currentModel,
                  auth: {
                    providerAuth: catalog.providerAuth,
                    catalog: catalog.toolCatalog,
                    tool: undefined,
                  },
                  plan: planModelRows({ rows: [row], width: 80, providerId: undefined }),
                })}
              />
            </Box>
          ))}
        </Box>
      );
    }

    const ui = renderFeature(<SeatProbe />);
    try {
      await flushEffects();
      const leads = [glyph('treeBranch'), glyph('treeLast')].map(
        (mark) => `${mark}${glyph('divider')} `,
      );
      const childLabels = ui
        .lastFrame()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => leads.some((lead) => line.startsWith(lead)))
        .map((line) => line.split(/\s+/).slice(0, 2).join(' '));
      expect(childLabels).toEqual([`${glyph('treeLast')}${glyph('divider')} effort`]);
    } finally {
      ui.unmount();
    }
  });

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

  it.each([
    { role: 'planner', runner: 'its own runner' },
    { role: 'reviewer', runner: 'the runner inherited from the planner' },
  ] as const)(
    "lists the $role seat's custom models only on the tool of $runner",
    async ({ role }) => {
      configStore.__testReset({
        projectDir: '/tmp/project',
        config: makeConfig({
          planner: { kind: 'cli', tool: 'codex', model: 'auto', customModels: ['team-model'] },
        }),
      });
      seedDetections();
      let catalog: ReturnType<typeof usePickerCatalog> | undefined;
      function SeatProbe({ toolId }: { toolId: string }) {
        catalog = usePickerCatalog(role, 'seat', 0, toolId);
        return <Text>seat</Text>;
      }

      const ui = renderFeature(<SeatProbe toolId="claude-code" />);
      try {
        await flushEffects();
        expect(catalog?.currentItem?.modelCapability.allowsCustom).toBe(true);
        expect(rowModels(catalog?.rightRows ?? []).map((model) => model.id)).not.toContain(
          'team-model',
        );
        expect(catalog?.customModels).toEqual([]);

        ui.rerender(<SeatProbe toolId="codex" />);
        await flushEffects();
        expect(
          rowModels(catalog?.rightRows ?? []).find((model) => model.id === 'team-model')?.isCustom,
        ).toBe(true);
        expect(catalog?.customModels).toEqual(['team-model']);
      } finally {
        ui.unmount();
      }
    },
  );

  it('marks no CLI row current for an API implementer that reuses the CLI id', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'opencode',
          service: 'opencode',
          offering: 'payg',
          apiBase: 'https://my-endpoint.example/v1',
          apiKey: 'sk-inline',
          model: 'gpt-5',
        },
      }),
    });
    seedDetections();

    const ui = renderFeature(<CurrentSelectionProbe role="implementer" />);
    await tick(20);

    expect(ui.lastFrame()).toContain(
      `${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS.implementer]}|none|gpt-5`,
    );
    ui.unmount();
  });

  it('marks the CLI row current for the CLI seat of that name', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ implementer: { kind: 'cli', tool: 'opencode', model: 'gpt-5' } }),
    });
    seedDetections();

    const ui = renderFeature(<CurrentSelectionProbe role="implementer" />);
    await tick(20);

    expect(ui.lastFrame()).toContain(
      `${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS.implementer]}|opencode|gpt-5`,
    );
    ui.unmount();
  });

  it('reports the persisted model regardless of the browsed tool, and only counts confirmed models as detected', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'codex', model: 'auto' } }),
    });
    seedDetections();

    function PersistedProbe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('planner', 'seat', 0, toolId);
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

  it('does not carry current tool selection from planner to implementer', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } }),
    });
    const ui = renderFeature(<CatalogProbe role="planner" selectedItemId="claude-code" />);
    await tick(20);
    expect(ui.lastFrame()).toContain('planner:claude-code');

    ui.rerender(<CatalogProbe role="implementer" />);
    await tick(20);

    expect(ui.lastFrame()).toContain('implementer:codex:gpt-5-codex');
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
          default: 'codex-build',
          profiles: {
            'codex-build': { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' },
          },
        },
      }),
    });

    let savedRunner: ReturnType<typeof usePickerCatalog>['savedRunner'] | undefined;
    function Probe() {
      const catalog = usePickerCatalog('implementer', 'seat', 0, null);
      savedRunner = catalog.savedRunner;
      return (
        <Text>
          implementer:{catalog.currentItem?.id ?? 'none'}:{catalog.currentModel ?? 'none'}
        </Text>
      );
    }

    const ui = renderFeature(<Probe />);
    await tick(20);

    expect(ui.lastFrame()).toContain('implementer:codex:gpt-5-codex');
    expect(savedRunner).toMatchObject({ kind: 'cli', tool: 'codex', model: 'gpt-5-codex' });
    expect(savedRunner).not.toMatchObject({
      provider: 'custom-endpoint',
      model: 'custom-endpoint-model',
    });
    ui.unmount();
  });

  it('derives right models in the same render as the selected tool', () => {
    publishDisjointCliLists();
    const frames: string[] = [];
    function Probe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('implementer', 'seat', 0, toolId);
      frames.push(
        rowModels(catalog.rightRows)
          .map((model) => model.id)
          .join(','),
      );
      return <ModelListProbe toolId={toolId} />;
    }

    const ui = renderFeature(<Probe toolId="codex" />);
    expect(frames.at(-1)).toContain('codex-only-model');
    expect(frames.at(-1)).not.toContain('cursor-only-model');

    ui.rerender(<Probe toolId="cursor" />);
    expect(frames.at(-1)).toContain('cursor-only-model');
    expect(frames.at(-1)).not.toContain('codex-only-model');
    ui.unmount();
  });

  it('rapid tool selection never shows previous-tool model ids', async () => {
    publishDisjointCliLists();
    const frames: string[] = [];
    function Probe({ toolId }: { toolId: string }) {
      const catalog = usePickerCatalog('implementer', 'seat', 0, toolId);
      frames.push(
        `${catalog.currentItem?.id}:${
          rowModels(catalog.rightRows)
            .map((model) => model.id)
            .join('|') || 'empty'
        }`,
      );
      return <Text>{frames.at(-1)}</Text>;
    }

    const ui = renderFeature(<Probe toolId="codex" />);
    const toolSequence = ['cursor', 'codex', 'cursor', 'codex'] as const;
    for (const toolId of toolSequence) {
      ui.rerender(<Probe toolId={toolId} />);
    }

    const cursorMarker = 'cursor-only-model';
    const codexMarker = 'codex-only-model';
    // A leaked previous-tool model shows up as a frame carrying both tools' ids,
    // or as a frame pairing one tool with the other tool's models.
    for (const frame of frames) {
      expect(frame.includes(cursorMarker) && frame.includes(codexMarker)).toBe(false);
    }
    expect(frames.some((frame) => frame.startsWith('cursor:'))).toBe(true);
    expect(frames.filter((frame) => frame.startsWith('cursor:'))).not.toContainEqual(
      expect.stringContaining(codexMarker),
    );
    expect(frames.filter((frame) => frame.startsWith('codex:'))).not.toContainEqual(
      expect.stringContaining(cursorMarker),
    );
    expect(frames.at(-1)).toMatch(/^codex:/);
    expect(frames.at(-1)).toContain(codexMarker);
    expect(frames.at(-1)).not.toContain(cursorMarker);
    ui.unmount();
  });

  it('mouse target changes update models without a previous-tool model frame', async () => {
    publishDisjointCliLists();
    const frames: string[] = [];
    const ui = renderFeature(
      <ControlledCatalogPicker role="implementer" onFrame={(frame) => frames.push(frame)} />,
    );
    await flushEffects();

    const zones = collectClickableZones({ cols: 140, rows: 40 });
    zones.get('runner-left:cursor')?.();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('cursor-only-model');
      expect(ui.lastFrame()).not.toContain('codex-only-model');
    });

    zones.get('runner-left:codex')?.();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('codex-only-model');
      expect(ui.lastFrame()).not.toContain('cursor-only-model');
    });

    const cursorFrames = frames.filter((frame) => frame.startsWith('cursor:'));
    const codexFrames = frames.filter((frame) => frame.startsWith('codex:'));
    expect(cursorFrames.length).toBeGreaterThan(0);
    expect(codexFrames.length).toBeGreaterThan(0);
    for (const frame of cursorFrames) {
      expect(frame).toContain('cursor-only-model');
      expect(frame).not.toContain('codex-only-model');
    }
    for (const frame of codexFrames) {
      expect(frame).toContain('codex-only-model');
      expect(frame).not.toContain('cursor-only-model');
    }
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
      config: makeConfig({ implementer: { kind: 'cli', tool: 'cursor', model: 'zeta-high' } }),
    });
    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
    });
    detectionStore.publish({
      request,
      result: {
        providers: [],
        cliTools: [cliDetectionFor('ready', 'cursor')],
        catalog: null,
        cliModels: [
          {
            connection: { tool: 'cursor', contextKey: 'c' },
            outcome: { kind: 'success', value: zeta },
          },
        ],
        generation: 1,
      },
    });
    pickerViewStore.expand('zeta-high', 'zeta-high');

    function AxisProbe() {
      const catalog = usePickerCatalog('implementer', 'seat', 0, 'cursor');
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
      const catalog = usePickerCatalog('planner', 'seat', 0, 'opencode');
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
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
    });
    publishDisjointCliLists();
    const ui = renderFeature(<KeyboardCatalogProbe role="implementer" />);
    await flushEffects();
    const initial = ui.lastFrame() ?? '';
    expect(initial).toContain('codex:');
    expect(initial).toContain('codex-only-model');

    await flushEffects();
    ui.stdin.write('\u001B[B');
    await flushEffects();

    const next = ui.lastFrame() ?? '';
    expect(next).toContain('claude-code:');
    expect(next).not.toContain('codex-only-model');
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
      catalogSnapshot = usePickerCatalog('planner', 'seat', 0, 'codex');
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
    const catalog = usePickerCatalog('planner', 'seat', 0, null);
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
    routePrefix: string | undefined;
    modelId: string | undefined;
    focusModels: boolean;
    axisIndex: number;
    modelIndex: number;
    effortRoutes: string[];
  } | null = null;

  function AxisProbe() {
    const catalog = usePickerCatalog('planner', 'seat', 0, null);
    const row = catalog.rightRows[catalog.initialRightIndex];
    landing = {
      rightIndex: catalog.initialRightIndex,
      rowKind: row?.kind,
      axisName: row?.kind === 'axis' ? row.axis : undefined,
      routePrefix: row?.kind === 'axis' ? row.providerPrefix : undefined,
      modelId: row?.kind === 'model' ? row.model.id : undefined,
      focusModels: catalog.focusModels,
      axisIndex: catalog.rightRows.findIndex((r) => r.kind === 'axis' && r.axis === 'effort'),
      modelIndex: catalog.rightRows.findIndex(
        (r) => r.kind === 'model' && r.model.id === catalog.currentModel,
      ),
      effortRoutes: catalog.rightRows.flatMap((r) =>
        r.kind === 'axis' && r.axis === 'effort' ? [r.providerPrefix] : [],
      ),
    };
    return <Text>probe</Text>;
  }

  const EFFORTS = ['low', 'medium', 'high'];

  /** The PLAN seat runs `openai/gpt-5.5` on Kilo, which lists that model on two routes in this order. */
  function seatOnKiloRoutes(listing: { id: string; nativeReasoningEfforts?: string[] }[]) {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'kilo-code', model: 'openai/gpt-5.5' },
      }),
    });
    detectionStore.reset();
    modelCacheStore.reset();
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
            outcome: { kind: 'success', value: listing },
          },
        ],
        generation: 1,
      },
    });
    pickerViewStore.expand('openai/gpt-5.5');
    overlayStore.setFocus(seatAxisFocus('plan'));
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

  it("lands on the effort row of the seat's own route when another route is listed first", () => {
    seatOnKiloRoutes([
      { id: 'github-copilot/gpt-5.5', nativeReasoningEfforts: EFFORTS },
      { id: 'openai/gpt-5.5', nativeReasoningEfforts: EFFORTS },
    ]);
    const ui = renderFeature(<AxisProbe />);

    expect(landing?.effortRoutes).toEqual(['github-copilot', 'openai']);
    expect(landing).toMatchObject({ rowKind: 'axis', axisName: 'effort', routePrefix: 'openai' });
    expect(landing?.focusModels).toBe(true);
    ui.unmount();
  });

  it("lands on the effort row of the seat's own route when that route is listed first", () => {
    seatOnKiloRoutes([
      { id: 'openai/gpt-5.5', nativeReasoningEfforts: EFFORTS },
      { id: 'github-copilot/gpt-5.5', nativeReasoningEfforts: EFFORTS },
    ]);
    const ui = renderFeature(<AxisProbe />);

    expect(landing?.effortRoutes).toEqual(['openai', 'github-copilot']);
    expect(landing).toMatchObject({ rowKind: 'axis', axisName: 'effort', routePrefix: 'openai' });
    ui.unmount();
  });

  it("lands on the seat's model row when only another route has an effort row", () => {
    seatOnKiloRoutes([
      { id: 'github-copilot/gpt-5.5', nativeReasoningEfforts: EFFORTS },
      { id: 'openai/gpt-5.5' },
    ]);
    const ui = renderFeature(<AxisProbe />);

    expect(landing?.effortRoutes).toEqual(['github-copilot']);
    expect(landing?.rowKind).toBe('model');
    expect(landing?.modelId).toBe('openai/gpt-5.5');
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

/** A tool's own captured listing, published the way detection publishes it. */
function publishCapturedListing(
  tool: 'opencode' | 'cursor',
  path: string,
  parse: (stdout: string) => NativeCliModelCatalog | null,
) {
  const catalog = parse(
    readFileSync(join(import.meta.dirname, '../../../../testing/fixtures', path), 'utf8'),
  );
  if (catalog === null) throw new Error(`the ${tool} capture did not parse`);
  const request = detectionStore.beginRefresh({
    contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
  });
  detectionStore.publish({
    request,
    result: {
      providers: [],
      cliTools: [cliDetectionFor('ready', tool)],
      catalog: {},
      cliModels: [
        {
          connection: { tool, contextKey: 'c' },
          outcome: { kind: 'success', value: nativeCliCatalogToDetectedModels(catalog) },
        },
      ],
      generation: 1,
    },
  });
}

describe('usePickerCatalog count', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    pickerViewStore.reset();
  });

  it('counts the rows the list shows, not the models it leaves out', async () => {
    // `opencode api GET /api/model` on opencode 2.0.14: 118 models, four of them image ones.
    publishCapturedListing(
      'opencode',
      'opencode/api-model-full.json',
      parseOpenCodeNativeModelCatalog,
    );
    let catalog: ReturnType<typeof usePickerCatalog> | undefined;
    function CountProbe() {
      catalog = usePickerCatalog('planner', 'seat', 0, 'opencode');
      return <Text>count</Text>;
    }

    const ui = renderFeature(<CountProbe />);
    await tick(20);

    const shown = rowModels(catalog?.rightRows ?? []).filter(
      (model) => !isAutomaticModel(model.id),
    );
    expect(shown.map((model) => model.id)).not.toContain('openai/gpt-image-1.5');
    expect(catalog?.modelRowCount).toBe(shown.length);
    ui.unmount();
  });

  it("states one count for Cursor's 240 ids: the 37 models its rows show", async () => {
    // `cursor-agent --list-models` 2026.09.18: 241 lines, its own `auto` among them.
    publishCapturedListing(
      'cursor',
      'cursor/list-models-2026.09.18.txt',
      parseCursorNativeModelCatalog,
    );
    let catalog: ReturnType<typeof usePickerCatalog> | undefined;
    function CountProbe() {
      catalog = usePickerCatalog('planner', 'seat', 0, 'cursor');
      return <Text>count</Text>;
    }

    const ui = renderFeature(<CountProbe />);
    await tick(20);

    const item = catalog?.currentItem;
    if (catalog === undefined || item === undefined) throw new Error('no cursor catalog');
    expect(catalog.modelRowCount).toBe(37);
    expect(formatModelCatalogGuidance(item, catalog.modelCounts).headline).toContain(
      '37 models detected',
    );

    ui.unmount();
  });
});
