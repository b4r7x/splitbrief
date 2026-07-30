/// <reference types="@chialab/vitest-axe/matchers" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import matchers from '@chialab/vitest-axe';
import { render, screen } from '@testing-library/react';
import { run as axe } from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundSurface, OpenGraphSurface } from './metadata-surfaces.js';

expect.extend(matchers);

describe('metadata surfaces', () => {
  it('offers an accessible recovery path from the 404 face', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<NotFoundSurface />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'No signal at this address.',
    );
    expect(screen.getByRole('img', { name: 'splitbrief' })).toBeVisible();
    expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /docs/i })).toHaveAttribute(
      'href',
      '/docs/getting-started/introduction',
    );
    expect(container.firstElementChild).toHaveAttribute('data-theme', 'dark');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the OG face to the frozen message and a single decorative pin', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<OpenGraphSurface />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Patch your planner into your implementer.',
    );
    expect(screen.getByText('The Task Brief is the signal between them.')).toBeVisible();
    expect(screen.getByRole('img', { name: 'splitbrief' })).toBeVisible();
    expect(container.querySelectorAll('.metadata-matrix-motif__cell')).toHaveLength(36);
    expect(container.querySelectorAll('.metadata-matrix-motif__cell--selected')).toHaveLength(1);
    expect(container).not.toHaveTextContent(/npm|cost|savings|ollama|anthropic/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('uses the shared token palette and fixes the OG capture geometry', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/features/landing/open-graph-surface.css'),
      'utf8',
    );

    expect(css).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(css).not.toMatch(/gradient/i);
    expect(css).toMatch(/\.metadata-og\s*\{[^}]*inline-size:\s*1200px;/s);
    expect(css).toMatch(/\.metadata-og\s*\{[^}]*block-size:\s*630px;/s);
  });
});
