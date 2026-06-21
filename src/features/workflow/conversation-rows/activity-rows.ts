import {
  fitCompactActivityDisplayLine,
  type ActivityDisplayValueFit,
} from '../display/activity-display-text.js';
import {
  buildActivityBatchViewModel,
  type ActivityBatchViewModel,
  type RunnerActivityEvent,
} from './activity-batch-model.js';
import { row } from './row-format.js';
import type { ConversationRow, ConversationRowTone } from './types.js';

const ACTIVITY_PREFIX_CELLS = 2;

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

export function runnerActivityBatchRows(
  options: RunnerActivityBatchRowsOptions,
): ConversationRow[] {
  const { model, width } =
    'model' in options
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

  if (model.visibleItems.length === 0) return [];

  const rows: ConversationRow[] = [];
  if (model.headerText !== null) {
    rows.push(
      row({
        key: `${model.batchKey}-header`,
        text: fitCompactActivityDisplayLine({
          label: model.headerText,
          rowCells: width,
          prefixCells: ACTIVITY_PREFIX_CELLS,
        }).text,
        tone: model.tone,
        bold: true,
        kind: 'activity',
      }),
    );
  }

  if (model.hiddenCount > 0) {
    rows.push(
      activityCardRow({
        key: `${model.batchKey}-hidden`,
        label: model.visibleItems.length === model.allItems.length ? 'less' : 'more',
        value: `ctrl+a ${
          model.visibleItems.length === model.allItems.length ? 'collapse' : 'expand'
        } ${model.hiddenCount} earlier ${model.hiddenCount === 1 ? 'update' : 'updates'}`,
        width,
        labelTone: 'textDim',
        valueTone: 'textDim',
        fitMode: 'end',
      }),
    );
  }

  for (const [index, item] of model.visibleItems.entries()) {
    rows.push(
      activityCardRow({
        key: `${model.batchKey}-item-${index}`,
        label: item.label,
        value: item.value,
        width,
        labelTone: item.labelTone,
        valueTone: item.valueTone,
        fitMode: item.fitMode,
      }),
    );
  }

  return rows;
}

function activityCardRow(input: {
  key: string;
  label: string;
  value: string;
  width: number;
  labelTone: ConversationRowTone;
  valueTone: ConversationRowTone;
  fitMode: ActivityDisplayValueFit;
}): ConversationRow {
  const line = fitCompactActivityDisplayLine({
    label: input.label,
    value: input.value,
    rowCells: input.width,
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
      ],
    };
  }

  return row({
    key: input.key,
    text: line.text,
    tone: line.value === undefined ? input.labelTone : input.valueTone,
    kind: 'activity-child',
  });
}
