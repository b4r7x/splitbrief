import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECTION, IMPLEMENTER_JACKS, PLANNER_JACKS } from '../matrix/pairings.js';
import { WORDMARK_TIERS } from '../wordmark.js';
import { TerminalEntrance } from './terminal.js';
import { CYCLE_PAIRINGS, PAIRING_CYCLE_MS } from './use-pairing-cycle.js';

function installMatchMedia(reducedMotion: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string): MediaQueryList => {
      const events = new EventTarget();

      return {
        matches: query === '(prefers-reduced-motion: reduce)' ? reducedMotion : true,
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

function advanceOneCycle(): void {
  act(() => {
    vi.advanceTimersByTime(PAIRING_CYCLE_MS);
  });
}

describe('TerminalEntrance', () => {
  beforeEach(() => {
    installMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('cycles only over pairings the patch field can actually emit', () => {
    expect(CYCLE_PAIRINGS[0]).toEqual(DEFAULT_SELECTION);
    expect(new Set(CYCLE_PAIRINGS.map((pairing) => pairing.plannerId)).size).toBe(
      CYCLE_PAIRINGS.length,
    );
    expect(new Set(CYCLE_PAIRINGS.map((pairing) => pairing.implementerId)).size).toBe(
      CYCLE_PAIRINGS.length,
    );

    for (const { plannerId, implementerId } of CYCLE_PAIRINGS) {
      expect(PLANNER_JACKS[plannerId]).toBeDefined();
      expect(IMPLEMENTER_JACKS[implementerId]).toBeDefined();
    }
  });

  it('recreates the entrance rows: faceplate, both wordmark tiers, sessions, hints', () => {
    const { container } = render(<TerminalEntrance />);

    expect(screen.getByText('~ % splitbrief')).toBeVisible();
    expect(screen.getByText('html recreation')).toBeVisible();

    const tiers = screen.getAllByRole('img', { name: 'splitbrief' });
    expect(tiers.map((tier) => tier.textContent)).toEqual([
      WORDMARK_TIERS.full.join('\n'),
      WORDMARK_TIERS.compact.join('\n'),
    ]);

    expect(screen.getByText('Recent sessions')).toBeVisible();
    expect(screen.getByText('No recent sessions')).toBeVisible();
    expect(screen.getByText('/help · /settings · /skills · ctrl+k commands')).toBeVisible();
    expect(container.querySelector('.terminal__caret')).toBeInTheDocument();
  });

  it('opens on the pre-seated pairing and advances one crossing every cycle', () => {
    vi.useFakeTimers();
    const { container } = render(<TerminalEntrance />);

    const line = container.querySelector('.terminal__pairing');
    expect(line?.textContent).toBe('Claude Code · Ollama > qwen3-coder:30b · standard');

    advanceOneCycle();
    expect(line?.textContent).toBe('Codex · LM Studio > qwen2.5-coder-7b · standard');

    advanceOneCycle();
    advanceOneCycle();
    advanceOneCycle();
    expect(line?.textContent).toBe(
      'Anthropic > claude-opus-4-6 · OpenRouter > anthropic/claude-sonnet-4.6 · standard',
    );
  });

  it('holds the pre-seated pairing under reduced motion', () => {
    vi.useFakeTimers();
    installMatchMedia(true);
    const { container } = render(<TerminalEntrance />);

    const line = container.querySelector('.terminal__pairing');
    advanceOneCycle();
    advanceOneCycle();

    expect(line?.textContent).toBe('Claude Code · Ollama > qwen3-coder:30b · standard');
  });

  it('stops cycling while the document is hidden', () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { container } = render(<TerminalEntrance />);

    const line = container.querySelector('.terminal__pairing');
    advanceOneCycle();
    expect(line?.textContent).toBe('Claude Code · Ollama > qwen3-coder:30b · standard');

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    advanceOneCycle();
    expect(line?.textContent).toBe('Codex · LM Studio > qwen2.5-coder-7b · standard');

    hidden.mockRestore();
  });

  it('sends a real Enter to the patch field and yields the block cursor to typing', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const target = document.createElement('section');
    target.id = 'patch-field';
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);

    const { container } = render(<TerminalEntrance />);
    const input = screen.getByRole('textbox', {
      name: 'Command entry — press Enter to jump to the patch field',
    });

    await user.type(input, 'patch');
    expect(container.querySelector('.terminal__caret')).not.toBeInTheDocument();

    const form = container.querySelector('form');
    if (!(form instanceof HTMLFormElement)) throw new Error('Composer form is missing');
    form.requestSubmit();

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    target.remove();
  });
});
