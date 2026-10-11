import {
  fitCompactActivityDisplayLine,
  type ActivityDisplayValueFit,
} from '../display/activity-display-text.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../display/activity-label-display.js';
import type { RunnerActivityLedgerLabel } from '../display/runner-activity-display.js';
import { cutSeatIdentity } from '../../../core/crew/identity.js';
import { getShortcutKey } from '../../../core/keybindings/registry.js';
import {
  ELLIPSIS,
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  segmentsForRowText,
} from '../../../utils/display-text.js';
import {
  buildActivityBatchViewModel,
  type ActivityBatchViewModel,
  type RunnerActivityEvent,
} from './activity-batch-model.js';
import { row, segmentedRow } from './row-format/rows.js';
import { rowLeadingCells } from './row-markers.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowSegment,
  ConversationRowTone,
} from './types.js';

const HEADER_RUNNER_GAP = '  ';

type RunnerActivityBatchRowsInput = {
  events: readonly RunnerActivityEvent[];
  width: number;
  batchKey: string;
  expanded?: boolean;
};

type RunnerActivityBatchRowsOptions =
  | {
      model: ActivityBatchViewModel;
      width: number;
    }
  | RunnerActivityBatchRowsInput;

export function runnerActivityBatchRowBlock(
  options: RunnerActivityBatchRowsOptions,
): ConversationRowBlock | null {
  const { model, width } = resolveActivityBatchRowsOptions(options);
  const rowCount = runnerActivityBatchRowCount(model);
  if (rowCount === 0) return null;

  const activeRowKey = activityBatchActiveRowKey(model);
  return {
    key: model.batchKey,
    rowCount,
    renderableUnits: model.renderableUnits,
    ...(activeRowKey !== undefined ? { activeRowKey } : {}),
    createRows: (windowStart, windowEnd) =>
      runnerActivityBatchWindowRows({ model, width, windowStart, windowEnd }),
  };
}

function activityBatchActiveRowKey(model: ActivityBatchViewModel): string | undefined {
  if (model.headerSegments.length > 0) return `${model.batchKey}-header`;
  return undefined;
}

export function runnerActivityBatchRowCount(model: ActivityBatchViewModel): number {
  if (model.visibleItems.length === 0) return 0;
  return (
    (model.headerSegments.length === 0 ? 0 : 1) +
    model.visibleItems.length +
    (model.hiddenCount > 0 ? 1 : 0)
  );
}

export function runnerActivityBatchWindowRows(input: {
  model: ActivityBatchViewModel;
  width: number;
  windowStart: number;
  windowEnd: number;
}): ConversationRow[] {
  const { model, width } = input;

  if (model.visibleItems.length === 0) return [];

  const rows: ConversationRow[] = [];
  const start = Math.max(0, input.windowStart);
  const end = Math.max(start, input.windowEnd);
  let rowIndex = 0;

  const appendVisibleRow = (createRow: () => ConversationRow): void => {
    if (rowIndex >= start && rowIndex < end) rows.push(createRow());
    rowIndex += 1;
  };

  if (model.headerSegments.length > 0) {
    const prefixCells = rowLeadingCells('activity');
    appendVisibleRow(() =>
      activityHeaderRow({
        key: `${model.batchKey}-header`,
        model,
        width,
        prefixCells,
      }),
    );
  }

  const visibleCount = model.visibleItems.length;
  const hasDisclosure = model.hiddenCount > 0;
  const lastItemIndex = visibleCount - 1;

  for (const [index, item] of model.visibleItems.entries()) {
    const isLastVisible = index === lastItemIndex;
    appendVisibleRow(() =>
      activityCardRow({
        key: `${model.batchKey}-item-${index}`,
        label: item.label,
        value: item.value,
        width,
        labelTone: item.labelTone,
        valueTone: item.valueTone,
        fitMode: item.fitMode,
        rawMarker: item.rawMarker,
        kind: isLastVisible ? 'activity-child-last' : 'activity-child',
      }),
    );
    if (rowIndex >= end) return rows;
  }

  if (hasDisclosure) {
    appendVisibleRow(() => activityDisclosureRow({ model, width }));
  }

  return rows;
}

/**
 * The runner closes the header and sheds the way a seat identity does: the model goes before the
 * tool, and a tool name that would be cut leaves the line instead, so no header ends in half a name.
 */
function activityHeaderSegments(
  model: ActivityBatchViewModel,
  cells: number,
): ConversationRowSegment[] {
  const runner = model.headerRunner;
  const segments = [...model.headerSegments];
  const text = segments.map((segment) => segment.text).join('');
  if (runner === null) return segments;
  const budget = cells - getTerminalCellWidth(`${text}${HEADER_RUNNER_GAP}[]`);
  if (budget <= 0) return segments;
  const fitted = cutSeatIdentity(runner, budget);
  return fitted.endsWith(ELLIPSIS)
    ? segments
    : [
        ...segments,
        { text: `${HEADER_RUNNER_GAP}[`, tone: 'textDim' },
        { text: fitted, tone: model.tone },
        { text: ']', tone: 'textDim' },
      ];
}

function activityHeaderRow(input: {
  key: string;
  model: ActivityBatchViewModel;
  width: number;
  prefixCells: number;
}): ConversationRow {
  const segments = activityHeaderSegments(input.model, input.width - input.prefixCells);
  const text = fitCompactActivityDisplayLine({
    label: segments.map((segment) => segment.text).join(''),
    rowCells: input.width,
    prefixCells: input.prefixCells,
  }).text;
  return {
    ...segmentedRow(
      input.key,
      segmentsForRowText(segments, text).map((segment) => ({ ...segment, bold: true })),
      'activity',
    ),
    markerTone: input.model.markerTone,
  };
}

function activityDisclosureRow(input: {
  model: ActivityBatchViewModel;
  width: number;
}): ConversationRow {
  const prefixCells = rowLeadingCells('activity-more');
  const budget = Math.max(0, input.width - prefixCells);
  const label = input.model.expanded ? 'collapse' : `+${input.model.hiddenCount} more`;
  const text = truncateTerminalDisplayText(`${label}${activityDisclosureHint()}`, budget);

  return segmentedRow(
    `${input.model.batchKey}-hidden`,
    [{ text, tone: 'textDim' as const }],
    'activity-more',
  );
}

function activityDisclosureHint(): string {
  const shortcut = getShortcutKey('activity');
  if (shortcut === null) return '';
  const chord = (shortcut.split(',').at(-1) ?? shortcut).trim().toLowerCase();
  return chord.length === 0 ? '' : ` · ${chord}`;
}

function resolveActivityBatchRowsOptions(options: RunnerActivityBatchRowsOptions): {
  model: ActivityBatchViewModel;
  width: number;
} {
  return 'model' in options
    ? options
    : {
        model: buildActivityBatchViewModel(
          options.expanded === undefined
            ? {
                events: options.events,
                batchKey: options.batchKey,
              }
            : {
                events: options.events,
                batchKey: options.batchKey,
                expanded: options.expanded,
              },
        ),
        width: options.width,
      };
}

function activityCardRow(input: {
  key: string;
  label: RunnerActivityLedgerLabel;
  value: string;
  width: number;
  labelTone: ConversationRowTone;
  valueTone: ConversationRowTone;
  fitMode: ActivityDisplayValueFit;
  rawMarker?: string | null | undefined;
  kind?: 'activity' | 'activity-child' | 'activity-child-last' | 'activity-more';
  prefixCells?: number;
}): ConversationRow {
  const rawMarker = input.rawMarker ?? null;
  const rawMarkerText = rawMarker ? `  ${rawMarker}` : '';
  const kind = input.kind ?? 'activity-child';
  const line = fitCompactActivityDisplayLine({
    label: displayActivityLabel(input.label).padEnd(ACTIVITY_LABEL_PAD),
    value: input.value,
    rowCells: input.width - rawMarkerText.length,
    prefixCells: input.prefixCells ?? rowLeadingCells(kind),
    valueFit: input.fitMode,
  });
  const labelText = line.value === undefined ? line.label : `${line.label}  `;

  if (line.value !== undefined && line.text.startsWith(labelText)) {
    return {
      key: input.key,
      kind,
      segments: [
        { text: labelText, tone: input.labelTone },
        { text: line.value, tone: input.valueTone },
        ...(rawMarker ? [{ text: rawMarkerText, tone: 'textDim' as const }] : []),
      ],
    };
  }

  return row({
    key: input.key,
    text: `${line.text}${rawMarkerText}`,
    tone: line.value === undefined ? input.labelTone : input.valueTone,
    kind,
  });
}
