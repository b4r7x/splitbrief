import { filterByFields } from '../../../components/pickers/filtering.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { CLI_TOOL_IDS } from '../../../core/runners/cli-tool/catalog.js';
import {
  type SeatPickerRole,
  type PickerSlot,
  PICKER_ROLE_SEAT_IDS,
} from '../../../core/runners/seat-roles.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { useSpinnerFrame } from '../../../hooks/use-spinner-frame.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { includes } from '../../../utils/type-guards.js';
import { inheritsPlannerSeat } from '../config-transforms/seat-selection.js';
import { localConnectionProvider } from '../local-connection/model.js';
import { type PickerOption, sortPickerOptions } from '../model-catalog/options.js';
import { isCustomModel } from '../model-catalog/recency.js';
import { rightRowKey, sectionOf } from '../model-catalog/rows.js';
import type { RightRow } from '../model-catalog/types.js';
import {
  type RouteAuthContext,
  confirmRow as confirmRightRow,
  rightRowMatches,
  activationOfRightRow,
  rowEnterHint,
} from '../right-column/policy.js';
import { cycleRightRow } from '../right-column/drafts.js';
import { expansionDraft } from '../right-column/drafts.js';
import { toolRowModel, modelRowModel } from '../tool-row.js';
import { TwoColumnPicker } from '../two-column-picker/picker.js';
import type { PickerCatalog } from './use-catalog.js';
import { fallbackInheritanceNotice, isPickerItemDisabled } from './labels.js';
import { ModelGuidance } from './model-guidance.js';
import { resolvePreview, terminalPaneFor } from './preview.js';
import { rowPlansFor } from './row-plans.js';
import {
  type PickerActions,
  type PickerEffectDeps,
  defaultPickerEffectDeps,
} from './use-actions.js';

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
  const notice = feedbackStore.use((s) => s);

  const toolId =
    catalog.currentItem !== undefined && includes(CLI_TOOL_IDS, catalog.currentItem.id)
      ? catalog.currentItem.id
      : undefined;
  const handleRefresh = () => {
    void deps.refresh(projectDir);
  };

  const authContext: RouteAuthContext = {
    tool: toolId,
    providerAuth: catalog.providerAuth,
    catalog: catalog.toolCatalog,
  };

  const rightRows = keyRows(catalog.rightRows);
  const { rowPlanAt, statusesFitAt, toolRowWidth } = rowPlansFor(catalog);

  return (
    <TwoColumnPicker<PickerOption, KeyedRightRow>
      title={`${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]]}${slot === 'fallback' ? ' fallback' : ''}${SOFT_SEP}tool, model, effort`}
      stepLabel={resolvedStepLabel}
      initialColumn={catalog.focusModels ? 'right' : 'left'}
      onConfirm={(left, row) => confirmRightRow(left, row, { actions, auth: authContext })}
      onCancel={() => overlayStore.close()}
      onRefresh={handleRefresh}
      notice={notice}
      preview={(ctx) => resolvePreview(ctx, { catalog, auth: authContext })}
      leftProps={{
        items: catalog.items,
        minRowWidth: toolRowWidth,
        label: 'Tools',
        getKey: (item) => item.id,
        // Clearing a fallback and adding a command stay reachable under any filter.
        filterBy: (item, query) =>
          item.kind === 'custom-command' ||
          item.kind === 'no-fallback' ||
          filterByFields(item, query, ['id', 'displayName']),
        compare: (a, b) => sortPickerOptions(a, b, { filterActive: true }),
        terminalPane: (item) => terminalPaneFor(item, catalog),
        // A local server that is not answering is not a dead row: it still owns an
        // address the operator can edit, so it stays reachable and opens its form.
        isDisabled: (item) =>
          isPickerItemDisabled(item) && localConnectionProvider(item) === undefined,
        initialIndex: catalog.initialLeftIdx,
        rowModel: (item, { isCursor, isSelected, isContext, maxWidth }) =>
          toolRowModel({
            item,
            isCursor,
            isSelected,
            isContext,
            showStatus: statusesFitAt(maxWidth),
          }),
      }}
      rightProps={{
        items: rightRows,
        label: 'Models',
        getKey: (row) => row.id,
        filterBy: (row, query) => rightRowMatches(row, query, catalog.currentItem?.id),
        initialIndex: catalog.initialRightIndex,
        resolveInitialIndex: catalog.resolveRightIndex,
        onLeftChange: actions.leftChange,
        section: { by: (row) => sectionOf(row) ?? '' },
        activationOf: (row) => activationOfRightRow(row, authContext),
        onExpand: (row) => {
          if (row.kind !== 'model') return;
          const draft = expansionDraft(row.model, {
            ...pickerViewStore.get(),
            currentModel: catalog.currentModel,
            role,
            slot,
          });
          pickerViewStore.expand(row.model.id, draft.optionDraftId, draft.effortDraft);
        },
        onCollapse: () => pickerViewStore.collapse(),
        onCycle: cycleRightRow,
        enterHint: (row) => rowEnterHint(row, authContext),
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
        customRow: {
          appliesTo: (item) => item.modelCapability.allowsCustom,
          onSelect: actions.openCustomModel,
          onDelete: (row: KeyedRightRow) => {
            if (row.kind === 'model') void actions.deleteRight(row.model);
          },
          isCustom: (row: KeyedRightRow) =>
            slot === 'seat' && row.kind === 'model' && isCustomModel(row.model),
        },
        rowModel: (row, { isCursor, maxWidth }) =>
          modelRowModel({
            row,
            isCursor,
            currentModel: catalog.currentModel,
            auth: authContext,
            plan: rowPlanAt(maxWidth),
          }),
      }}
    />
  );
}
