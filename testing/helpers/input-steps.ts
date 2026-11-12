import { hitTopmostZone } from '../../src/lib/terminal/mouse-zones.js';
import { flushEffects, tick, type RenderFeatureResult, type RenderViewport } from './ink.js';
import { collectClickableZones } from './mouse-zones.js';

export type InputStep = string | { click: string } | { wheel: string };

const ESC = '\u001B';

function actionOf(ui: RenderFeatureResult, viewport: RenderViewport, step: InputStep): () => void {
  if (typeof step === 'string') return () => ui.stdin.write(step);
  if ('click' in step) {
    const click = collectClickableZones(viewport).get(step.click);
    if (click === undefined) throw new Error(`no click zone ${step.click}`);
    return click;
  }
  for (let y = 1; y <= viewport.rows; y++) {
    for (let x = 1; x <= viewport.cols; x++) {
      const wheel = hitTopmostZone(x, y);
      if (wheel?.id === step.wheel && wheel.onWheel) {
        const onWheel = wheel.onWheel;
        return () => onWheel('down');
      }
    }
  }
  throw new Error(`no wheel zone ${step.wheel}`);
}

/**
 * `steady` renders after each step. `burst` takes every action from the frame at the start and
 * runs them with no render between them.
 */
export async function deliverSteps(
  ui: RenderFeatureResult,
  viewport: RenderViewport,
  steps: InputStep[],
  delivery: 'steady' | 'burst',
): Promise<void> {
  if (delivery === 'steady') {
    for (const step of steps) {
      actionOf(ui, viewport, step)();
      await flushEffects();
    }
    return;
  }
  const actions = steps.map((step) => actionOf(ui, viewport, step));
  for (const [index, act] of actions.entries()) {
    act();
    // Ink holds a lone Esc until the check phase to tell it from an escape sequence, and
    // joins it with the next write. One turn lets the Esc out alone, with no render of the
    // key after it.
    if (steps[index] === ESC && index < actions.length - 1) await tick();
  }
  // The picker takes one entry per render, so each step needs its own render.
  for (const _ of steps) await flushEffects();
}
