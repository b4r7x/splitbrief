import { afterEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { modeAdviceStore } from '../../../stores/workflow/mode-advice.js';
import { useRunMode } from './use-run-mode.js';

function Probe() {
  return <Text>{useRunMode() ?? 'none'}</Text>;
}

function freshRun() {
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({ mode: null }),
    execution: { kind: 'at-rest' },
  });
}

afterEach(() => {
  routerStore.reset();
  configStore.__testReset();
  modeAdviceStore.__testReset();
});

describe('useRunMode', () => {
  it('keeps a fresh run on its resolved mode when the next-run config changes', async () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'standard' } }) });
    freshRun();
    modeAdviceStore.__testReset({ mode: 'quick' });

    const ui = renderFeature(<Probe />);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('quick');

    // `/mode speckit` is written for the next run; the running run keeps the mode the engine
    // resolved for it.
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'speckit' } }) });
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('quick');
    ui.unmount();
  });

  it('falls back to the record’s prepared-run mode before the config', async () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'standard' } }) });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ mode: 'speckit' }),
      execution: { kind: 'at-rest' },
    });
    modeAdviceStore.__testReset();

    const ui = renderFeature(<Probe />);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('speckit');
    ui.unmount();
  });

  it('keeps a fresh local run on its prepared mode when the next-run config changes', async () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'standard' } }) });
    // A fresh run: home read the record before any state was saved, so it carries no recorded
    // mode, and the engine has not published `mode_resolved` yet.
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ mode: null }),
      execution: {
        kind: 'local',
        prepared: makePreparedExecution({
          projectDir: '/tmp/prepared-run',
          sessionId: 'prepared-run-session',
          feature: 'add auth',
          config: makeConfig({ workflow: { mode: 'quick' } }),
        }),
      },
    });
    modeAdviceStore.__testReset();

    const ui = renderFeature(<Probe />);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('quick');

    // `/mode speckit` is written for the next run; this run reads the config it was prepared with.
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'speckit' } }) });
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('quick');
    ui.unmount();
  });

  it('reads the config only while the run has neither a resolved nor a recorded mode', async () => {
    configStore.__testReset({ config: makeConfig({ workflow: { mode: 'speckit' } }) });
    freshRun();
    modeAdviceStore.__testReset();

    const ui = renderFeature(<Probe />);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('speckit');
    ui.unmount();
  });
});
