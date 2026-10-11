import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { paint } from '../../../core/theme/paint.js';
import { CREW_LABEL_WIDTH, formatCollapsedSeatSpans } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES, deriveCrewSeats } from '../../../core/crew/seats.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { configStore } from '../../../stores/project/config.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { detectionStore } from '../../../stores/project/detection.js';
import type { Config } from '../../../core/schemas/config.js';
import { HomeSeatBlock } from './seat-block.js';

const DISCOVERY_CONTEXTS = {
  readiness: 'seat-block:readiness',
  modelsDev: 'seat-block:models-dev',
  cliModels: 'seat-block:cli-models',
};

const WIDTH = 76;
const originalColorLevel = chalk.level;

function seed(config: Config = makeConfig()): void {
  configStore.__testReset({ config, projectDir: '/tmp/home-seat-block-test' });
}

/** A discovery result has landed once: `fetchedAt` is what makes the seats warm. */
function warmDiscovery(): void {
  detectionStore.hydrate({
    providers: [],
    cliTools: [],
    fetchedAt: 100,
    validatedAt: 100,
    generation: 1,
    requestId: 1,
    contexts: DISCOVERY_CONTEXTS,
  });
}

async function renderBlock(
  rows: number,
  width = WIDTH,
): Promise<{ lines: string[]; unmount: () => void }> {
  const ui = renderFeature(<HomeSeatBlock rows={rows} width={width} />, { cols: 120, rows });
  await tick(20);
  const lines = stripAnsiStyles(ui.lastFrame() ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return { lines, unmount: () => ui.unmount() };
}

describe('HomeSeatBlock', () => {
  beforeEach(() => {
    resetAllStores();
    seed();
    warmDiscovery();
  });

  afterEach(() => {
    chalk.level = originalColorLevel;
    resetAllStores();
  });

  it.each(['dark', 'light'] as const)(
    'dims collapsed seats until the first discovery result in %s',
    async (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      for (const cold of [false, true]) {
        resetAllStores();
        const config = makeConfig();
        seed(config);
        if (!cold) warmDiscovery();
        const ui = renderFeature(
          <ThemeProvider theme={theme}>
            <HomeSeatBlock rows={18} width={WIDTH} />
          </ThemeProvider>,
          { cols: 120, rows: 18 },
        );
        await tick(20);
        const spans = formatCollapsedSeatSpans({
          planner: config.planner,
          build: config.implementer,
          reviewer: undefined,
          budget: WIDTH - 2,
        });
        if (cold) {
          expect(ui.lastFrame()).toContain(
            paint(theme.textDim, spans.map((span) => span.text).join('')),
          );
        } else {
          for (const span of spans) {
            expect(ui.lastFrame()).toContain(
              paint(
                span.seat === undefined ? theme.textDim : theme[CREW_SEAT_ROLES[span.seat]],
                span.text,
              ).replace('\u001b[39m', ''),
            );
          }
        }
        ui.unmount();
      }
    },
  );

  it('names all three seats plus a status line and fits the given width', async () => {
    const { lines, unmount } = await renderBlock(40);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('PLAN');
    expect(lines[1]).toContain('BUILD');
    expect(lines[2]).toContain('REVIEW');
    expect(lines[2]).toContain('same as planner');
    expect(lines[3]).toContain('/crew to change');
    expect(lines[3]).not.toMatch(/\b(quick|standard|speckit)\b/);
    for (const line of lines) {
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(WIDTH);
    }
    unmount();
  });

  it.each(['dark', 'light'] as const)(
    'dims expanded seats until the first discovery result in %s',
    async (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      for (const cold of [false, true]) {
        resetAllStores();
        const config = makeConfig();
        seed(config);
        if (!cold) warmDiscovery();
        const ui = renderFeature(
          <ThemeProvider theme={theme}>
            <HomeSeatBlock rows={40} width={WIDTH} />
          </ThemeProvider>,
          { cols: 120, rows: 40 },
        );
        await tick(20);
        const frame = ui.lastFrame() ?? '';
        for (const seat of deriveCrewSeats({ config })) {
          const identity = seat.id === 'review' ? 'same as planner' : seat.model;
          if (cold) {
            expect(frame).toContain(
              chalk
                .bold(paint(theme.textDim, seat.label.padEnd(CREW_LABEL_WIDTH)))
                .replace('\u001b[39m', '') + `  ${identity}`,
            );
          } else {
            expect(frame).toContain(paint(theme[CREW_SEAT_ROLES[seat.id]], identity));
          }
        }
        expect(stripAnsiStyles(frame).includes('detecting')).toBe(cold);
        ui.unmount();
      }
    },
  );

  it.each([18, 40])(
    'warms the mounted seats once and keeps them warm during refresh at %s rows',
    async (rows) => {
      chalk.level = 3;
      resetAllStores();
      const config = makeConfig();
      seed(config);
      const ui = renderFeature(<HomeSeatBlock rows={rows} width={WIDTH} />, { cols: 120, rows });
      await tick(20);
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.textDim, 'PLAN').replace('\u001b[39m', ''),
      );
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('detecting');

      warmDiscovery();
      await tick(20);
      for (const seat of deriveCrewSeats({ config })) {
        expect(ui.lastFrame()).toContain(
          paint(defaultTheme[CREW_SEAT_ROLES[seat.id]], seat.label).replace('\u001b[39m', ''),
        );
      }
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('detecting');

      detectionStore.beginRefresh({ contexts: DISCOVERY_CONTEXTS });
      await tick(20);
      for (const seat of deriveCrewSeats({ config })) {
        expect(ui.lastFrame()).toContain(
          paint(defaultTheme[CREW_SEAT_ROLES[seat.id]], seat.label).replace('\u001b[39m', ''),
        );
      }
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('detecting');
      ui.unmount();
    },
  );

  it('collapses to one seat line plus the status line below 24 rows', async () => {
    const { lines, unmount } = await renderBlock(18);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('PLAN');
    expect(lines[0]).toContain('BUILD');
    expect(lines[0]).toContain('REVIEW');
    expect(lines[1]).toContain('/crew to change');
    unmount();
  });

  it('drops a whole identity from the collapsed line instead of cutting one', async () => {
    const width = 40;

    const { lines, unmount } = await renderBlock(18, width);

    expect(getTerminalCellWidth(lines[0] ?? '')).toBeLessThanOrEqual(width);
    expect(lines[0]).toContain('PLAN');
    expect(lines[0]).toContain('BUILD');
    // A seat that does not fit leaves the line rather than standing there unnamed, so no ellipsis
    // reaches the row at all.
    expect(lines[0]).not.toContain('…');
    unmount();
  });

  it('shows a configured reviewer its own identity instead of the inheritance sentence', async () => {
    seed(
      makeConfig({
        reviewer: {
          kind: 'api',
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
          model: 'custom-reasoner',
        },
      }),
    );

    const { lines, unmount } = await renderBlock(40);

    expect(lines[2]).toContain('custom-endpoint');
    expect(lines[2]).not.toContain('same as planner');
    unmount();
  });

  it('says it is still detecting tools without changing the row count', async () => {
    for (const rows of [24, 18]) {
      const warm = await renderBlock(rows);
      expect(warm.lines.join('\n')).not.toContain('detecting');
      warm.unmount();

      resetAllStores();
      seed();
      const cold = await renderBlock(rows);
      expect(cold.lines.join('\n')).toContain('detecting');
      expect(cold.lines).toHaveLength(warm.lines.length);
      cold.unmount();
      resetAllStores();
      seed();
      warmDiscovery();
    }
  });

  it('keeps the crew hint when the cold status line cannot fit the narrowest body', async () => {
    resetAllStores();
    seed();
    skillsStore.setSelected(new Set(Array.from({ length: 12 }, (_, i) => `skill-${i}`)));

    const { lines, unmount } = await renderBlock(18, 56);

    expect(lines[1]).toContain('/crew to change');
    expect(getTerminalCellWidth(lines[1] ?? '')).toBeLessThanOrEqual(56);
    expect(lines[1]).toContain('detecting');
    expect(lines[1]).not.toContain('12 skills');
    unmount();
  });
});
