import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { useWorkflowKeys } from './use-keys.js';

function Harness() {
  useWorkflowKeys(true);
  return <Text> </Text>;
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

  it('↓ scrolls the open review pane even while inputMode is review', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);
    expect(reviewStore.get().scrollOffset).toBe(0);

    ui.stdin.write('\x1B[B');
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBe(1);
    ui.unmount();
  });

  it('↑ scrolls the open review pane back up while inputMode is review', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    reviewStore.setScrollOffset(5);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write('\x1B[A');
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBe(4);
    ui.unmount();
  });

  it('End jumps to the bottom of the open review pane while inputMode is review', async () => {
    reviewStore.setReviewFile('/tmp/spec.md', 1000);
    controlsStore.setInputMode('review');
    const ui = render(<Harness />);
    await tick(1);
    await tick(1);

    ui.stdin.write('\x1B[F');
    await tick(1);
    await tick(1);

    expect(reviewStore.get().scrollOffset).toBeGreaterThan(0);
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
