import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from './site-footer.js';

describe('SiteFooter', () => {
  it('provides contextual project links without creating another navigation landmark', () => {
    render(<SiteFooter />);

    const footer = screen.getByRole('contentinfo');
    const expectedLinks = [
      ['Docs', '/docs/getting-started/introduction'],
      ['GitHub', 'https://github.com/b4r7x/splitbrief'],
      ['MIT', 'https://github.com/b4r7x/splitbrief/blob/main/LICENSE'],
      ['llms.txt', '/llms.txt'],
    ] as const;

    for (const [name, href] of expectedLinks) {
      expect(within(footer).getByRole('link', { name })).toHaveAttribute('href', href);
    }

    expect(within(footer).queryByRole('navigation')).not.toBeInTheDocument();
  });
});
