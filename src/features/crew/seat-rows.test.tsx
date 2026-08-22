import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { deriveCrewSeats } from '../../core/crew/seats.js';
import type { Config } from '../../core/schemas/config.js';
import { SeatRows } from './seat-rows.js';

const VIEWPORT = { cols: 80, rows: 24 };

async function frameFor(config: Config): Promise<string> {
  const ui = renderFeature(
    <SeatRows seats={deriveCrewSeats({ config })} selected="plan" width={72} />,
    VIEWPORT,
  );
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame() ?? '');
  ui.unmount();
  return frame;
}

describe('crew seat rows', () => {
  it('lists the three seats in workflow order with their resolved identity', async () => {
    const frame = await frameFor(makeConfig());
    const plan = frame.indexOf('PLAN');
    const build = frame.indexOf('BUILD');
    const review = frame.indexOf('REVIEW');

    expect(plan).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(plan);
    expect(review).toBeGreaterThan(build);
    expect(frame).toContain('qwen2.5-coder:7b');
  });

  it('points the review seat at the planner when no reviewer is configured', async () => {
    const frame = await frameFor(makeConfig());

    expect(frame).toContain('same as planner');
  });

  it('names the configured reviewer instead of the planner pointer', async () => {
    const frame = await frameFor(
      makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } }),
    );

    expect(frame).toContain('gpt-5-codex');
    expect(frame).not.toContain('same as planner');
  });

  it('renders the escalate branch only when the build seat carries one', async () => {
    const without = await frameFor(makeConfig());
    expect(without).not.toContain('escalate');

    const withBranch = await frameFor(
      makeConfig({
        escalation: {
          enabled: true,
          intermediateProvider: 'deepseek',
          intermediateModel: 'deepseek-chat',
        },
      }),
    );
    expect(withBranch).toContain('escalate');
    expect(withBranch).toContain('deepseek-chat');
  });

  it('states the cross-lab verdict in words when both labs are determined', async () => {
    const frame = await frameFor(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code' },
        reviewer: { kind: 'cli', tool: 'codex' },
      }),
    );

    expect(frame).toContain('lab');
  });

  it('says nothing about labs when either seat is undetermined', async () => {
    const frame = await frameFor(makeConfig({ reviewer: { kind: 'cli', tool: 'claude-code' } }));

    expect(frame).not.toContain('lab');
  });

  it('keeps every rendered line inside the given width', async () => {
    const ui = renderFeature(
      <SeatRows
        seats={deriveCrewSeats({
          config: makeConfig({
            escalation: {
              enabled: true,
              intermediateProvider: 'deepseek',
              intermediateModel: 'deepseek-chat',
            },
          }),
        })}
        selected="build"
        width={56}
      />,
      { cols: 60, rows: 18 },
    );
    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    ui.unmount();

    for (const line of lines) expect(line.trimEnd().length).toBeLessThanOrEqual(56);
  });

  it('keeps the cross-lab verdict inside the given width', async () => {
    const ui = renderFeature(
      <SeatRows
        seats={deriveCrewSeats({
          config: makeConfig({
            planner: { kind: 'cli', tool: 'claude-code' },
            implementer: { kind: 'cli', tool: 'claude-code' },
            reviewer: { kind: 'cli', tool: 'codex' },
          }),
        })}
        selected="review"
        width={40}
      />,
      { cols: 44, rows: 18 },
    );
    await flushEffects();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    ui.unmount();

    expect(lines.some((line) => line.includes('reads'))).toBe(true);
    for (const line of lines) expect(line.trimEnd().length).toBeLessThanOrEqual(40);
  });
});
