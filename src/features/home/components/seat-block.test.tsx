import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    resetAllStores();
  });

  it('names all three seats plus a status line and fits the given width', async () => {
    const { lines, unmount } = await renderBlock(40);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('PLAN');
    expect(lines[1]).toContain('BUILD');
    expect(lines[2]).toContain('REVIEW');
    expect(lines[2]).toContain('same as planner');
    expect(lines[3]).toContain('/crew to change');
    for (const line of lines) {
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(WIDTH);
    }
    unmount();
  });

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
    expect(lines[0]).toContain('REVIEW');
    // A cut name leaves the ellipsis welded to the word it ate; a dropped one
    // stands alone after the seat label.
    expect(lines[0]).not.toMatch(/\S…/);
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
