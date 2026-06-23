import {
  fitCompactActivityDisplayLine,
  type ActivityDisplayValueFit,
} from '../display/activity-display-text.js';
import { getShortcutKey } from '../../../core/keybindings/registry.js';
import {
  buildActivityBatchViewModel,
  type ActivityBatchViewModel,
  type RunnerActivityEvent,
} from './activity-batch-model.js';
import { row } from './row-format.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowTone } from './types.js';

const ACTIVITY_PREFIX_CELLS = 2;
const ACTIVITY_EXPAND_ACTION = getShortcutKey('activity') ?? '/activity';

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

  return {
    key: model.batchKey,
    rowCount,
    renderableUnits: model.renderableUnits,
    createRows: (windowStart, windowEnd) =>
      runnerActivityBatchWindowRows({ model, width, windowStart, windowEnd }),
  };
}

export function runnerActivityBatchRowCount(model: ActivityBatchViewModel): number {
  if (model.visibleItems.length === 0) return 0;
  return (
    (model.headerText === null ? 0 : 1) +
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

  const headerText = model.headerText;
  if (headerText !== null) {
    appendVisibleRow(() =>
      row({
        key: `${model.batchKey}-header`,
        text: fitCompactActivityDisplayLine({
          label: headerText,
          rowCells: width,
          prefixCells: ACTIVITY_PREFIX_CELLS,
        }).text,
        tone: model.tone,
        bold: true,
        kind: 'activity',
      }),
    );
  }

  for (const [index, item] of model.visibleItems.entries()) {
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
      }),
    );
    if (rowIndex >= end) return rows;
  }

  if (model.hiddenCount > 0) {
    appendVisibleRow(() =>
      activityCardRow({
        key: `${model.batchKey}-hidden`,
        label: model.expanded ? 'less' : '+',
        value: model.expanded
          ? ACTIVITY_EXPAND_ACTION
          : `${model.hiddenCount} earlier  ${ACTIVITY_EXPAND_ACTION}`,
        width,
        labelTone: 'textDim',
        valueTone: 'textDim',
        fitMode: 'end',
      }),
    );
  }

  return rows;
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
  label: string;
  value: string;
  width: number;
  labelTone: ConversationRowTone;
  valueTone: ConversationRowTone;
  fitMode: ActivityDisplayValueFit;
  rawMarker?: string | null | undefined;
}): ConversationRow {
  const rawMarker = input.rawMarker ?? null;
  const rawMarkerText = rawMarker ? `  ${rawMarker}` : '';
  const line = fitCompactActivityDisplayLine({
    label: input.label.padEnd(4),
    value: input.value,
    rowCells: input.width - rawMarkerText.length,
    prefixCells: ACTIVITY_PREFIX_CELLS,
    valueFit: input.fitMode,
  });
  const labelText = line.value === undefined ? line.label : `${line.label}  `;

  if (line.value !== undefined && line.text.startsWith(labelText)) {
    return {
      key: input.key,
      kind: 'activity-child',
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
    kind: 'activity-child',
  });
}
