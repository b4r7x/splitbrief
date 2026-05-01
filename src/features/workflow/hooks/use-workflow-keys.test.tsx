import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { useWorkflowKeys } from './use-workflow-keys.js';

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

  it("pressing '$' opens the cost-drilldown overlay", async () => {
    const ui = render(<Harness />);
    await tick(1); await tick(1);
    expect(overlayStore.get().active).toBe('none');

    ui.stdin.write('$');
    await tick(1); await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');
    ui.unmount();
  });

  it('any keypress closes the cost-drilldown overlay when it is open', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness />);
    await tick(1); await tick(1);

    expect(overlayStore.get().active).toBe('cost-drilldown');

    ui.stdin.write('x');
    await tick(1); await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Escape closes the cost-drilldown overlay', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness />);
    await tick(1); await tick(1);

    ui.stdin.write('\x1B');
    await tick(1); await tick(1);

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });
});
