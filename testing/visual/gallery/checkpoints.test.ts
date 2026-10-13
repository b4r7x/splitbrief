import { describe, expect, it } from 'vitest';
import { findVisualScenario } from '../catalog.js';
import { checkpointPredicate, waitForCheckpoint } from './checkpoints.js';

describe('checkpoint frame text', () => {
  it.each([
    'workflow-plan-card',
    'workflow-plan-card-render-note',
    'workflow-plan-card-shared-command',
  ])('waits for the plan document before accepting %s', (id) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports[0];
    if (scenario === undefined || checkpoint === undefined || viewport === undefined)
      throw new Error(`Missing checkpoint for ${id}`);
    const output = `${checkpoint.marker}\nEnd run\nEdit plan.json`;
    const context = { output, scenario, checkpoint, viewport };
    const ready = checkpointPredicate(scenario, checkpoint);
    expect(ready(context)).toBe(false);
    expect(
      ready({ ...context, output: `${output}\nAdd a greeting module and expose it from the CLI.` }),
    ).toBe(true);
  });
  it.each([
    'workflow-stop-menu-ended-gate',
    'workflow-stop-menu-ended-rewound-gate',
    'workflow-recovery-balance-spent',
  ])('matches %s across ANSI color runs', async (id) => {
    const scenario = findVisualScenario(id);
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports[0];
    if (scenario === undefined || checkpoint === undefined || viewport === undefined) {
      throw new Error(`Missing checkpoint for ${id}`);
    }
    const words = checkpoint.marker.split(' · ');
    const ansi = `${words.map((word) => `\u001b[31m${word}\u001b[39m`).join('\u001b[90m · \u001b[39m')}\nChange BUILD tool`;
    const context = { output: ansi, scenario, checkpoint, viewport };
    expect(checkpointPredicate(scenario, checkpoint)(context)).toBe(true);
    expect(await waitForCheckpoint({ ...context, lastFrame: () => ansi })).toBe(ansi);
  });

  it('passes plain text to a supplied predicate and returns the original ANSI frame', async () => {
    const scenario = findVisualScenario('home-empty');
    const checkpoint = scenario?.checkpoints[0];
    const viewport = scenario?.viewports[0];
    if (scenario === undefined || checkpoint === undefined || viewport === undefined) {
      throw new Error('Missing home-empty checkpoint');
    }
    const ansi = '\u001b[31mfirst\u001b[39m\n\u001b[34msecond\u001b[39m';
    let received = '';
    const frame = await waitForCheckpoint({
      scenario,
      checkpoint,
      viewport,
      lastFrame: () => ansi,
      predicate: ({ output }) => {
        received = output;
        return true;
      },
    });
    expect(received).toBe('first\nsecond');
    expect(frame).toBe(ansi);
  });
});
