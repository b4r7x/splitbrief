import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Text, useInput } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import type { SeatPickerRole } from '../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../core/schemas/config.js';
import { INHERIT_PLANNER_OPTION_ID, type RunnerPickerOption } from './model-catalog/options.js';
import { usePickerActions } from './use-picker-actions.js';
import { usePickerCatalog } from './use-picker-catalog.js';

function ConfirmOnKeyProbe({
  role,
  selection,
  model,
}: {
  role: SeatPickerRole;
  selection: RunnerPickerOption;
  model?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 0, selection.id);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    void actions.confirm(selection, { id: model ?? 'auto' });
  });

  return <Text>{catalog.roleLabel}</Text>;
}

/** Confirms a catalog row; with no `itemId` it confirms the pre-selected one. */
function ConfirmRowProbe({ role, itemId }: { role: SeatPickerRole; itemId?: string | undefined }) {
  const catalog = usePickerCatalog(role, 0);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    const row =
      itemId === undefined
        ? catalog.items[catalog.initialLeftIdx]
        : catalog.items.find((item) => item.id === itemId);
    if (row !== undefined) void actions.confirm(row, null);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function DeleteOnKeyProbe({ role, modelId }: { role: SeatPickerRole; modelId: string }) {
  const catalog = usePickerCatalog(role, 0, modelId);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    void actions.deleteRight({ id: modelId, isCustom: true });
  });

  return <Text>{catalog.roleLabel}</Text>;
}

describe('usePickerActions', () => {
  let projectDir = '';

  const seed = (config: Config) => configStore.__testReset({ projectDir, config });

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'picker-actions-test-'));
    configStore.__testReset({ projectDir, config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    feedbackStore.reset();
    pickerViewStore.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('commits a reviewer confirmation to the reviewer block and leaves the planner unchanged', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    seed(config);
    const plannerBefore = JSON.stringify(config.planner);

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="reviewer" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });
    });
    expect(JSON.stringify(configStore.get().config?.planner)).toBe(plannerBefore);
    ui.unmount();
  });

  it('commits a planner confirmation to the planner block and writes no reviewer block', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="planner" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ kind: 'cli', tool: 'codex' });
    });
    expect(configStore.get().config?.reviewer).toBeUndefined();
    ui.unmount();
  });

  it('leaves the review seat inherited when the pre-selected row is confirmed', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));

    const ui = renderFeature(<ConfirmRowProbe role="reviewer" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toContain('same as planner');
    });
    expect(configStore.get().config?.reviewer).toBeUndefined();
    ui.unmount();
  });

  it('clears a configured reviewer block when the inherit row is confirmed', async () => {
    seed(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    );

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="reviewer" selection={realPickerOption('planner', 'claude-code')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({ tool: 'claude-code' });
    });
    ui.unmount();

    const back = renderFeature(
      <ConfirmRowProbe role="reviewer" itemId={INHERIT_PLANNER_OPTION_ID} />,
    );
    await flushEffects();
    back.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toBeUndefined();
    });
    back.unmount();
  });

  it('reports a refusal instead of a removal when the reviewer inherits the planner custom model', async () => {
    seed(
      makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'inherited-custom',
          customModels: ['inherited-custom'],
        },
      }),
    );

    const ui = renderFeature(<DeleteOnKeyProbe role="reviewer" modelId="inherited-custom" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().isError).toBe(true);
    });
    expect(configStore.get().config?.planner).toMatchObject({
      customModels: ['inherited-custom'],
    });
    ui.unmount();
  });

  it('says so when switching tools clears an effort the new tool cannot carry', async () => {
    seed(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto', effort: 'high' } }),
    );

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="planner" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toContain('cleared');
    });
    ui.unmount();
  });
});
