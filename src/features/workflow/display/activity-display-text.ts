import {
  getTerminalCellWidth,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
  truncateTerminalDisplayTextStart,
} from '../../../utils/display-text.js';
import { assertNever } from '../../../utils/type-guards.js';

const LABEL_VALUE_SEPARATOR = '  ';

export type ActivityDisplayValueFit = 'end' | 'middle' | 'start';

export interface CompactActivityDisplayLineInput {
  label: string;
  value?: string;
  rowCells: number;
  prefixCells: number;
  valueFit?: ActivityDisplayValueFit;
}

export interface CompactActivityDisplayLine {
  label: string;
  text: string;
  value?: string;
}

export function fitCompactActivityDisplayLine(
  input: CompactActivityDisplayLineInput,
): CompactActivityDisplayLine {
  const availableCells = Math.max(0, input.rowCells - Math.max(0, input.prefixCells));
  const label = sanitizeTerminalDisplayText(input.label);
  const value = input.value === undefined ? undefined : sanitizeTerminalDisplayText(input.value);

  if (value === undefined || value === '') return fitLabelOnly(label, availableCells);

  const labelText = `${label}${LABEL_VALUE_SEPARATOR}`;
  const text = `${labelText}${value}`;
  if (getTerminalCellWidth(text) <= availableCells) return { label, value, text };

  const labelCells = getTerminalCellWidth(labelText);
  if (labelCells >= availableCells) {
    const fittedText = truncateTerminalDisplayText(text, availableCells);
    return { label: fittedText, text: fittedText };
  }

  const valueCells = availableCells - labelCells;
  const valueFit = input.valueFit ?? valueFitForActivityLabel(label);
  const fittedValue = fitActivityValue(value, valueCells, valueFit);
  return { label, value: fittedValue, text: `${labelText}${fittedValue}` };
}

function fitLabelOnly(label: string, availableCells: number): CompactActivityDisplayLine {
  const fittedLabel = truncateTerminalDisplayText(label, availableCells);
  return { label: fittedLabel, text: fittedLabel };
}

function fitActivityValue(
  value: string,
  maxCells: number,
  valueFit: ActivityDisplayValueFit,
): string {
  switch (valueFit) {
    case 'end':
      return truncateTerminalDisplayText(value, maxCells);
    case 'middle':
      return truncateTerminalDisplayTextMiddle(value, maxCells);
    case 'start':
      return truncateTerminalDisplayTextStart(value, maxCells);
    default:
      return assertNever(valueFit);
  }
}

function valueFitForActivityLabel(label: string): ActivityDisplayValueFit {
  switch (label) {
    case 'run':
      return 'middle';
    case 'edit':
    case 'file':
    case 'read':
      return 'start';
    default:
      return 'end';
  }
}
