import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORDMARK_TIERS } from './wordmark.js';
import { Hero } from './hero.js';

const COMPACT_LOGO_ROWS = [
  ' ___      _ _ _   _        _      __',
  '/ __|_ __| (_) |_| |__ _ _(_)___ / _|',
  "\\__ \\ '_ \\ | |  _| '_ \\ '_| / -_)  _|",
  '|___/ .__/_|_|\\__|_.__/_| |_\\___|_|',
  '    |_|',
] as const;

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

  it('renders the instrument face: headline, wordmark legend, built CTA, and the matrix', () => {
    render(<Hero />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Patch your planner into your implementer.',
      }),
    ).toBeVisible();
    expect(screen.getByText('The Task Brief is the signal between them.')).toBeVisible();
    expect(screen.getByText('open source · MIT · runs in your terminal')).toBeVisible();
    expect(screen.getByText('SPLITBRIEF')).toBeVisible();

    const wordmark = screen.getByRole('img', { name: 'splitbrief' });
    expect(wordmark).toBeVisible();
    expect(WORDMARK_TIERS.compact).toEqual(COMPACT_LOGO_ROWS);
    expect(wordmark.textContent).toBe(COMPACT_LOGO_ROWS.join('\n'));

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

  it('mounts the pairing matrix with its emitted config inside the hero', () => {
    render(<Hero />);

    expect(
      screen.getByText(
        'Six planners × six implementers. Every crossing emits a complete, schema-valid config.',
      ),
    ).toBeVisible();
    const matrix = screen.getByRole('region', { name: 'Planner and implementer pairing' });
    expect(
      within(matrix).getByRole('grid', { name: 'Planner × implementer pairings' }),
    ).toBeInTheDocument();
    expect(within(matrix).getByRole('figure', { name: 'Generated config' })).toBeInTheDocument();
  });

  it('colors the two role claims with the duality and nothing else', () => {
    const { container } = render(<Hero />);

    expect(container.querySelector('.hero__accent-planner')?.textContent).toBe('your planner');
    expect(container.querySelector('.hero__accent-implementer')?.textContent).toBe(
      'your implementer',
    );
  });
});
