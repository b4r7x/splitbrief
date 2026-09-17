import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from '../../../src/app/router.js';
import { useAppKeys } from '../../../src/app/keys.js';
import { ThemeProvider } from '../../../src/components/theme.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import { configStore } from '../../../src/stores/project/config.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { clearAllHandlers } from '../../../src/features/workflow/handlers.js';
import { cancelEscapeAction } from '../../../src/lib/terminal/escape-debounce.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { flushSessionDrafts } from '../../../src/stores/ui/session-drafts.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const stopped = vi.fn();
function runWorkflow(options: RunWorkflowOptions): Promise<Summary> {
  const state = {
    ...createInitialState(options.prepared.runtime.feature),
    phase: 'researching' as const,
  };
  saveState(options.prepared.session.ref, state);
  options.tuiSink?.({
    type: 'planner_status',
    ts: Date.now(),
    phase: 'researching',
    status: 'running',
  });
  options.tuiSink?.({
    type: 'planner_text',
    ts: Date.now(),
    phase: 'researching',
    role: 'planner',
    content: 'plain',
    text: 'Inspecting the authentication module.',
  });
  return new Promise((resolve) => {
    options.signal?.addEventListener(
      'abort',
      () => {
        stopped();
        saveState(
          options.prepared.session.ref,
          transition(state, {
            type: 'INTERRUPT_STEP',
            step: { kind: 'planner', call: 'research' },
            source: 'user',
            cut: 'mid-step',
          }),
        );
        resolve(makeSummary());
      },
      { once: true },
    );
  });
}

function App() {
  useAppKeys({
    exit: () => {
      throw new Error('Stopping must not exit the app');
    },
  });
  const screen = routerStore.use((state) => state.screen);
  const overlay = overlayStore.use((state) => state.active);
  return (
    <ThemeProvider>
      <Router
        screen={screen}
        overlayActive={overlay}
        commands={[]}
        onRuntime={() => {}}
        copyTarget={async () => 'empty'}
        workflowDeps={{ runWorkflow }}
      />
    </ThemeProvider>
  );
}

describe('inline stop menu in the routed workflow', () => {
  let projectDir = '';
  let ui: ReturnType<typeof renderFeature> | undefined;
  beforeEach(() => {
    resetAllStores();
    stopped.mockClear();
    projectDir = createTempDir('inline-stop-menu');
    const config = makeConfig();
    const prepared = prepareWorkflowExecution({
      projectDir,
      config,
      feature: 'Inspect authentication',
    });
    configStore.__testReset({ config, projectDir });
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref: prepared.session.ref }),
      execution: { kind: 'local', prepared },
    });
  });
  afterEach(() => {
    ui?.unmount();
    cancelEscapeAction();
    clearAllHandlers();
    flushSessionDrafts();
    resetAllStores();
    cleanupTempDir(projectDir);
  });

  it.each([
    { cols: 60, rows: 18 },
    { cols: 80, rows: 24 },
    { cols: 120, rows: 40 },
  ])('keeps the workflow visible and restores the draft at $cols x $rows', async (viewport) => {
    terminalSizeStore.__testReset(viewport);
    ui = renderFeature(<App />, viewport);
    const screen = ui;
    const frame = () => stripAnsiStyles(screen.lastFrame());
    await vi.waitFor(() => expect(frame()).toContain('Inspecting the authentication module.'));
    composerDraftStore.request('First draft line\nSecond draft line');
    await vi.waitFor(() => expect(frame()).toContain('Second draft line'));
    await flushEffects();
    screen.stdin.write('\x1b');
    await vi.waitFor(() => expect(frame()).toContain('Stop options'));
    expect(frame()).toContain('Inspecting the authentication module.');
    expect(frame()).toContain('End run');
    expect(frame()).toContain('tab back');
    expect(frame().split('\n').length).toBeLessThanOrEqual(viewport.rows);
    expect(stopStore.get().intent).toBe('none');
    addEvent({
      type: 'planner_text',
      ts: Date.now(),
      phase: 'researching',
      role: 'planner',
      content: 'plain',
      text: '\nStill checking the module.',
    });
    await vi.waitFor(() => expect(frame()).toContain('Still checking the module.'));
    await flushEffects();
    screen.stdin.write('\t');
    await vi.waitFor(() => expect(frame()).not.toContain('Stop options'));
    expect(frame()).toContain('First draft line');
    expect(frame()).toContain('Second draft line');
    await flushEffects();
    screen.stdin.write('\x1b');
    await vi.waitFor(() => expect(frame()).toContain('Stop options'));
    await flushEffects();
    screen.stdin.write('\x1b');
    await tick(50);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopStore.get().intent).toBe('stop-now');
    expect(overlayStore.get().active).toBe('stop-sheet');
    expect(stopStore.get().phase).toBe('parked');
    expect(routerStore.get().screen).toBe('workflow');
    expect(frame()).toContain('Resume');
    expect(frame()).toContain('End run');
    expect(frame()).toContain('Back to sessions');
    await flushEffects();
    screen.stdin.write('\x1b');
    await vi.waitFor(() => expect(routerStore.get().screen).toBe('home'));
  });
});
