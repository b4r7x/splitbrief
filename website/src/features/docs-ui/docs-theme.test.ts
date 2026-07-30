import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCS_THEME_INIT_SCRIPT,
  DOCS_THEME_STORAGE_KEY,
  initializeDocsTheme,
  synchronizeDocsTheme,
} from './docs-theme.js';

const ROOT_ROUTE_SOURCE = readFileSync(resolve(process.cwd(), 'src/routes/__root.tsx'), 'utf8');

function navigate(pathname: string): void {
  window.history.replaceState({}, '', pathname);
}

describe('docs theme store', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    localStorage.clear();
    navigate('/');
    synchronizeDocsTheme('/');
  });

  it.each(['dark', 'light'] as const)('restores the stored %s theme on docs routes', (theme) => {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, theme);

    navigate('/docs/getting-started/introduction');
    synchronizeDocsTheme(window.location.pathname);

    expect(document.documentElement).toHaveAttribute('data-theme', theme);
  });

  it.each([null, '', 'auto', 'LIGHT'])('defaults invalid stored value %s to dark', (stored) => {
    if (stored !== null) localStorage.setItem(DOCS_THEME_STORAGE_KEY, stored);

    navigate('/docs');
    synchronizeDocsTheme(window.location.pathname);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('scopes the preference to docs and restores it after client navigation', () => {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, 'light');

    navigate('/docs/concepts/task-briefs');
    synchronizeDocsTheme(window.location.pathname);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    navigate('/');
    synchronizeDocsTheme(window.location.pathname);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(DOCS_THEME_STORAGE_KEY)).toBe('light');

    navigate('/docs/guides/cookbook');
    synchronizeDocsTheme(window.location.pathname);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('applies the allowlisted docs preference during pre-paint initialization', () => {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, 'light');
    navigate('/docs/reference/configuration');

    initializeDocsTheme(DOCS_THEME_STORAGE_KEY);

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(DOCS_THEME_INIT_SCRIPT).toContain(JSON.stringify(DOCS_THEME_STORAGE_KEY));
  });

  it('forces dark during pre-paint initialization outside docs', () => {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, 'light');
    navigate('/');

    initializeDocsTheme(DOCS_THEME_STORAGE_KEY);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('does not treat neighboring paths as docs routes', () => {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, 'light');
    navigate('/documentation');

    initializeDocsTheme(DOCS_THEME_STORAGE_KEY);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('resets a stale preference when storage becomes unavailable', () => {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, 'light');
    navigate('/docs');
    synchronizeDocsTheme(window.location.pathname);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    navigate('/');
    synchronizeDocsTheme(window.location.pathname);
    navigate('/docs');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied');
    });

    synchronizeDocsTheme(window.location.pathname);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('keeps the dark pre-paint default when storage is unavailable', () => {
    navigate('/docs');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied');
    });

    initializeDocsTheme(DOCS_THEME_STORAGE_KEY);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('places the SSR-only initializer before head assets with a guarded html root', () => {
    const scriptIndex = ROOT_ROUTE_SOURCE.indexOf(
      '<ScriptOnce>{DOCS_THEME_INIT_SCRIPT}</ScriptOnce>',
    );
    const headContentIndex = ROOT_ROUTE_SOURCE.indexOf('<HeadContent />');

    expect(scriptIndex).toBeGreaterThan(-1);
    expect(scriptIndex).toBeLessThan(headContentIndex);
    expect(ROOT_ROUTE_SOURCE).toContain(
      '<html data-theme="dark" lang="en" suppressHydrationWarning>',
    );
  });
});
