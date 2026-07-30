import { useHydrated } from '@tanstack/react-router';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { useEffect, useRef } from 'react';
import { DOCS_PAGE_COUNT } from '../../docs-page-count.js';
import './search-dialog.css';

const searchClient = {
  deps: [],
  async search(query: string) {
    const { searchSimpleIndex } = await import('./simple-search-client.js');
    return searchSimpleIndex(query);
  },
};

function plainSearchText(value: string): string {
  return value.replaceAll('<mark>', '').replaceAll('</mark>', '');
}

export function SearchDialog() {
  const hydrated = useHydrated();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { query, search, setSearch } = useDocsSearch({
    client: searchClient,
    delayMs: 150,
  });

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        triggerRef.current?.click();
      }
    }

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  function openDialog() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    inputRef.current?.focus();
  }

  function handleClose() {
    setSearch('');
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
  }

  return (
    <div className="docs-search">
      <button
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        className="docs-search__trigger"
        disabled={!hydrated}
        onClick={openDialog}
        ref={triggerRef}
        type="button"
      >
        <span>Search</span>
        <span aria-hidden="true" className="docs-search__shortcut">
          ⌘K
        </span>
      </button>

      <dialog
        aria-labelledby="docs-search-title"
        className="docs-search__dialog"
        onCancel={(event) => {
          event.preventDefault();
          dialogRef.current?.close();
        }}
        onClose={handleClose}
        ref={dialogRef}
      >
        <div className="docs-search__header">
          <div>
            <p className="docs-search__signal" aria-hidden="true">
              Index / {DOCS_PAGE_COUNT} pages
            </p>
            <h2 id="docs-search-title">Search documentation</h2>
          </div>
          <button
            aria-label="Close documentation search"
            className="docs-search__close"
            onClick={() => dialogRef.current?.close()}
            type="button"
          >
            [ close ]
          </button>
        </div>

        <label className="docs-search__field">
          <span>Query</span>
          <input
            autoComplete="off"
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;

              event.preventDefault();
              event.stopPropagation();
              dialogRef.current?.close();
            }}
            placeholder="Task Brief, runners, recovery…"
            ref={inputRef}
            type="search"
            value={search}
          />
        </label>

        <div className="docs-search__results">
          {query.isLoading ? <p role="status">Searching the patch index…</p> : null}

          {!query.isLoading && query.error ? (
            <p className="docs-search__message docs-search__message--error" role="alert">
              Search is unavailable. Try again.
            </p>
          ) : null}

          {!query.isLoading && !query.error && query.data === 'empty' ? (
            <p className="docs-search__message">
              {search.trim().length === 0
                ? 'Type a page title or topic.'
                : `No results for “${search.trim()}”.`}
            </p>
          ) : null}

          {!query.isLoading &&
          !query.error &&
          query.data !== 'empty' &&
          query.data !== undefined &&
          query.data.length === 0 ? (
            <p className="docs-search__message">No results for “{search.trim()}”.</p>
          ) : null}

          {!query.isLoading &&
          !query.error &&
          query.data !== 'empty' &&
          query.data !== undefined &&
          query.data.length > 0 ? (
            <ul aria-label="Search results" className="docs-search__list">
              {query.data.map((result) => {
                const content = plainSearchText(result.content);
                const breadcrumbs = result.breadcrumbs?.map(plainSearchText).join(' / ');

                return (
                  <li key={result.id}>
                    <a
                      aria-label={breadcrumbs ? `${content} — ${breadcrumbs}` : content}
                      className="docs-search__result"
                      href={result.url}
                    >
                      <span className="docs-search__result-content">{content}</span>
                      {breadcrumbs ? (
                        <span className="docs-search__breadcrumbs">{breadcrumbs}</span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}
