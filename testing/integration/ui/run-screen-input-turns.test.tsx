import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeImplementerGenerate } from '#testing/helpers/events/implementer.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { taskId } from '../../../src/core/schemas/task.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { wireAppMouse } from '../../../src/app/mouse.js';
import { WorkflowScreen } from '../../../src/app/screens/workflow.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { configStore } from '../../../src/stores/project/config.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { eventsStore } from '../../../src/stores/workflow/events/state.js';
import { conversationScrollStore } from '../../../src/stores/workflow/conversation-scroll.js';

// The composer lists the project files with a git child. Each test deletes its project folder at
// the end, and a git child that reads its working folder after that scans the whole temp folder.
vi.mock('../../../src/lib/git/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/git/files.js')>()),
  listTrackedAndUntrackedFiles: async () => null,
}));

const VIEWPORT = { cols: 120, rows: 40 } as const;
const FIXED_TS = 1_783_958_400_000;
const WHEEL_UP = '\x1b[<64;40;20M';
const SHIFT_UP = '\x1b[1;2A';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const DIFF_FILE = 'src/test.ts';

let projectDir = '';
const unmounts: Array<() => void> = [];

beforeEach(() => {
  resetAllStores();
  projectDir = createTempDir('run-screen-input-turns');
  configStore.__testReset({ config: makeConfig(), projectDir });
  terminalSizeStore.__testReset({ cols: VIEWPORT.cols, rows: VIEWPORT.rows });
  routerStore.init({
    screen: 'workflow',
    run: makeRunRecord({
      ref: { projectDir, sessionId: 'run-screen-input-turns' },
      status: {
        kind: 'open',
        stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
        resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
      },
      hydration: { kind: 'loaded', state: makeWorkflowState({ phase: 'implementing' }) },
    }),
    execution: { kind: 'at-rest' },
  });
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  resetAllStores();
  cleanupTempDir(projectDir);
});

function notes(from: number, count: number): EngineEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'planner_text',
    ts: FIXED_TS + from + index,
    phase: 'implementing',
    text: `note ${from + index}`,
  }));
}

/** A transcript with one diff row, which a click opens, and `after` notes below it. */
function seedTranscript(after: number): void {
  const diff = makeImplementerGenerate({ ts: FIXED_TS + 100, diff: '+ export const total = 1;' });
  eventsStore.__testReset({ events: [...notes(0, 100), diff, ...notes(101, after)] });
}

async function mountRunScreen() {
  const ui = renderThroughFilteredStdin(
    <WorkflowScreen commands={[]} onRuntimeCommand={() => {}} />,
    VIEWPORT,
  );
  const unwire = wireAppMouse(ui.filtered);
  unmounts.push(() => {
    unwire();
    ui.unmount();
  });
  await ui.settled();
  const lines = () => stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
  return { ...ui, lines };
}

function opened(): string[] {
  const scroll = conversationScrollStore.get();
  return [...scroll.expandedDiffs, ...scroll.expandedActivityBatches];
}

function press(x: number, y: number): string {
  return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
}

describe('the run screen takes the scroll inputs of one terminal read', () => {
  it.each([
    ['wheel steps', WHEEL_UP],
    ['Shift+↑ keys', SHIFT_UP],
  ])('scrolls the transcript by 60 %s of one read', async (_label, step) => {
    seedTranscript(100);
    const ui = await mountRunScreen();

    ui.pressBytes(step.repeat(60));
    await ui.settled();

    expect(conversationScrollStore.get().scrollOffset).toBe(60);
    expect(ui.lines().join('\n')).toContain('60 lines below');
  });

  it('scrolls the transcript by 30 wheel steps of one read in one turn', async () => {
    seedTranscript(100);
    const ui = await mountRunScreen();
    const before = ui.turns();

    ui.pressBytes(WHEEL_UP.repeat(30));
    await ui.settled();

    expect(conversationScrollStore.get().scrollOffset).toBe(30);
    expect(ui.turns() - before).toBe(1);
  });
});

describe('a click read with the scroll input before it acts on the row that the screen showed', () => {
  /** Where the diff row is drawn now: the column and the row of its file name, from 1. */
  function diffRowAt(lines: string[]): { x: number; y: number } {
    const index = lines.findIndex((line) => line.includes(DIFF_FILE));
    if (index < 0) throw new Error(`no diff row on the screen:\n${lines.join('\n')}`);
    return { x: (lines[index]?.indexOf(DIFF_FILE) ?? 0) + 1, y: index + 1 };
  }

  it('opens nothing for a wheel step and a click of one read on the row below the diff row', async () => {
    seedTranscript(8);
    const ui = await mountRunScreen();
    const diff = diffRowAt(ui.lines());

    ui.pressBytes(WHEEL_UP + press(diff.x, diff.y + 1));
    await ui.settled();

    expect(conversationScrollStore.get().scrollOffset).toBe(1);
    expect(opened()).toEqual([]);

    ui.pressBytes(press(diff.x, diff.y + 1));
    await ui.settled();

    expect(opened()).toHaveLength(1);
  });

  it('opens nothing for PageUp and a click of one read where PageUp brings the diff row', async () => {
    seedTranscript(20);
    const ui = await mountRunScreen();
    expect(ui.lines().join('\n')).not.toContain(DIFF_FILE);
    ui.pressBytes(PAGE_UP);
    await ui.settled();
    const diff = diffRowAt(ui.lines());
    const page = conversationScrollStore.get().scrollOffset;
    ui.pressBytes(PAGE_DOWN);
    await ui.settled();
    expect(conversationScrollStore.get().scrollOffset).toBe(0);

    ui.pressBytes(PAGE_UP + press(diff.x, diff.y));
    await ui.settled();

    expect(conversationScrollStore.get().scrollOffset).toBe(page);
    expect(opened()).toEqual([]);

    ui.pressBytes(press(diff.x, diff.y));
    await ui.settled();

    expect(opened()).toHaveLength(1);
  });
});
