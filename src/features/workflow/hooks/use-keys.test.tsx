import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { addEvent } from '../../../stores/workflow/actions.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { activityBatchKey } from '../conversation-rows/activity-batch-key.js';
import { useWorkflowKeys } from './use-keys.js';

const CTRL_A = '\x01';
const CTRL_B = '\x02';
const CTRL_F = '\x06';
const ALT_A = '\x1ba';
const SHIFT_UP = '\x1B[1;2A';
const SHIFT_DOWN = '\x1B[1;2B';
const PAGE_UP = '\x1B[5~';
const PAGE_DOWN = '\x1B[6~';
const HOME = '\x1B[H';
const END = '\x1B[F';
const ARROW_UP = '\x1B[A';
const ARROW_DOWN = '\x1B[B';

function Harness() {
  useWorkflowKeys({ isActive: true });
  return <Text> </Text>;
}

function activity(
  overrides: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: overrides.ts ?? 0,
    phase: overrides.phase ?? 'researching',
    callId: overrides.callId ?? 'call-1',
    role: overrides.role ?? 'planner',
    backendKind: overrides.backendKind ?? 'cli',
    runnerName: overrides.runnerName ?? 'codex',
    sequence: overrides.sequence ?? 1,
    activityId: overrides.activityId ?? 'activity-1',
    stage: overrides.stage ?? 'updated',
    kind: overrides.kind ?? 'read',
    label: overrides.label ?? 'reading file.ts',
    redacted: overrides.redacted ?? false,
    ...(overrides.target !== undefined && { target: overrides.target }),
  };
}

function seedExpandableActivityBatch(): string {
  addEvent(activity({ sequence: 1, activityId: 'a', label: 'reading a.ts' }));
  addEvent(activity({ sequence: 2, activityId: 'b', label: 'reading b.ts' }));
  addEvent(activity({ sequence: 3, activityId: 'c', label: 'reading c.ts' }));
  addEvent(activity({ sequence: 4, activityId: 'd', label: 'reading d.ts' }));
  return activityBatchKey(0, 'call-1');
}

describe('useWorkflowKeys', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('Ctrl+G opens the cost-drilldown overlay', async () => {
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);
    expect(overlayStore.get().active).toBe('none');

    ui.stdin.write('\x07');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');
    ui.unmount();
  });

  it('Alt+A toggles the latest expandable activity batch', async () => {
    const key = seedExpandableActivityBatch();
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);

    ui.stdin.write(ALT_A);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(true);

    ui.stdin.write(ALT_A);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);
    ui.unmount();
  });

  it('Ctrl+A does not toggle activity expansion while composing', async () => {
    const key = seedExpandableActivityBatch();
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write(CTRL_A);
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);
    ui.unmount();
  });

  it('plain a and A do not toggle activity expansion while composing', async () => {
    const key = seedExpandableActivityBatch();
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write('a');
    await tick(1);
    ui.stdin.write('A');
    await tick(1);
    await tick(1);

    expect(conversationScrollStore.get().expandedActivityBatches.has(key)).toBe(false);
    ui.unmount();
  });

  it("plain '$' does not open the cost-drilldown overlay while composing", async () => {
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write('$');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('plain g and G leave every overlay closed so they stay composer text', async () => {
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write('g');
    await tick(1);
    ui.stdin.write('G');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('any keypress closes the cost-drilldown overlay when it is open', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');

    ui.stdin.write('x');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Escape closes the cost-drilldown overlay', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write('\x1B');
    await tick(1);
    await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Shift+↓ scrolls the open review pane even while inputMode is review', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);

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
    await tick(1);

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
    await tick(1);

    ui.stdin.write(ARROW_DOWN);
    await tick(1);
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
    await tick(1);

    ui.stdin.write(PAGE_DOWN);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeGreaterThan(0);

    const afterPageDown = reviewStore.get().scrollOffset;
    ui.stdin.write(CTRL_B);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeLessThan(afterPageDown);

    ui.stdin.write(CTRL_F);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeGreaterThan(0);

    ui.stdin.write(END);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBeGreaterThan(0);

    ui.stdin.write(HOME);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);

    ui.stdin.write(PAGE_UP);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);
    ui.unmount();
  });

  it('plain G does not scroll the open review pane so it stays composer text', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write('G');
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBe(0);
    ui.unmount();
  });
});
