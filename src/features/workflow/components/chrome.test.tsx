import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../../stores/project/config.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { WorkflowHeader } from './chrome.js';

type WorkflowConfigOverrides = Partial<
  Omit<EngineEventOf<'workflow_config'>, 'type' | 'ts' | 'phase'>
>;

function workflowConfig(overrides: WorkflowConfigOverrides = {}): EngineEventOf<'workflow_config'> {
  return {
    type: 'workflow_config',
    ts: Date.now(),
    phase: 'planning',
    mode: 'instant',
    plannerTool: 'codex',
    implementerTool: 'codex',
    ...overrides,
  };
}

describe('WorkflowHeader', () => {
  beforeEach(() => {
    resetAllStores();
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    routerStore.init({ screen: 'workflow', feature: 'test feature' });
    lifecycleStore.__testReset({ phase: 'researching' });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('inlines full config with models when the allocated config column is wide enough', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    eventsStore.__testReset({
      events: [
        workflowConfig({
          plannerModel: 'p',
          implementerModel: 'i',
        }),
      ],
    });

    const ui = renderFeature(<WorkflowHeader startedAt={new Date().toISOString()} />);
    await tick();
    const lines = (ui.lastFrame() ?? '').split('\n');

    expect(
      lines.some(
        (line) =>
          line.includes('instant') &&
          line.includes('(p)') &&
          line.includes('(i)') &&
          line.includes('spent n/a'),
      ),
    ).toBe(true);

    ui.unmount();
  });

  it('keeps labels but omits models when the inline config column cannot fit full text', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    eventsStore.__testReset({
      events: [
        workflowConfig({
          plannerModel: 'planner-model',
          implementerModel: 'implementer-model',
        }),
      ],
    });

    const ui = renderFeature(<WorkflowHeader startedAt={new Date().toISOString()} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('instant · Planner: Codex');
    expect(frame).toContain('Implementer: Codex');
    expect(frame).not.toContain('planner-model');
    expect(frame).not.toContain('implementer-model');

    ui.unmount();
  });

  it('uses tool-only config text when labels do not fit the available width', async () => {
    terminalSizeStore.__testReset({ cols: 40, rows: 24, isSmall: true });
    eventsStore.__testReset({
      events: [workflowConfig()],
    });

    const ui = renderFeature(<WorkflowHeader startedAt={new Date().toISOString()} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('instant · Codex → Codex');
    expect(frame).not.toContain('Planner:');
    expect(frame).not.toContain('Implementer:');

    ui.unmount();
  });

  it('keeps the pipeline on the same right side as the timer', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    routerStore.init({
      screen: 'workflow',
      feature: 'a long feature name that should stop before the right chrome',
    });

    const ui = renderFeature(<WorkflowHeader startedAt={new Date().toISOString()} />);
    await tick();
    const header = (ui.lastFrame() ?? '').split('\n')[0] ?? '';
    const pipelineIndex = header.indexOf('res');
    const timerIndex = header.indexOf('00:');

    expect(pipelineIndex).toBeGreaterThan(40);
    expect(timerIndex).toBeGreaterThan(pipelineIndex);

    ui.unmount();
  });

  it('keeps running agent status to one chrome row when heartbeat details are present', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    eventsStore.__testReset({
      events: [
        {
          type: 'planner_status',
          ts: Date.now(),
          phase: 'researching',
          status: 'running',
          tool: 'codex',
          model: 'default',
        },
        {
          type: 'planner_heartbeat',
          ts: Date.now(),
          phase: 'researching',
          elapsedMs: 200,
          accumulatedTokens: 12_300,
          phaseHint: 'collecting enough context to decide whether the work should be split',
        },
      ],
    });

    const ui = renderFeature(<WorkflowHeader startedAt={new Date().toISOString()} />);
    await tick();
    const frame = ui.lastFrame() ?? '';
    const statusLines = frame
      .split('\n')
      .filter(
        (line) =>
          line.includes('planner researching') || line.includes('collecting enough context'),
      );

    expect(statusLines).toHaveLength(1);

    ui.unmount();
  });
});
