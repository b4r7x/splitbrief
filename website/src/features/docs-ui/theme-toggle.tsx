import { useHydrated } from '@tanstack/react-router';
import { setDocsTheme, useDocsTheme } from './docs-theme.js';
import './theme-toggle.css';

export function ThemeToggle() {
  const hydrated = useHydrated();
  const theme = useDocsTheme();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}
      className="docs-theme-toggle"
      disabled={!hydrated}
      onClick={() => setDocsTheme(nextTheme)}
      type="button"
    >
      <span className="docs-theme-toggle__legend">Theme</span>
      <span className="docs-theme-toggle__value">{theme}</span>
      <span aria-hidden="true" className="docs-theme-toggle__jacks">
        <span className="docs-theme-toggle__jack docs-theme-toggle__jack--planner" />
        <span className="docs-theme-toggle__jack docs-theme-toggle__jack--implementer" />
      </span>
    </button>
  );
}
