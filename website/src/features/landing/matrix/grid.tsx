import type { ReactNode } from 'react';
import {
  IMPLEMENTER_JACK_IDS,
  IMPLEMENTER_JACKS,
  PLANNER_JACK_IDS,
  PLANNER_JACKS,
} from './pairings.js';
import type { PairingSelection } from './pairings.js';
import { useMatrixKeys } from './use-matrix-keys.js';
import type { MatrixCellPosition } from './use-matrix-keys.js';

export type MatrixGridProps = {
  readonly selected: PairingSelection;
  readonly onSelect: (selection: PairingSelection) => void;
};

function initialCellFor(selection: PairingSelection): MatrixCellPosition {
  const rowIndex = PLANNER_JACK_IDS.indexOf(selection.plannerId);
  const columnIndex = IMPLEMENTER_JACK_IDS.indexOf(selection.implementerId);

  if (rowIndex < 0 || columnIndex < 0) {
    throw new Error('Matrix selection is outside the supported jack axes');
  }

  return { rowIndex, columnIndex };
}

function selectionForCell(cell: MatrixCellPosition): PairingSelection {
  const plannerId = PLANNER_JACK_IDS[cell.rowIndex];
  const implementerId = IMPLEMENTER_JACK_IDS[cell.columnIndex];

  if (!plannerId || !implementerId) {
    throw new Error(`Matrix cell ${cell.rowIndex}:${cell.columnIndex} is outside the jack axes`);
  }

  return { plannerId, implementerId };
}

function isSameSelection(left: PairingSelection, right: PairingSelection): boolean {
  return left.plannerId === right.plannerId && left.implementerId === right.implementerId;
}

function plannerHeaderId(plannerId: PairingSelection['plannerId']): string {
  return `matrix-planner-${plannerId}`;
}

function implementerHeaderId(implementerId: PairingSelection['implementerId']): string {
  return `matrix-implementer-${implementerId}`;
}

function renderImplementerLabel(implementerId: PairingSelection['implementerId']): ReactNode {
  switch (implementerId) {
    case 'deepseek':
      return (
        <>
          Deep
          <wbr />
          Seek
        </>
      );
    case 'openrouter':
      return (
        <>
          Open
          <wbr />
          Router
        </>
      );
    case 'together':
      return (
        <>
          Together <wbr />
          AI
        </>
      );
    default:
      return IMPLEMENTER_JACKS[implementerId].label;
  }
}

// biome-ignore-start lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA permits a native table and its td elements to host an interactive data grid.
export function MatrixGrid({ selected, onSelect }: MatrixGridProps) {
  const { activeCell, handleCellClick, handleCellFocus, handleCellKeyDown, setCellRef } =
    useMatrixKeys({
      initialCell: initialCellFor(selected),
      rowCount: PLANNER_JACK_IDS.length,
      columnCount: IMPLEMENTER_JACK_IDS.length,
      onActivate: (cell) => onSelect(selectionForCell(cell)),
    });

  return (
    <table className="matrix-grid" role="grid" aria-label="Planner × implementer pairings">
      <thead>
        <tr>
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: The non-focusable corner cell is decorative and must not add a seventh announced header. */}
          <th className="matrix-grid__corner" aria-hidden="true" />
          {IMPLEMENTER_JACK_IDS.map((implementerId, columnIndex) => (
            <th
              className="matrix-grid__column-header"
              data-column-index={columnIndex}
              data-implementer={implementerId}
              id={implementerHeaderId(implementerId)}
              key={implementerId}
              scope="col"
            >
              <span className="matrix-grid__jack" aria-hidden="true" />
              <span>{renderImplementerLabel(implementerId)}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {PLANNER_JACK_IDS.map((plannerId, rowIndex) => (
          <tr className="matrix-grid__row" data-planner={plannerId} key={plannerId}>
            <th
              className="matrix-grid__row-header"
              data-planner={plannerId}
              data-row-index={rowIndex}
              id={plannerHeaderId(plannerId)}
              scope="row"
            >
              <span className="matrix-grid__jack" aria-hidden="true" />
              <span>{PLANNER_JACKS[plannerId].label}</span>
            </th>
            {IMPLEMENTER_JACK_IDS.map((implementerId, columnIndex) => {
              const cell = { rowIndex, columnIndex };
              const cellSelection = { plannerId, implementerId };
              const isActive =
                activeCell.rowIndex === rowIndex && activeCell.columnIndex === columnIndex;
              const isSelected = isSameSelection(selected, cellSelection);

              return (
                <td
                  aria-labelledby={`${plannerHeaderId(plannerId)} ${implementerHeaderId(implementerId)}`}
                  aria-selected={isSelected}
                  className="matrix-grid__cell"
                  data-column-index={columnIndex}
                  data-implementer={implementerId}
                  data-planner={plannerId}
                  data-row-index={rowIndex}
                  key={implementerId}
                  onClick={(event) => handleCellClick(event, cell)}
                  onFocus={() => handleCellFocus(cell)}
                  onKeyDown={(event) => handleCellKeyDown(event, cell)}
                  ref={(element) => setCellRef(cell, element)}
                  role="gridcell"
                  tabIndex={isActive ? 0 : -1}
                >
                  <span className="matrix-grid__jack" aria-hidden="true">
                    {isSelected ? <span className="matrix-grid__pin" /> : null}
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
// biome-ignore-end lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA permits a native table and its td elements to host an interactive data grid.
