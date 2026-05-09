import { describe, expect, it } from 'vitest';
import { getTheme } from './theme.js';

describe('theme', () => {
  it('keeps terminal panel backgrounds transparent but gives suggestion overlays an opaque color', () => {
    const theme = getTheme('terminal');

    expect(theme.panelBg).toBeUndefined();
    expect(theme.suggestionPanelBg).toBe('#24283b');
  });

  it('uses the mono panel color for mono suggestion overlays', () => {
    const theme = getTheme('mono');

    expect(theme.suggestionPanelBg).toBe(theme.panelBg);
  });
});
