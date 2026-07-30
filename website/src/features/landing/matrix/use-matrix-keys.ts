import { useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

export type MatrixCellPosition = {
  readonly rowIndex: number;
  readonly columnIndex: number;
};

type UseMatrixKeysOptions = {
  readonly initialCell: MatrixCellPosition;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly onActivate: (cell: MatrixCellPosition) => void;
};

type NavigationTargetOptions = {
  readonly event: KeyboardEvent<HTMLTableCellElement>;
  readonly cell: MatrixCellPosition;
  readonly rowCount: number;
  readonly columnCount: number;
};

function cellIndex(cell: MatrixCellPosition, columnCount: number): number {
  return cell.rowIndex * columnCount + cell.columnIndex;
}

function sameCell(left: MatrixCellPosition, right: MatrixCellPosition): boolean {
  return left.rowIndex === right.rowIndex && left.columnIndex === right.columnIndex;
}

function navigationTarget({
  event,
  cell,
  rowCount,
  columnCount,
}: NavigationTargetOptions): MatrixCellPosition | null {
  if (event.altKey || event.metaKey) return null;

  if (event.key === 'Home') {
    return event.ctrlKey ? { rowIndex: 0, columnIndex: 0 } : { ...cell, columnIndex: 0 };
  }

  if (event.key === 'End') {
    const lastColumn = columnCount - 1;
    return event.ctrlKey
      ? { rowIndex: rowCount - 1, columnIndex: lastColumn }
      : { ...cell, columnIndex: lastColumn };
  }

  if (event.ctrlKey) return null;

  switch (event.key) {
    case 'ArrowDown':
      return { ...cell, rowIndex: Math.min(cell.rowIndex + 1, rowCount - 1) };
    case 'ArrowLeft':
      return { ...cell, columnIndex: Math.max(cell.columnIndex - 1, 0) };
    case 'ArrowRight':
      return { ...cell, columnIndex: Math.min(cell.columnIndex + 1, columnCount - 1) };
    case 'ArrowUp':
      return { ...cell, rowIndex: Math.max(cell.rowIndex - 1, 0) };
    default:
      return null;
  }
}

export function useMatrixKeys({
  initialCell,
  rowCount,
  columnCount,
  onActivate,
}: UseMatrixKeysOptions) {
  const [activeCell, setActiveCell] = useState(initialCell);
  const cellRefs = useRef<Array<HTMLTableCellElement | null>>([]);

  function setCellRef(cell: MatrixCellPosition, element: HTMLTableCellElement | null): void {
    cellRefs.current[cellIndex(cell, columnCount)] = element;
  }

  function focusCell(cell: MatrixCellPosition): void {
    const element = cellRefs.current[cellIndex(cell, columnCount)];
    if (!element) {
      throw new Error(`Matrix cell ${cell.rowIndex}:${cell.columnIndex} is not mounted`);
    }

    setActiveCell(cell);
    element.focus();
  }

  function handleCellFocus(cell: MatrixCellPosition): void {
    setActiveCell(cell);
  }

  function handleCellClick(
    event: MouseEvent<HTMLTableCellElement>,
    cell: MatrixCellPosition,
  ): void {
    setActiveCell(cell);
    event.currentTarget.focus();
    onActivate(cell);
  }

  function handleCellKeyDown(
    event: KeyboardEvent<HTMLTableCellElement>,
    cell: MatrixCellPosition,
  ): void {
    const target = navigationTarget({ event, cell, rowCount, columnCount });
    if (target) {
      event.preventDefault();
      if (!sameCell(target, cell)) focusCell(target);
      return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && !event.altKey && !event.metaKey) {
      event.preventDefault();
      onActivate(cell);
    }
  }

  return {
    activeCell,
    handleCellClick,
    handleCellFocus,
    handleCellKeyDown,
    setCellRef,
  };
}
