import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { run as axe } from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PATCH_PULSE_MS } from './matrix-state.js';
import { MATRIX_DESKTOP_QUERY, REDUCED_MOTION_QUERY } from './matrix-media.js';
import { PairingMatrix } from './matrix.js';
import { DEFAULT_SELECTION, pairingYaml } from './pairings.js';

const INITIAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

type MediaDefaults = Readonly<{
  desktop?: boolean;
  reducedMotion?: boolean;
}>;

type MediaController = Readonly<{
  setDesktop: (matches: boolean) => void;
  setReducedMotion: (matches: boolean) => void;
}>;

function installMedia({
  desktop = true,
  reducedMotion = false,
}: MediaDefaults = {}): MediaController {
  const matchesByQuery = new Map<string, boolean>([
    [MATRIX_DESKTOP_QUERY, desktop],
    [REDUCED_MOTION_QUERY, reducedMotion],
  ]);
  const queryLists = new Map<string, Set<MediaQueryList>>();

  const matchMedia = vi.fn((query: string): MediaQueryList => {
    const eventTarget = new EventTarget();
    const queryList = {
      get matches() {
        return matchesByQuery.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    } as MediaQueryList;

    const lists = queryLists.get(query) ?? new Set<MediaQueryList>();
    lists.add(queryList);
    queryLists.set(query, lists);
    return queryList;
  });

  vi.stubGlobal('matchMedia', matchMedia);

  function setMatches(query: string, matches: boolean): void {
    matchesByQuery.set(query, matches);
    for (const queryList of queryLists.get(query) ?? []) {
      queryList.dispatchEvent(new Event('change'));
    }
  }

  return {
    setDesktop: (matches) => setMatches(MATRIX_DESKTOP_QUERY, matches),
    setReducedMotion: (matches) => setMatches(REDUCED_MOTION_QUERY, matches),
  };
}

function matrixCell(plannerId: string, implementerId: string): HTMLElement {
  const cell = document.querySelector(
    `[role="gridcell"][data-planner="${plannerId}"][data-implementer="${implementerId}"]`,
  );

  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Missing matrix cell for ${plannerId} × ${implementerId}`);
  }

  return cell;
}

function generatedYaml(): string {
  const code = screen.getByRole('figure', { name: 'Generated config' }).querySelector('code');
  if (!code) throw new Error('Generated config is missing its code element');
  return code.textContent ?? '';
}

function radio(jackId: string): HTMLInputElement {
  const input = document.querySelector(`input[type="radio"][data-jack-id="${jackId}"]`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing picker radio for ${jackId}`);
  }
  return input;
}

describe('PairingMatrix', () => {
  afterEach(() => {
    if (INITIAL_CLIPBOARD_DESCRIPTOR) {
      Object.defineProperty(navigator, 'clipboard', INITIAL_CLIPBOARD_DESCRIPTOR);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders one desktop layout, one empty status, and a non-live YAML region', async () => {
    installMedia();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const { container } = render(<PairingMatrix />);

    expect(screen.getByRole('grid', { name: 'Planner × implementer pairings' })).toBeVisible();
    expect(screen.queryAllByRole('radiogroup', { hidden: true })).toHaveLength(0);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(generatedYaml()).toBe(pairingYaml(DEFAULT_SELECTION));

    const output = screen.getByRole('figure', { name: 'Generated config' });
    expect(output.closest('[aria-live]')).toBeNull();
    expect(output.querySelector('[aria-live]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy generated configuration' })).toBeVisible();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('holds output and announcement until the 400ms patch pulse completes', () => {
    vi.useFakeTimers();
    installMedia();
    render(<PairingMatrix />);

    const nextSelection = { plannerId: 'codex', implementerId: 'deepseek' } as const;
    const controls = document.querySelector('.matrix__controls');
    const nextCell = matrixCell(nextSelection.plannerId, nextSelection.implementerId);

    fireEvent.click(nextCell);

    expect(nextCell).toHaveAttribute('aria-selected', 'true');
    expect(controls).toHaveAttribute('data-pulse', 'active');
    expect(controls).toHaveAttribute('data-pulse-variant', 'b');
    expect(generatedYaml()).toBe(pairingYaml(DEFAULT_SELECTION));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    act(() => vi.advanceTimersByTime(PATCH_PULSE_MS - 1));
    expect(generatedYaml()).toBe(pairingYaml(DEFAULT_SELECTION));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    act(() => vi.advanceTimersByTime(1));
    expect(controls).not.toHaveAttribute('data-pulse');
    expect(generatedYaml()).toBe(pairingYaml(nextSelection));
    expect(screen.getByRole('status')).toHaveTextContent('Config updated: codex × deepseek');
  });

  it('changes pin, output, and status together when reduced motion is requested', () => {
    installMedia({ reducedMotion: true });
    render(<PairingMatrix />);

    const nextSelection = { plannerId: 'opencode', implementerId: 'groq' } as const;
    const controls = document.querySelector('.matrix__controls');
    const nextCell = matrixCell(nextSelection.plannerId, nextSelection.implementerId);

    fireEvent.click(nextCell);

    expect(nextCell).toHaveAttribute('aria-selected', 'true');
    expect(controls).not.toHaveAttribute('data-pulse');
    expect(generatedYaml()).toBe(pairingYaml(nextSelection));
    expect(screen.getByRole('status')).toHaveTextContent('Config updated: opencode × groq');
  });

  it('preserves the pair while mounting only the layout for each side of 700px', async () => {
    const media = installMedia({ desktop: false, reducedMotion: true });
    render(
      <>
        <button type="button">Outside matrix</button>
        <PairingMatrix />
      </>,
    );

    expect(screen.queryAllByRole('grid', { hidden: true })).toHaveLength(0);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(2);

    fireEvent.click(radio('codex'));
    fireEvent.click(radio('deepseek'));
    expect(radio('codex')).toBeChecked();
    expect(radio('deepseek')).toBeChecked();
    radio('deepseek').focus();
    expect(radio('deepseek')).toHaveFocus();

    act(() => media.setDesktop(true));
    await waitFor(() => {
      expect(screen.getByRole('grid', { name: 'Planner × implementer pairings' })).toBeVisible();
    });
    expect(screen.queryAllByRole('radiogroup', { hidden: true })).toHaveLength(0);
    expect(matrixCell('codex', 'deepseek')).toHaveAttribute('aria-selected', 'true');
    expect(matrixCell('codex', 'deepseek')).toHaveFocus();

    act(() => media.setDesktop(false));
    await waitFor(() => {
      expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
    });
    expect(screen.queryAllByRole('grid', { hidden: true })).toHaveLength(0);
    expect(radio('codex')).toBeChecked();
    expect(radio('deepseek')).toBeChecked();
    expect(radio('deepseek')).toHaveFocus();

    const outside = screen.getByRole('button', { name: 'Outside matrix' });
    outside.focus();
    act(() => media.setDesktop(true));
    await waitFor(() => {
      expect(screen.getByRole('grid', { name: 'Planner × implementer pairings' })).toBeVisible();
    });
    expect(outside).toHaveFocus();

    const selectedCell = matrixCell('codex', 'deepseek');
    selectedCell.focus();
    fireEvent.keyDown(selectedCell, { key: 'ArrowRight' });
    expect(matrixCell('codex', 'groq')).toHaveFocus();
    expect(matrixCell('codex', 'groq')).toHaveAttribute('aria-selected', 'false');

    act(() => media.setDesktop(false));
    await waitFor(() => {
      expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
    });
    expect(radio('deepseek')).toBeChecked();
    expect(radio('deepseek')).toHaveFocus();
  });

  it('prerenders both CSS-exclusive first-paint layouts, then hydrates only one', async () => {
    installMedia({ desktop: false });
    const markup = renderToString(<PairingMatrix />);
    const container = document.createElement('div');
    container.innerHTML = markup;
    document.body.append(container);

    const prerender = container.querySelector('[data-matrix-prerender]');
    expect(prerender).not.toBeNull();
    expect(container.querySelector('.matrix__controls')).toHaveAttribute('inert');
    expect(
      prerender?.querySelectorAll('[data-matrix-layout="desktop"], [data-matrix-layout="mobile"]'),
    ).toHaveLength(2);

    const recoverableErrors: unknown[] = [];
    const root = hydrateRoot(container, <PairingMatrix />, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });

    await waitFor(() => {
      expect(container.querySelector('[data-matrix-prerender]')).toBeNull();
      expect(container.querySelectorAll('[data-matrix-layout="mobile"]')).toHaveLength(1);
    });

    expect(container.querySelectorAll('[data-matrix-layout="desktop"]')).toHaveLength(0);
    expect(container.querySelector('.matrix__controls')).not.toHaveAttribute('inert');
    expect(recoverableErrors).toEqual([]);

    act(() => root.unmount());
    container.remove();
  });

  it('copies the exact runnable YAML and exposes feedback on the action itself', async () => {
    installMedia();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<PairingMatrix />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy generated configuration' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(pairingYaml(DEFAULT_SELECTION));
      expect(screen.getByRole('button', { name: 'Configuration copied' })).toBeVisible();
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(
      within(screen.getByRole('figure', { name: 'Generated config' })).getByText('[ copied ]'),
    ).toBeVisible();
  });
});
