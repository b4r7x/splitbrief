import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { resetAllStores } from '#testing/helpers/stores.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { useWorkflowKeys } from './use-workflow-keys.js';

function Harness() {
  useWorkflowKeys(true);
  return <Text> </Text>;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
    await tick();
    expect(overlayStore.get().active).toBe('none');

    ui.stdin.write('$');
    await tick();

    expect(overlayStore.get().active).toBe('cost-drilldown');
    ui.unmount();
  });

  it('any keypress closes the cost-drilldown overlay when it is open', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness />);
    await tick();

    expect(overlayStore.get().active).toBe('cost-drilldown');

    ui.stdin.write('x');
    await tick();

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });

  it('Escape closes the cost-drilldown overlay', async () => {
    overlayStore.open('cost-drilldown');
    const ui = render(<Harness />);
    await tick();

    ui.stdin.write('\x1B');
    await tick();

    expect(overlayStore.get().active).toBe('none');
    ui.unmount();
  });
});
