import { Box, Text } from 'ink';
import { TwoColumnPicker, type PreviewContext } from './two-column-picker/picker.js';
import type { TerminalPane } from './two-column-picker/types.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { providerOracleCommand } from '../../engine/runners/cli-tools/provider-oracle.js';
import { configStore } from '../../stores/project/config.js';

import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import type { SeatPickerRole } from '../../core/runners/seat-roles.js';
import type { RunnerBillingPosture } from '../../core/runners/runner-billing.js';
import { includes } from '../../utils/type-guards.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../utils/display-text.js';
import { contractForRunnerKind } from '../../core/config/custom-commands.js';
import { sortPickerOptions, type PickerOption } from './model-catalog/options.js';
import { isCustomModel, type ModelVariant } from './model-catalog/recency.js';
import { isOptionFamily, optionDraftOf } from './model-catalog/option-axis.js';
import {
  rightRowKey,
  sectionOf,
  type RightRow,
  type RouteAuthState,
} from './model-catalog/rows.js';
import {
  activationOfRightRow,
  confirmRow as confirmRightRow,
  cycleRightRow,
  expandedRowHint,
  rightRowMatches,
  seatVariantDraft,
  type RouteAuthContext,
} from './right-column-policy.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import {
  formatBillingLabel,
  formatModelCatalogGuidance,
  formatPermissionLabels,
  formatPickerByline,
  formatRouteRemedy,
  isPickerItemDisabled,
  type ModelCatalogDiagnostic,
} from './picker-format.js';
import { renderToolRow, renderModelRow } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';
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

/**
 * The card truncates below its own wrap threshold and wraps at or above it, so a
 * line kept inside that width costs the pane exactly one row at every terminal
 * width — which is what lets the copy below be budgeted against the pane's height.
 */
const CARD_LINE_CELLS = 40;

const CURRENT_COMMAND_PREFIX = 'Current: ';

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
  catalog: PickerCatalog;
  actions: PickerActions;
}

function subtitleFor(role: SeatPickerRole): string {
  if (role === 'implementer') return 'Model';
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

export function PickerView({ role, catalog, actions }: PickerViewProps) {
  const isRefreshing = catalog.discovery.refreshing;
  const { frame } = useSpinnerFrame(isRefreshing);
  const resolvedStepLabel = isRefreshing ? `${frame} refreshing…` : undefined;
  const projectDir = configStore.use((s) => s.projectDir);
  const optionDraftId = pickerViewStore.use((s) => s.optionDraftId);
  const allowsCustom = catalog.currentItem?.modelCapability.allowsCustom ?? false;

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
    if (item.kind !== 'custom-command') return undefined;
    const contract =
      catalog.currentCommandKind === undefined
        ? ''
        : `${SOFT_SEP}${contractForRunnerKind(catalog.currentCommandKind)}`;
    // The command shares its row with the prefix and the contract word, so it is
    // cut to what is left of the card line rather than pushed onto a second row.
    const configured =
      catalog.currentCommand === undefined
        ? []
        : [
            `${CURRENT_COMMAND_PREFIX}${truncateTerminalDisplayText(
              catalog.currentCommand,
              CARD_LINE_CELLS - getTerminalCellWidth(`${CURRENT_COMMAND_PREFIX}${contract}`),
            )}${contract}`,
          ];
    // Six lines is what the pane holds on a short terminal, and the two contract
    // lines are short enough to still read at the narrowest card, where the card
    // truncates instead of wrapping. The contract words are the launcher row's own.
    return {
      label: 'Custom command',
      verb: 'add custom',
      lines: [
        ...configured,
        `Run your own command in the ${catalog.roleLabel.toLowerCase()} seat.`,
        `output${SOFT_SEP}reads stdout`,
        `direct${SOFT_SEP}writes files`,
        '⏎ picks the contract, then the command.',
        'Nothing is saved until you confirm.',
      ],
    };
  };

  const handleRefresh = () => {
    void refreshPickerDetection(projectDir);
  };

  const authContext: RouteAuthContext = {
    hasOracle: catalog.hasOracle,
    providerAuth: catalog.providerAuth,
  };

  const rightRows = keyRows(catalog.rightRows);

  const resolvePreview = (ctx: PreviewContext<PickerOption, KeyedRightRow>): string | undefined => {
    const tool = ctx.leftItem ?? catalog.currentItem;
    if (!tool) return undefined;
    // A signed-in route needs no remedy, so the byline is what the row falls
    // back to rather than an empty preview line.
    const remedyFor = (auth: RouteAuthState, variant: ModelVariant): string | undefined => {
      // Option-axis children have no provider to sign into; their prefix is empty.
      if (variant.providerPrefix === '') return undefined;
      return formatRouteRemedy({
        auth,
        toolName: tool.displayName,
        oracleCommand: oracleCommand ?? '',
        provider: variant.providerPrefix,
        versions,
      });
    };
    const row = ctx.rightItem;
    if (row?.kind === 'route') {
      const remedy = remedyFor(row.auth, row.variant);
      if (remedy !== undefined) return remedy;
    }
    if (row?.kind === 'model' && row.expanded) {
      // The route that still needs the user is the one worth naming, not the
      // first one the model happens to list. Option-axis children have no provider.
      const pending = catalog.rightRows.find(
        (candidate) =>
          candidate.kind === 'route' &&
          candidate.model.id === row.model.id &&
          candidate.variant.providerPrefix !== '' &&
          candidate.auth.kind !== 'configured',
      );
      if (pending?.kind === 'route') {
        const remedy = remedyFor(pending.auth, pending.variant);
        if (remedy !== undefined) return remedy;
      }
    }
    const byline = formatPickerByline({
      toolName: tool.displayName,
      toolId,
      version: tool.version,
      counts: catalog.modelCounts,
      lane: catalog.catalogLane,
      diagnostic: catalog.catalogDiagnostic,
      capabilities: [...formatPermissionLabels(tool.permissions), formatBillingLabel(tool.billing)],
    });
    const stale = staleModelCopy(catalog.modelCounts.stale);
    const trail = stale === undefined ? byline : `${byline}${SOFT_SEP}${stale}`;
    // A status remediation leads: a runner the picker cannot run says how to fix
    // it before it recites what it is, so right truncation cuts the byline
    // before it ever reaches the actionable part. The retained-stale line is
    // already a refresh instruction, so a remediation ahead of it would only
    // push it off the end.
    const reason = stale === undefined ? tool.status.remediation : null;
    return reason === null ? trail : `${reason}${SOFT_SEP}${trail}`;
  };

  return (
    <TwoColumnPicker<PickerOption, KeyedRightRow>
      title={catalog.roleLabel}
      subtitle={subtitleFor(role)}
      stepLabel={resolvedStepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={(left, row) => confirmRightRow(left, row, { actions, auth: authContext })}
      onCancel={() => overlayStore.close()}
      onRefresh={handleRefresh}
      preview={resolvePreview}
      leftProps={{
        items: catalog.items,
        label: 'Tools',
        getKey: (item) => item.id,
        // The launcher stays visible under any filter query so adding a custom
        // command is always reachable.
        filterBy: (item, query) =>
          item.kind === 'custom-command' || filterByFields(item, query, ['id', 'displayName']),
        compare: (a, b) => sortPickerOptions(a, b, { filterActive: true }),
        terminalPane: terminalPaneFor,
        isDisabled: isPickerItemDisabled,
        initialIndex: catalog.initialLeftIdx,
        renderRow: (item, { isCursor, isSelected, isContext, maxWidth }) =>
          renderToolRow({
            item,
            isCursor,
            isSelected,
            isContext,
            maxWidth,
            currentCommand: catalog.currentCommand,
            currentCommandKind: catalog.currentCommandKind,
          }),
      }}
      rightProps={{
        items: rightRows,
        label: 'Models',
        getKey: (row) => row.id,
        filterBy: rightRowMatches,
        initialIndex: catalog.initialRightIndex,
        resolveInitialIndex: catalog.resolveRightIndex,
        onLeftChange: actions.leftChange,
        section: { by: (row) => sectionOf(row) ?? '' },
        activationOf: (row) => activationOfRightRow(row, authContext),
        onExpand: (row) => {
          if (row.kind !== 'model') return;
          const draft = isOptionFamily(row.model)
            ? optionDraftOf(row.model, catalog.currentModel ?? catalog.persistedModel)
            : undefined;
          pickerViewStore.expand(row.model.id, draft, seatVariantDraft(row.model, draft, role));
        },
        onCollapse: () => pickerViewStore.collapse(),
        onCycle: cycleRightRow,
        expandedHint: (row) => expandedRowHint(row, authContext),
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
            optionDraftId,
          }),
      }}
    />
  );
}
