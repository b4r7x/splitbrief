import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { ThemeText as Text, useTheme } from '../components/theme.js';
import { resolveTheme } from '../core/theme/resolve.js';
import { terminalBackgroundStore } from '../stores/ui/terminal-background.js';
import { AppProvider } from './provider.js';

const initialLevel = chalk.level;
const mounted: ReturnType<typeof renderFeature>[] = [];

function ThemeReadout() {
  const theme = useTheme();
  return (
    <Text color={theme.textDim} backgroundColor={theme.suggestionPanelBg}>
      {theme.textDim ?? 'Native foreground'}
    </Text>
  );
}

function mount() {
  const ui = renderFeature(
    <AppProvider>
      <ThemeReadout />
    </AppProvider>,
  );
  mounted.push(ui);
  return ui;
}

beforeEach(() => {
  chalk.level = 3;
  vi.stubEnv('COLORFGBG', '0;15');
  terminalBackgroundStore.reset();
});

afterEach(() => {
  for (const ui of mounted.splice(0)) ui.unmount();
  terminalBackgroundStore.reset();
  chalk.level = initialLevel;
  vi.unstubAllEnvs();
});

describe('AppProvider terminal theme', () => {
  it('uses a light COLORFGBG before the background is detected', () => {
    expect(mount().lastFrame()).toContain('#454c59');
  });

  it('keeps the native foreground and unpainted surface on a light ANSI terminal', () => {
    chalk.level = 1;
    expect(mount().lastFrame()).toBe('Native foreground');
  });

  it('uses the detected background instead of COLORFGBG', async () => {
    const ui = mount();
    terminalBackgroundStore.detected('#5c5c5c');
    await tick(20);
    const expected = resolveTheme({ variant: 'dark', level: 3, terminalBackground: '#5c5c5c' });
    expect(ui.lastFrame()).toContain(expected.textDim);
  });
});
