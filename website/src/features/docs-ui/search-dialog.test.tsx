/// <reference types="@chialab/vitest-axe/matchers" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import matchers from '@chialab/vitest-axe';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { run as axe } from 'axe-core';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchDialog } from './search-dialog.js';

const searchMocks = vi.hoisted(() => ({
  searchSimpleIndex: vi.fn(),
  setSearch: vi.fn(),
  useDocsSearch: vi.fn(),
}));

vi.mock('fumadocs-core/search/client', () => ({
  useDocsSearch: searchMocks.useDocsSearch,
}));

vi.mock('./simple-search-client.js', () => ({
  searchSimpleIndex: searchMocks.searchSimpleIndex,
}));

expect.extend(matchers);

const CLOSE_DESCRIPTOR = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const SHOW_MODAL_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal',
);

function installDialogMethods() {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    }),
  });
}

function restoreDialogMethods() {
  if (SHOW_MODAL_DESCRIPTOR) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', SHOW_MODAL_DESCRIPTOR);
  } else {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  }
  if (CLOSE_DESCRIPTOR) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', CLOSE_DESCRIPTOR);
  } else {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  }
}

function openSearchDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

function useStatefulSearchMock() {
  const [search, setSearch] = useState('');

  return {
    query: { data: 'empty' as const, error: undefined, isLoading: false },
    search,
    setSearch,
  };
}

describe('SearchDialog', () => {
  beforeEach(() => {
    installDialogMethods();
    searchMocks.useDocsSearch.mockReturnValue({
      query: { data: 'empty', error: undefined, isLoading: false },
      search: '',
      setSearch: searchMocks.setSearch,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreDialogMethods();
    searchMocks.searchSimpleIndex.mockReset();
    searchMocks.setSearch.mockReset();
    searchMocks.useDocsSearch.mockReset();
  });

  it('opens from Cmd+K, focuses the query, and restores the prior focus on close', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before search</button>
        <SearchDialog />
      </>,
    );
    const beforeSearch = screen.getByRole('button', { name: 'Before search' });
    beforeSearch.focus();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    const dialog = screen.getByRole('dialog', { name: 'Search documentation' });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('searchbox')).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Close documentation search' }));

    expect(dialog).not.toHaveAttribute('open');
    expect(beforeSearch).toHaveFocus();
    expect(searchMocks.setSearch).toHaveBeenCalledWith('');
  });

  it('supports Ctrl+K and updates the official search hook from the input', async () => {
    const user = userEvent.setup();
    searchMocks.useDocsSearch.mockImplementation(useStatefulSearchMock);
    render(<SearchDialog />);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const searchbox = screen.getByRole('searchbox');
    await user.type(searchbox, 'recovery');

    expect(searchbox).toHaveValue('recovery');
    expect(searchMocks.useDocsSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({ deps: [] }),
        delayMs: 150,
      }),
    );
  });

  it('loads the static search engine only when the search hook submits a query', async () => {
    render(<SearchDialog />);

    expect(searchMocks.searchSimpleIndex).not.toHaveBeenCalled();
    const options = searchMocks.useDocsSearch.mock.calls[0]?.[0];
    if (!options || typeof options.client?.search !== 'function') {
      throw new Error('Expected a deferred search client');
    }

    await options.client.search('recovery');

    expect(searchMocks.searchSimpleIndex).toHaveBeenCalledWith('recovery');
  });

  it('closes a populated search on the first Escape and restores focus', async () => {
    const user = userEvent.setup();
    searchMocks.useDocsSearch.mockImplementation(useStatefulSearchMock);
    render(
      <>
        <button type="button">Before search</button>
        <SearchDialog />
      </>,
    );
    const beforeSearch = screen.getByRole('button', { name: 'Before search' });
    beforeSearch.focus();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Search documentation' });
    const searchbox = screen.getByRole('searchbox');
    await user.type(searchbox, 'recovery');
    await user.keyboard('{Escape}');

    expect(dialog).not.toHaveAttribute('open');
    expect(searchbox).toHaveValue('');
    expect(beforeSearch).toHaveFocus();
  });

  it('renders loading, error, and empty states explicitly', () => {
    searchMocks.useDocsSearch.mockReturnValue({
      query: { data: 'empty', error: new Error('stale error'), isLoading: true },
      search: 'task',
      setSearch: searchMocks.setSearch,
    });
    const { rerender } = render(<SearchDialog />);
    openSearchDialog();
    expect(screen.getByRole('status')).toHaveTextContent('Searching the patch index…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    searchMocks.useDocsSearch.mockReturnValue({
      query: { data: undefined, error: new Error('index unavailable'), isLoading: false },
      search: 'task',
      setSearch: searchMocks.setSearch,
    });
    rerender(<SearchDialog />);
    expect(screen.getByRole('alert')).toHaveTextContent('Search is unavailable. Try again.');

    searchMocks.useDocsSearch.mockReturnValue({
      query: { data: [], error: undefined, isLoading: false },
      search: 'missing',
      setSearch: searchMocks.setSearch,
    });
    rerender(<SearchDialog />);
    expect(screen.getByText('No results for “missing”.')).toBeVisible();
  });

  it('renders highlighted content as inert plain text', () => {
    searchMocks.useDocsSearch.mockReturnValue({
      query: {
        data: [
          {
            breadcrumbs: ['Guides', '<mark>Safety</mark>'],
            content: '<mark>Recovery</mark> <img src=x onerror=alert(1)> uses <repo-map>',
            id: 'recovery',
            type: 'page',
            url: '/docs/concepts/approval-escalation-and-recovery',
          },
        ],
        error: undefined,
        isLoading: false,
      },
      search: 'recovery',
      setSearch: searchMocks.setSearch,
    });
    render(<SearchDialog />);
    openSearchDialog();

    const result = screen.getByRole('link', {
      name: 'Recovery <img src=x onerror=alert(1)> uses <repo-map> — Guides / Safety',
    });
    expect(result).toHaveTextContent('Recovery <img src=x onerror=alert(1)> uses <repo-map>');
    expect(result).toHaveTextContent('Guides / Safety');
    expect(result.querySelector('mark')).toBeNull();
    expect(result.querySelector('img')).toBeNull();
    expect(result).not.toContainHTML('<mark>');
  });

  it('passes axe and keeps every search control at the 44px target contract', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = render(<SearchDialog />);
    const css = readFileSync(
      resolve(process.cwd(), 'src/features/docs-ui/search-dialog.css'),
      'utf8',
    );
    openSearchDialog();

    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    expect(css).toMatch(
      /\.docs-search__trigger,\s*\.docs-search__close\s*\{[^}]*min-block-size:\s*2\.75rem/s,
    );
    expect(css).toMatch(/\.docs-search__field input\s*\{[^}]*min-block-size:\s*2\.75rem/s);
    expect(css).toMatch(/\.docs-search__result\s*\{[^}]*min-block-size:\s*2\.75rem/s);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(css).not.toMatch(/gradient/i);
  });
});
