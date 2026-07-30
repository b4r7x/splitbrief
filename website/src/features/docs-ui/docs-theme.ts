import { useSyncExternalStore } from 'react';

export type DocsTheme = 'dark' | 'light';

export const DOCS_THEME_STORAGE_KEY = 'splitbrief-docs-theme';

const DEFAULT_THEME: DocsTheme = 'dark';
const listeners = new Set<() => void>();

let effectiveTheme: DocsTheme = DEFAULT_THEME;
let storageListening = false;

function isTheme(value: string | null): value is DocsTheme {
  return value === 'dark' || value === 'light';
}

function isDocsPath(pathname: string): boolean {
  return pathname === '/docs' || pathname.startsWith('/docs/');
}

function readStoredTheme(): DocsTheme {
  try {
    const stored = localStorage.getItem(DOCS_THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyEffectiveTheme(theme: DocsTheme): void {
  document.documentElement.setAttribute('data-theme', theme);
  if (effectiveTheme === theme) return;

  effectiveTheme = theme;
  for (const listener of listeners) listener();
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== DOCS_THEME_STORAGE_KEY) return;

  const theme = isTheme(event.newValue) ? event.newValue : DEFAULT_THEME;
  applyEffectiveTheme(isDocsPath(window.location.pathname) ? theme : DEFAULT_THEME);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (!storageListening) {
    window.addEventListener('storage', handleStorage);
    storageListening = true;
  }

  synchronizeDocsTheme(window.location.pathname);

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;

    window.removeEventListener('storage', handleStorage);
    storageListening = false;
  };
}

function getSnapshot(): DocsTheme {
  return effectiveTheme;
}

function getServerSnapshot(): DocsTheme {
  return DEFAULT_THEME;
}

export function initializeDocsTheme(storageKey: string): void {
  const pathname = window.location.pathname;
  let theme: DocsTheme = 'dark';

  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === 'dark' || stored === 'light') theme = stored;
    } catch {
      // A locked-down browser keeps the dark server default.
    }
  }

  document.documentElement.setAttribute('data-theme', theme);
}

export const DOCS_THEME_INIT_SCRIPT = `(${initializeDocsTheme.toString()})(${JSON.stringify(
  DOCS_THEME_STORAGE_KEY,
)});`;

export function synchronizeDocsTheme(pathname: string): void {
  applyEffectiveTheme(isDocsPath(pathname) ? readStoredTheme() : DEFAULT_THEME);
}

export function setDocsTheme(theme: DocsTheme): void {
  try {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies to the current render.
  }

  applyEffectiveTheme(isDocsPath(window.location.pathname) ? theme : DEFAULT_THEME);
}

export function useDocsTheme(): DocsTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
