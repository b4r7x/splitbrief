import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { plainUserMessage, type UserMessageInput } from '../../../src/core/types/user-input.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';
import type { SessionSelectDeps } from '../../../src/stores/navigation/session-select.js';
import { handleSessionSelect } from '../../../src/stores/navigation/session-select.js';
import { loadOwnerWorkflowState } from '../../../src/core/state/resume-hydration.js';
import { hydrateRun, readRunHistory } from '../../../src/features/workflow/run-history.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { sessionDir } from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

const STEER = 'prefer the cached parser, please';
// The store and the render must agree: renderFeature's default viewport (100x24)
// lays the frame out at a width the terminal size store does not declare.
const VIEWPORT = { cols: 120, rows: 40 } as const;

let projectDir = '';
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  projectDir = createTempDir('at-rest-steer-screen');
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(projectDir);
});

describe('a correction typed on a run at rest', () => {
  it('steers the re-entered run, shows the user message row, and replays it from the log', async () => {
    const sessionId = 'at-rest-steer-session';
    const feature = 'add auth';
    const savedState = { ...createInitialState(feature), phase: 'planning' as const };
    saveState({ projectDir, sessionId }, savedState);

    // The re-entry runs the real engine on a planner that is not installed: the
    // steer is published on the resume path, then the run settles at rest again.
    const steers: (UserMessageInput | undefined)[] = [];
    const config = makeConfig({
      planner: { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
    });
    const prepared = prepareWorkflowExecution({
      projectDir,
      feature,
      config,
      sessionId,
      resumeState: savedState,
    });
    const sessionSelect: SessionSelectDeps = {
      loadResumeState: loadOwnerWorkflowState,
      prepareResume: async () => ({ kind: 'prepared', execution: prepared }),
      hydrateRun,
      readRunHistory,
    };
    const deps: WorkflowScreenDeps = {
      runWorkflow: async (options) => {
        steers.push(options.steer);
        return runWorkflow(options);
      },
      sessionSelect,
    };

    configStore.__testReset({ config, projectDir });
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
    await handleSessionSelect(
      makeSession({ id: sessionId, feature, status: 'open' }),
      projectDir,
      sessionSelect,
    );
    const entered = routerStore.get();
    expect(entered.screen === 'workflow' && entered.execution.kind).toBe('at-rest');

    ui = renderFeature(
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={deps} />,
      VIEWPORT,
    );
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain('Stopped at');
    });
    expect(eventsStore.get().events.filter((event) => event.type === 'user_message')).toHaveLength(
      0,
    );

    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    ui.stdin.write(STEER);
    await flushEffects();
    ui.stdin.write('\r');

    await vi.waitFor(() => {
      expect(steers.at(-1)).toEqual(plainUserMessage(STEER));
      expect(
        eventsStore
          .get()
          .events.filter((event) => event.type === 'user_message')
          .map((event) => ('text' in event ? event.text : '')),
      ).toEqual([STEER]);
    });
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui?.lastFrame() ?? '')).toContain(STEER);
    });
    await vi.waitFor(() => {
      const route = routerStore.get();
      expect(route.screen === 'workflow' && route.execution.kind === 'at-rest').toBe(true);
    });

    const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf-8');
    const steerRows = log
      .split('\n')
      .filter((line) => line.includes('"kind":"message"') && line.includes(JSON.stringify(STEER)));
    expect(steerRows).toHaveLength(1);

    const replay = await readRunEvents({ projectDir, sessionId });
    expect(
      replay.events
        .filter((event) => event.type === 'user_message')
        .map((event) => ('text' in event ? event.text : '')),
    ).toEqual([STEER]);
  });
});
