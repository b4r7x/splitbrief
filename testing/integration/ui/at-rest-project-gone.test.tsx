import fs, { existsSync, mkdirSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import type { SessionSelectDeps } from '../../../src/stores/navigation/session-select.js';
import { handleSessionSelect } from '../../../src/stores/navigation/session-select.js';
import {
  loadOwnerWorkflowState,
  projectGoneMessage,
} from '../../../src/core/state/resume-hydration.js';
import { hydrateRun, readRunHistory } from '../../../src/features/workflow/run-history.js';
import { rereadRunAtRest } from '../../../src/features/workflow/run-requests/end-run.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { getSplitbriefPath } from '../../../src/core/paths.js';
import { saveDetectionCache } from '../../../src/engine/detection/cache/store.js';
import { createRecoveryBus } from '../../../src/engine/orchestrator/recovery/bus.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { listRowLead } from '../../../src/components/list-row/lead.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';
import { runViewStore } from '../../../src/stores/workflow/run-view.js';
import { eventsStore } from '../../../src/stores/workflow/events/state.js';
import { useRuntimeCommands } from '../../../src/app/command-context.js';
import type { WorkflowScreenDeps } from '../../../src/features/workflow/hooks/workflow-screen/use-model.js';

const VIEWPORT = { cols: 120, rows: 40 } as const;
// The sidebar takes a column only on a terminal wider than 120 columns.
const WIDE_VIEWPORT = { cols: 140, rows: 40 } as const;
const ARROW_DOWN = '\u001B[B';
const FEATURE = 'add a word counter';
const PLANNER_TEXT = 'The counter reads the words of each line.';
const CORRECTION = 'count the words of the title too';

let root = '';
let projectDir = '';
let ui: ReturnType<typeof renderFeature> | undefined;

beforeEach(() => {
  resetAllStores();
  routerStore.init({ screen: 'home' });
  root = createTempDir('at-rest-project-gone');
  projectDir = join(root, 'project');
  mkdirSync(projectDir);
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  resetAllStores();
  routerStore.init({ screen: 'home' });
  cleanupTempDir(root);
});

function frame(): string {
  return stripAnsiStyles(ui?.lastFrame() ?? '');
}

/** The run screen with the runtime commands of the app, as the app mounts it. */
function WorkflowScreenWithCommands({ deps }: { deps: WorkflowScreenDeps }) {
  const phase = runViewStore.use((state) => state.phase);
  const model = useRuntimeCommands({ exit: () => {}, phase });
  return (
    <WorkflowScreen
      commands={model.commands}
      onRuntimeCommand={(raw, sentBy) => model.handleRuntimeCommand(raw, 'workflow', sentBy)}
      deps={deps}
    />
  );
}

/** A run at rest on screen, with one planner row in its transcript. */
async function openRunAtRest({
  withCommands = false,
  viewport = VIEWPORT,
}: {
  withCommands?: boolean;
  viewport?: { cols: number; rows: number };
} = {}) {
  const sessionId = 'project-gone-session';
  const ref = { projectDir, sessionId };
  saveState(ref, { ...createInitialState(FEATURE), ...RUN_CREW, phase: 'planning' });
  createRecoveryBus({ ...ref, sink: () => {} }).publish({
    type: 'planner_text',
    ts: 1_000,
    phase: 'planning',
    role: 'planner',
    content: 'plain',
    text: PLANNER_TEXT,
  });
  const prepareResume = vi.fn();
  const runWorkflow = vi.fn();
  const sessionSelect: SessionSelectDeps = {
    applying: () => false,
    loadResumeState: loadOwnerWorkflowState,
    prepareResume,
    hydrateRun,
    readRunHistory,
  };
  configStore.__testReset({ config: makeConfig(), projectDir });
  terminalSizeStore.__testReset({ ...viewport, isSmall: false });
  await handleSessionSelect(
    makeSession({ id: sessionId, feature: FEATURE, status: 'open' }),
    projectDir,
    sessionSelect,
  );
  const opened = routerStore.get();
  const deps = { runWorkflow, sessionSelect };
  ui = renderFeature(
    withCommands ? (
      <WorkflowScreenWithCommands deps={deps} />
    ) : (
      <WorkflowScreen commands={[]} onRuntimeCommand={vi.fn()} deps={deps} />
    ),
    viewport,
  );
  // The screen reads the run again when it mounts; that read ends before the folder moves.
  await vi.waitFor(() => {
    expect(routerStore.get()).not.toBe(opened);
    expect(frame()).toContain(PLANNER_TEXT);
    expect(frame()).toContain('Stopped at');
  });
  return { prepareResume, runWorkflow };
}

/** The project folder moves away under the open screen, and the screen answers the move. */
async function moveProjectAway(): Promise<void> {
  const messages: (string | null)[] = [];
  const off = feedbackStore.subscribe(() => messages.push(feedbackStore.get().message));
  renameSync(projectDir, join(root, 'moved'));
  // The screen polls the state file and the session log apart, and each one answers the move.
  await vi.waitFor(() => {
    const gone = messages.filter((message) => message === projectGoneMessage(projectDir));
    expect(gone.length === 2 || frame().includes('Saved state unreadable')).toBe(true);
  });
  off();
}

/** Records each footer message from now on, after the sentence that answered the move. */
function recordFooter() {
  feedbackStore.reset();
  const messages: (string | null)[] = [];
  const off = feedbackStore.subscribe(() => messages.push(feedbackStore.get().message));
  return { messages, off };
}

/** The footer messages that answer an action: the draft of a typed command is refused apart. */
function answers(messages: readonly (string | null)[]): (string | null)[] {
  return messages.filter((message) => message !== null && message !== 'Draft not saved');
}

/** Types a command into the composer and sends it once the composer shows it. */
async function runCommand(name: string): Promise<void> {
  await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
  ui?.stdin.write(name);
  await vi.waitFor(() => expect(frame()).toMatch(new RegExp(`[>›] ${name}`)));
  ui?.stdin.write('\r');
}

describe('a run at rest whose project folder moves away', () => {
  it('keeps the transcript and the byline and says that the project folder is gone', async () => {
    await openRunAtRest();
    const byline = frame()
      .split('\n')
      .find((line) => line.includes('Stopped at'));

    await moveProjectAway();

    const after = frame();
    expect(after).not.toContain('Saved state unreadable');
    expect(after).not.toContain('no events yet');
    expect(after).toContain(PLANNER_TEXT);
    expect(after.split('\n')).toContain(byline);
    expect(feedbackStore.get()).toEqual({
      message: projectGoneMessage(projectDir),
      isError: true,
    });
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.run.hydration.kind).toBe('loaded');
  });

  it('keeps the loaded transcript when the folder moves between reading state and reading history', async () => {
    await openRunAtRest();
    ui?.unmount();
    ui = undefined;
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('Expected the workflow screen.');
    const events = eventsStore.get().events;

    const refresh = rereadRunAtRest(route.run.ref);
    renameSync(projectDir, join(root, 'moved'));
    await refresh;

    expect(eventsStore.get().events).toBe(events);
    expect(routerStore.get()).toBe(route);
    expect(feedbackStore.get()).toEqual({ message: projectGoneMessage(projectDir), isError: true });
  });

  it('keeps the transcript and names the moved folder when a tool-cache save races the rename', async () => {
    await openRunAtRest();
    ui?.unmount();
    ui = undefined;
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('Expected the workflow screen.');
    const events = eventsStore.get().events;
    const moved = join(root, 'moved');
    const metadata = getSplitbriefPath(projectDir);
    const pathExists = fs.existsSync;
    const cacheCheck = vi.spyOn(fs, 'existsSync').mockImplementation((path) => {
      const present = pathExists(path);
      if (path === metadata && present) renameSync(projectDir, moved);
      return present;
    });
    syncBuiltinESMExports();
    try {
      await saveDetectionCache({
        projectDir,
        snapshot: {
          contextKey: 'readiness-context',
          fetchedAt: 1_000,
          validatedAt: 1_000,
          generation: 1,
          requestId: 1,
          providers: [],
          cliTools: [],
        },
      });
    } finally {
      cacheCheck.mockRestore();
      syncBuiltinESMExports();
    }
    expect(existsSync(moved)).toBe(true);

    await rereadRunAtRest(route.run.ref);

    expect.soft(existsSync(projectDir)).toBe(false);
    expect.soft(routerStore.get() === route).toBe(true);
    expect.soft(eventsStore.get().events.some((event) => event.type === 'planner_text')).toBe(true);
    expect.soft(eventsStore.get().events === events).toBe(true);
    expect(feedbackStore.get()).toEqual({ message: projectGoneMessage(projectDir), isError: true });
  });

  it('answers Enter with the same sentence and stays on the run screen', async () => {
    const { prepareResume, runWorkflow } = await openRunAtRest();
    await moveProjectAway();
    feedbackStore.reset();

    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    ui?.stdin.write('\r');

    await vi.waitFor(() => {
      expect(feedbackStore.get().message !== null || routerStore.get().screen !== 'workflow').toBe(
        true,
      );
    });
    expect(routerStore.get().screen).toBe('workflow');
    expect(feedbackStore.get()).toEqual({
      message: projectGoneMessage(projectDir),
      isError: false,
    });
    expect(frame()).not.toContain('No saved state to continue.');
    expect(prepareResume).not.toHaveBeenCalled();
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('keeps the draft out of the folder that is gone and answers typed words with the sentence', async () => {
    const { prepareResume, runWorkflow } = await openRunAtRest();
    await moveProjectAway();
    feedbackStore.reset();
    const messages: (string | null)[] = [];
    const off = feedbackStore.subscribe(() => messages.push(feedbackStore.get().message));

    await tick(PROMPT_TYPEAHEAD_GRACE_MS + 30);
    ui?.stdin.write(CORRECTION);
    // The screen saves the draft a short time after the words change.
    await vi.waitFor(() => {
      expect(messages.includes('Draft not saved') || existsSync(projectDir)).toBe(true);
    });
    expect(existsSync(projectDir)).toBe(false);
    await flushEffects();
    ui?.stdin.write('\r');
    await vi.waitFor(() => {
      expect(messages.some((message) => message !== null && message !== 'Draft not saved')).toBe(
        true,
      );
    });
    // The refused words go back into the composer, and their draft is refused again.
    await vi.waitFor(() => {
      expect(messages.filter((message) => message === 'Draft not saved')).toHaveLength(2);
    });
    off();

    expect(messages.filter((message) => message !== null && message !== 'Draft not saved')).toEqual(
      [projectGoneMessage(projectDir)],
    );
    // The warning at the end of the transcript names the folder that is gone, not a system error.
    const warning = frame()
      .replace(/\s*[│|]\s*/g, ' ')
      .replace(/\s+/g, ' ');
    expect(warning).toContain('Draft not saved: the project folder');
    expect(warning).toContain('is gone · .splitbrief');
    expect(existsSync(projectDir)).toBe(false);
    expect(prepareResume).not.toHaveBeenCalled();
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it('answers /end with the sentence and keeps the run open on the screen', async () => {
    await openRunAtRest({ withCommands: true });
    await moveProjectAway();
    const { messages, off } = recordFooter();

    await runCommand('/end');

    await vi.waitFor(() => expect(answers(messages)).not.toEqual([]));
    await flushEffects();
    off();
    expect(answers(messages)).toEqual([projectGoneMessage(projectDir)]);
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.run.hydration.kind).toBe('loaded');
    expect(stopStore.get().intent).toBe('none');
    expect(existsSync(projectDir)).toBe(false);
  });

  it('answers End run in the stop sheet with the sentence', async () => {
    await openRunAtRest({ withCommands: true });
    await moveProjectAway();
    const { messages, off } = recordFooter();
    await runCommand('/stop');
    await vi.waitFor(() => expect(frame()).toContain('End run · close this run'));

    ui?.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => expect(frame()).toContain(`${listRowLead('active')}End run`));
    ui?.stdin.write('\r');

    await vi.waitFor(() => expect(answers(messages)).not.toEqual([]));
    await flushEffects();
    off();
    expect(answers(messages)).toEqual([projectGoneMessage(projectDir)]);
    expect(overlayStore.get().active).toBe('none');
    expect(stopStore.get().intent).toBe('none');
    expect(existsSync(projectDir)).toBe(false);
  });

  it('hides the sidebar with no folder made again, and Enter then says that the project folder is gone', async () => {
    await openRunAtRest({ withCommands: true, viewport: WIDE_VIEWPORT });
    await moveProjectAway();
    const { messages, off } = recordFooter();

    await runCommand('/sidebar');
    await vi.waitFor(() => expect(answers(messages)).toEqual(['Sidebar hidden']));
    expect(controlsStore.get().sidebarVisible).toBe(false);
    expect(existsSync(projectDir)).toBe(false);
    ui?.stdin.write('\r');

    await vi.waitFor(() => expect(answers(messages)).toHaveLength(2));
    await flushEffects();
    off();
    expect(answers(messages)).toEqual(['Sidebar hidden', projectGoneMessage(projectDir)]);
    expect(frame()).not.toContain('No saved state to continue.');
    expect(existsSync(projectDir)).toBe(false);
  });
});
