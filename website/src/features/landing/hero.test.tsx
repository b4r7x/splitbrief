import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hero } from './hero.js';

function installMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string): MediaQueryList => {
      const events = new EventTarget();

      return {
        matches: query === '(min-width: 700px)',
        media: query,
        onchange: null,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };
    }),
  );
}

describe('Hero', () => {
  beforeEach(() => {
    installMatchMedia();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the instrument face: headline, quiet sub-line, and a built CTA', () => {
    render(<Hero />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Patch any planner into any implementer.',
      }),
    ).toBeVisible();
    expect(screen.getByText('The Task Brief is the signal between them.')).toBeVisible();
    expect(screen.getByText('open source · MIT · runs in your terminal')).toBeVisible();
    expect(screen.getByText('SPLITBRIEF')).toBeVisible();

    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: '[ docs ]' })).toHaveAttribute(
      'href',
      '/docs/getting-started/introduction',
    );
    expect(within(nav).getByRole('link', { name: '[ github ]' })).toHaveAttribute(
      'href',
      'https://github.com/b4r7x/splitbrief',
    );

    const cta = screen.getByRole('link', { name: 'install from source' });
    expect(cta).toHaveAttribute('href', '#install');
    expect(cta).toHaveClass('hero__cta');
  });

  it('mounts the labeled entrance recreation and leaves the matrix to its own section', () => {
    const { container } = render(<Hero />);

    expect(screen.getByText('~ % splitbrief')).toBeVisible();
    expect(screen.getByText('html recreation')).toBeVisible();
    expect(container.querySelector('.terminal')).toBeInTheDocument();
    expect(container.querySelector('.matrix')).not.toBeInTheDocument();
  });

  it('colors the two role claims with the duality and nothing else', () => {
    const { container } = render(<Hero />);

    expect(container.querySelector('.hero__accent-planner')?.textContent).toBe('any planner');
    expect(container.querySelector('.hero__accent-implementer')?.textContent).toBe(
      'any implementer',
    );
  });
});
