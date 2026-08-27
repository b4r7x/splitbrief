import { beforeEach, describe, expect, it } from 'vitest';
import { overlayStore } from './overlay.js';

describe('overlayStore', () => {
  beforeEach(() => overlayStore.reset());

  it('opens and closes a single overlay with exclusive-input toggle', () => {
    expect(overlayStore.get()).toMatchObject({ active: 'none', exclusive: false, stack: [] });

    overlayStore.open('help');
    expect(overlayStore.get()).toMatchObject({ active: 'help', exclusive: false, stack: [] });

    overlayStore.setExclusive(true);
    expect(overlayStore.get().exclusive).toBe(true);

    overlayStore.close();
    expect(overlayStore.get()).toMatchObject({ active: 'none', exclusive: false, stack: [] });
  });

  it('stacks overlays and pops back on close — parent focus preserved', () => {
    overlayStore.open('settings', 'planner.tool');
    expect(overlayStore.get().active).toBe('settings');
    expect(overlayStore.get().stack).toEqual([]);

    overlayStore.open('planner-picker', 'models');
    expect(overlayStore.get()).toMatchObject({
      active: 'planner-picker',
      focus: 'models',
      stack: [{ type: 'settings', focus: 'planner.tool' }],
    });

    overlayStore.close();
    expect(overlayStore.get()).toMatchObject({
      active: 'settings',
      focus: 'planner.tool',
      stack: [],
    });

    overlayStore.close();
    expect(overlayStore.get()).toMatchObject({ active: 'none', stack: [] });
  });

  it('updates focus without double-stacking when re-opening the same overlay', () => {
    overlayStore.open('settings', 'planner.tool');

    overlayStore.open('settings', 'planner.tool');
    expect(overlayStore.get().stack).toEqual([]);

    // Same type, different focus — focus updates, and since the active overlay
    // has changed focus, the previous (self) frame is pushed onto the stack
    overlayStore.open('settings', 'implementer.model');
    expect(overlayStore.get().focus).toBe('implementer.model');
    expect(overlayStore.get().stack).toEqual([{ type: 'settings', focus: 'planner.tool' }]);

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
