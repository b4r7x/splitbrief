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

    overlayStore.setExclusive(true);
    overlayStore.open('planner-picker', 'models');
    expect(overlayStore.get()).toMatchObject({
      active: 'planner-picker',
      focus: 'models',
      exclusive: false,
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

    overlayStore.open('settings', 'implementer.model');
    expect(overlayStore.get().focus).toBe('implementer.model');
    expect(overlayStore.get().stack).toEqual([]);

    overlayStore.open('settings');
    expect(overlayStore.get().focus).toBeUndefined();
    expect(overlayStore.get().stack).toEqual([]);
  });

  it('clears omitted focus without clearing exclusivity or stacking the active overlay', () => {
    overlayStore.open('settings', 'planner.tool');
    overlayStore.setExclusive(true);

    overlayStore.open('settings');

    expect(overlayStore.get()).toEqual({
      active: 'settings',
      focus: undefined,
      exclusive: true,
      stack: [],
    });
  });

  it('changes defined focus while keeping exclusivity and the existing stack', () => {
    overlayStore.open('settings', 'planner.tool');
    overlayStore.setExclusive(true);
    const before = overlayStore.get();

    overlayStore.open('settings', 'planner.tool');
    expect(overlayStore.get()).toBe(before);

    overlayStore.open('settings', 'implementer.model');
    expect(overlayStore.get()).toEqual({
      active: 'settings',
      focus: 'implementer.model',
      exclusive: true,
      stack: [],
    });
    expect(overlayStore.get().stack).toBe(before.stack);

    overlayStore.close();
    expect(overlayStore.get().active).toBe('none');

    overlayStore.open('help');
    overlayStore.open('settings', 'planner.tool');
    overlayStore.setExclusive(true);
    const stacked = overlayStore.get();

    overlayStore.open('settings', 'implementer.model');
    expect(overlayStore.get()).toEqual({ ...stacked, focus: 'implementer.model' });
    expect(overlayStore.get().stack).toBe(stacked.stack);

    overlayStore.close();
    expect(overlayStore.get()).toEqual({
      active: 'help',
      focus: undefined,
      exclusive: false,
      stack: [],
    });
  });

  it('keeps an active exclusive overlay as it is when the same overlay opens again', () => {
    overlayStore.open('editor');
    overlayStore.setExclusive(true);
    const before = overlayStore.get();

    overlayStore.open('editor');

    expect(overlayStore.get()).toBe(before);
    expect(overlayStore.get()).toEqual({ active: 'editor', exclusive: true, stack: [] });
  });

  it('closes a directly opened seat picker back to the screen, not into settings', () => {
    // The /crew hop opens the seat picker with no overlay beneath it,
    // so Esc must land on the previous screen — never on Settings.
    overlayStore.open('planner-picker', 'models');
    expect(overlayStore.get().stack).toEqual([]);

    overlayStore.close();
    expect(overlayStore.get()).toEqual({ active: 'none', exclusive: false, stack: [] });
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
