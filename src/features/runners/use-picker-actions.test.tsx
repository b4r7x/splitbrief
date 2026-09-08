import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Text, useInput } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import type { SeatPickerRole } from '../../core/runners/seat-roles.js';
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

/** Confirms an expanded model: the drafted id, plus the drafted variant when there is one. */
function ConfirmVariantProbe({
  role,
  toolId,
  modelId,
  variant,
}: {
  role: SeatPickerRole;
  toolId: string;
  modelId: string;
  variant?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 0, toolId);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    void actions.confirmProviderVariant(modelId, variant);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function BrowseOnKeyProbe({ role }: { role: SeatPickerRole }) {
  const catalog = usePickerCatalog(role, 0);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    actions.browseCatalog();
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function LeftChangeOnKeyProbe({
  role,
  selection,
}: {
  role: SeatPickerRole;
  selection: RunnerPickerOption;
}) {
  const catalog = usePickerCatalog(role, 0);
  const actions = usePickerActions({ role, catalog });

  useInput(() => {
    actions.leftChange(selection);
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

  it('opens the full catalog when the browse action fires', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    seed(config);
    const configBefore = JSON.stringify(configStore.get().config);

    const ui = renderFeature(<BrowseOnKeyProbe role="planner" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(pickerViewStore.get().browseCatalog).toBe(true);
    });
    expect(JSON.stringify(configStore.get().config)).toBe(configBefore);
    ui.unmount();
  });

  it('closes the browsed catalog when the tool cursor moves', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    pickerViewStore.setBrowseCatalog(true);

    const ui = renderFeature(
      <LeftChangeOnKeyProbe role="planner" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(pickerViewStore.get().browseCatalog).toBe(false);
    });
    ui.unmount();
  });

  it('persists the drafted variant beside the model on confirm', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const ui = renderFeature(
      <ConfirmVariantProbe
        role="planner"
        toolId="opencode"
        modelId="openai/gpt-5.6"
        variant="high"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.6',
        variant: 'high',
      });
    });
    ui.unmount();
  });

  it('saves the model alone when no variant was drafted', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const ui = renderFeature(
      <ConfirmVariantProbe role="planner" toolId="opencode" modelId="openai/gpt-5.5" />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ model: 'openai/gpt-5.5' });
    });
    expect(configStore.get().config?.planner).not.toHaveProperty('variant');
    ui.unmount();
  });

  it('names the saved variant in the confirmation message', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const ui = renderFeature(
      <ConfirmVariantProbe
        role="planner"
        toolId="opencode"
        modelId="openai/gpt-5.6"
        variant="high"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toContain('high');
    });
    expect(feedbackStore.get().message).toContain('Planner set to:');
    ui.unmount();
  });

  // The picker offers one ladder per row and the seat's channel picks the field that
  // spends it, so a level drafted on a flag-channel tool is saved rather than announced
  // as a drop. Naming it in the save line is `effort-commit-routing`'s (REQ-E17).
  it('saves a drafted level to the effort field of a flag-channel seat', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6' } }));

    const messages: string[] = [];
    const stopWatching = feedbackStore.subscribe(() => {
      const message = feedbackStore.get().message;
      if (message !== null) messages.push(message);
    });

    const ui = renderFeature(
      <ConfirmVariantProbe role="planner" toolId="codex" modelId="gpt-5-codex" variant="high" />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(messages.some((message) => message.startsWith('Planner set to:'))).toBe(true);
    });
    stopWatching();

    expect(configStore.get().config?.planner).toMatchObject({ tool: 'codex', effort: 'high' });
    expect(configStore.get().config?.planner).not.toHaveProperty('variant');
    expect(messages.every((message) => !message.includes('cleared'))).toBe(true);
    ui.unmount();
  });

  it('says so when switching tools clears an effort the new tool cannot carry', async () => {
    seed(
      makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto', effort: 'high' } }),
    );

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="planner" selection={realPickerOption('planner', 'opencode')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toContain('cleared');
    });
    ui.unmount();
  });
});
