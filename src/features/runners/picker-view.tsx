import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { Box } from 'ink';
import { TwoColumnPicker, type PreviewContext } from './two-column-picker/picker.js';
import type { TerminalPane } from './two-column-picker/types.js';
import { SOFT_SEP } from '../../core/separators.js';
import { useSpinnerFrame } from '../../hooks/use-spinner-frame.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { providerOracleCommand } from '../../engine/runners/cli-tools/provider-oracle.js';
import { configStore } from '../../stores/project/config.js';

import { CREW_SEAT_LABELS, PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import {
  PICKER_ROLE_SEAT_IDS,
  type PickerSlot,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import { billingWord } from '../../core/runners/runner-billing.js';
import { includes } from '../../utils/type-guards.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { localProviderStartup } from '../../core/readiness/checks/availability.js';
import { sortPickerOptions, type PickerOption } from './model-catalog/options.js';
import { isCustomModel, type ModelVariant } from './model-catalog/recency.js';
import { formatModelName } from '../../core/model-display.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import { isOptionFamily, optionDraftOf, routeDraftOf } from './model-catalog/option-axis.js';
import {
  AUTH_METHOD_WORDS,
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
  seatEffortDraft,
  type RouteAuthContext,
} from './right-column-policy.js';
import { filterByFields } from '../../components/pickers/filtering.js';
import {
  bylineDiagnostic,
  CUSTOM_COMMAND_PANE_CELLS,
  CUSTOM_COMMAND_PANE_LINES,
  fallbackInheritanceNotice,
  formatModelCatalogGuidance,
  formatModelsByline,
  formatPermissionLabels,
  formatRouteRemedy,
  formatToolsByline,
  isPickerItemDisabled,
  modelBylineAxes,
  pickerListingSource,
  wrapOnWords,
  type ModelCatalogDiagnostic,
} from './picker-format.js';
import { localConnectionProvider } from './local-connection-form.js';
import { planModelRows, type ModelRowPlan } from './model-row-plan.js';
import { renderToolRow, renderModelRow, toolStatusesFit } from './tool-row.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import {
  defaultPickerEffectDeps,
  type PickerActions,
  type PickerEffectDeps,
} from './use-picker-actions.js';
import type { PickerModelCounts } from './model-catalog/catalog.js';
import { inheritsPlannerSeat } from './config-transforms.js';

const MAX_STALE_MODEL_COPY_COUNT = 99;

/** Rows a failed refresh left behind are not a count the byline can claim. */
function staleModelCopy(staleCount: number): string | undefined {
  if (staleCount <= 0) return undefined;
  const count = Math.min(staleCount, MAX_STALE_MODEL_COPY_COUNT);
  const label = staleCount > MAX_STALE_MODEL_COPY_COUNT ? `${count}+` : String(count);
  const noun = staleCount === 1 ? 'model' : 'models';
  return `${label} stale ${noun} retained. Refresh detection.`;
}

/** The remedy the card may spend before its own copy needs the rest of the budget. */
const PANE_REMEDY_LINES = 3;

/**
 * What the local-server row promises, written to the narrowest card the picker draws
 * (23 cells at 60 columns, `CUSTOM_COMMAND_PANE_CELLS`): what to do about this server,
 * what Enter opens, and that landing on the row has saved nothing. A server that is
 * simply not answering needs starting, and the probe's own words for that are evidence
 * rather than an instruction — they wait in the form, under a check. Any other status
 * keeps its own remedy, so a rejected credential is never told to start a server that
 * is already running. The address is not repeated here: the form owns it.
 */
function localConnectionPaneLines(item: PickerOption): string[] {
  const remediation =
    item.status.state === 'unavailable'
      ? (localProviderStartup(item.id) ?? item.status.remediation)
      : item.status.remediation;
  const remedy =
    remediation === null
      ? []
      : // The card truncates rather than wraps, so its copy is broken on words by hand.
        [...wrapOnWords(remediation, CUSTOM_COMMAND_PANE_CELLS, PANE_REMEDY_LINES).lines, ''];
  return [...remedy, '⏎ opens its address,', 'its token and a check.', '', 'Nothing is saved yet.'];
}

function postureLine(item: PickerOption): string {
  return [billingWord(item.billing), ...formatPermissionLabels(item.permissions)]
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
        <Text color={t.textDim} wrap="truncate-end">
          {guidance.detail}
        </Text>
      ) : null}
    </Box>
  );
}

interface PickerViewProps {
  role: SeatPickerRole;
  slot: PickerSlot;
  catalog: PickerCatalog;
  actions: PickerActions;
  deps?: PickerEffectDeps | undefined;
}

/**
 * The two-column picker keys its rows by `id`; a `RightRow` is a shape, not an
 * entity, so the row key it already publishes becomes that id.
 */
type KeyedRightRow = RightRow & { id: string };

/** The row kinds that carry a model, and so have a Models byline. */
type ModelBylineRow = Extract<KeyedRightRow, { kind: 'model' | 'route' | 'axis' }>;

function keyRows(rows: readonly RightRow[]): KeyedRightRow[] {
  return rows.map((row) => ({ ...row, id: rightRowKey(row) }));
}

export function PickerView({
  role,
  slot,
  catalog,
  actions,
  deps = defaultPickerEffectDeps,
}: PickerViewProps) {
  const isRefreshing = catalog.discovery.refreshing;
  const { frame } = useSpinnerFrame(isRefreshing);
  const projectDir = configStore.use((s) => s.projectDir);
  const inheritedReview = configStore.use(
    (s) => s.config !== null && inheritsPlannerSeat(s.config, 'reviewer'),
  );
  const inheritanceNotice = fallbackInheritanceNotice({ slot, role, inherited: inheritedReview });
  const resolvedStepLabel =
    [inheritanceNotice, isRefreshing ? `${frame} refreshing…` : undefined]
      .filter((line) => line !== undefined)
      .join(SOFT_SEP) || undefined;
  const saveError = feedbackStore.use((s) => (s.isError ? s.message : null));
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
    if (item.kind === 'no-fallback') {
      return {
        label: 'No fallback',
        verb: item.isCurrent === true ? 'keep no fallback' : 'clear fallback',
        lines: ['A Seat down halt', 'pauses the run and', 'asks which tool', 'takes the seat.'],
      };
    }
    if (item.kind === 'inherit-planner') {
      return {
        label: PLANNER_INHERITANCE.mark,
        verb: 'confirm',
        lines: [
          'Review uses the same',
          'tool and model:',
          { whole: catalog.plannerIdentity },
          { whole: postureLine(item) },
          '',
          'Pick a tool on the left',
          'for a separate setup.',
        ],
      };
    }
    if (localConnectionProvider(item) !== undefined) {
      // The remedy the model column used to carry as its placeholder: the row that
      // replaced that column owes it.
      return { label: 'Local server', verb: 'set up', lines: localConnectionPaneLines(item) };
    }
    if (item.kind !== 'custom-command') return undefined;
    return {
      label: 'Custom command',
      verb: 'add custom',
      lines: [...CUSTOM_COMMAND_PANE_LINES],
    };
  };

  const handleRefresh = () => {
    void deps.refresh(projectDir);
  };

  const authContext: RouteAuthContext = {
    hasOracle: catalog.hasOracle,
    providerAuth: catalog.providerAuth,
  };

  const rightRows = keyRows(catalog.rightRows);
  // Every row of the column is drawn at one width and the plan answers for the whole list, so it
  // is made once per render, at the width the first row asks for.
  let rowPlan: ModelRowPlan | undefined;
  const rowPlanAt = (width: number): ModelRowPlan => {
    if (rowPlan?.width !== width)
      rowPlan = planModelRows({
        rows: catalog.rightRows,
        width,
        providerId: catalog.currentItem?.id,
      });
    return rowPlan;
  };
  // The tool column answers for its status words the same way, over every tool, not the filtered few.
  let statusPlan: { width: number; fits: boolean } | undefined;
  const statusesFitAt = (width: number): boolean => {
    if (statusPlan?.width !== width) {
      statusPlan = { width, fits: toolStatusesFit(catalog.items, width) };
    }
    return statusPlan.fits;
  };

  const resolvePreview = (ctx: PreviewContext<PickerOption, KeyedRightRow>): string | undefined => {
    const tool = ctx.leftItem ?? catalog.currentItem;
    if (!tool) return undefined;
    if (tool.kind === 'no-fallback') return undefined;
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
    if (row?.kind === 'auth') {
      return `Auth: ${AUTH_METHOD_WORDS[row.method]}${row.unproven ? `${SOFT_SEP}unproven; select a supported auth method` : ''}`;
    }
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
    const signedOut = tool.status.state === 'unauthenticated';
    const stale = staleModelCopy(catalog.modelCounts.stale);
    // A status remediation leads: a runner the picker cannot run says how to fix it before it
    // recites what it is. The retained-stale line is already a refresh instruction, so a
    // remediation ahead of it would only push it off the end.
    const reason = stale === undefined ? tool.status.remediation : null;
    const spent = [reason, stale]
      .filter((part): part is string => part !== null && part !== undefined)
      .reduce((sum, part) => sum + getTerminalCellWidth(part) + getTerminalCellWidth(SOFT_SEP), 0);

    const toolsByline = (): string => {
      const listing = pickerListingSource(toolId);
      return formatToolsByline({
        toolName: tool.displayName,
        version: tool.version,
        modelCount: catalog.modelRowCount,
        rowNoun: listing.rowNoun,
        rowNounPlural: listing.rowNounPlural,
        source: listing.source,
        unverifiedForPlan: listing.unverifiedForPlan,
        diagnostic: catalog.catalogDiagnostic,
        signedOut,
        lane: catalog.catalogLane,
        capabilities: formatPermissionLabels(tool.permissions),
        billing: tool.billing,
        budget: Math.max(0, ctx.bylineBudget - spent),
      });
    };
    const modelsByline = (current: ModelBylineRow): string => {
      const model = current.model;
      const label = model.displayName ?? formatModelName(model.id, catalog.currentItem?.id);
      if (isAutomaticModel(model.id)) {
        return formatModelsByline({
          label,
          id: '',
          axes: [],
          contextLength: undefined,
          autoRow: { toolName: tool.displayName },
        });
      }
      const id =
        current.kind === 'route'
          ? current.variant.fullId
          : current.kind === 'axis'
            ? routeDraftOf(model, current.providerPrefix, catalog.optionDraftId)
            : optionDraftOf(model, catalog.optionDraftId);
      return formatModelsByline({
        label,
        id,
        axes: modelBylineAxes({ model, id, effortDraft: catalog.effortDraft }),
        contextLength: model.contextLength,
        supportsToolCalls: model.supportsToolCalls,
      });
    };
    const status = bylineDiagnostic({
      diagnostic: catalog.catalogDiagnostic,
      modelCount: catalog.modelRowCount,
      toolName: tool.displayName,
      signedOut,
      budget: ctx.bylineBudget,
    });
    if (status !== undefined) return status;
    const byline =
      ctx.activeColumn === 'right' && row !== null && row.kind !== 'action'
        ? modelsByline(row)
        : toolsByline();
    const trail = stale === undefined ? byline : `${byline}${SOFT_SEP}${stale}`;
    return reason === null ? trail : `${reason}${SOFT_SEP}${trail}`;
  };

  return (
    <TwoColumnPicker<PickerOption, KeyedRightRow>
      title={`${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]]}${slot === 'fallback' ? ' fallback' : ''}${SOFT_SEP}tool, model, effort`}
      stepLabel={resolvedStepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={(left, row) => confirmRightRow(left, row, { actions, auth: authContext })}
      onCancel={() => overlayStore.close()}
      onRefresh={handleRefresh}
      error={saveError ?? undefined}
      preview={resolvePreview}
      leftProps={{
        items: catalog.items,
        label: 'Tools',
        getKey: (item) => item.id,
        // Clearing a fallback and adding a command stay reachable under any filter.
        filterBy: (item, query) =>
          item.kind === 'custom-command' ||
          item.kind === 'no-fallback' ||
          filterByFields(item, query, ['id', 'displayName']),
        compare: (a, b) => sortPickerOptions(a, b, { filterActive: true }),
        terminalPane: terminalPaneFor,
        // A local server that is not answering is not a dead row: it still owns an
        // address the operator can edit, so it stays reachable and opens its form.
        isDisabled: (item) =>
          isPickerItemDisabled(item) && localConnectionProvider(item) === undefined,
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
            showStatus: statusesFitAt(maxWidth),
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
          pickerViewStore.expand(
            row.model.id,
            draft,
            seatEffortDraft(row.model, draft, role, slot),
          );
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
                isCustom: (row: KeyedRightRow) =>
                  slot === 'seat' && row.kind === 'model' && isCustomModel(row.model),
              },
            }
          : {}),
        renderRow: (row, { isCursor, maxWidth }) =>
          renderModelRow({
            row,
            isCursor,
            maxWidth,
            currentModel: catalog.currentModel,
            auth: authContext,
            plan: rowPlanAt(maxWidth),
          }),
      }}
    />
  );
}
