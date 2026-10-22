import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Text, useInput } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { loadConfig } from '../../core/config/load/io.js';
import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import { seatAxisFocus } from '../../core/navigation/types.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { routerStore } from '../../stores/navigation/router.js';
import {
  CHECKING_TOOLS_STAGE,
  preparationStore,
  type PreparationOrigin,
} from '../../stores/navigation/preparation.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { CREW_SEAT_LABELS, PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import type { CliAuthMethod } from '../../core/runners/cli-tool-catalog.js';
import type { PickerSlot, SeatPickerRole } from '../../core/runners/seat-roles.js';
import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import {
  INHERIT_PLANNER_OPTION_ID,
  noFallbackOption,
  type RunnerPickerOption,
} from './model-catalog/options.js';
import type { LocalConnectionSave } from './local-connection-form.js';
import {
  defaultPickerEffectDeps,
  useLocalConnectionActions,
  usePickerActions,
  type PickerActions,
} from './use-picker-actions.js';
import { usePickerCatalog } from './use-picker-catalog.js';
import { PickerView } from './picker-view.js';

function AntigravityPickerProbe({ role }: { role: SeatPickerRole }) {
  const catalog = usePickerCatalog(role, 'seat', 0);
  const actions = usePickerActions({ role, slot: 'seat', catalog });
  return <PickerView role={role} slot="seat" catalog={catalog} actions={actions} />;
}

function ConfirmOnKeyProbe({
  role,
  selection,
  model,
}: {
  role: SeatPickerRole;
  selection: RunnerPickerOption;
  model?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 'seat', 0, selection.id);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

  useInput(() => {
    void actions.confirm(selection, { id: model ?? 'auto' });
  });

  return <Text>{catalog.roleLabel}</Text>;
}

/** Confirms a catalog row; with no `itemId` it confirms the pre-selected one. */
function ConfirmRowProbe({ role, itemId }: { role: SeatPickerRole; itemId?: string | undefined }) {
  const catalog = usePickerCatalog(role, 'seat', 0);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

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
  const catalog = usePickerCatalog(role, 'seat', 0, toolId);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

  useInput(() => {
    void actions.confirmProviderSelection(modelId, variant);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

/** Saves a typed custom model for the seat or its fallback on the tool the picker opened on. */
function CustomModelProbe({
  role,
  slot,
  toolId,
  modelName,
}: {
  role: SeatPickerRole;
  slot: PickerSlot;
  toolId: string;
  modelName: string;
}) {
  const catalog = usePickerCatalog(role, slot, 0, toolId);
  const actions = usePickerActions({ role, slot, catalog });

  useInput(() => {
    void actions.customModel(modelName);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

/** Saves one local connection to the seat's own block, and reports what that seat reads back. */
function LocalConnectionProbe({
  role,
  save,
  onSeat,
}: {
  role: SeatPickerRole;
  save: LocalConnectionSave;
  onSeat: (apiBase: string, model: string | undefined) => void;
}) {
  const actions = useLocalConnectionActions(role);
  const seat = actions.seat(save.provider);

  useInput((input) => {
    if (input === 's') void actions.save(save);
    else onSeat(seat.apiBase, seat.model);
  });

  return <Text>{seat.apiBase}</Text>;
}

/** Confirms one authentication method for the seat; `c` leaves the picker instead. */
function ConfirmAuthProbe({
  role,
  method,
}: {
  role: SeatPickerRole;
  method: CliAuthMethod | 'host-configured';
}) {
  const catalog = usePickerCatalog(role, 'seat', 0);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

  useInput((input) => {
    if (input === 'c') actions.closeOverlay();
    else void actions.confirmAuthMethod(method);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function CustomCommandProbe({ role, command }: { role: SeatPickerRole; command: string }) {
  const catalog = usePickerCatalog(role, 'seat', 0);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

  useInput(() => {
    void actions.customCommand(command);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function BrowseOnKeyProbe({ role }: { role: SeatPickerRole }) {
  const catalog = usePickerCatalog(role, 'seat', 0);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

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
  const catalog = usePickerCatalog(role, 'seat', 0);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

  useInput(() => {
    actions.leftChange(selection);
  });

  return <Text>{catalog.roleLabel}</Text>;
}

function DeleteOnKeyProbe({ role, modelId }: { role: SeatPickerRole; modelId: string }) {
  const catalog = usePickerCatalog(role, 'seat', 0, modelId);
  const actions = usePickerActions({ role, slot: 'seat', catalog });

  useInput(() => {
    void actions.deleteRight({ id: modelId, isCustom: true });
  });

  return <Text>{catalog.roleLabel}</Text>;
}

describe('usePickerActions fallback slot', () => {
  let projectDir = '';
  let actions: PickerActions | undefined;
  const saveConfig = vi.fn(configStore.save);

  function FallbackProbe({
    role = 'implementer',
    selectedItemId = 'codex',
  }: {
    role?: SeatPickerRole;
    selectedItemId?: string;
  }) {
    const catalog = usePickerCatalog(role, 'fallback', 0, selectedItemId);
    actions = usePickerActions({
      role,
      slot: 'fallback',
      catalog,
      deps: { ...defaultPickerEffectDeps, saveConfig },
    });
    return <Text>{catalog.roleLabel}</Text>;
  }

  function currentActions(): PickerActions {
    if (actions === undefined) throw new Error('fallback actions were not rendered');
    return actions;
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'fallback-picker-actions-'));
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
      }),
    });
    actions = undefined;
    saveConfig.mockClear();
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    overlayStore.open('implementer-fallback-picker');
    feedbackStore.reset();
    pickerViewStore.reset();
    routerStore.reset();
    lifecycleStore.__testReset();
    detectionStore.setDetection({
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
      providers: [],
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('sets only the default BUILD profile fallback and reports its identity', async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'opus' },
      implementerProfiles: {
        default: 'main',
        profiles: {
          main: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
          other: { kind: 'cli', tool: 'codex', model: 'gpt-5.5' },
        },
      },
    });
    configStore.__testReset({ projectDir, config });
    const ui = renderFeature(<FallbackProbe />);
    await flushEffects();

    await currentActions().confirm(realPickerOption('implementer', 'codex'), { id: 'gpt-5-codex' });

    const saved = saveConfig.mock.calls[0]?.[0];
    expect(saved?.implementerProfiles?.profiles.main).toEqual({
      ...config.implementerProfiles?.profiles.main,
      fallback: { tool: 'codex', model: 'gpt-5-codex' },
    });
    expect(saved?.implementerProfiles?.profiles.other).toEqual(
      config.implementerProfiles?.profiles.other,
    );
    expect(feedbackStore.get().message).toBe(
      'Saved BUILD fallback · OpenAI Codex CLI · GPT-5 Codex to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
    );
    ui.unmount();
  });

  it('reports a saved fallback with the catalog name used by the crew', async () => {
    modelCacheStore.hydrateDetection({
      providers: [],
      cliTools: [],
      fetchedAt: 1,
      validatedAt: 1,
      generation: 0,
      requestId: 0,
      contexts: { readiness: 'readiness', modelsDev: 'catalog', cliModels: 'tools' },
      cliCatalogs: [
        { tool: 'codex', probedAt: 1, models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
      ],
    });
    const ui = renderFeature(<FallbackProbe />);
    await flushEffects();

    await currentActions().confirm(realPickerOption('implementer', 'codex'), {
      id: 'gpt-6-luna',
    });

    expect(feedbackStore.get().message).toBe(
      'Saved BUILD fallback · OpenAI Codex CLI · GPT-6-Luna to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
    );
    ui.unmount();
  });

  it('refuses the current seat identity even with a different effort and keeps the picker open', async () => {
    const ui = renderFeature(<FallbackProbe selectedItemId="claude-code" />);
    await flushEffects();

    await currentActions().confirmProviderSelection('opus', 'low');

    expect(saveConfig).not.toHaveBeenCalled();
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toMatch(/^BUILD runs .*choose another tool or model$/);
    expect(overlayStore.get().active).toBe('implementer-fallback-picker');
    ui.unmount();
  });

  it('clears the fallback key with None and says a seat down now pauses', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
      }),
    });
    const ui = renderFeature(<FallbackProbe selectedItemId="no-fallback" />);
    await flushEffects();
    await currentActions().confirm(noFallbackOption({ isCurrent: false }), null);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0]?.[0].implementer).not.toHaveProperty('fallback');
    expect(feedbackStore.get().message).toBe(
      'Saved BUILD fallback · none to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore · Seat down pauses and asks',
    );
    ui.unmount();
  });

  it('closes None on an inherited REVIEW with no PLAN fallback without saving or forking', async () => {
    overlayStore.close();
    overlayStore.open('reviewer-fallback-picker');
    const ui = renderFeature(<FallbackProbe role="reviewer" selectedItemId="no-fallback" />);
    await flushEffects();
    await currentActions().confirm(noFallbackOption({ isCurrent: true }), null);

    expect(saveConfig).not.toHaveBeenCalled();
    expect(configStore.get().config?.reviewer).toBeUndefined();
    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('writes a custom model only to fallback.model', async () => {
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'opus',
        customModels: ['seat-model'],
      },
    });
    configStore.__testReset({ projectDir, config });
    pickerViewStore.open({ kind: 'custom-model' });
    const ui = renderFeature(<FallbackProbe />);
    await flushEffects();
    await currentActions().customModel('private-codex-model');

    expect(saveConfig.mock.calls[0]?.[0].implementer).toEqual({
      ...config.implementer,
      fallback: { tool: 'codex', model: 'private-codex-model' },
    });
    ui.unmount();
  });

  it('drafts the fallback level when moving back to its tool', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'opus',
          effort: 'max',
          fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'low' },
        },
      }),
    });
    const ui = renderFeature(<FallbackProbe selectedItemId="claude-code" />);
    await flushEffects();
    currentActions().leftChange({ ...realPickerOption('implementer', 'codex'), isCurrent: true });

    expect(pickerViewStore.get().effortDraft).toBe('low');
    ui.unmount();
  });

  it('does not delete seat custom models from the fallback slot', async () => {
    const ui = renderFeature(<FallbackProbe />);
    await flushEffects();
    await currentActions().deleteRight({ id: 'seat-only-model', isCustom: true });

    expect(saveConfig).not.toHaveBeenCalled();
    ui.unmount();
  });
});

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
    routerStore.reset();
    lifecycleStore.__testReset();
    preparationStore.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    preparationStore.reset();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.each([
    ['planner', 'plan'],
    ['implementer', 'build'],
    ['reviewer', 'review'],
  ] as const)('saves the Antigravity level chosen in the %s picker', async (role, seat) => {
    const oldSeat = {
      kind: 'cli',
      tool: 'antigravity',
      model: 'gemini-3.8-flash-high',
      effort: 'low',
    } as const;
    seed(makeConfig({ planner: oldSeat, implementer: oldSeat, reviewer: oldSeat }));
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'r', modelsDev: 'm', cliModels: 'c' },
    });
    detectionStore.publish({
      request,
      result: {
        providers: [],
        cliTools: [cliDetectionFor('ready', 'antigravity')],
        catalog: null,
        cliModels: [
          {
            connection: { tool: 'antigravity', contextKey: 'c' },
            outcome: {
              kind: 'success',
              value: ['high', 'medium', 'low'].map((level) => ({
                id: `gemini-3.8-flash-${level}`,
                displayName: `Gemini 3.8 Flash (${level})`,
                nativeReasoningEfforts: ['low', 'medium', 'high'],
              })),
            },
          },
        ],
        generation: 1,
      },
    });
    pickerViewStore.expand(oldSeat.model, oldSeat.model, null);
    overlayStore.open(`${role}-picker`, seatAxisFocus(seat));
    const ui = renderFeature(<AntigravityPickerProbe role={role} />);
    await flushEffects();

    expect(ui.lastFrame()).toContain('gemini-3.8-flash-high · high');
    ui.stdin.write(' ');
    await flushEffects();
    expect(ui.lastFrame()).toContain('gemini-3.8-flash-low · low');
    ui.stdin.write('\r');
    await vi.waitFor(() => {
      expect(readActiveRunner({ config: loadConfig(projectDir).config, role })).toMatchObject({
        model: 'gemini-3.8-flash-low',
      });
      expect(readActiveRunner({ config: loadConfig(projectDir).config, role })).not.toHaveProperty(
        'effort',
      );
      expect(feedbackStore.get().message).toContain('Effort low cleared');
    });
    ui.unmount();
  });

  it.each([
    ['planner', 'setup'],
    ['implementer', 'setup'],
    ['reviewer', 'setup'],
    ['planner', 'home'],
  ] as const)('confirms the saved %s seat and config path on %s', async (role, screen) => {
    routerStore.init({ screen });
    overlayStore.open(`${role}-picker`);
    const ui = renderFeature(
      <ConfirmOnKeyProbe
        role={role}
        selection={realPickerOption(role === 'reviewer' ? 'planner' : role, 'codex')}
        model="gpt-5-codex"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    const label = role === 'planner' ? 'PLAN' : role === 'implementer' ? 'BUILD' : 'REVIEW';
    await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
    expect(feedbackStore.get()).toMatchObject({
      message: `Saved ${label} · OpenAI Codex CLI · GPT-5 Codex to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
      isError: false,
    });
    ui.unmount();
  });

  it.each(['setup', 'home'] as const)(
    'confirms the saved local seat and config path on %s',
    async (screen) => {
      routerStore.init({ screen });
      overlayStore.open('planner-picker');
      const ui = renderFeature(
        <LocalConnectionProbe
          role="planner"
          save={{
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            apiKey: undefined,
            model: 'modelA',
          }}
          onSeat={() => {}}
        />,
      );
      await flushEffects();
      ui.stdin.write('s');

      await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
      expect(feedbackStore.get()).toMatchObject({
        message:
          'Saved PLAN · Ollama · ModelA to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
        isError: false,
      });
      ui.unmount();
    },
  );

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

  // The save said `seat changes after this brief` while the plan was made and in the final review,
  // where no brief runs: the words now come from the one place the composer legend reads.
  const saveBuildSeatUnderRun = async (
    phase: Phase,
    status: 'running' | 'paused' = 'running',
  ): Promise<string> => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    seed(config);
    const prepared = makePreparedExecution({
      projectDir,
      sessionId: 'sess-live',
      feature: 'live run',
      config,
    });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: prepared.session.ref }),
      execution: { kind: 'local', prepared },
    });
    lifecycleStore.__testReset({ phase, status });

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="implementer" selection={realPickerOption('implementer', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).not.toBeNull();
    });
    expect(configStore.get().config?.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });
    ui.unmount();
    return feedbackStore.get().message ?? '';
  };

  it('says a seat saved under a running brief lands after that brief', async () => {
    tasksStore.__testReset({
      tasks: [
        { id: 'T001', title: 'first', status: 'in_progress' },
        { id: 'T002', title: 'second', status: 'pending' },
      ],
      currentTask: 1,
      totalTasks: 2,
    });

    expect(await saveBuildSeatUnderRun('implementing')).toBe(
      `${CREW_SEAT_LABELS.build} seat changes after T001`,
    );
  });

  it('says a seat saved while the plan is made lands after the next brief', async () => {
    tasksStore.__testReset();

    expect(await saveBuildSeatUnderRun('planning')).toBe(
      `${CREW_SEAT_LABELS.build} seat changes after the next brief`,
    );
  });

  it('says a seat saved in the final review lands after a fix brief or at the next run', async () => {
    tasksStore.__testReset({
      tasks: [{ id: 'T001', title: 'first', status: 'done' }],
      currentTask: 1,
      totalTasks: 1,
    });

    expect(await saveBuildSeatUnderRun('final-review')).toBe(
      `${CREW_SEAT_LABELS.build} seat changes after a fix brief or at the next run`,
    );
  });

  it('says a seat saved while the run is parked after a brief lands after that brief', async () => {
    tasksStore.__testReset({
      tasks: [
        { id: 'T001', title: 'first', status: 'done' },
        { id: 'T002', title: 'second', status: 'pending' },
      ],
      currentTask: 1,
      totalTasks: 2,
    });

    expect(await saveBuildSeatUnderRun('implementing', 'paused')).toBe(
      `${CREW_SEAT_LABELS.build} seat changes after T001`,
    );
  });

  // A start checks its tools on home and runs on the config it read before the check ended, so a
  // seat saved during the check takes over at the first boundary, the way a running run's does.
  // A continue admits a seat saved during its check when it enters, so its save is a plain save.
  const saveBuildSeatWhilePreparing = async (origin: PreparationOrigin): Promise<string> => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    routerStore.init({ screen: 'home' });
    preparationStore.submit({
      origin,
      stage: CHECKING_TOOLS_STAGE,
      prepare: () => new Promise(() => {}),
      onPrepared: () => {},
    });

    const ui = renderFeature(
      <ConfirmOnKeyProbe role="implementer" selection={realPickerOption('implementer', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).not.toBeNull();
    });
    expect(configStore.get().config?.implementer).toMatchObject({ kind: 'cli', tool: 'codex' });
    ui.unmount();
    return feedbackStore.get().message ?? '';
  };

  it('says a seat saved while a start checks its tools lands after the next brief', async () => {
    tasksStore.__testReset({
      tasks: [{ id: 'T001', title: 'an earlier run', status: 'done' }],
      currentTask: 1,
      totalTasks: 1,
    });

    expect(await saveBuildSeatWhilePreparing('start')).toBe(
      `${CREW_SEAT_LABELS.build} seat changes after the next brief`,
    );
  });

  it('says a seat saved while a continue checks its tools is saved', async () => {
    expect(await saveBuildSeatWhilePreparing('continue')).toMatch(
      new RegExp(`^Saved ${CREW_SEAT_LABELS.build} · `),
    );
  });

  it('leaves the review seat inherited when the pre-selected row is confirmed in Setup', async () => {
    routerStore.init({ screen: 'setup' });
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));

    const ui = renderFeature(<ConfirmRowProbe role="reviewer" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toBe(
        `Saved ${CREW_SEAT_LABELS.review} ${PLANNER_INHERITANCE.mark} to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
      );
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

  it("saves a custom model typed on another tool without the seat tool's custom models", async () => {
    seed(
      makeConfig({
        planner: { kind: 'cli', tool: 'codex', model: 'team-model', customModels: ['team-model'] },
      }),
    );
    detectionStore.setDetection({
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'codex')],
      providers: [],
    });
    pickerViewStore.open({ kind: 'custom-model' });

    const ui = renderFeature(
      <CustomModelProbe role="planner" slot="seat" toolId="claude-code" modelName="claude-new" />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ tool: 'claude-code' });
    });
    expect(configStore.get().config?.planner).toMatchObject({
      model: 'claude-new',
      customModels: ['claude-new'],
    });
    ui.unmount();
  });

  it('marks the picker as having taken a row when a confirmation saves the seat and closes it', async () => {
    overlayStore.open('planner-picker');
    const ui = renderFeature(
      <ConfirmOnKeyProbe role="planner" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    expect(pickerViewStore.get().committed).toBe(false);
    ui.stdin.write('\r');

    await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
    expect(pickerViewStore.get().committed).toBe(true);
    ui.unmount();
  });

  it('marks the picker as having taken a row when a local connection saves the seat and closes it', async () => {
    overlayStore.open('planner-picker');
    const ui = renderFeature(
      <LocalConnectionProbe
        role="planner"
        save={{
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          apiKey: undefined,
          model: 'modelA',
        }}
        onSeat={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('s');

    await vi.waitFor(() => expect(overlayStore.get().active).toBe('none'));
    expect(pickerViewStore.get().committed).toBe(true);
    ui.unmount();
  });

  it('takes no row when Ctrl+D removes a custom model: the seat is saved and the picker stays open', async () => {
    seed(
      makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'my-a',
          customModels: ['my-a', 'my-b'],
        },
      }),
    );
    overlayStore.open('planner-picker');

    const ui = renderFeature(<DeleteOnKeyProbe role="planner" modelId="my-b" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ customModels: ['my-a'] });
    });
    expect(overlayStore.get().active).toBe('planner-picker');
    expect(pickerViewStore.get().committed).toBe(false);
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

  it('closes the browsed catalog and drops the drafts when the tool cursor moves', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    pickerViewStore.setBrowseCatalog(true);
    pickerViewStore.setEffortDraft('max');
    pickerViewStore.setAuthDraft('api-key');

    const ui = renderFeature(
      <LeftChangeOnKeyProbe role="planner" selection={realPickerOption('planner', 'codex')} />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(pickerViewStore.get()).toMatchObject({
        browseCatalog: false,
        effortDraft: null,
        authDraft: null,
      });
    });
    ui.unmount();
  });

  // The tool column reports its current tool once on mount; nothing moved, so a draft the
  // picker was opened with has to survive it.
  it('keeps every draft when the column reports the tool that is already current', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    pickerViewStore.setBrowseCatalog(true);
    pickerViewStore.setEffortDraft('max');
    pickerViewStore.setAuthDraft('api-key');

    const ui = renderFeature(
      <LeftChangeOnKeyProbe
        role="planner"
        selection={realPickerOption('planner', 'claude-code')}
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(pickerViewStore.get()).toMatchObject({
      browseCatalog: true,
      effortDraft: 'max',
      authDraft: 'api-key',
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

  describe('the sign-in note on a saved OpenCode route', () => {
    const CATALOG_CONTEXTS = { readiness: 'readiness', modelsDev: 'catalog', cliModels: 'tools' };
    const DEEPSEEK = { id: 'deepseek', provider: 'DeepSeek', source: 'stored' } as const;
    const signedInToDeepSeek = () =>
      detectionStore.setDetection({
        cliTools: [
          cliDetectionFor('ready', 'opencode', {
            providerAuth: { kind: 'read', facts: [DEEPSEEK] },
          }),
        ],
        providers: [],
      });
    const listsModels = (ids: readonly string[]) => {
      const request = modelCacheStore.beginRefresh({ contexts: CATALOG_CONTEXTS });
      modelCacheStore.publishLane({
        request,
        lane: {
          lane: 'cliModels',
          outcome: {
            kind: 'fresh',
            origin: 'request',
            snapshot: {
              source: 'cli-models',
              contextKey: CATALOG_CONTEXTS.cliModels,
              generation: 1,
              requestId: 1,
              fetchedAt: 1,
              validatedAt: 1,
              stale: false,
              value: [
                {
                  connection: { tool: 'opencode', contextKey: 'opencode-context' },
                  outcome: { kind: 'success', value: ids.map((id) => ({ id })) },
                },
              ],
            },
          },
        },
      });
    };
    const confirmed = async (modelId: string): Promise<string> => {
      const ui = renderFeature(
        <ConfirmVariantProbe role="planner" toolId="opencode" modelId={modelId} />,
      );
      await flushEffects();
      ui.stdin.write('\r');
      await vi.waitFor(() => {
        expect(configStore.get().config?.planner).toMatchObject({ model: modelId });
      });
      ui.unmount();
      return feedbackStore.get().message ?? '';
    };

    it('names the gateway account in the words and with the sign-in command doctor and the halt use', async () => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      signedInToDeepSeek();

      const message = await confirmed('opencode/big-pickle');
      expect(message).toMatch(
        / · OpenCode CLI has no credential for opencode — run opencode auth login opencode before start$/,
      );
      expect(message.match(/Saved/g)).toHaveLength(1);
    });

    it('names the sign-in for a route of a tool signed in to no provider, as the row reads it', async () => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      detectionStore.setDetection({
        cliTools: [cliDetectionFor('ready', 'opencode', { providerAuth: { kind: 'empty' } })],
        providers: [],
      });
      listsModels(['lmstudio/qwen3']);

      expect(await confirmed('ollama/llama3')).toMatch(
        / · OpenCode CLI has no credential for ollama — run opencode auth login ollama before start$/,
      );
    });

    it('adds no note for a tool signed in to no provider before its model list is read', async () => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      detectionStore.setDetection({
        cliTools: [cliDetectionFor('ready', 'opencode', { providerAuth: { kind: 'empty' } })],
        providers: [],
      });

      expect(await confirmed('ollama/llama3')).not.toContain('auth login');
    });

    it('adds no note for a route the tool lists though no credential names its provider', async () => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      signedInToDeepSeek();
      listsModels(['ollama/llama3']);

      expect(await confirmed('ollama/llama3')).not.toContain('auth login');
    });

    // A route only the last listing named can be a provider signed out since then.
    it('counts a route a remembered listing serves before any live read', async () => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      modelCacheStore.hydrateDetection({
        providers: [],
        cliTools: [],
        fetchedAt: 1,
        validatedAt: 1,
        generation: 0,
        requestId: 0,
        contexts: CATALOG_CONTEXTS,
        cliCatalogs: [{ tool: 'opencode', probedAt: 1, models: [{ id: 'ollama/llama3' }] }],
      });
      signedInToDeepSeek();

      expect(await confirmed('ollama/llama3')).not.toContain('auth login');
    });

    it('adds no note for a dropped route while the listing still serves its provider', async () => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      modelCacheStore.hydrateDetection({
        providers: [],
        cliTools: [],
        fetchedAt: 1,
        validatedAt: 1,
        generation: 0,
        requestId: 0,
        contexts: CATALOG_CONTEXTS,
        cliCatalogs: [
          {
            tool: 'opencode',
            probedAt: 1,
            models: [{ id: 'ollama/llama3' }, { id: 'ollama/qwen3' }],
            missingOnce: ['ollama/qwen3'],
          },
        ],
      });
      signedInToDeepSeek();

      expect(await confirmed('ollama/qwen3')).not.toContain('auth login');
    });

    it('names the sign-in for a route the last successful read dropped', async () => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      modelCacheStore.hydrateDetection({
        providers: [],
        cliTools: [],
        fetchedAt: 1,
        validatedAt: 1,
        generation: 0,
        requestId: 0,
        contexts: CATALOG_CONTEXTS,
        cliCatalogs: [
          {
            tool: 'opencode',
            probedAt: 1,
            models: [{ id: 'ollama/llama3' }],
            missingOnce: ['ollama/llama3'],
          },
        ],
      });
      signedInToDeepSeek();

      expect(await confirmed('ollama/llama3')).toMatch(
        / · OpenCode CLI has no credential for ollama — run opencode auth login ollama before start$/,
      );
    });

    const ANTHROPIC_SIGN_IN =
      / · OpenCode CLI has no credential for anthropic — run opencode auth login anthropic before start$/;
    const HAIKU = 'anthropic/claude-haiku-4-5';
    const savedCustom = async (slot: PickerSlot, saved: () => unknown): Promise<string> => {
      pickerViewStore.open({ kind: 'custom-model' });
      const ui = renderFeature(
        <CustomModelProbe role="planner" slot={slot} toolId="opencode" modelName={HAIKU} />,
      );
      await flushEffects();
      ui.stdin.write('\r');
      await vi.waitFor(() => {
        expect(saved()).toBe(HAIKU);
      });
      ui.unmount();
      return feedbackStore.get().message ?? '';
    };
    const onDeepSeekListing = (ids: readonly string[]) => {
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        }),
      );
      signedInToDeepSeek();
      listsModels(ids);
    };

    it('names the sign-in for a custom model typed for the seat', async () => {
      onDeepSeekListing(['deepseek/deepseek-flash']);

      const message = await savedCustom('seat', () => configStore.get().config?.planner.model);
      expect(message).toMatch(ANTHROPIC_SIGN_IN);
    });

    it('names the sign-in for a custom model typed for the fallback', async () => {
      onDeepSeekListing(['deepseek/deepseek-flash']);

      const message = await savedCustom('fallback', () => {
        const planner = configStore.get().config?.planner;
        return planner?.kind === 'cli' ? planner.fallback?.model : undefined;
      });
      expect(message).toMatch(ANTHROPIC_SIGN_IN);
    });

    it('names the sign-in for a saved custom model row', async () => {
      seed(
        makeConfig({
          planner: {
            kind: 'cli',
            tool: 'opencode',
            model: 'deepseek/deepseek-flash',
            customModels: [HAIKU],
          },
        }),
      );
      signedInToDeepSeek();
      listsModels(['deepseek/deepseek-flash']);
      const ui = renderFeature(
        <ConfirmOnKeyProbe
          role="planner"
          selection={realPickerOption('planner', 'opencode')}
          model={HAIKU}
        />,
      );
      await flushEffects();
      ui.stdin.write('\r');
      await vi.waitFor(() => {
        expect(configStore.get().config?.planner).toMatchObject({ model: HAIKU });
      });
      ui.unmount();

      expect(feedbackStore.get().message).toMatch(ANTHROPIC_SIGN_IN);
    });

    it('adds no note for a custom model the listing serves', async () => {
      onDeepSeekListing([HAIKU]);

      const message = await savedCustom('seat', () => configStore.get().config?.planner.model);
      expect(message).not.toContain('auth login');
    });
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
    expect(feedbackStore.get().message).toContain(`Saved ${CREW_SEAT_LABELS.plan} · `);
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
      expect(
        messages.some((message) => message.startsWith(`Saved ${CREW_SEAT_LABELS.plan} · `)),
      ).toBe(true);
    });
    stopWatching();

    expect(configStore.get().config?.planner).toMatchObject({ tool: 'codex', effort: 'high' });
    expect(configStore.get().config?.planner).not.toHaveProperty('variant');
    expect(messages.every((message) => !message.includes('cleared'))).toBe(true);
    ui.unmount();
  });

  it.each(['home', 'setup'] as const)(
    'keeps the save notice when switching tools clears an effort from %s',
    async (screen) => {
      routerStore.init({ screen });
      feedbackStore.setMessage('Saved Claude crew to .splitbrief/config.yaml');
      seed(
        makeConfig({
          planner: { kind: 'cli', tool: 'claude-code', model: 'auto', effort: 'high' },
        }),
      );

      const ui = renderFeature(
        <ConfirmOnKeyProbe role="planner" selection={realPickerOption('planner', 'opencode')} />,
      );
      await flushEffects();
      ui.stdin.write('\r');

      await vi.waitFor(() => expect(feedbackStore.get().message).toContain('cleared'));
      expect(feedbackStore.get().message).toMatch(
        /^Saved PLAN · OpenCode CLI .* to \.splitbrief\/config\.yaml · .*cleared/,
      );
      ui.unmount();
    },
  );

  it('names the kept level once, as one identity string', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } }));

    const messages: string[] = [];
    const stopWatching = feedbackStore.subscribe(() => {
      const message = feedbackStore.get().message;
      if (message !== null) messages.push(message);
    });

    const ui = renderFeature(
      <ConfirmVariantProbe role="planner" toolId="claude-code" modelId="opus" variant="high" />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(
        messages.some((message) => message.startsWith(`Saved ${CREW_SEAT_LABELS.plan} · `)),
      ).toBe(true);
    });
    stopWatching();

    expect(
      messages.filter((message) => message.startsWith(`Saved ${CREW_SEAT_LABELS.plan} · `)),
    ).toEqual([
      `Saved ${CREW_SEAT_LABELS.plan} · Claude Code CLI · Opus 5.5 · high to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore`,
    ]);
    expect(configStore.get().config?.planner).toMatchObject({
      tool: 'claude-code',
      effort: 'high',
    });
    expect(configStore.get().config?.planner).not.toHaveProperty('variant');
    ui.unmount();
  });

  it('leaves a dropped level out of the save line', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'opus' } }));

    const messages: string[] = [];
    const stopWatching = feedbackStore.subscribe(() => {
      const message = feedbackStore.get().message;
      if (message !== null) messages.push(message);
    });

    const ui = renderFeature(
      <ConfirmVariantProbe
        role="planner"
        toolId="claude-code"
        modelId="opus"
        variant="ludicrous"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(
        messages.some((message) => message.startsWith(`Saved ${CREW_SEAT_LABELS.plan} · `)),
      ).toBe(true);
    });
    stopWatching();

    const saves = messages.filter((message) =>
      message.startsWith(`Saved ${CREW_SEAT_LABELS.plan} · `),
    );
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatch(
      /^Saved PLAN · Claude Code CLI · Opus 5\.5 to \.splitbrief\/config\.yaml · .*Effort ludicrous/,
    );
    expect(configStore.get().config?.planner).not.toHaveProperty('effort');
    ui.unmount();
  });

  it('keeps a saved PLAN and REVIEW local connection independent across reopen', async () => {
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    const serverA = 'http://localhost:11434/v1';
    const serverB = 'http://127.0.0.1:11435/v1';
    const readBack: string[] = [];

    const plan = renderFeature(
      <LocalConnectionProbe
        role="planner"
        save={{ provider: 'ollama', apiBase: serverA, apiKey: undefined, model: 'modelA' }}
        onSeat={() => {}}
      />,
    );
    await flushEffects();
    plan.stdin.write('s');
    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ apiBase: serverA });
    });
    plan.unmount();

    const review = renderFeature(
      <LocalConnectionProbe
        role="reviewer"
        save={{ provider: 'ollama', apiBase: serverB, apiKey: undefined, model: 'modelB' }}
        onSeat={() => {}}
      />,
    );
    await flushEffects();
    review.stdin.write('s');
    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({ apiBase: serverB });
    });
    review.unmount();

    expect(configStore.get().config?.planner).toMatchObject({
      kind: 'api',
      provider: 'ollama',
      apiBase: serverA,
      model: 'modelA',
    });
    expect(configStore.get().config?.reviewer).toMatchObject({
      kind: 'api',
      provider: 'ollama',
      apiBase: serverB,
      model: 'modelB',
    });

    // Reopened, each seat prefills from its own block rather than from the planner's.
    for (const role of ['planner', 'reviewer'] as const) {
      const reopened = renderFeature(
        <LocalConnectionProbe
          role={role}
          save={{ provider: 'ollama', apiBase: serverA, apiKey: undefined, model: 'modelA' }}
          onSeat={(apiBase, model) => readBack.push(`${apiBase}|${model ?? 'none'}`)}
        />,
      );
      await flushEffects();
      reopened.stdin.write('r');
      await vi.waitFor(() => {
        expect(readBack).toHaveLength(role === 'planner' ? 1 : 2);
      });
      reopened.unmount();
    }
    expect(readBack).toEqual([`${serverA}|modelA`, `${serverB}|modelB`]);
  });

  it('prefills an unconfigured review seat from the profile default, never the planner address', async () => {
    seed(
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11499/v1',
          model: 'plan-model',
        },
      }),
    );
    const readBack: string[] = [];

    const ui = renderFeature(
      <LocalConnectionProbe
        role="reviewer"
        save={{
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          apiKey: undefined,
          model: 'x',
        }}
        onSeat={(apiBase, model) => readBack.push(`${apiBase}|${model ?? 'none'}`)}
      />,
    );
    await flushEffects();
    ui.stdin.write('r');
    await vi.waitFor(() => {
      expect(readBack).toHaveLength(1);
    });

    expect(readBack).toEqual(['http://localhost:11434/v1|none']);
    ui.unmount();
  });

  it("drops a carried variant the confirmed row's own ladder does not spell", async () => {
    seed(
      makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'opencode',
          model: 'anthropic/claude-sonnet-5',
          variant: 'max',
        },
      }),
    );
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
              value: [
                {
                  id: 'openai/gpt-5.5',
                  nativeReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
                },
              ],
            },
          },
        ],
        generation: 1,
      },
    });

    const ui = renderFeature(
      <ConfirmOnKeyProbe
        role="implementer"
        selection={realPickerOption('implementer', 'opencode')}
        model="openai/gpt-5.5"
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.implementer).toMatchObject({
        kind: 'cli',
        tool: 'opencode',
        model: 'openai/gpt-5.5',
      });
    });
    expect(configStore.get().config?.implementer).not.toHaveProperty('variant');
    expect(feedbackStore.get().message).toContain('max');
    ui.unmount();
  });
  it('stores the confirmed method on the seat and changes nothing else', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    seed(config);
    const detectionBefore = JSON.stringify(detectionStore.get());

    const ui = renderFeature(<ConfirmAuthProbe role="planner" method="api-key" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({ authChannel: 'api-key' });
    });
    // The method binds the invocation; it is not a second way to choose a tool or a
    // model, and it reaches nothing outside this seat's own block.
    expect(configStore.get().config?.planner).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'auto',
    });
    expect(configStore.get().config?.reviewer).toBeUndefined();
    expect(JSON.stringify(configStore.get().config?.implementer)).toBe(
      JSON.stringify(config.implementer),
    );
    // Nothing probes, signs in or switches an account: the whole action is one
    // config write, so the detection the host login is read through is untouched.
    expect(JSON.stringify(detectionStore.get())).toBe(detectionBefore);
    expect(feedbackStore.get().isError).toBe(false);
    expect(feedbackStore.get().message).toContain('api key');
    ui.unmount();
  });

  it('confirms a saved method in Setup with the seat and config path', async () => {
    routerStore.init({ screen: 'setup' });
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));

    const ui = renderFeature(<ConfirmAuthProbe role="planner" method="api-key" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get()).toMatchObject({
        message:
          'Saved PLAN auth · api key to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
        isError: false,
      });
    });
    ui.unmount();
  });

  it('confirms a saved custom command with the seat words the crew row shows', async () => {
    routerStore.init({ screen: 'setup' });
    seed(makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }));
    pickerViewStore.open({ kind: 'custom-command', intendedKind: 'shell' });

    const ui = renderFeature(<CustomCommandProbe role="planner" command="./plan.sh" />);
    await flushEffects();
    ui.stdin.write('x');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).toMatchObject({
        kind: 'shell',
        command: './plan.sh',
      });
    });
    expect(feedbackStore.get()).toMatchObject({
      message:
        'Saved PLAN · Custom Shell · auto to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
      isError: false,
    });
    ui.unmount();
  });

  it('removes the explicit field when host configuration is confirmed', async () => {
    seed(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'auto', authChannel: 'session' },
      }),
    );

    const ui = renderFeature(<ConfirmAuthProbe role="planner" method="host-configured" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.planner).not.toHaveProperty('authChannel');
    });
    // Removed, not overwritten with the tool's default: a resolver's answer must
    // never be persisted as the user's choice.
    expect(configStore.get().config?.planner).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      model: 'auto',
    });
    ui.unmount();
  });

  it('leaves the seat alone when the picker is closed without confirming', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto', authChannel: 'session' },
    });
    seed(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(<ConfirmAuthProbe role="planner" method="api-key" />);
    await flushEffects();
    ui.stdin.write('c');
    await flushEffects();

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBe(null);
    ui.unmount();
  });

  it('writes the review seat its own channel and leaves the planner unchanged', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
      reviewer: { kind: 'cli', tool: 'codex' },
    });
    seed(config);
    const plannerBefore = JSON.stringify(config.planner);

    const ui = renderFeature(<ConfirmAuthProbe role="reviewer" method="session" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.reviewer).toMatchObject({
        tool: 'codex',
        authChannel: 'session',
      });
    });
    expect(JSON.stringify(configStore.get().config?.planner)).toBe(plannerBefore);
    ui.unmount();
  });

  it('writes the build seat its own channel', async () => {
    seed(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
        implementer: { kind: 'cli', tool: 'codex' },
      }),
    );

    const ui = renderFeature(<ConfirmAuthProbe role="implementer" method="api-key" />);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(configStore.get().config?.implementer).toMatchObject({
        tool: 'codex',
        authChannel: 'api-key',
      });
    });
    expect(configStore.get().config?.planner).not.toHaveProperty('authChannel');
    ui.unmount();
  });
});
