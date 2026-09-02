import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { reportConfigSaveFailure } from '../../stores/project/save-feedback.js';
import { SOFT_SEP } from '../../components/separators.js';
import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { cliProviderAuthFacts } from '../../core/discovery/detection.js';
import { formatModelName } from '../../core/model-display.js';
import type { CustomCommandRunnerKind } from '../../core/config/custom-commands.js';
import { clearReviewerSeat } from '../../core/config/accessors/active-runner.js';

import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import {
  seatPickerLane,
  type ActiveRunnerRole,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import type { Config } from '../../core/schemas/config.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import type { PickerOption, RunnerPickerOption } from './model-catalog/options.js';
import {
  compactProviderTag,
  modelProviderAuthKey,
  modelProviderPrefix,
  resolveProviderAuthState,
} from './model-catalog/provider-axis.js';
import type { ModelOption } from './model-catalog/recency.js';
import { formatNeedsSignInSaveFeedback, gatewayAccountName } from './picker-format.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import {
  commitPlannerTierSelection,
  commitImplementerSelection,
  commitCustomCommand,
  commitCustomModel,
  inheritsPlannerSeat,
  removeCustomModel,
  type SeatCommitResult,
} from './config-transforms.js';
import { pickerViewStore, type PickerSubView } from '../../stores/ui/picker-view.js';

export interface PickerActions {
  confirm(selection: PickerOption, model: ModelOption | null): Promise<void>;
  confirmProviderVariant(fullId: string, variant?: string | undefined): Promise<void>;
  leftChange(item: PickerOption): void;
  browseCatalog(): void;
  deleteRight(item: ModelOption): Promise<void>;
  chooseContract(kind: CustomCommandRunnerKind): void;
  customCommand(cmd: string): Promise<void>;
  customModel(modelName: string): Promise<void>;
  openCustomModel(item: PickerOption): void;
  closeOverlay(): void;
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
  if (item.kind === 'custom-command' || item.kind === 'inherit-planner') {
    return undefined;
  }
  return item;
}

/**
 * The provider honesty note for a chosen variant, mirroring the picker's
 * confirm-time semantics: an unreadable oracle claims nothing, a configured
 * provider needs no note, and only a missing credential names the login
 * command that unblocks the saved selection.
 */
function needsSignInVariantNote(item: RunnerPickerOption, fullId: string): string | undefined {
  const toolId = includes(CLI_TOOL_IDS, item.id) ? item.id : undefined;
  if (toolId === undefined) return undefined;
  const facts = cliProviderAuthFacts(
    detectionStore.get().cliTools.find((d) => d.tool === toolId)?.providerAuth,
  );
  if (facts === undefined) return undefined;
  const authKey = modelProviderAuthKey(fullId);
  const prefix = modelProviderPrefix(fullId);
  if (authKey === undefined || prefix === undefined) return undefined;
  if (resolveProviderAuthState(authKey, facts) === 'configured') return undefined;
  const gatewayKey = CLI_TOOL_CATALOG[toolId].command;
  return formatNeedsSignInSaveFeedback({
    modelId: fullId,
    tag: compactProviderTag(prefix),
    authKey,
    loginCommand: `${gatewayKey} auth login`,
    ...(authKey === gatewayKey ? { gatewayAccount: gatewayAccountName(toolId) } : {}),
  });
}

export function usePickerActions(opts: {
  role: SeatPickerRole;
  catalog: PickerCatalog;
}): PickerActions {
  const { role, catalog } = opts;
  const seatRole: ActiveRunnerRole = seatPickerLane(role);
  const config = configStore.useConfig();
  const view = pickerViewStore.use((s) => s.view);
  const preservedLeftIndex = pickerViewStore.use((s) => s.preservedLeftIndex);

  const reportNotice = (notice: string | undefined) => {
    if (notice !== undefined && !feedbackStore.get().isError) {
      feedbackStore.setMessage(notice);
    }
  };

  const commit = async (updated: Config, message: string) => {
    const result = await configStore.save(updated);
    if (reportConfigSaveFailure(result)) return;
    feedbackStore.setMessage(message);
    overlayStore.close();
  };

  // Axis 2 of the role: which config node a selection is written to. A reviewer
  // committed through the planner path would overwrite `config.planner`.
  const commitSelection = (
    selection: RunnerPickerOption,
    model: { id: string } | null,
    variant?: string | undefined,
  ): SeatCommitResult => {
    switch (seatRole) {
      case 'planner':
        return commitPlannerTierSelection({ config, role: 'planner', selection, model, variant });
      case 'reviewer':
        return commitPlannerTierSelection({ config, role: 'reviewer', selection, model, variant });
      case 'implementer':
        return commitImplementerSelection({ config, selection, model, variant });
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
    note?: string | undefined,
    variant?: string | undefined,
  ) => {
    const seat = commitSelection(selection, modelId === null ? null : { id: modelId }, variant);
    const label =
      modelId === null
        ? selection.displayName
        : `${selection.displayName}${SOFT_SEP}${formatModelName(modelId)}`;
    // The line names what the commit kept: a variant the seat's tool cannot spell
    // is dropped there, and announcing it would retract itself one line later.
    const saved = seat.variant === undefined ? label : `${label}${SOFT_SEP}${seat.variant}`;
    await commit(seat.config, `${catalog.roleLabel} set to: ${saved}`);
    // Both notices are news the save does not carry: neither may overwrite the
    // other, so they land as one line.
    reportNotice(
      [seat.notice, note].filter((line) => line !== undefined).join(SOFT_SEP) || undefined,
    );
  };

  return {
    confirm(selection: PickerOption, model: ModelOption | null) {
      return reportFailure(async () => {
        if (selection.kind === 'custom-command') {
          const selectionIndex = catalog.items.findIndex((item) => item.id === selection.id);
          pickerViewStore.open(
            { kind: 'custom-command-contract' },
            selectionIndex >= 0 ? selectionIndex : launcherIndex >= 0 ? launcherIndex : 0,
          );
          return;
        }
        if (selection.kind === 'inherit-planner') {
          await commit(clearReviewerSeat(config), `${catalog.roleLabel} set to: same as planner`);
          return;
        }
        await saveModelSelection(selection, model?.id ?? null);
      });
    },
    async confirmProviderVariant(fullId: string, variant?: string | undefined) {
      const item = runnerItemOf(catalog.currentItem);
      if (item === undefined) return;
      await saveModelSelection(item, fullId, needsSignInVariantNote(item, fullId), variant);
    },
    leftChange(item: PickerOption) {
      // A catalog opened for one tool must not follow the cursor onto the next, and
      // neither may a preset drafted from the tool the cursor left.
      pickerViewStore.setBrowseCatalog(false);
      pickerViewStore.setVariantDraft(null);
      catalog.setCurrentItem(item);
    },
    browseCatalog() {
      pickerViewStore.setBrowseCatalog(true);
    },
    deleteRight(item: ModelOption) {
      return reportFailure(async () => {
        if (inheritsPlannerSeat(config, seatRole)) {
          feedbackStore.setError(`${item.id} belongs to the planner. Remove it from the planner.`);
          return;
        }
        const updated = removeCustomModel(config, seatRole, item.id);
        const result = await configStore.save(updated);
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
        });
        await commit(updated, `${catalog.roleLabel} set to: ${view.intendedKind}: ${cmd}`);
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
        const updated = commitCustomModel({
          config,
          role: seatRole,
          selection: customModelItem,
          modelName,
          customModels: catalog.customModels,
        });
        await commit(
          updated,
          `${catalog.roleLabel} set to: ${customModelItem.displayName}${SOFT_SEP}${formatModelName(modelName)}`,
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
