/// <reference types="@chialab/vitest-axe/matchers" />

import matchers from '@chialab/vitest-axe';
import { render, screen, within } from '@testing-library/react';
import { run as axe } from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { RunnerKindsSection } from './runner-kinds.js';

expect.extend(matchers);

describe('RunnerKindsSection', () => {
  it('presents all 25 supported runner-kind crossings and qualifies the contract', () => {
    render(<RunnerKindsSection />);

    const section = screen.getByRole('region', { name: 'Runner kinds' });
    const tableScroll = within(section).getByRole('region', {
      name: 'Runner-kind crossing table',
    });
    const table = within(section).getByRole('table', {
      name: 'Planner and implementer runner-kind crossings',
    });

    expect(tableScroll).toHaveAttribute('tabindex', '0');
    expect(tableScroll).toContainElement(table);
    expect(within(section).getByText('Five supported runner kinds on either side.')).toBeVisible();
    expect(within(table).getAllByRole('rowheader')).toHaveLength(5);
    expect(within(table).getAllByRole('cell')).toHaveLength(25);
    expect(
      within(section).getByText(/Every kind-to-kind intersection can be expressed/),
    ).toBeVisible();
    expect(
      within(section).getByRole('link', {
        name: 'Read the planners and implementers guide.',
      }),
    ).toHaveAttribute('href', '/docs/guides/planners-and-implementers');
  });

  it('has no automated accessibility violations', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<RunnerKindsSection />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
