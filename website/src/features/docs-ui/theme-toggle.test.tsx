/// <reference types="@chialab/vitest-axe/matchers" />

import matchers from '@chialab/vitest-axe';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { run as axe } from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCS_THEME_STORAGE_KEY, initializeDocsTheme, synchronizeDocsTheme } from './docs-theme.js';
import { ThemeToggle } from './theme-toggle.js';

expect.extend(matchers);

function navigate(pathname: string): void {
  window.history.replaceState({}, '', pathname);
}

describe('ThemeToggle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    localStorage.clear();
    navigate('/');
    synchronizeDocsTheme('/');
  });

  it('persists changes and adopts valid storage events', async () => {
    const user = userEvent.setup();
    navigate('/docs/getting-started/introduction');
    synchronizeDocsTheme(window.location.pathname);
    render(<ThemeToggle />);

    const toggle = screen.getByRole('button', {
      name: 'Theme: dark. Switch to light.',
    });
    await user.click(toggle);

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem(DOCS_THEME_STORAGE_KEY)).toBe('light');
    expect(toggle).toHaveAccessibleName('Theme: light. Switch to dark.');

    localStorage.setItem(DOCS_THEME_STORAGE_KEY, 'dark');
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: DOCS_THEME_STORAGE_KEY,
          newValue: 'dark',
        }),
      );
    });

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(toggle).toHaveAccessibleName('Theme: dark. Switch to light.');
  });

  it('keeps server and hydration markup stable before adopting stored light', async () => {
    navigate('/docs/concepts/task-briefs');
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, 'light');

    const serverMarkup = renderToString(<ThemeToggle />);
    expect(serverMarkup).toContain('>dark<');
    expect(serverMarkup).toContain('disabled=""');

    const container = document.createElement('div');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    initializeDocsTheme(DOCS_THEME_STORAGE_KEY);

    const onRecoverableError = vi.fn();
    const root = hydrateRoot(container, <ThemeToggle />, { onRecoverableError });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Theme: light. Switch to dark.' }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Theme: light. Switch to dark.' })).toBeEnabled();
    expect(onRecoverableError).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });

  it('continues in memory when persistence is blocked', async () => {
    const user = userEvent.setup();
    navigate('/docs');
    synchronizeDocsTheme(window.location.pathname);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage denied');
    });
    render(<ThemeToggle />);

    await user.click(
      screen.getByRole('button', {
        name: 'Theme: dark. Switch to light.',
      }),
    );

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(
      screen.getByRole('button', {
        name: 'Theme: light. Switch to dark.',
      }),
    ).toBeInTheDocument();
  });

  it('has no automated accessibility violations', async () => {
    navigate('/docs');
    synchronizeDocsTheme(window.location.pathname);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(
      <div className="docs-shell">
        <ThemeToggle />
      </div>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
