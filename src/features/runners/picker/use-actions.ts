import { useRef } from 'react';
import {
  readActiveRunner,
  clearReviewerSeat,
  setReviewNone,
} from '../../../core/config/accessors/active-runner.js';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { CustomCommandRunnerKind } from '../../../core/config/custom-commands/tuple.js';
import { seatFallback } from '../../../core/crew/fallback.js';
import { CREW_SEAT_LABELS, PLANNER_INHERITANCE, REVIEW_NONE } from '../../../core/crew/identity.js';
import { isSeatIdentity } from '../../../core/crew/seat-ids.js';
import { seatChangeWords } from '../../../core/crew/seats.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { seatConfiguredEffort } from '../../../core/runners/capabilities.js';
import {
  type SeatPickerRole,
  type PickerSlot,
  type ActiveRunnerRole,
  seatPickerLane,
  PICKER_ROLE_SEAT_IDS,
} from '../../../core/runners/seat-roles.js';
import type { Config } from '../../../core/schemas/config.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { detectProviderCatalog } from '../../../engine/providers/catalog-detection.js';
import { configStore } from '../../../stores/project/config.js';
import {
  reportConfigSaveFailure,
  formatConfigSaveSuccess,
} from '../../../stores/project/save-feedback.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore, type PickerSubView } from '../../../stores/ui/picker-view.js';
import { error } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  removeCustomModel,
  commitCustomCommand,
  commitCustomModel,
} from '../config-transforms/custom-model.js';
import {
  type SeatCommitResult,
  commitFallbackSelection,
  commitPlannerTierSelection,
  commitImplementerSelection,
  clearSeatFallback,
} from '../config-transforms/seat-selection.js';
import { type LocalConnectionProbe, localConnectionProvider } from '../local-connection/model.js';
import { readPickerRunner } from '../model-catalog/catalog.js';
import type { PickerOption, RunnerPickerOption } from '../model-catalog/options.js';
import type { ModelOption } from '../model-catalog/recency.js';
import { refreshPickerDetection } from '../refresh-detection.js';
import type { PickerCatalog } from './use-catalog.js';
import { usePickerProfile } from './profile.js';
import {
  savedSeatIdentity,
  runningSeatChangePoint,
  type RowEffortLadder,
  needsSignInVariantNote,
  rowEffortLadder,
  runnerItemOf,
} from './seat-identity.js';

export interface PickerActions {
  confirm(selection: PickerOption, model: ModelOption | null): Promise<void>;
  confirmProviderSelection(fullId: string, effort?: string | null | undefined): Promise<void>;
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
    signal: input.signal,
  });

/** The production ports, in one place: no other layer names these three functions. */
export const defaultPickerEffectDeps: PickerEffectDeps = {
  refresh: refreshPickerDetection,
  checkConnection: probeLocalConnection,
  saveConfig: configStore.save,
};

/** A picker action runs unawaited; its failure has to reach the user here. */
export async function reportFailure(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    feedbackStore.setError(toErrorMessage(err));
  }
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
  const profile = usePickerProfile();
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
      const changePoint = runningSeatChangePoint(config, updated);
      const words = [
        changePoint === undefined
          ? formatConfigSaveSuccess(subject, result)
          : seatChangeWords(`${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]]} seat`, changePoint),
        ...(notice === undefined ? [] : [notice]),
      ].join(SOFT_SEP);
      // A save that still needs a step from the user, such as a sign-in, is a warning.
      if (notice === undefined) feedbackStore.setMessage(words);
      else feedbackStore.setWarning(words);
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
    ladder?: RowEffortLadder | undefined,
  ): SeatCommitResult => {
    if (slot === 'fallback') {
      return commitFallbackSelection({
        config,
        role: seatRole,
        selection,
        model,
        effort,
        ...ladder,
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
          ...ladder,
        });
      case 'reviewer':
        return commitPlannerTierSelection({
          config,
          role: 'reviewer',
          selection,
          model,
          effort,
          ...ladder,
        });
      case 'implementer':
        return commitImplementerSelection({
          config,
          profile,
          selection,
          model,
          effort,
          ...ladder,
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
    ladder?: RowEffortLadder | undefined,
  ) => {
    if (slot === 'fallback') {
      const runner = readActiveRunner({ config, role: seatRole });
      if (
        isSeatIdentity(
          { tool: runner.kind === 'cli' ? runner.tool : '', model: runner.model },
          { tool: selection.id, model: modelId ?? undefined },
        )
      ) {
        feedbackStore.setMessage(
          `${catalog.roleLabel} runs ${savedSeatIdentity(config, seatRole, 'seat', profile)} now${SOFT_SEP}choose another tool or model`,
        );
        return;
      }
    }
    const seat = commitSelection(
      selection,
      modelId === null ? null : { id: modelId },
      effort,
      ladder,
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
        if (selection.kind === 'configured-command') return;
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
        if (selection.kind === 'review-none') {
          await commit(setReviewNone(config), `${catalog.roleLabel} ${REVIEW_NONE.mark}`);
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
    leftChange(item: PickerOption) {
      // A catalog opened for one tool must not follow the cursor onto the next, and
      // neither may a preset drafted from the tool the cursor left. The
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
      }
      catalog.setCurrentItem(item);
    },
    browseCatalog() {
      pickerViewStore.setBrowseCatalog(true);
    },
    deleteRight(item: ModelOption) {
      return reportFailure(async () => {
        if (slot === 'fallback') return;
        if (seatRole === 'reviewer' && configuredReviewerRunner(config) === undefined) {
          feedbackStore.setMessage(
            `${item.id} belongs to the planner. Remove it from the planner.`,
          );
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
          feedbackStore.setMessage('"auto" is already offered as the Auto row — select it there.');
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
