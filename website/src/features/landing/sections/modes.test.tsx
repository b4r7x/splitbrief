import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModesSection } from './modes.js';

describe('ModesSection', () => {
  it('shows the four canonical modes and planner call counts as ruled rows', () => {
    render(<ModesSection />);

    const section = screen.getByRole('region', { name: 'Modes' });
    const table = within(section).getByRole('table');
    const expectedModes = [
      ['instant', '1', 'none', 'tasks.md'],
      ['quick', '1', 'none', 'tasks.md'],
      ['standard', '4', 'spec', 'research, spec.md, plan.md, tasks.md'],
      [
        'speckit',
        '6–7',
        'all',
        'research, spec.md, clarifications.md, constitution-check.json, plan.md, tasks.md, analyze.json',
      ],
    ] as const;

    expect(within(table).getByRole('columnheader', { name: 'Planner calls' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Default approval' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Artifacts' })).toBeVisible();
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    for (const [name, plannerCalls, approval, artifacts] of expectedModes) {
      const row = within(table).getByRole('row', {
        name: `${name} ${plannerCalls} ${approval} ${artifacts}`,
      });
      expect(within(row).getByRole('rowheader', { name })).toBeVisible();
      expect(within(row).getByRole('cell', { name: plannerCalls })).toBeVisible();
      expect(within(row).getByRole('cell', { name: approval })).toBeVisible();
      expect(within(row).getByRole('cell', { name: artifacts })).toBeVisible();
    }
    expect(
      within(section).getByText(
        'Counts assume a clean run. Regeneration, clarifications, retries, and escalation add calls.',
      ),
    ).toBeVisible();
    expect(within(section).getByText(/pause for briefs review before/)).toBeVisible();
  });
});
