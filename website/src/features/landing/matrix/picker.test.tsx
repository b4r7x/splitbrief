import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { run as axe } from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECTION, type PairingSelection } from './pairings.js';
import { PairingPicker } from './picker.js';

function PairingPickerHarness() {
  const [selected, setSelected] = useState<PairingSelection>(DEFAULT_SELECTION);

  return <PairingPicker onSelect={setSelected} selected={selected} />;
}

function expectOneCheckedTabStop(group: HTMLElement) {
  const radios = within(group).getAllByRole('radio');
  const checked = radios.filter((radio) => radio.matches(':checked'));
  const tabStops = radios.filter((radio) => radio.tabIndex === 0);

  expect(radios).toHaveLength(6);
  expect(checked).toHaveLength(1);
  expect(tabStops).toHaveLength(1);
  expect(tabStops[0]).toBe(checked[0]);
}

describe('PairingPicker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects either side independently with one native radio tab stop per group', async () => {
    const user = userEvent.setup();

    render(<PairingPickerHarness />);

    const plannerGroup = screen.getByRole('radiogroup', { name: 'Planner' });
    const implementerGroup = screen.getByRole('radiogroup', { name: 'Implementer' });
    const claudeCode = within(plannerGroup).getByRole('radio', { name: 'Claude Code' });
    const codex = within(plannerGroup).getByRole('radio', { name: 'Codex' });
    const ollama = within(implementerGroup).getByRole('radio', { name: 'Ollama' });
    const together = within(implementerGroup).getByRole('radio', { name: 'Together AI' });

    expect(screen.getByText('Planner', { selector: 'legend' })).toBeVisible();
    expect(screen.getByText('Implementer', { selector: 'legend' })).toBeVisible();
    expect(claudeCode).toBeChecked();
    expect(ollama).toBeChecked();
    expectOneCheckedTabStop(plannerGroup);
    expectOneCheckedTabStop(implementerGroup);

    ollama.focus();
    await user.keyboard('{ArrowLeft}');
    expect(together).toBeChecked();
    expect(together).toHaveFocus();
    expect(claudeCode).toBeChecked();

    await user.click(codex);
    expect(codex).toBeChecked();
    expect(together).toBeChecked();
    expectOneCheckedTabStop(plannerGroup);
    expectOneCheckedTabStop(implementerGroup);
  });

  it('has no automated accessibility violations', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const { container } = render(<PairingPickerHarness />);

    expect((await axe(container)).violations).toEqual([]);
  });
});
