import { Box, Text } from 'ink';
import { TwoColumnPicker, type PreviewContext } from './two-column-picker/picker.js';
import type { TerminalPane } from './two-column-picker/use-nav-state.js';
import { arrowSep, SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { detectionStore } from '../../stores/project/detection.js';
import { providerOracleCommand } from '../../engine/runners/cli-tools/provider-oracle.js';
import { configStore } from '../../stores/project/config.js';

import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  type SeatPickerRole,
} from '../../core/runners/cli-tool-catalog.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import { includes } from '../../utils/type-guards.js';
import type { PickerOption } from './model-catalog/options.js';
import { isCustomModel, type ModelVariant } from './model-catalog/recency.js';
import {
  rightRowKey,
  routeAuthStateFor,
  sectionOf,
  type RightRow,
  type RouteAuthState,
} from './model-catalog/rows.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import {
  formatAuthActionAffordance,
  formatBillingLabel,
  formatModelCatalogGuidance,
  formatPermissionLabels,
  formatPickerByline,
  formatRouteRemedy,
  isPickerItemDisabled,
  type ModelCatalogDiagnostic,
} from './picker-format.js';
import { needsAuthAction, type ProviderAuthAction } from './provider-auth.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import type { PickerModelCounts } from './model-catalog/catalog.js';
import { refreshPickerDetection } from './refresh-detection.js';

/**
 * The seat cards say how the seat is paid for in one lower-case word; the
 * capitalised billing labels belong to the byline, not to a card line.
 */
const POSTURE_WORDS: Readonly<Record<RunnerBillingPosture, string | undefined>> = {
  local: 'local',
  'subscription-included': 'subscription',
  'api-metered': 'metered',
  'provider-dependent': 'provider',
  unknown: undefined,
};

const MAX_STALE_MODEL_COPY_COUNT = 99;

/** Rows a failed refresh left behind are not a count the byline can claim. */
function staleModelCopy(staleCount: number): string | undefined {
  if (staleCount <= 0) return undefined;
  const count = Math.min(staleCount, MAX_STALE_MODEL_COPY_COUNT);
  const label = staleCount > MAX_STALE_MODEL_COPY_COUNT ? `${count}+` : String(count);
  const noun = staleCount === 1 ? 'model' : 'models';
  return `${label} stale ${noun} retained. Refresh detection.`;
}

function postureLine(item: PickerOption): string {
  return [POSTURE_WORDS[item.billing], ...formatPermissionLabels(item.permissions)]
    .filter(Boolean)
    .join(SOFT_SEP);
}

function ModelGuidance({
  currentItem,
  counts,
  diagnostic,
  refreshing,
}: {
  currentItem: PickerOption;
  counts: PickerModelCounts;
  diagnostic: ModelCatalogDiagnostic | undefined;
  refreshing: boolean;
}) {
  const t = useTheme();
  const guidance = formatModelCatalogGuidance(currentItem, counts, diagnostic, refreshing);

  return (
    <Box flexDirection="column">
      <Text color={t.textDim} wrap="truncate-end">
        {guidance.headline}
      </Text>
      {guidance.detail ? (
        <Text color={t.textDim} dimColor wrap="truncate-end">
          {guidance.detail}
        </Text>
      ) : null}
    </Box>
  );
}

interface PickerViewProps {
  role: SeatPickerRole;
  stepLabel?: string | undefined;
  catalog: PickerCatalog;
  actions: PickerActions;
}

function subtitleFor(role: SeatPickerRole): string {
  if (role === 'implementer') return 'Model';
  if (role === 'escalation') return 'Provider & model';
  return 'Tool & model';
}

/**
 * The two-column picker keys its rows by `id`; a `RightRow` is a shape, not an
 * entity, so the row key it already publishes becomes that id.
 */
type KeyedRightRow = RightRow & { id: string };

function keyRows(rows: readonly RightRow[]): KeyedRightRow[] {
  return rows.map((row) => ({ ...row, id: rightRowKey(row) }));
}

export function PickerView({ role, stepLabel, catalog, actions }: PickerViewProps) {
  const projectDir = configStore.use((s) => s.projectDir);
  const providers = detectionStore.use((s) => s.providers);
  // The escalate seat keeps a provider and a model, not a custom-model list, so
  // adding or deleting one there could only touch another seat's list.
  const allowsCustom =
    role !== 'escalation' && (catalog.currentItem?.modelCapability.allowsCustom ?? false);

  const toolId =
    catalog.currentItem !== undefined && includes(CLI_TOOL_IDS, catalog.currentItem.id)
      ? catalog.currentItem.id
      : undefined;
  const oracleCommand = toolId === undefined ? undefined : providerOracleCommand(toolId)?.join(' ');
  // The frame names the version gap the upgrade closes; the catalog is the only
  // place that knows what SplitBrief was tested against.
  const versions =
    toolId !== undefined && catalog.currentItem?.version !== undefined
      ? {
          observed: catalog.currentItem.version,
          required: CLI_TOOL_CATALOG[toolId].compatibility.minimumAdmittedVersion,
        }
      : undefined;

  const terminalPaneFor = (item: PickerOption): TerminalPane | undefined => {
    if (item.kind === 'inherit-planner') {
      return {
        label: "Planner's setup",
        verb: "use planner's setup",
        lines: [
          'The review seat runs whatever the planner runs.',
          '',
          catalog.plannerIdentity,
          postureLine(item),
          '',
          'Pick a tool on the left to give the review seat its own setup.',
        ],
      };
    }
    if (item.kind === 'escalation-off') {
      return {
        label: 'Escalation off',
        verb: 'disable escalation',
        lines: [
          'No intermediate model.',
          '',
          'A stuck task goes straight to the planner:',
          catalog.plannerIdentity,
          '',
          'Pick a provider on the left to add a stronger API model in between.',
        ],
      };
    }
    if (item.kind !== 'custom-command') return undefined;
    return {
      label: 'Custom command',
      verb: 'add custom',
      lines: [
        `run a custom ${catalog.roleLabel.toLowerCase()} command`,
        '',
        `OUTPUT${SOFT_SEP}reads stdout`,
        `DIRECT${SOFT_SEP}writes files`,
        '',
        `⏎ contract${arrowSep()}command`,
        'saved only on final ⏎',
      ],
    };
  };

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

  // One signed-in route needs no chooser: Enter saves it. Two or more, or none,
  // is a decision the user has to see, so the row expands instead.
  const soleConfiguredRoute = (row: RightRow): ModelVariant | undefined => {
    if (row.kind !== 'model') return undefined;
    const variants = row.model.variants ?? [];
    if (variants.length <= 1) return variants[0];
    const configured = variants.filter(
      (variant) =>
        routeAuthStateFor({
          hasOracle: catalog.hasOracle,
          variant,
          providerAuth: catalog.providerAuth,
        }).kind === 'configured',
    );
    return configured.length === 1 ? configured[0] : undefined;
  };

  const rightRows = keyRows(catalog.rightRows);

  const confirmRow = (left: PickerOption, row: RightRow | null) => {
    if (row === null) {
      void actions.confirm(left, null);
      return;
    }
    if (row.kind === 'route') {
      void actions.confirmProviderVariant(row.variant.fullId);
      return;
    }
    if (row.kind !== 'model') return;
    const sole = soleConfiguredRoute(row);
    if (sole !== undefined) {
      void actions.confirmProviderVariant(sole.fullId);
      return;
    }
    void actions.confirm(left, row.model);
  };

  const resolvePreview = (ctx: PreviewContext<PickerOption, KeyedRightRow>): string | undefined => {
    const tool = ctx.leftItem ?? catalog.currentItem;
    if (!tool) return undefined;
    // A signed-in route needs no remedy, so the byline is what the row falls
    // back to rather than an empty preview line.
    const remedyFor = (auth: RouteAuthState, variant: ModelVariant): string | undefined =>
      formatRouteRemedy({
        auth,
        toolName: tool.displayName,
        oracleCommand: oracleCommand ?? '',
        provider: variant.providerPrefix,
        versions,
      });
    const row = ctx.rightItem;
    if (row?.kind === 'route') {
      const remedy = remedyFor(row.auth, row.variant);
      if (remedy !== undefined) return remedy;
    }
    if (row?.kind === 'model' && row.expanded) {
      // The route that still needs the user is the one worth naming, not the
      // first one the model happens to list.
      const pending = catalog.rightRows.find(
        (candidate) =>
          candidate.kind === 'route' &&
          candidate.model.id === row.model.id &&
          candidate.auth.kind !== 'configured',
      );
      if (pending?.kind === 'route') {
        const remedy = remedyFor(pending.auth, pending.variant);
        if (remedy !== undefined) return remedy;
      }
    }
    const byline = formatPickerByline({
      toolName: tool.displayName,
      version: tool.version,
      counts: catalog.modelCounts,
      lane: catalog.catalogLane,
      diagnostic: catalog.catalogDiagnostic,
      capabilities: [...formatPermissionLabels(tool.permissions), formatBillingLabel(tool.billing)],
    });
    const stale = staleModelCopy(catalog.modelCounts.stale);
    const trail = stale === undefined ? byline : `${byline}${SOFT_SEP}${stale}`;
    // A provider whose key this picker can take has its remedy in a keystroke.
    // Like a route's sign-in command it leads, so right truncation cuts the
    // byline before it ever reaches the actionable part. A status remediation
    // leads for the same reason: a runner the picker cannot run says how to fix
    // it before it recites what it is. The retained-stale line is already a
    // refresh instruction, so a remediation ahead of it would only push it off
    // the end.
    const reason = stale === undefined ? tool.status.remediation : null;
    const remedied = reason === null ? trail : `${reason}${SOFT_SEP}${trail}`;
    const authAction = resolveAuthAction(tool);
    if (authAction === null) return remedied;
    return `${formatAuthActionAffordance(authAction)}${SOFT_SEP}${remedied}`;
  };

  return (
    <TwoColumnPicker<PickerOption, KeyedRightRow>
      title={catalog.roleLabel}
      subtitle={subtitleFor(role)}
      stepLabel={stepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={confirmRow}
      onCancel={() => overlayStore.close()}
      onRefresh={handleRefresh}
      onDisabledSelect={(item) => {
        if (resolveAuthAction(item) !== null) actions.openProviderAuth(item);
      }}
      preview={resolvePreview}
      leftProps={{
        items: catalog.items,
        label: role === 'escalation' ? 'Providers' : 'Tools',
        getKey: (item) => item.id,
        // The launcher stays visible under any filter query so adding a custom
        // command is always reachable.
        filterBy: (item, query) =>
          item.kind === 'custom-command' || filterByFields(item, query, ['id', 'displayName']),
        terminalPane: terminalPaneFor,
        isDisabled: isPickerItemDisabled,
        initialIndex: catalog.initialLeftIdx,
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
        items: rightRows,
        label: 'Models',
        getKey: (row) => row.id,
        // A merged row answers for every provider spelling it folded, so typing
        // a provider name ("openrouter") still finds it.
        filterBy: (row, query) => {
          if (row.kind === 'notice') return true;
          if (row.kind !== 'model') return false;
          return (
            filterByFields(row.model, query, ['id']) ||
            (row.model.variants?.some((variant) =>
              variant.fullId.toLowerCase().includes(query.toLowerCase()),
            ) ??
              false)
          );
        },
        initialIndex: catalog.initialRightIndex,
        resolveInitialIndex: catalog.resolveRightIndex,
        onLeftChange: actions.leftChange,
        section: { by: (row) => sectionOf(row) ?? '' },
        activationOf: (row) => {
          if (row.kind === 'notice') return row.action === 'refresh' ? 'refresh' : 'none';
          if (row.kind === 'route') return 'confirm';
          if (row.expanded) return 'collapse';
          return (row.model.variants?.length ?? 0) > 1 && soleConfiguredRoute(row) === undefined
            ? 'expand'
            : 'confirm';
        },
        onExpand: (row) => {
          if (row.kind === 'model') pickerViewStore.expand(row.model.id);
        },
        onCollapse: () => pickerViewStore.collapse(),
        // The store's id survives a move to another tool, whose rows carry no
        // expansion; only the rows on screen can say whether Escape collapses.
        isExpanded: catalog.rightRows.some((row) => row.kind === 'model' && row.expanded),
        placeholder:
          catalog.currentItem === undefined ? undefined : (
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
                onDelete: (row: KeyedRightRow) => {
                  if (row.kind === 'model') void actions.deleteRight(row.model);
                },
                isCustom: (row: KeyedRightRow) => row.kind === 'model' && isCustomModel(row.model),
              },
            }
          : {}),
        renderRow: (row, { isCursor, maxWidth }) =>
          renderModelRow({
            row,
            isCursor,
            maxWidth,
            currentModel: catalog.currentModel,
            sectioned: sectionOf(row) !== undefined,
          }),
      }}
    />
  );
}
