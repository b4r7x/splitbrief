import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixGrid } from './grid.js';
import {
  DEFAULT_SELECTION,
  IMPLEMENTER_JACK_IDS,
  IMPLEMENTER_JACKS,
  PLANNER_JACK_IDS,
  PLANNER_JACKS,
} from './pairings.js';
import type { PairingSelection } from './pairings.js';

function MatrixHarness() {
  const [selected, setSelected] = useState<PairingSelection>(DEFAULT_SELECTION);
  return <MatrixGrid selected={selected} onSelect={setSelected} />;
}

function axisIdAt<Id extends string>(ids: readonly Id[], index: number): Id {
  const id = ids[index];
  if (!id) throw new Error(`Missing matrix axis entry at index ${index}`);
  return id;
}

function cellAt(cells: HTMLElement[], rowIndex: number, columnIndex: number): HTMLElement {
  const plannerId = axisIdAt(PLANNER_JACK_IDS, rowIndex);
  const implementerId = axisIdAt(IMPLEMENTER_JACK_IDS, columnIndex);
  const cell = cells[rowIndex * IMPLEMENTER_JACK_IDS.length + columnIndex];

  if (!cell) throw new Error(`Missing rendered matrix cell at ${rowIndex}:${columnIndex}`);
  expect(cell).toHaveAccessibleName(
    `${PLANNER_JACKS[plannerId].label} ${IMPLEMENTER_JACKS[implementerId].label}`,
  );
  return cell;
}

function selectedCells(cells: HTMLElement[]): HTMLElement[] {
  return cells.filter((cell) => cell.getAttribute('aria-selected') === 'true');
}

function tabStopCells(cells: HTMLElement[]): HTMLElement[] {
  return cells.filter((cell) => cell.tabIndex === 0);
}

describe('MatrixGrid', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the complete single-select pairing grid without accessibility violations', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<MatrixHarness />);
    const grid = screen.getByRole('grid', { name: 'Planner × implementer pairings' });
    const cells = within(grid).getAllByRole('gridcell');

    expect(within(grid).getAllByRole('columnheader')).toHaveLength(6);
    expect(within(grid).getAllByRole('rowheader')).toHaveLength(6);
    for (const name of ['DeepSeek', 'OpenRouter', 'Together AI']) {
      const header = within(grid).getByRole('columnheader', { name });
      expect(header).toHaveTextContent(name);
      expect(header.querySelectorAll('wbr')).toHaveLength(1);
    }
    expect(within(grid).getByRole('columnheader', { name: 'LM Studio' }).querySelector('wbr')).toBe(
      null,
    );
    expect(cells).toHaveLength(36);
    expect(cells.every((cell) => cell.hasAttribute('aria-selected'))).toBe(true);
    const headerJacks = container.querySelectorAll(
      '.matrix-grid__column-header > .matrix-grid__jack, .matrix-grid__row-header > .matrix-grid__jack',
    );
    expect(headerJacks).toHaveLength(12);
    expect([...headerJacks].every((jack) => jack.getAttribute('aria-hidden') === 'true')).toBe(
      true,
    );
    expect(selectedCells(cells)).toEqual([cellAt(cells, 0, 0)]);
    expect(tabStopCells(cells)).toEqual([cellAt(cells, 0, 0)]);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('moves one roving focus without seating a pair until Enter or Space', async () => {
    const user = userEvent.setup();
    render(<MatrixHarness />);
    const cells = within(
      screen.getByRole('grid', { name: 'Planner × implementer pairings' }),
    ).getAllByRole('gridcell');

    await user.tab();
    expect(cellAt(cells, 0, 0)).toHaveFocus();

    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(cellAt(cells, 1, 1)).toHaveFocus();
    expect(selectedCells(cells)).toEqual([cellAt(cells, 0, 0)]);
    expect(tabStopCells(cells)).toEqual([cellAt(cells, 1, 1)]);

    await user.keyboard('{Enter}');
    expect(selectedCells(cells)).toEqual([cellAt(cells, 1, 1)]);
    expect(cellAt(cells, 1, 1)).toHaveFocus();

    await user.keyboard('{ArrowLeft} ');
    expect(cellAt(cells, 1, 0)).toHaveFocus();
    expect(selectedCells(cells)).toEqual([cellAt(cells, 1, 0)]);
    expect(tabStopCells(cells)).toEqual([cellAt(cells, 1, 0)]);
  });

  it('keeps arrows bounded, supports row and grid bounds, and anchors clicks', async () => {
    const user = userEvent.setup();
    render(<MatrixHarness />);
    const cells = within(
      screen.getByRole('grid', { name: 'Planner × implementer pairings' }),
    ).getAllByRole('gridcell');

    await user.tab();
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(cellAt(cells, 0, 0)).toHaveFocus();

    await user.keyboard('{End}{ArrowRight}');
    expect(cellAt(cells, 0, 5)).toHaveFocus();
    expect(selectedCells(cells)).toEqual([cellAt(cells, 0, 0)]);

    await user.keyboard('{Control>}{End}{/Control}{ArrowDown}');
    expect(cellAt(cells, 5, 5)).toHaveFocus();

    await user.keyboard('{Home}');
    expect(cellAt(cells, 5, 0)).toHaveFocus();

    await user.keyboard('{Control>}{Home}{/Control}');
    expect(cellAt(cells, 0, 0)).toHaveFocus();

    await user.click(cellAt(cells, 4, 3));
    expect(cellAt(cells, 4, 3)).toHaveFocus();
    expect(selectedCells(cells)).toEqual([cellAt(cells, 4, 3)]);
    expect(tabStopCells(cells)).toEqual([cellAt(cells, 4, 3)]);

    await user.keyboard('{ArrowRight}');
    expect(cellAt(cells, 4, 4)).toHaveFocus();
    expect(selectedCells(cells)).toEqual([cellAt(cells, 4, 3)]);
  });
});
