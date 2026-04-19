import { beforeEach, describe, expect, it } from 'vitest';
import { overlayStore } from './overlay.js';

describe('overlayStore', () => {
  beforeEach(() => overlayStore.reset());

  it('opens and closes a single overlay with exclusive-input toggle', () => {
    // Fresh store starts idle
    expect(overlayStore.get()).toMatchObject({ active: 'none', exclusive: false, stack: [] });

    // Opening transitions to active with no stack
    overlayStore.open('help');
    expect(overlayStore.get()).toMatchObject({ active: 'help', exclusive: false, stack: [] });

    // Exclusive input is a separate toggle
    overlayStore.setExclusive(true);
    expect(overlayStore.get().exclusive).toBe(true);

    // close returns to idle, and always clears exclusive
    overlayStore.close();
    expect(overlayStore.get()).toMatchObject({ active: 'none', exclusive: false, stack: [] });
  });

  it('stacks overlays and pops back on close — parent focus preserved', () => {
    // Opening from idle does NOT push a stack frame
    overlayStore.open('settings', 'planner.tool');
    expect(overlayStore.get().active).toBe('settings');
    expect(overlayStore.get().stack).toEqual([]);

    // Opening a second overlay pushes the parent (with its focus) onto the stack
    overlayStore.open('planner-picker', 'models');
    expect(overlayStore.get()).toMatchObject({
      active: 'planner-picker',
      focus: 'models',
      stack: [{ type: 'settings', focus: 'planner.tool' }],
    });

    // Closing pops the parent back and restores its focus
    overlayStore.close();
    expect(overlayStore.get()).toMatchObject({
      active: 'settings',
      focus: 'planner.tool',
      stack: [],
    });

    // One more close returns to idle
    overlayStore.close();
    expect(overlayStore.get()).toMatchObject({ active: 'none', stack: [] });
  });

  it('updates focus without double-stacking when re-opening the same overlay', () => {
    overlayStore.open('settings', 'planner.tool');

    // Re-opening with the same type/focus is a no-op on the stack
    overlayStore.open('settings', 'planner.tool');
    expect(overlayStore.get().stack).toEqual([]);

    // Same type, different focus — focus updates, and since the active overlay
    // has changed focus, the previous (self) frame is pushed onto the stack
    overlayStore.open('settings', 'implementer.model');
    expect(overlayStore.get().focus).toBe('implementer.model');
    expect(overlayStore.get().stack).toEqual([{ type: 'settings', focus: 'planner.tool' }]);

    // Opening again without focus clears it
    overlayStore.open('settings');
    expect(overlayStore.get().focus).toBeUndefined();
  });

  it('setExclusive toggles exclusive-input independently of the active overlay', () => {
    overlayStore.setExclusive(true);
    expect(overlayStore.get().exclusive).toBe(true);
    overlayStore.setExclusive(false);
    expect(overlayStore.get().exclusive).toBe(false);
  });

  it('reset clears active, focus, exclusive, and the whole stack', () => {
    overlayStore.open('settings', 'planner.tool');
    overlayStore.open('planner-picker', 'models');
    overlayStore.setExclusive(true);

    overlayStore.reset();

    expect(overlayStore.get()).toEqual({ active: 'none', exclusive: false, stack: [] });
  });
});
