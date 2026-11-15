import { REVIEW_NONE, PLANNER_INHERITANCE } from '../../../core/crew/identity.js';
import { isAutomaticModel } from '../../../core/providers/automatic-model.js';
import { formatModelName } from '../../../core/providers/model-display.js';
import { localProviderStartup } from '../../../core/readiness/checks/availability.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import type { RouteAuthState } from '../../../core/runners/route-auth.js';
import { billingWord } from '../../../core/runners/billing.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { providerOracleCommand } from '../../../engine/runners/cli-tools/probe/provider-oracle.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { localConnectionProvider } from '../local-connection/model.js';
import { routeDraftOf } from '../model-catalog/option-axis.js';
import type { PickerOption } from '../model-catalog/options.js';
import type { ModelVariant } from '../model-catalog/recency.js';
import type { RightRow } from '../model-catalog/types.js';
import { type RouteAuthContext, modelRowSave } from '../right-column/policy.js';
import type { PreviewContext } from '../two-column-picker/picker.js';
import type { TerminalPane } from '../two-column-picker/types.js';
import {
  wrapOnWords,
  formatToolsByline,
  formatModelsByline,
  modelBylineAxes,
  bylineDiagnostic,
} from './byline.js';
import {
  CUSTOM_COMMAND_PANE_CELLS,
  CUSTOM_COMMAND_PANE_LINES,
  notReadyPane,
  formatPermissionLabels,
} from './labels.js';
import { pickerListingSource } from './listing-source.js';
import { formatRouteRemedy } from './route-auth.js';
import type { PickerCatalog } from './use-catalog.js';

/** The row kinds that carry a model, and so have a Models byline. */
type ModelBylineRow = Extract<RightRow, { kind: 'model' | 'route' | 'axis' }>;

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
      : // The remedy keeps what fits the narrowest card; the card breaks it again at its own width.
        [
          wrapOnWords(remediation, CUSTOM_COMMAND_PANE_CELLS, PANE_REMEDY_LINES).lines.join(' '),
          '',
        ];
  return [...remedy, '⏎ opens its address, its token and a check.', '', 'Nothing is saved yet.'];
}

function postureLine(item: PickerOption): string {
  return [billingWord(item.billing), ...formatPermissionLabels(item.permissions)]
    .filter(Boolean)
    .join(SOFT_SEP);
}

export function terminalPaneFor(
  item: PickerOption,
  catalog: Pick<PickerCatalog, 'plannerIdentity' | 'savedRunner'>,
): TerminalPane | undefined {
  if (item.kind === 'no-fallback') {
    return {
      label: 'No fallback',
      verb: item.isCurrent === true ? 'keep no fallback' : 'clear fallback',
      lines: ['A Seat down halt pauses the run and asks which tool takes the seat.'],
    };
  }
  if (item.kind === 'review-none') {
    return {
      label: REVIEW_NONE.mark,
      verb: 'confirm',
      lines: [
        'No seat reviews the run.',
        'Each brief runs its own',
        'checks. No end-of-run',
        'check and no render',
        'check run.',
      ],
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
  if (item.kind === 'custom-command') {
    return {
      label: 'Custom command',
      verb: 'add custom',
      lines: [...CUSTOM_COMMAND_PANE_LINES],
    };
  }
  if (item.kind !== 'cli') return undefined;
  return notReadyPane({
    status: item.status,
    savedRunner: item.isCurrent === true ? catalog.savedRunner : undefined,
  });
}

export function resolvePreview(
  ctx: PreviewContext<PickerOption, RightRow>,
  { catalog, auth }: { catalog: PickerCatalog; auth: RouteAuthContext },
): string | undefined {
  const tool = ctx.leftItem ?? catalog.currentItem;
  if (!tool) return undefined;
  if (tool.kind === 'no-fallback' || tool.kind === 'review-none') return undefined;
  const toolId = auth.tool;
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
  // A signed-in route needs no remedy, so the byline is what the row falls
  // back to rather than an empty preview line.
  const remedyFor = (routeAuth: RouteAuthState, variant: ModelVariant): string | undefined => {
    // Option-axis children have no provider to sign into; their prefix is empty.
    if (variant.providerPrefix === '') return undefined;
    return formatRouteRemedy({
      auth: routeAuth,
      toolName: tool.displayName,
      oracleCommand: oracleCommand ?? '',
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
  const stale = staleModelCopy(catalog.modelCounts.stale);
  const spent =
    stale === undefined ? 0 : getTerminalCellWidth(stale) + getTerminalCellWidth(SOFT_SEP);

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
          : modelRowSave(current, auth, catalog.optionDraftId).fullId;
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
    budget: ctx.bylineBudget,
  });
  if (status !== undefined) return status;
  const byline =
    ctx.activeColumn === 'right' && row !== null && row.kind !== 'action'
      ? modelsByline(row)
      : toolsByline();
  return stale === undefined ? byline : `${byline}${SOFT_SEP}${stale}`;
}
