import { hitTopmostZone } from '../../src/lib/terminal/mouse-zones.js';
import type { FilteredStdinHarness, FilteredStdinViewport } from './filtered-stdin-harness.js';
import { tick } from './ink.js';

/** The bytes of a key, a click on the zone with this id, or one wheel step down on it. */
export type InputStep = string | { click: string } | { wheel: string };

const ESC = '\u001B';
// The input bridge holds a lone Esc for 50 ms to tell it from the start of an escape sequence.
const ESC_HOLD_MS = 80;

function pointOf(viewport: FilteredStdinViewport, id: string): { x: number; y: number } {
  for (let y = 1; y <= viewport.rows; y++) {
    for (let x = 1; x <= viewport.cols; x++) {
      if (hitTopmostZone(x, y)?.id === id) return { x, y };
    }
  }
  throw new Error(`no zone ${id}`);
}

/** The bytes a terminal sends for `step`, at the point of its zone in the frame on screen now. */
export function stepBytes(viewport: FilteredStdinViewport, step: InputStep): string {
  if (typeof step === 'string') return step;
  if ('click' in step) {
    const { x, y } = pointOf(viewport, step.click);
    return `${ESC}[<0;${x};${y}M${ESC}[<0;${x};${y}m`;
  }
  const { x, y } = pointOf(viewport, step.wheel);
  return `${ESC}[<65;${x};${y}M`;
}

/**
 * `steady` lets the app take each step before the next one is read. `burst` takes the point of
 * each click and wheel step from the frame at the start and writes each step as its own read
 * before the app takes any of them.
 */
export async function deliverSteps(
  ui: FilteredStdinHarness,
  viewport: FilteredStdinViewport,
  steps: InputStep[],
  delivery: 'steady' | 'burst',
): Promise<void> {
  if (delivery === 'steady') {
    for (const step of steps) {
      ui.pressBytes(stepBytes(viewport, step));
      if (step === ESC) await tick(ESC_HOLD_MS);
      await ui.settled();
    }
    return;
  }
  const reads = steps.map((step) => stepBytes(viewport, step));
  for (const [index, read] of reads.entries()) {
    ui.pressBytes(read);
    // A lone Esc that the next read reaches within the hold is Alt and that key.
    if (steps[index] === ESC) await tick(ESC_HOLD_MS);
  }
  await ui.settled();
}
