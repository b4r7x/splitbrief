import { Box, Text } from 'ink';
import { TwoColumnPicker, type PreviewContext } from './two-column-picker/picker.js';
import { ARROW_SEP, SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { detectionStore } from '../../stores/project/detection.js';
import { getDefaultDetectionService } from '../../engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../../engine/detection/store-publication.js';
import { providerOracleCommand } from '../../engine/runners/cli-tools/provider-oracle.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';

import type { CliProviderAuthFact } from '../../core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  type ActiveRunnerRole,
} from '../../core/runners/cli-tool-catalog.js';
import { includes } from '../../utils/type-guards.js';
import {
  compactProviderTag,
  findProviderCredentialFact,
  findProviderCredentialFacts,
  modelProviderAuthKey,
  modelProviderPrefix,
  providerFactMatchesAuthKey,
  type PickerOption,
} from './model-catalog/options.js';
import { isCustomModel, type ModelOption } from './model-catalog/recency.js';
import {
  buildRightModels,
  modelRowMatchesId,
  type PickerModelCounts,
} from './model-catalog/catalog.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import {
  formatAuthFactsUnavailableNotice,
  formatCustomCommandPreview,
  formatModelCatalogGuidance,
  formatNeedsSignInSaveFeedback,
  formatProviderConfiguredClause,
  formatProviderSignInClause,
  formatStoredCredentialNote,
  formatToolPostureSummary,
  formatToolPreview,
  gatewayAccountName,
  isPickerItemDisabled,
  type ModelCatalogDiagnostic,
} from './picker-format.js';
import { needsAuthAction, type ProviderAuthAction } from './provider-auth.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import { formatModelName } from '../../core/model-display.js';
import { formatContextLength } from '../../core/formatting.js';
import {
  formatDiscoveryRefreshFeedback,
  type DiscoveryRefreshSummary,
} from '../../core/runtime/commands/types.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const MAX_STALE_MODEL_COPY_COUNT = 99;

function staleModelCopy(staleCount: number): string | undefined {
  if (staleCount <= 0) return undefined;
  const count = Math.min(staleCount, MAX_STALE_MODEL_COPY_COUNT);
  const label = staleCount > MAX_STALE_MODEL_COPY_COUNT ? `${count}+` : String(count);
  const noun = count === 1 && staleCount === 1 ? 'model' : 'models';
  return `${label} stale ${noun} retained. Refresh detection.`;
}

/**
 * Resolved provider-axis context for the highlighted provider-dependent tool.
 * `facts` is tri-state at the source: undefined means the credential oracle
 * could not be read, and nothing may claim an auth state.
 */
interface ProviderAxisView {
  facts: readonly CliProviderAuthFact[] | undefined;
  loginCommand: string;
  oracleCommand: string | undefined;
  gatewayKey: string;
  gatewayAccount: string | undefined;
}

function providerSignInGateway(
  axis: ProviderAxisView,
  authKey: string,
): { gatewayAccount?: string | undefined } {
  return authKey === axis.gatewayKey ? { gatewayAccount: axis.gatewayAccount } : {};
}

function modelPreview(
  model: ModelOption,
  tool: PickerOption | undefined,
  axis?: ProviderAxisView,
): string {
  const parts = [formatModelName(model.id)];
  const ctx = formatContextLength(model.contextLength);
  if (ctx) parts.push(`${ctx} context`);
  if (tool) parts.push(`via ${tool.displayName}`);
  if (axis !== undefined) {
    const authKey = modelProviderAuthKey(model.id);
    const prefix = modelProviderPrefix(model.id);
    if (axis.facts === undefined) {
      if (axis.oracleCommand !== undefined) {
        parts.push(formatAuthFactsUnavailableNotice(axis.oracleCommand));
      }
    } else if (authKey !== undefined && prefix !== undefined) {
      const facts = findProviderCredentialFacts(authKey, axis.facts);
      const tag = compactProviderTag(prefix);
      parts.push(
        facts.length > 0
          ? formatProviderConfiguredClause(tag, facts)
          : formatProviderSignInClause({
              tag,
              authKey,
              loginCommand: axis.loginCommand,
              ...providerSignInGateway(axis, authKey),
            }),
      );
    }
  }
  if (model.isStale || model.membership === 'stale') {
    parts.push('Last confirmed catalog is stale. Refresh detection.');
  }
  return parts.join(SOFT_SEP);
}

function modelGuidancePreview(
  item: PickerOption,
  counts: PickerModelCounts,
  diagnostic: ModelCatalogDiagnostic | undefined,
  refreshing: boolean,
): string {
  const guidance = formatModelCatalogGuidance(item, counts, diagnostic, refreshing);
  const parts = [guidance.headline];
  if (guidance.detail) parts.push(guidance.detail);
  const staleCopy = staleModelCopy(counts.stale);
  if (staleCopy) parts.push(staleCopy);
  parts.push(formatToolPostureSummary(item));
  return parts.filter(Boolean).join(SOFT_SEP);
}

function ModelGuidance({
  currentItem,
  counts,
  diagnostic,
  refreshing,
}: {
  currentItem: PickerOption | undefined;
  counts: PickerModelCounts;
  diagnostic: ModelCatalogDiagnostic | undefined;
  refreshing: boolean;
}) {
  const t = useTheme();
  if (!currentItem) {
    return <Text color={t.textDim}>Select a tool</Text>;
  }

  const guidance = formatModelCatalogGuidance(currentItem, counts, diagnostic, refreshing);
  const posture = formatToolPostureSummary(currentItem);
  const staleCopy = staleModelCopy(counts.stale);

  return (
    <Box flexDirection="column">
      <Text color={t.textDim}>{guidance.headline}</Text>
      {guidance.detail ? (
        <Text color={t.textDim} dimColor>
          {guidance.detail}
        </Text>
      ) : null}
      {staleCopy ? (
        <Text color={t.textDim} dimColor>
          {staleCopy}
        </Text>
      ) : null}
      {posture ? (
        <Text color={t.textDim} dimColor>
          {posture}
        </Text>
      ) : null}
    </Box>
  );
}

interface PickerViewProps {
  role: ActiveRunnerRole;
  stepLabel?: string | undefined;
  catalog: PickerCatalog;
  actions: PickerActions;
}

const defaultRefresh = (projectDir: string | undefined): Promise<DiscoveryRefreshSummary> =>
  refreshDetectionForCurrentConfig({
    service: getDefaultDetectionService(),
    publication: detectionStore,
    getCurrent: () => {
      const config = configStore.get().config;
      if (config === null || projectDir === undefined) return null;
      return { config, projectDir };
    },
  });

export async function refreshPickerDetection(
  projectDir: string,
  refresh: (projectDir: string | undefined) => Promise<DiscoveryRefreshSummary> = defaultRefresh,
): Promise<void> {
  feedbackStore.setMessage('Refreshing models…');
  try {
    const summary = await refresh(projectDir);
    const feedback = formatDiscoveryRefreshFeedback({ subject: 'Models', summary });
    if (feedback.isError) feedbackStore.setError(feedback.message);
    else feedbackStore.setMessage(feedback.message);
  } catch (err) {
    feedbackStore.setError(`Failed to refresh models: ${toErrorMessage(err)}`);
  }
}

export function PickerView({ role, stepLabel, catalog, actions }: PickerViewProps) {
  const t = useTheme();
  const projectDir = configStore.use((s) => s.projectDir);
  const providers = detectionStore.use((s) => s.providers);
  const cliTools = detectionStore.use((s) => s.cliTools);
  const allowsCustom = catalog.currentItem?.modelCapability.allowsCustom ?? false;

  const axisTool =
    catalog.currentItem !== undefined && catalog.currentItem.providerDependent === true
      ? catalog.currentItem
      : undefined;
  const axisToolId =
    axisTool !== undefined && includes(CLI_TOOL_IDS, axisTool.id) ? axisTool.id : undefined;
  const providerAxisView: ProviderAxisView | undefined =
    axisToolId === undefined
      ? undefined
      : {
          facts: cliTools.find((detection) => detection.tool === axisToolId)?.providerAuth,
          loginCommand: `${CLI_TOOL_CATALOG[axisToolId].command} auth login`,
          oracleCommand: providerOracleCommand(axisToolId)?.join(' '),
          gatewayKey: CLI_TOOL_CATALOG[axisToolId].command,
          gatewayAccount: gatewayAccountName(axisToolId),
        };

  const credentialNoteFor = (tool: PickerOption): string | undefined => {
    if (providerAxisView === undefined || tool.id !== axisToolId) return undefined;
    const facts = providerAxisView.facts;
    if (facts === undefined) {
      return providerAxisView.oracleCommand === undefined
        ? undefined
        : formatAuthFactsUnavailableNotice(providerAxisView.oracleCommand);
    }
    const distinctProviders = new Set(facts.map((fact) => fact.provider)).size;
    if (distinctProviders === 0) return undefined;
    const listedKeys = [
      ...new Set(
        catalog.rightModels
          .map((model) => modelProviderAuthKey(model.id))
          .filter((key): key is string => key !== undefined),
      ),
    ];
    // Stored auth must never be invisible: a credential whose provider
    // contributes no enumerated models surfaces as a count on the tool line.
    const hasUnlisted = facts.some(
      (fact) => !listedKeys.some((key) => providerFactMatchesAuthKey(fact, key)),
    );
    return hasUnlisted ? formatStoredCredentialNote(distinctProviders) : undefined;
  };

  const needsSignInSaveNote = (selection: PickerOption, model: ModelOption): string | undefined => {
    if (providerAxisView?.facts === undefined || selection.id !== axisToolId) return undefined;
    const authKey = modelProviderAuthKey(model.id);
    const prefix = modelProviderPrefix(model.id);
    if (authKey === undefined || prefix === undefined) return undefined;
    if (findProviderCredentialFact(authKey, providerAxisView.facts) !== undefined) return undefined;
    return formatNeedsSignInSaveFeedback({
      modelId: model.id,
      tag: compactProviderTag(prefix),
      authKey,
      loginCommand: providerAxisView.loginCommand,
      ...providerSignInGateway(providerAxisView, authKey),
    });
  };

  const confirmSelection = (selection: PickerOption, model: ModelOption | null) => {
    const note = model === null ? undefined : needsSignInSaveNote(selection, model);
    const outcome = actions.confirm(selection, model);
    if (note === undefined) return;
    // The commit path posts its own save or failure feedback first; the
    // provider honesty note replaces only a successful save message.
    void Promise.resolve(outcome).then(() => {
      if (!feedbackStore.get().isError) feedbackStore.setMessage(note);
    });
  };

  // Both the mount index and every reset must land on the configured model, or
  // confirming without first moving within the model column silently rewrites it.
  const resolveModelIndex = (item: PickerOption | undefined): number | undefined => {
    const persistedModel = catalog.persistedModel;
    if (!item?.isCurrent || persistedModel === undefined) return undefined;
    const models = buildRightModels({
      role,
      customModels: catalog.customModels,
      currentItem: item,
      cache: modelCacheStore,
      persistedModel,
    });
    const idx = models.findIndex((model) => modelRowMatchesId(model, persistedModel));
    if (idx < 0) return undefined;
    return idx + (item.modelCapability.allowsCustom ? 1 : 0);
  };
  const initialRightIndex = resolveModelIndex(catalog.currentItem);

  const handleRefresh = () => {
    void refreshPickerDetection(projectDir);
  };

  const resolveAuthAction = (item: PickerOption): ProviderAuthAction | null => {
    if (item.kind !== 'api') return null;
    const descriptor = getApiProviderDescriptor(item.id);
    if (descriptor === undefined) return null;
    return needsAuthAction(
      item.status,
      providers.find((provider) => provider.provider === item.id),
      descriptor,
    );
  };

  const resolvePreview = (ctx: PreviewContext<PickerOption, ModelOption>): string | undefined => {
    if (ctx.isOnLeftCustomItem) {
      return formatCustomCommandPreview(
        role,
        catalog.currentCommand !== undefined && catalog.currentCommandKind !== undefined
          ? { command: catalog.currentCommand, kind: catalog.currentCommandKind }
          : undefined,
      );
    }
    if (ctx.isOnCustomItem) {
      const tool = catalog.currentItem;
      const toolName = tool?.displayName ?? role;
      const parts = [`add a model id ${toolName} can't auto-detect`];
      if (tool) {
        parts.push(
          modelGuidancePreview(
            tool,
            catalog.modelCounts,
            catalog.catalogDiagnostic,
            catalog.discovery.refreshing,
          ),
        );
      }
      return parts.join(SOFT_SEP);
    }
    if (ctx.activeColumn === 'right' && ctx.rightItem) {
      return modelPreview(ctx.rightItem, catalog.currentItem, providerAxisView);
    }
    const tool = ctx.leftItem ?? catalog.currentItem;
    if (!tool) return undefined;
    if (tool.kind === 'inherit-planner') {
      return ['the review seat runs whatever the planner runs', formatToolPostureSummary(tool)]
        .filter(Boolean)
        .join(SOFT_SEP);
    }
    if (ctx.activeColumn === 'right' && catalog.rightModels.length === 0) {
      return modelGuidancePreview(
        tool,
        catalog.modelCounts,
        catalog.catalogDiagnostic,
        catalog.discovery.refreshing,
      );
    }
    return [
      staleModelCopy(catalog.modelCounts.stale),
      formatToolPreview(
        tool,
        catalog.modelCounts,
        resolveAuthAction(tool),
        catalog.catalogDiagnostic,
        credentialNoteFor(tool),
        catalog.discovery.refreshing,
      ),
    ]
      .filter(Boolean)
      .join(SOFT_SEP);
  };

  return (
    <TwoColumnPicker<PickerOption, ModelOption>
      title={catalog.roleLabel}
      subtitle={role === 'implementer' ? 'Model' : 'Tool & model'}
      stepLabel={stepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={confirmSelection}
      onCancel={() => overlayStore.close()}
      onRefresh={handleRefresh}
      onDisabledSelect={(item) => {
        if (resolveAuthAction(item) !== null) actions.openProviderAuth(item);
      }}
      preview={resolvePreview}
      leftProps={{
        items: catalog.items,
        label: 'Tools',
        getKey: (item) => item.id,
        // The launcher stays visible under any filter query so adding a custom
        // command is always reachable.
        filterBy: (item, query) =>
          item.kind === 'custom-command' || filterByFields(item, query, ['id', 'displayName']),
        isSpecial: (item) => item.kind === 'custom-command',
        isDisabled: isPickerItemDisabled,
        initialIndex: catalog.initialLeftIdx,
        specialHelp: (
          <Box flexDirection="column">
            <Text color={t.textDim}>run a custom {role} command</Text>
            <Box marginTop={1} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={t.info} bold>
                  OUTPUT
                </Text>
                <Text color={t.textDim}>{`${SOFT_SEP}reads stdout`}</Text>
              </Text>
              <Text wrap="truncate-end">
                <Text color={t.warning} bold>
                  DIRECT
                </Text>
                <Text color={t.textDim}>{`${SOFT_SEP}writes files`}</Text>
              </Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={t.textDim} wrap="truncate-end">{`⏎ contract${ARROW_SEP}command`}</Text>
              <Text color={t.textDim} dimColor wrap="truncate-end">
                saved only on final ⏎
              </Text>
            </Box>
          </Box>
        ),
        renderRow: (item, { isCursor, isSelected, maxWidth }) =>
          renderToolRow({
            item,
            isCursor,
            isSelected,
            maxWidth,
            currentCommand: catalog.currentCommand,
            currentCommandKind: catalog.currentCommandKind,
          }),
      }}
      rightProps={{
        items: catalog.rightModels,
        label: 'Models',
        getKey: (item) => item.id,
        // A merged row answers for every provider spelling it folded, so typing
        // a provider name ("openrouter") still finds it.
        filterBy: (item, query) =>
          filterByFields(item, query, ['id']) ||
          (item.variants?.some((variant) =>
            variant.fullId.toLowerCase().includes(query.toLowerCase()),
          ) ??
            false),
        initialIndex: initialRightIndex,
        resolveInitialIndex: resolveModelIndex,
        onLeftChange: actions.leftChange,
        placeholder: (
          <ModelGuidance
            currentItem={catalog.currentItem}
            counts={catalog.modelCounts}
            diagnostic={catalog.catalogDiagnostic}
            refreshing={catalog.discovery.refreshing}
          />
        ),
        ...(allowsCustom
          ? {
              customRow: {
                onSelect: actions.openCustomModel,
                onDelete: actions.deleteRight,
                isCustom: isCustomModel,
              },
            }
          : {}),
        renderRow: (item, { isCursor, maxWidth }) =>
          renderModelRow({
            item,
            isCursor,
            maxWidth,
            currentModel: catalog.currentModel,
          }),
      }}
    />
  );
}
