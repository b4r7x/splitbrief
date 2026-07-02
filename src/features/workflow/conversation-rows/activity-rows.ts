import {
  fitCompactActivityDisplayLine,
  type ActivityDisplayValueFit,
} from '../display/activity-display-text.js';
import { ACTIVITY_LABEL_PAD, displayActivityLabel } from '../display/activity-label-display.js';
import type { RunnerActivityLedgerLabel } from '../display/runner-activity-display.js';
import { getShortcutKey } from '../../../core/keybindings/registry.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import {
  buildActivityBatchViewModel,
  type ActivityBatchViewModel,
  type RunnerActivityEvent,
} from './activity-batch-model.js';
import { row, segmentedRow } from './row-format.js';
import { rowLeadingCells } from './row-markers.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowTone } from './types.js';

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
  if (model.headerText !== null) return `${model.batchKey}-header`;
  return undefined;
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
      activityHeaderRow({
        key: `${model.batchKey}-header`,
        text: fitCompactActivityDisplayLine({
          label: headerText,
          rowCells: width,
          prefixCells: rowLeadingCells('activity'),
        }).text,
        tone: model.tone,
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

function activityHeaderRow(input: {
  key: string;
  text: string;
  tone: ConversationRowTone;
}): ConversationRow {
  return row({ key: input.key, text: input.text, tone: input.tone, bold: true, kind: 'activity' });
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
