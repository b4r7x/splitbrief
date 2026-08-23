import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { reportConfigSaveFailure } from '../../stores/project/save-feedback.js';
import { CHEVRON_SEP, SOFT_SEP } from '../../components/separators.js';
import { error } from '../../utils/error.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { formatModelName } from '../../core/model-display.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { clearReviewerSeat } from '../../core/config/accessors/active-runner.js';

import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  type ActiveRunnerRole,
} from '../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../core/schemas/config.js';
import { getDefaultDetectionService } from '../../engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../../engine/detection/store-publication.js';
import { assertNever, includes } from '../../utils/type-guards.js';
import {
  compactProviderTag,
  modelProviderAuthKey,
  modelProviderPrefix,
  resolveProviderAuthState,
  type PickerOption,
  type RunnerPickerOption,
} from './model-catalog/options.js';
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
} from './config-transforms.js';
import {
  configHasInlineApiKey,
  failureCopy,
  gitignoreCoversSplitbrief,
  redactKey,
  validateProviderKey,
} from './provider-auth.js';
import type { ViewState, ViewAction } from './view-state.js';

export interface PickerActions {
  confirm(selection: PickerOption, model: ModelOption | null): void;
  confirmProviderVariant(fullId: string): Promise<void>;
  leftChange(item: PickerOption): void;
  deleteRight(item: ModelOption): void;
  chooseContract(kind: 'shell' | 'agent'): void;
  customCommand(cmd: string): void;
  customModel(modelName: string): void;
  openCustomModel(item: PickerOption): void;
  openProviderAuth(item: PickerOption): void;
  submitProviderKey(value: string): Promise<void>;
  closeOverlay(): void;
}

export interface PickerActionDeps {
  validateKey: typeof validateProviderKey;
  refreshDetection: () => Promise<unknown>;
  readGitignore: (projectDir: string) => Promise<string | null>;
}

function defaultRefreshDetection(): Promise<unknown> {
  return refreshDetectionForCurrentConfig({
    service: getDefaultDetectionService(),
    publication: detectionStore,
    getCurrent: () => {
      const { config, projectDir } = configStore.get();
      return config === null || projectDir === '' ? null : { config, projectDir };
    },
  });
}

async function defaultReadGitignore(projectDir: string): Promise<string | null> {
  try {
    return await readFile(join(projectDir, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
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
  const facts = detectionStore.get().cliTools.find((d) => d.tool === toolId)?.providerAuth;
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
  role: ActiveRunnerRole;
  catalog: PickerCatalog;
  viewState: ViewState;
  dispatchView: (action: ViewAction) => void;
  deps?: Partial<PickerActionDeps> | undefined;
}): PickerActions {
  const { role, catalog, viewState, dispatchView } = opts;
  const config = configStore.useConfig();
  const deps: PickerActionDeps = {
    validateKey: opts.deps?.validateKey ?? validateProviderKey,
    refreshDetection: opts.deps?.refreshDetection ?? defaultRefreshDetection,
    readGitignore: opts.deps?.readGitignore ?? defaultReadGitignore,
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
    apiKey?: string,
  ): Config => {
    switch (role) {
      case 'planner':
        return commitPlannerTierSelection({ config, role: 'planner', selection, model, apiKey });
      case 'reviewer':
        return commitPlannerTierSelection({ config, role: 'reviewer', selection, model, apiKey });
      case 'implementer':
        return commitImplementerSelection(config, selection, model, apiKey);
      default:
        return assertNever(role);
    }
  };

  const launcherIndex = catalog.items.findIndex((item) => item.kind === 'custom-command');

  return {
    async confirm(selection: PickerOption, model: ModelOption | null) {
      if (selection.kind === 'custom-command') {
        const selectionIndex = catalog.items.findIndex((item) => item.id === selection.id);
        dispatchView({
          type: 'open-custom-command-contract',
          preservedLeftIndex:
            selectionIndex >= 0 ? selectionIndex : launcherIndex >= 0 ? launcherIndex : 0,
        });
        return;
      }
      if (selection.kind === 'inherit-planner') {
        await commit(clearReviewerSeat(config), `${catalog.roleLabel} set to: same as planner`);
        return;
      }
      if (model !== null && (model.variants?.length ?? 0) > 1) {
        // A merged row spans several provider routes; the choice of route is
        // the user's, so nothing saves until the overlay picks one.
        dispatchView({ type: 'open-provider-choice', item: selection, model });
        return;
      }
      const label = model
        ? `${selection.displayName}${CHEVRON_SEP}${formatModelName(model.id)}`
        : selection.displayName;
      const updated = commitSelection(selection, model);
      await commit(updated, `${catalog.roleLabel} set to: ${label}`);
    },
    async confirmProviderVariant(fullId: string) {
      if (viewState.view.kind !== 'provider-choice') return;
      const item = viewState.view.item;
      const note = needsSignInVariantNote(item, fullId);
      const label = `${item.displayName}${CHEVRON_SEP}${formatModelName(fullId)}`;
      const updated = commitSelection(item, { id: fullId });
      await commit(updated, `${catalog.roleLabel} set to: ${label}`);
      // The commit posts its own save or failure feedback first; the provider
      // honesty note replaces only a successful save message.
      if (note !== undefined && !feedbackStore.get().isError) {
        feedbackStore.setMessage(note);
      }
    },
    leftChange(item: PickerOption) {
      catalog.setCurrentItem(item);
    },
    async deleteRight(item: ModelOption) {
      if (inheritsPlannerSeat(config, role)) {
        feedbackStore.setError(`${item.id} belongs to the planner. Remove it from the planner.`);
        return;
      }
      const updated = removeCustomModel(config, role, item.id);
      const result = await configStore.save(updated);
      if (reportConfigSaveFailure(result)) return;
      feedbackStore.setMessage(`Removed custom model: ${item.id}`);
    },
    chooseContract(kind: 'shell' | 'agent') {
      if (viewState.view.kind !== 'custom-command-contract') return;
      dispatchView({
        type: 'open-custom-command',
        preservedLeftIndex: viewState.preservedLeftIndex,
        intendedKind: kind,
      });
    },
    async customCommand(cmd: string) {
      if (viewState.view.kind !== 'custom-command') {
        throw error('picker-invalid-view', 'customCommand called outside custom-command view', {
          view: viewState.view.kind,
        });
      }
      const updated = commitCustomCommand({
        config,
        role,
        command: cmd,
        kind: viewState.view.intendedKind,
      });
      await commit(updated, `${catalog.roleLabel} set to: ${viewState.view.intendedKind}: ${cmd}`);
    },
    async customModel(modelName: string) {
      if (viewState.view.kind !== 'custom-model') return;
      if (isAutomaticModel(modelName)) {
        feedbackStore.setError('"auto" is already offered as the Auto row — select it there.');
        return;
      }
      const customModelItem = viewState.view.item;
      const updated = commitCustomModel({
        config,
        role,
        selection: customModelItem,
        modelName,
        customModels: catalog.customModels,
      });
      await commit(
        updated,
        `${catalog.roleLabel} set to: ${customModelItem.displayName}${CHEVRON_SEP}${formatModelName(modelName)}`,
      );
    },
    openCustomModel(item: PickerOption) {
      if (item.kind === 'custom-command' || item.kind === 'inherit-planner') return;
      dispatchView({ type: 'open-custom-model', item });
    },
    openProviderAuth(item: PickerOption) {
      if (item.kind !== 'api') return;
      dispatchView({ type: 'open-provider-auth', item });
    },
    async submitProviderKey(value: string) {
      if (viewState.view.kind !== 'provider-auth') {
        throw error('picker-invalid-view', 'submitProviderKey called outside provider-auth view', {
          view: viewState.view.kind,
        });
      }
      const item = viewState.view.item;
      const descriptor = getApiProviderDescriptor(item.id);
      if (descriptor === undefined) {
        feedbackStore.setError(`Unknown provider: ${item.id}`);
        return;
      }
      feedbackStore.setMessage(`Validating ${descriptor.displayName} key…`);
      const validation = await deps.validateKey({ provider: descriptor.id, apiKey: value });
      if (validation.kind === 'invalid') {
        feedbackStore.setError(failureCopy(validation.failure, descriptor));
        return;
      }
      // An implementer moving onto a new provider needs a model; the probe's
      // catalog supplies one. A planner-tier seat or an unchanged provider keeps its own.
      const authModel = (): { id: string } | null => {
        if (role !== 'implementer') return null;
        const existing = resolveImplementerProfiles(config).defaultProfile.config;
        if (
          existing.kind === 'api' &&
          existing.provider === item.id &&
          existing.model !== undefined
        ) {
          return null;
        }
        const first = validation.models[0];
        return first === undefined ? null : { id: first.id };
      };
      const firstInlineKey = !configHasInlineApiKey(config);
      let updated: Config;
      try {
        updated = commitSelection(item, authModel(), value);
      } catch (err) {
        feedbackStore.setError(redactKey(toErrorMessage(err), value));
        return;
      }
      // Read before the save: the config transaction appends the entry itself,
      // so only the pre-save state can reveal that the key landed in a
      // directory the user's .gitignore was not covering.
      const gitignore = firstInlineKey
        ? await deps.readGitignore(configStore.get().projectDir)
        : null;
      const result = await configStore.save(updated);
      if (reportConfigSaveFailure(result, (message) => redactKey(message, value))) return;
      let message = `${catalog.roleLabel} set to: ${item.displayName}${SOFT_SEP}key saved to ${SPLITBRIEF_DIR}/${CONFIG_FILE}`;
      if (firstInlineKey && !gitignoreCoversSplitbrief(gitignore)) {
        message += `${SOFT_SEP}warning: .gitignore did not cover ${SPLITBRIEF_DIR}/ — verify before committing`;
      }
      feedbackStore.setMessage(message);
      overlayStore.close();
      try {
        await deps.refreshDetection();
      } catch {
        // Detection refresh is advisory; the key is already saved and selected.
      }
    },
    closeOverlay() {
      dispatchView({ type: 'close' });
    },
  };
}
