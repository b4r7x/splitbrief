import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { flushEffects, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';

// Read once from a freshly reset store so the assertion tracks the shipped default.
controlsStore.__testReset();
const sidebarDefault = controlsStore.get().sidebarVisible;
import { completionStore } from '../../../stores/ui/completion.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { questionPromptStore } from '../../../stores/question-prompt/prompt.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { activityBatchKey } from '../conversation-rows/activity-batch-key.js';
import { readConversationScrollSnapshot, readReviewContentHeight } from '../layout/snapshot.js';
import { useWorkflowKeys } from './use-keys.js';
import { taskId } from '../../../core/schemas/task.js';

const CTRL_A = '\x01';
const CTRL_B = '\x02';
const CTRL_D = '\x04';
const CTRL_E = '\x05';
const CTRL_F = '\x06';
const SHIFT_UP = '\x1B[1;2A';
const SHIFT_DOWN = '\x1B[1;2B';
const PAGE_UP = '\x1B[5~';
const PAGE_DOWN = '\x1B[6~';
const HOME = '\x1B[H';
const END = '\x1B[F';
const ARROW_UP = '\x1B[A';
const ARROW_DOWN = '\x1B[B';

const VIEWPORTS = [
  { label: '120x40', cols: 120, rows: 40 },
  { label: '80x24', cols: 80, rows: 24 },
  { label: '60x18', cols: 60, rows: 18 },
];

function Harness({ isActive = true }: { isActive?: boolean }) {
  useWorkflowKeys({ isActive });
  return <Text> </Text>;
}

function seedLongConversation(): void {
  const events: EngineEventOf<'planner_text'>[] = Array.from({ length: 80 }, (_, ts) => ({
    type: 'planner_text',
    ts,
    phase: 'specifying',
    text: `event-${ts}`,
  }));
  eventsStore.__testReset({
    events,
  });
}

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return makeRunnerCallActivity('planner-read', overrides);
}

function seedExpandableActivityBatch(): string {
  addEvent(activity({ sequence: 1, activityId: 'a', label: 'reading a.ts' }));
  addEvent(activity({ sequence: 2, activityId: 'b', label: 'reading b.ts' }));
  addEvent(activity({ sequence: 3, activityId: 'c', label: 'reading c.ts' }));
  addEvent(activity({ sequence: 4, activityId: 'd', label: 'reading d.ts' }));
  return activityBatchKey(0, 'call-1');
}

function seedDiff(): string {
  addEvent({
    type: 'implementer_generate_done',
    ts: 1,
    phase: 'implementing',
    taskId: taskId('T001'),
    file: 'src/app.ts',
    diff: '+ changed',
    linesAdded: 1,
    linesRemoved: 0,
    duration: 10,
  });
  // The key is the diff's global render index (0 for the only event), not its timestamp.
  return 'implementer_generate_done:0';
}

describe('useWorkflowKeys', () => {
  beforeEach(() => {
    resetAllStores();
    completionStore.reset();
    questionPromptStore.reset();
  });

  afterEach(() => {
    resetAllStores();
    completionStore.reset();
    questionPromptStore.reset();
  });

  it('Ctrl+G opens the cost-drilldown overlay', async () => {
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);
    expect(overlayStore.get().active).toBe('none');

    await flushEffects();
    ui.stdin.write('\x07');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');
    ui.unmount();
  });

  it('Ctrl+A toggles the latest expandable activity batch', async () => {
    const key = seedExpandableActivityBatch();
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);

    await flushEffects();
    ui.stdin.write(CTRL_A);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(true);

    await flushEffects();
    ui.stdin.write(CTRL_A);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);
    ui.unmount();
  });

  it('Alt+A does not toggle activity expansion', async () => {
    const key = seedExpandableActivityBatch();
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('\x1ba');
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);
    ui.unmount();
  });

  it('Ctrl+B, Ctrl+E, and Ctrl+F stay with normal composer focus', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    reviewStore.setScrollOffset(20);
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write(CTRL_B);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(20);

    await flushEffects();
    ui.stdin.write(CTRL_F);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(20);

    await flushEffects();
    ui.stdin.write(CTRL_E);
    await tick(1);
    await tick(1);
    // The point is that none of these keys touched the sidebar, so compare against the default
    // rather than a literal that has to be edited every time the default moves.
    expect(controlsStore.get().sidebarVisible).toBe(sidebarDefault);
    ui.unmount();
  });

  it('Ctrl+D toggles the latest workflow diff by its unique render-index key', async () => {
    const key = seedDiff();
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedDiffs.has(key)).toBe(false);

    await flushEffects();
    ui.stdin.write(CTRL_D);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedDiffs.has(key)).toBe(true);
    ui.unmount();
  });

  it('attached Ctrl+D does not toggle the latest workflow diff', async () => {
    routerStore.init({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'attached test',
        sessionId: 'attached-session',
        attach: { sockPath: '/tmp/splitbrief.sock', authToken: 'token' },
      },
    });
    const key = seedDiff();
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write(CTRL_D);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedDiffs.has(key)).toBe(false);
    ui.unmount();
  });

  it('plain a and A do not toggle activity expansion while composing', async () => {
    const key = seedExpandableActivityBatch();
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('a');
    await flushEffects();
    ui.stdin.write('A');
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);
    ui.unmount();
  });

  it("plain '$' does not open the cost-drilldown overlay while composing", async () => {
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('$');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('plain g and G leave every overlay closed so they stay composer text', async () => {
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('g');
    await flushEffects();
    ui.stdin.write('G');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('leaves cost-drilldown key handling to the overlay while it is open', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');

    await flushEffects();
    ui.stdin.write('x');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');
    ui.unmount();
  });

  it('completion and non-cost overlays keep workflow chords and transcript scroll', async () => {
    seedLongConversation();
    completionStore.setOpen(true);
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('\x07');
    await tick(1);

    expect(overlayStore.get().active).toBe('none');

    await flushEffects();
    ui.stdin.write(SHIFT_UP);
    await tick(1);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);

    completionStore.setOpen(false);
    overlayStore.open('help');
    await flushEffects();
    ui.stdin.write('\x07');
    await flushEffects();
    ui.stdin.write(SHIFT_UP);
    await tick(1);

    expect(overlayStore.get().active).toBe('help');
    expect(conversationScrollStore.get().scrollOffset).toBe(0);

    overlayStore.close();
    await flushEffects();
    ui.stdin.write(SHIFT_UP);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().scrollOffset).toBe(1);
    ui.unmount();
  });

  it('Shift+↓ scrolls the open review pane even while inputMode is review', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);

    await flushEffects();
    ui.stdin.write(SHIFT_DOWN);
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBe(1);
    ui.unmount();
  });

  it('Shift+↑ scrolls the open review pane back up while inputMode is review', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    reviewStore.setScrollOffset(5);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write(SHIFT_UP);
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBe(4);
    ui.unmount();
  });

  it('plain arrows do not scroll the open review pane while inputMode is review', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write(ARROW_UP);
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBe(0);
    ui.unmount();
  });

  it('Home, PageUp, PageDown, End, and Ctrl+B/F scroll the open review pane', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write(PAGE_DOWN);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeGreaterThan(0);

    const afterPageDown = reviewStore.get().scrollOffset;
    await flushEffects();
    ui.stdin.write(CTRL_B);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeLessThan(afterPageDown);

    await flushEffects();
    ui.stdin.write(CTRL_F);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeGreaterThan(0);

    await flushEffects();
    ui.stdin.write(END);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeGreaterThan(0);

    await flushEffects();
    ui.stdin.write(HOME);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);

    await flushEffects();
    ui.stdin.write(PAGE_UP);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);
    ui.unmount();
  });

  it('PageDown and End use the simple brief task viewport to reach the final task', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 25, isSmall: false });
    inputHeightStore.__testReset({ rows: 3 });
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    reviewStore.setReviewFile('/tmp/tasks.md', 20);
    controlsStore.setInputMode('review');
    const visibleTasks = readReviewContentHeight();
    const maxTaskOffset = 20 - visibleTasks;
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write(PAGE_DOWN);
    await tick(1);
    await tick(1);
    // One page is a full task viewport, clamped to the last reachable offset when the taller
    // chrome-free body already shows most of the list.
    expect(reviewStore.get().scrollOffset).toBe(Math.min(visibleTasks, maxTaskOffset));

    for (let i = 0; i < 10; i += 1) {
      await flushEffects();
      ui.stdin.write(PAGE_DOWN);
      await tick(1);
    }
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(maxTaskOffset);

    await flushEffects();
    ui.stdin.write(HOME);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);

    await flushEffects();
    ui.stdin.write(END);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(maxTaskOffset);
    ui.unmount();
  });

  it.each(VIEWPORTS)(
    '$label keys start from canonical clamped offsets and keep the sibling pane fixed',
    async ({ cols, rows }) => {
      terminalSizeStore.__testReset({ cols, rows });
      inputHeightStore.__testReset({ rows: 3 });
      seedLongConversation();

      const initialConversation = readConversationScrollSnapshot();
      expect(initialConversation.maxOffset).toBeGreaterThan(1);
      conversationScrollStore.__testReset({
        scrollOffset: initialConversation.maxOffset + 10,
      });
      const visibleConversation = readConversationScrollSnapshot();
      reviewStore.setScrollOffset(7);

      const ui = render(<Harness />);
      await tick(1);
      await flushEffects();
      ui.stdin.write(SHIFT_DOWN);
      await tick(1);
      await tick(1);

      expect(readConversationScrollSnapshot().scrollOffset).toBe(visibleConversation.maxOffset - 1);
      expect(reviewStore.get().scrollOffset).toBe(7);

      const conversationOffset = conversationScrollStore.get().scrollOffset;
      reviewStore.setReviewFile('/tmp/spec.md', 100);
      controlsStore.setInputMode('review');
      const reviewMaxOffset = 100 - readReviewContentHeight();
      reviewStore.setScrollOffset(reviewMaxOffset + 10);
      await flushEffects();
      ui.stdin.write(SHIFT_UP);
      await tick(1);
      await tick(1);

      expect(reviewStore.get().scrollOffset).toBe(reviewMaxOffset - 1);
      expect(conversationScrollStore.get().scrollOffset).toBe(conversationOffset);
      ui.unmount();
    },
  );

  it('question ownership scrolls through resize and resumes from the visible offset', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    inputHeightStore.__testReset({ rows: 3 });
    seedLongConversation();
    const narrow = readConversationScrollSnapshot();
    conversationScrollStore.__testReset({ scrollOffset: narrow.maxOffset });
    questionPromptStore.setHint(
      'Question 1/1: Which implementation boundary should own this behavior?',
    );
    controlsStore.setInputMode('question');

    const ui = render(<Harness />);
    await tick(1);
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    await flushEffects();
    const asked = readConversationScrollSnapshot();
    expect(asked.scrollOffset).toBeLessThan(narrow.maxOffset);
    ui.stdin.write(SHIFT_DOWN);
    await tick(1);
    await tick(1);

    expect(readConversationScrollSnapshot().scrollOffset).toBe(asked.scrollOffset - 1);

    controlsStore.setInputMode('normal');
    questionPromptStore.clearHint();
    const wide = readConversationScrollSnapshot();
    expect(wide.maxOffset).toBeLessThan(asked.maxOffset);
    await flushEffects();
    ui.stdin.write(SHIFT_DOWN);
    await tick(1);
    await tick(1);

    expect(readConversationScrollSnapshot().scrollOffset).toBe(wide.scrollOffset - 1);
    ui.unmount();
  });

  it('question ownership pages the transcript and leaves Ctrl+B to the answer composer', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    inputHeightStore.__testReset({ rows: 3 });
    seedLongConversation();
    questionPromptStore.setHint('Question 1/1: Which boundary should own this behavior?');
    controlsStore.setInputMode('question');

    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();
    ui.stdin.write(PAGE_UP);
    await tick(1);
    await tick(1);

    const paged = readConversationScrollSnapshot().scrollOffset;
    expect(paged).toBeGreaterThan(0);

    await flushEffects();
    ui.stdin.write(CTRL_B);
    await tick(1);
    await tick(1);
    expect(readConversationScrollSnapshot().scrollOffset).toBe(paged);

    await flushEffects();
    ui.stdin.write(PAGE_DOWN);
    await tick(1);
    await tick(1);
    expect(readConversationScrollSnapshot().scrollOffset).toBeLessThan(paged);

    const maxOffset = readConversationScrollSnapshot().maxOffset;
    await flushEffects();
    ui.stdin.write(HOME);
    await tick(1);
    await tick(1);
    expect(readConversationScrollSnapshot().scrollOffset).toBe(maxOffset);

    await flushEffects();
    ui.stdin.write(END);
    await tick(1);
    await tick(1);
    expect(readConversationScrollSnapshot().scrollOffset).toBe(0);
    ui.unmount();
  });

  it('plain G does not scroll the open review pane so it stays composer text', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('G');
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBe(0);
    ui.unmount();
  });
});

describe('useWorkflowKeys suspended while a prompt is pending', () => {
  beforeEach(() => {
    resetAllStores();
    completionStore.reset();
    questionPromptStore.reset();
  });

  afterEach(() => {
    resetAllStores();
    completionStore.reset();
    questionPromptStore.reset();
  });

  it('prompt ownership blocks workflow chords and transcript scroll', async () => {
    seedLongConversation();
    const ui = render(<Harness isActive={false} />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('\x07');
    await flushEffects();
    ui.stdin.write(SHIFT_UP);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    ui.unmount();
  });

  it('does not close the cost-drilldown overlay with x while workflow keys are inactive', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness isActive={false} />);
    await tick(1);
    await flushEffects();

    ui.stdin.write('x');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');
    ui.unmount();
  });
});
