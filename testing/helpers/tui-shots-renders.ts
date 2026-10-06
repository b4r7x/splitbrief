import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TUI_SHOTS_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=',
  'base64',
);

export type TuiShotsRender = Readonly<{
  checkId: string;
  scenario: string;
  checkpoint: string;
  sizes: readonly string[];
  elements: readonly string[];
}>;

const NARROW_SIZES = ['120x40', '80x24', '60x18'];

/** The six render checks of the S9 verification run: 80 PNGs, 12 to 20 per check. */
export const S9_RENDER_CHECKS: readonly TuiShotsRender[] = [
  {
    checkId: 'RUN-PLAN-CARD-RENDER',
    scenario: 'workflow-plan-card',
    checkpoint: 'plan-card',
    sizes: [...NARROW_SIZES, '160x45'],
    elements: ['approval-panel', 'composer', 'header', 'transcript'],
  },
  {
    checkId: 'RUN-FINAL-REVIEW-RENDER',
    scenario: 'workflow-final-review',
    checkpoint: 'final-review',
    sizes: NARROW_SIZES,
    elements: ['composer', 'header', 'transcript'],
  },
  {
    checkId: 'RUN-NARRATION-RENDER',
    scenario: 'workflow-implementation-narration',
    checkpoint: 'implementation-narration',
    sizes: NARROW_SIZES,
    elements: ['activity', 'header', 'transcript'],
  },
  {
    checkId: 'RUN-RETRY-RENDER',
    scenario: 'workflow-implementation-retry',
    checkpoint: 'implementation-retry',
    sizes: NARROW_SIZES,
    elements: ['header', 'sidebar', 'transcript'],
  },
  {
    checkId: 'RUN-VALIDATION-RENDER',
    scenario: 'workflow-validation',
    checkpoint: 'validation',
    sizes: NARROW_SIZES,
    elements: ['header', 'sidebar', 'transcript'],
  },
  {
    checkId: 'RUN-PAUSED-BOUNDARY-RENDER',
    scenario: 'workflow-paused-boundary',
    checkpoint: 'paused-boundary',
    sizes: NARROW_SIZES,
    elements: ['composer', 'header', 'transcript'],
  },
];

/**
 * Writes one `npm run tui-shots` execution into `dir` the way `runRenderCheck`
 * copies it: `<execution>/catalog-1-<hash>/<scenario>/<size>/<checkpoint>/frame.png`
 * and `…/elements/<element>/crop.png`. The paths come back in checks-log order
 * (sorted, so each crop precedes its frame).
 */
export function writeTuiShotsRender(dir: string, render: TuiShotsRender): string[] {
  const relative: string[] = [];
  for (const size of render.sizes) {
    const capture = join(render.scenario, size, render.checkpoint);
    relative.push(join(capture, 'frame.png'));
    for (const element of render.elements) {
      relative.push(join(capture, 'elements', element, 'crop.png'));
    }
  }
  const root = join(dir, '6e448675-03f4-43fa-be38-706789c5dc3d', 'catalog-1-ca9a636d085b973469ea');
  return relative.sort().map((path) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, TUI_SHOTS_PNG);
    return absolute;
  });
}

export function isTuiShotsFrame(path: string): boolean {
  return path.endsWith('/frame.png');
}
