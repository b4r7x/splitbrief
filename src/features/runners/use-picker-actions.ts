import { useRef } from 'react';

import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { routerStore } from '../../stores/navigation/router.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { selectSeatChangePoint, tasksStore } from '../../stores/workflow/tasks.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import {
  formatConfigSaveSuccess,
  reportConfigSaveFailure,
} from '../../stores/project/save-feedback.js';
import { seatIdentitiesFromConfig, seatIdentityChanges } from '../../core/state/seats.js';
import { SOFT_SEP } from '../../core/separators.js';
import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import type { CustomCommandRunnerKind } from '../../core/config/custom-commands.js';

import {
  CREW_SEAT_LABELS,
  formatSeatIdentity,
  isSeatIdentity,
  PLANNER_INHERITANCE,
} from '../../core/crew/identity.js';
import { seatFallback } from '../../core/crew/fallback.js';
import { seatChangeWords } from '../../core/crew/seats.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';

import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import type { ApiProviderId } from '../../core/providers/api-provider-catalog.js';
import { getKnownProviderBaseURL } from '../../core/providers/catalog.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import {
  clearReviewerSeat,
  readActiveRunner,
  updateActiveRunner,
} from '../../core/config/accessors/active-runner.js';
import { detectProviderCatalog } from '../../engine/providers/catalog-detection.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';
import type { ImplementerConfig } from '../../core/schemas/implementer-config.js';
import {
  localConnectionProvider,
  type LocalConnectionProbe,
  type LocalConnectionSave,
  type LocalConnectionSeat,
} from './local-connection-form.js';
import { applyCliAuthChoice } from '../../core/runners/cli-auth-selection.js';
import { seatConfiguredEffort } from '../../core/runners/capabilities.js';
import { CLI_TOOL_IDS, type CliAuthMethod } from '../../core/runners/cli-tool-catalog.js';
import {
  PICKER_ROLE_SEAT_IDS,
  seatPickerLane,
  type ActiveRunnerRole,
  type PickerSlot,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import type { Config } from '../../core/schemas/config.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import type { PickerOption, RunnerPickerOption } from './model-catalog/options.js';
import { readPickerRunner } from './model-catalog/catalog.js';
import { routeAuthState } from '../../core/runners/route-auth.js';
import type { ModelOption } from './model-catalog/recency.js';
import { formatNeedsSignInSaveFeedback } from './picker-format.js';
import { refreshPickerDetection } from './refresh-detection.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import { AUTH_METHOD_WORDS, effortLadderFor, type RightRow } from './model-catalog/rows.js';
import {
  commitPlannerTierSelection,
  commitImplementerSelection,
  commitCustomCommand,
  commitCustomModel,
  commitFallbackSelection,
  clearSeatFallback,
  inheritsPlannerSeat,
  removeCustomModel,
  type SeatCommitResult,
} from './config-transforms.js';
import { pickerViewStore, type PickerSubView } from '../../stores/ui/picker-view.js';

export interface PickerActions {
  confirm(selection: PickerOption, model: ModelOption | null): Promise<void>;
  confirmProviderSelection(fullId: string, effort?: string | null | undefined): Promise<void>;
  /** Binds the seat's own invocations to one method, or hands them back to the tool's login. */
  confirmAuthMethod(method: CliAuthMethod | 'host-configured'): Promise<void>;
  leftChange(item: PickerOption): void;
  browseCatalog(): void;
  deleteRight(item: ModelOption): Promise<void>;
  chooseContract(kind: CustomCommandRunnerKind): void;
  customCommand(cmd: string): Promise<void>;
  customModel(modelName: string): Promise<void>;
  openCustomModel(item: PickerOption): void;
  closeOverlay(): void;
}

/**
 * The three effects the picker spends outside itself: the detection refresh Ctrl+R runs,
 * the read-only probe Check and Retry spend, and the config write a confirmation commits.
 * Every picker surface takes them as one object so a gallery preview can hand the picker
 * its own without any layer reaching for the production function.
 */
export interface PickerEffectDeps {
  refresh: typeof refreshPickerDetection;
  checkConnection: LocalConnectionProbe;
  saveConfig: typeof configStore.save;
}

/** The three functions the local-server form is driven by, and nothing else. */
export interface LocalConnectionActions {
  /** The seat's own connection; a review seat never reads the planner's. */
  seat(provider: ApiProviderId): LocalConnectionSeat;
  /** The read-only catalog probe Check and Retry spend; it runs no model. */
  check: LocalConnectionProbe;
  save(input: LocalConnectionSave): Promise<void>;
}

/**
 * Check and Retry list one connection's catalog and nothing else: no generation, no
 * pull, no load. The form receives it as a function so a test — and T-137's App — can
 * pass its own without the picker reaching for a client.
 */
const probeLocalConnection: LocalConnectionProbe = (input) =>
  detectProviderCatalog({
    provider: input.provider,
    configOverrides: {
      apiBase: input.apiBase,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    },
  });

/** The production ports, in one place: no other layer names these three functions. */
export const defaultPickerEffectDeps: PickerEffectDeps = {
  refresh: refreshPickerDetection,
  checkConnection: probeLocalConnection,
  saveConfig: configStore.save,
};

/**
 * The block the seat owns, never the one it falls back to: an unconfigured review seat
 * resolves to the planner's runner, and reading that here would prefill REVIEW with
 * PLAN's address.
 */
function seatOwnRunner(
  config: Config,
  role: ActiveRunnerRole,
  profile: string | undefined,
): PlannerConfig | ImplementerConfig | undefined {
  if (role === 'planner') return config.planner;
  if (role === 'reviewer') return config.reviewer;
  return readActiveRunner({ config, role: 'implementer', profile });
}

/**
 * A cleared token reference is a removal, and `buildRunnerConfig` would inherit the old
 * one instead: the seat's own block decides, so the drop happens after it is built.
 */
function dropClearedPlannerToken(runner: PlannerConfig, apiKey: string | undefined): PlannerConfig {
  if (apiKey !== undefined || runner.kind !== 'api' || runner.apiKey === undefined) return runner;
  const { apiKey: _cleared, ...rest } = runner;
  return rest;
}

function dropClearedImplementerToken(
  runner: ImplementerConfig,
  apiKey: string | undefined,
): ImplementerConfig {
  if (apiKey !== undefined || runner.kind !== 'api' || runner.apiKey === undefined) return runner;
  const { apiKey: _cleared, ...rest } = runner;
  return rest;
}

/**
 * The seat's own channel, written through the core choice so host configuration
 * removes the field rather than persisting the tool's default as a user's choice.
 * A seat that runs no CLI has no invocation to bind a method to.
 */
function writeSeatAuthChannel(
  config: Config,
  role: ActiveRunnerRole,
  method: CliAuthMethod | 'host-configured',
  profile: string | undefined,
): Config {
  switch (role) {
    case 'planner':
      return updateActiveRunner({
        config,
        role: 'planner',
        updater: (existing) =>
          existing.kind === 'cli' ? applyCliAuthChoice(existing, method) : existing,
      });
    case 'reviewer':
      return updateActiveRunner({
        config,
        role: 'reviewer',
        updater: (existing) =>
          existing.kind === 'cli' ? applyCliAuthChoice(existing, method) : existing,
      });
    case 'implementer':
      return updateActiveRunner({
        config,
        role: 'implementer',
        profile,
        updater: (existing) =>
          existing.kind === 'cli' ? applyCliAuthChoice(existing, method) : existing,
      });
    default:
      return assertNever(role);
  }
}

/**
 * A seat saved under a run this process is driving lands at the next brief boundary,
 * where the run re-prepares from the saved config. A halt's own picker swaps the seat at
 * once, so it is not announced as a boundary change.
 */
function changesRunningSeat(before: Config, after: Config): boolean {
  const route = routerStore.get();
  return (
    route.screen === 'workflow' &&
    route.execution.kind === 'local' &&
    lifecycleStore.get().status === 'running' &&
    recoveryNoticeStore.get().issue === null &&
    seatIdentityChanges(seatIdentitiesFromConfig(before), seatIdentitiesFromConfig(after)).length >
      0
  );
}

/**
 * The seat a save kept, in the words the crew rows and the sidebar show for it: the model's
 * catalog label and every axis the saved block carries, so a level the tool cannot spell, which
 * the commit dropped, is never announced.
 */
function savedSeatIdentity(
  saved: Config,
  role: ActiveRunnerRole,
  slot: PickerSlot,
  profile: string | undefined,
): string {
  const runner = readPickerRunner(saved, role, slot, profile);
  if (runner === undefined) {
    throw error('picker-invalid-fallback', 'Saved fallback has no CLI runner', { role });
  }
  return formatSeatIdentity({
    seat: runner,
    displayName: resolveSeatDisplayName(runner, role, modelCacheStore),
  });
}

/** A picker action runs unawaited; its failure has to reach the user here. */
async function reportFailure(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    feedbackStore.setError(toErrorMessage(err));
  }
}

/** The seat rows that can carry a model; the terminal rows never reach a commit. */
function runnerItemOf(item: PickerOption | undefined): RunnerPickerOption | undefined {
  if (item === undefined) return undefined;
  if (
    item.kind === 'custom-command' ||
    item.kind === 'inherit-planner' ||
    item.kind === 'no-fallback'
  ) {
    return undefined;
  }
  return item;
}

/**
 * The provider honesty note for a saved model, a route or a custom id, read the
 * way its picker row reads it: only a route that needs a sign-in names the login
 * command that unblocks the saved selection.
 */
function needsSignInVariantNote(item: RunnerPickerOption, fullId: string): string | undefined {
  const toolId = includes(CLI_TOOL_IDS, item.id) ? item.id : undefined;
  if (toolId === undefined) return undefined;
  const auth = routeAuthState({
    tool: toolId,
    model: fullId,
    providerAuth: detectionStore.get().cliTools.find((d) => d.tool === toolId)?.providerAuth,
    catalog: modelCacheStore.getCliCatalogRuntime({ tool: toolId }),
  });
  if (auth.kind === 'needs-sign-in' || (auth.kind === 'unknown' && auth.reason === 'empty')) {
    return formatNeedsSignInSaveFeedback({ tool: auth.tool, provider: auth.provider });
  }
  return undefined;
}

/** The ladder the row published for this id; an empty one is unknown, never a reason to clear. */
function rowEffortLadder(rows: readonly RightRow[], fullId: string): readonly string[] | undefined {
  for (const row of rows) {
    if (row.kind === 'action' || row.kind === 'auth') continue;
    const owns =
      row.model.id === fullId ||
      (row.model.variants ?? []).some((variant) => variant.fullId === fullId);
    if (!owns) continue;
    const choices = effortLadderFor(row.model, fullId);
    if (choices.length > 0) return choices;
  }
  return undefined;
}

export function usePickerActions(opts: {
  role: SeatPickerRole;
  slot: PickerSlot;
  catalog: PickerCatalog;
  deps?: PickerEffectDeps | undefined;
}): PickerActions {
  const { role, slot, catalog, deps = defaultPickerEffectDeps } = opts;
  const seatRole: ActiveRunnerRole = seatPickerLane(role);
  const config = configStore.useConfig();
  const view = pickerViewStore.use((s) => s.view);
  const preservedLeftIndex = pickerViewStore.use((s) => s.preservedLeftIndex);
  const profile = pickerViewStore.use((s) => s.profile);
  const saveInFlight = useRef(false);

  const seatSaved = (updated: Config) =>
    `${catalog.roleLabel}${slot === 'fallback' ? ' fallback' : ''}${SOFT_SEP}${savedSeatIdentity(updated, seatRole, slot, profile)}`;

  // A notice is news the save does not carry, so it joins the save line rather than replacing it.
  const commit = async (updated: Config, subject: string, notice?: string | undefined) => {
    // Enter can land again before the first save settles; the hold survives
    // re-renders and every outcome releases it so a later retry can save.
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    try {
      const result = await deps.saveConfig(updated);
      if (reportConfigSaveFailure(result)) return;
      feedbackStore.setMessage(
        [
          changesRunningSeat(config, updated)
            ? seatChangeWords(
                `${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]]} seat`,
                selectSeatChangePoint(tasksStore.get(), lifecycleStore.get().phase),
              )
            : formatConfigSaveSuccess(subject, result),
          ...(notice === undefined ? [] : [notice]),
        ].join(SOFT_SEP),
      );
      pickerViewStore.setCommitted(true);
      overlayStore.close();
    } finally {
      saveInFlight.current = false;
    }
  };

  // Axis 2 of the role: which config node a selection is written to. A reviewer
  // committed through the planner path would overwrite `config.planner`.
  const commitSelection = (
    selection: RunnerPickerOption,
    model: { id: string } | null,
    effort?: string | null | undefined,
    effortChoices?: readonly string[] | undefined,
  ): SeatCommitResult => {
    if (slot === 'fallback') {
      return commitFallbackSelection({
        config,
        role: seatRole,
        selection,
        model,
        effort,
        effortChoices,
      });
    }
    switch (seatRole) {
      case 'planner':
        return commitPlannerTierSelection({
          config,
          role: 'planner',
          selection,
          model,
          effort,
          effortChoices,
        });
      case 'reviewer':
        return commitPlannerTierSelection({
          config,
          role: 'reviewer',
          selection,
          model,
          effort,
          effortChoices,
        });
      case 'implementer':
        return commitImplementerSelection({
          config,
          profile,
          selection,
          model,
          effort,
          effortChoices,
        });
      default:
        return assertNever(seatRole);
    }
  };

  const launcherIndex = catalog.items.findIndex((item) => item.kind === 'custom-command');

  const openSubView = (subView: PickerSubView, item: PickerOption) => {
    const index = catalog.items.findIndex((entry) => entry.id === item.id);
    pickerViewStore.open(subView, index >= 0 ? index : 0);
  };

  const saveModelSelection = async (
    selection: RunnerPickerOption,
    modelId: string | null,
    effort?: string | null | undefined,
    effortChoices?: readonly string[] | undefined,
  ) => {
    if (slot === 'fallback') {
      const runner = readActiveRunner({ config, role: seatRole });
      if (
        isSeatIdentity(
          { tool: runner.kind === 'cli' ? runner.tool : '', model: runner.model },
          { tool: selection.id, model: modelId ?? undefined },
        )
      ) {
        feedbackStore.setError(
          `${catalog.roleLabel} runs ${savedSeatIdentity(config, seatRole, 'seat', profile)} now${SOFT_SEP}choose another tool or model`,
        );
        return;
      }
    }
    const seat = commitSelection(
      selection,
      modelId === null ? null : { id: modelId },
      effort,
      effortChoices,
    );
    const note = modelId === null ? undefined : needsSignInVariantNote(selection, modelId);
    await commit(
      seat.config,
      seatSaved(seat.config),
      [seat.notice, note].filter((line) => line !== undefined).join(SOFT_SEP) || undefined,
    );
  };

  return {
    confirm(selection: PickerOption, model: ModelOption | null) {
      return reportFailure(async () => {
        if (selection.kind === 'no-fallback') {
          if (seatFallback(config, seatRole) === undefined) {
            overlayStore.close();
            return;
          }
          await commit(
            clearSeatFallback(config, seatRole),
            `${catalog.roleLabel} fallback${SOFT_SEP}none`,
            'Seat down pauses and asks',
          );
          return;
        }
        const localProvider = localConnectionProvider(selection);
        if (localProvider !== undefined) {
          openSubView({ kind: 'local-connection', provider: localProvider }, selection);
          return;
        }
        if (selection.kind === 'custom-command') {
          const selectionIndex = catalog.items.findIndex((item) => item.id === selection.id);
          pickerViewStore.open(
            { kind: 'custom-command-contract' },
            selectionIndex >= 0 ? selectionIndex : launcherIndex >= 0 ? launcherIndex : 0,
          );
          return;
        }
        if (selection.kind === 'inherit-planner') {
          await commit(
            clearReviewerSeat(config),
            `${catalog.roleLabel} ${PLANNER_INHERITANCE.mark}`,
          );
          return;
        }
        await saveModelSelection(
          selection,
          model?.id ?? null,
          undefined,
          model === null ? undefined : rowEffortLadder(catalog.rightRows, model.id),
        );
      });
    },
    confirmProviderSelection(fullId: string, effort?: string | null | undefined) {
      return reportFailure(async () => {
        const item = runnerItemOf(catalog.currentItem);
        if (item === undefined) return;
        await saveModelSelection(item, fullId, effort, rowEffortLadder(catalog.rightRows, fullId));
      });
    },
    confirmAuthMethod(method: CliAuthMethod | 'host-configured') {
      return reportFailure(async () => {
        await commit(
          writeSeatAuthChannel(config, seatRole, method, profile),
          `${catalog.roleLabel} auth${SOFT_SEP}${AUTH_METHOD_WORDS[method]}`,
        );
      });
    },
    leftChange(item: PickerOption) {
      // A catalog opened for one tool must not follow the cursor onto the next, and
      // neither may a preset or a method drafted from the tool the cursor left. The
      // column's mount notice names the tool already current, which the cursor never
      // left, so the level a crew row opened the picker on survives the first paint.
      // Back on the current tool, the ladder reads the saved level again.
      if (item.id !== catalog.currentItem?.id) {
        pickerViewStore.setBrowseCatalog(false);
        const runner = readPickerRunner(config, seatRole, slot, profile);
        pickerViewStore.setEffortDraft(
          item.isCurrent === true && runner !== undefined
            ? seatConfiguredEffort({
                runner,
                role: seatRole,
              })
            : null,
        );
        pickerViewStore.setAuthDraft(null);
      }
      catalog.setCurrentItem(item);
    },
    browseCatalog() {
      pickerViewStore.setBrowseCatalog(true);
    },
    deleteRight(item: ModelOption) {
      return reportFailure(async () => {
        if (slot === 'fallback') return;
        if (inheritsPlannerSeat(config, seatRole)) {
          feedbackStore.setError(`${item.id} belongs to the planner. Remove it from the planner.`);
          return;
        }
        const updated = removeCustomModel(config, seatRole, item.id, profile);
        const result = await deps.saveConfig(updated);
        if (reportConfigSaveFailure(result)) return;
        feedbackStore.setMessage(`Removed custom model: ${item.id}`);
      });
    },
    chooseContract(kind: CustomCommandRunnerKind) {
      if (view.kind !== 'custom-command-contract') return;
      pickerViewStore.open({ kind: 'custom-command', intendedKind: kind }, preservedLeftIndex);
    },
    customCommand(cmd: string) {
      return reportFailure(async () => {
        if (view.kind !== 'custom-command') {
          throw error('picker-invalid-view', 'customCommand called outside custom-command view', {
            view: view.kind,
          });
        }
        const updated = commitCustomCommand({
          config,
          role: seatRole,
          command: cmd,
          kind: view.intendedKind,
          profile,
        });
        await commit(updated, seatSaved(updated));
      });
    },
    customModel(modelName: string) {
      return reportFailure(async () => {
        if (view.kind !== 'custom-model') return;
        if (isAutomaticModel(modelName)) {
          feedbackStore.setError('"auto" is already offered as the Auto row — select it there.');
          return;
        }
        const customModelItem = runnerItemOf(catalog.currentItem);
        if (customModelItem === undefined) return;
        if (slot === 'fallback') {
          await saveModelSelection(customModelItem, modelName);
          return;
        }
        const updated = commitCustomModel({
          config,
          role: seatRole,
          selection: customModelItem,
          modelName,
          customModels: catalog.customModels,
          profile,
        });
        await commit(
          updated,
          seatSaved(updated),
          needsSignInVariantNote(customModelItem, modelName),
        );
      });
    },
    openCustomModel(item: PickerOption) {
      if (runnerItemOf(item) === undefined) return;
      openSubView({ kind: 'custom-model' }, item);
    },
    closeOverlay() {
      pickerViewStore.close();
    },
  };
}

/**
 * The local-server form's own ports. They sit beside `usePickerActions` rather than
 * inside it: the form is the only caller, and every other picker surface would have to
 * carry three members it never spends.
 */
export function useLocalConnectionActions(
  role: SeatPickerRole,
  deps: PickerEffectDeps = defaultPickerEffectDeps,
): LocalConnectionActions {
  const seatRole: ActiveRunnerRole = seatPickerLane(role);
  const config = configStore.useConfig();
  const profile = pickerViewStore.use((s) => s.profile);
  const roleLabel = CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]];

  return {
    seat(provider: ApiProviderId): LocalConnectionSeat {
      const own = seatOwnRunner(config, seatRole, profile);
      const configured = own?.kind === 'api' && own.provider === provider ? own : undefined;
      return {
        apiBase: configured?.apiBase ?? getKnownProviderBaseURL(provider),
        ...(configured?.apiKey === undefined ? {} : { apiKey: configured.apiKey }),
        ...(configured?.model === undefined ? {} : { model: configured.model }),
      };
    },
    check: deps.checkConnection,
    save(input: LocalConnectionSave) {
      return reportFailure(async () => {
        const opts = {
          kind: 'api' as const,
          tool: input.provider,
          apiBase: input.apiBase,
          ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
          model: input.model,
        };
        // The seat's own block, so a saved REVIEW address never lands on the planner.
        const updated =
          seatRole === 'implementer'
            ? updateActiveRunner({
                config,
                role: 'implementer',
                profile,
                updater: (existing) =>
                  dropClearedImplementerToken(
                    buildRunnerConfig('implementer', { ...opts, existing }),
                    input.apiKey,
                  ),
              })
            : updateActiveRunner({
                config,
                role: seatRole,
                updater: (existing) =>
                  dropClearedPlannerToken(
                    buildRunnerConfig(seatRole, { ...opts, existing }),
                    input.apiKey,
                  ),
              });
        const result = await deps.saveConfig(updated);
        if (reportConfigSaveFailure(result)) return;
        feedbackStore.setMessage(
          formatConfigSaveSuccess(
            `${roleLabel}${SOFT_SEP}${savedSeatIdentity(updated, seatRole, 'seat', profile)}`,
            result,
          ),
        );
        pickerViewStore.setCommitted(true);
        overlayStore.close();
      });
    },
  };
}
