import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeText as Text, ThemeProvider, defaultTheme } from './theme.js';
import { paint } from '../core/theme/paint.js';
import { resolveTheme } from '../core/theme/resolve.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { TextSpans } from './text-spans.js';

const originalColorLevel = chalk.level;

afterEach(() => {
  chalk.level = originalColorLevel;
});

describe('TextSpans', () => {
  it.each(['dark', 'light'] as const)(
    'renders explicit primary, secondary and direct colours in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <Text color={theme.textDim}>
            <TextSpans
              parts={[
                { text: 'Primary', tone: 'text' },
                { text: ' secondary', tone: 'textDim' },
                { text: ' direct', color: theme.warning },
              ]}
            />
          </Text>
        </ThemeProvider>,
      );
      const frame = ui.lastFrame();
      expect(frame).toContain(paint(theme.text, 'Primary').replace('\u001b[39m', ''));
      expect(frame).toContain(paint(theme.textDim, ' secondary').replace('\u001b[39m', ''));
      expect(frame).toContain(paint(theme.warning, ' direct'));
      ui.unmount();
    },
  );

  it('keeps a bold seat word and a dim separator in separate spans', () => {
    chalk.level = 3;
    const ui = renderFeature(
      <Text>
        <TextSpans
          parts={[
            { text: 'Review', tone: 'reviewer', bold: true },
            { text: ' · ', tone: 'textDim' },
            { text: 'working', tone: 'textDim' },
          ]}
        />
      </Text>,
    );
    expect(ui.lastFrame()).toContain(
      chalk.bold(paint(defaultTheme.reviewer, 'Review')).replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(paint(defaultTheme.textDim, ' · working'));
    ui.unmount();
  });

  it('selects primary text while keeping seat and state colours', () => {
    chalk.level = 3;
    const ui = renderFeature(
      <Text>
        <TextSpans
          selected
          parts={[
            { text: 'Retry ', tone: 'text' },
            { text: 'BUILD', tone: 'implementer' },
            { text: ' failed', tone: 'error' },
          ]}
        />
      </Text>,
    );
    for (const [text, tone] of [
      ['Retry ', 'accent'],
      ['BUILD', 'implementer'],
      [' failed', 'error'],
    ] as const) {
      expect(ui.lastFrame()).toContain(paint(defaultTheme[tone], text).replace('\u001b[39m', ''));
    }
    ui.unmount();
  });
});
