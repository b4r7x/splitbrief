/// <reference types="@chialab/vitest-axe/matchers" />

import matchers from '@chialab/vitest-axe';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { run as axe } from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemDemo } from './demo.js';

expect.extend(matchers);

describe('DesignSystemDemo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders both instrument faces as one keyboard-navigable page', async () => {
    const user = userEvent.setup();

    render(<DesignSystemDemo />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2);
    expect(screen.getAllByRole('table', { name: 'Functional routing grid' })).toHaveLength(2);
    expect(screen.getByLabelText('Dark landing token tier')).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByLabelText('Light docs token tier')).toHaveAttribute('data-theme', 'light');
    expect(
      screen.getAllByText('Spec › Plan › Briefs → Build → Verify', { selector: 'code' }),
    ).toHaveLength(2);

    await user.tab();

    expect(screen.getByRole('link', { name: 'Trace dark output' })).toHaveFocus();
  });

  it('has no automated accessibility violations', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const { container } = render(<DesignSystemDemo />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
