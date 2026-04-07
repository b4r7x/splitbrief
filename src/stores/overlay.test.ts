import { describe, it, expect, beforeEach } from 'vitest';
import { overlayStore } from './overlay.js';

describe('overlayStore', () => {
  beforeEach(() => overlayStore.reset());

  it('starts with no active overlay', () => {
    expect(overlayStore.get().active).toBe('none');
    expect(overlayStore.get().exclusive).toBe(false);
    expect(overlayStore.get().stack).toEqual([]);
  });

  it('opens an overlay', () => {
    overlayStore.open('help');
    expect(overlayStore.get().active).toBe('help');
    expect(overlayStore.get().stack).toEqual([]);
  });

  it('closes an overlay and resets exclusive', () => {
    overlayStore.open('settings');
    overlayStore.setExclusive(true);
    overlayStore.close();
    expect(overlayStore.get().active).toBe('none');
    expect(overlayStore.get().exclusive).toBe(false);
    expect(overlayStore.get().stack).toEqual([]);
  });

  it('switches between overlays and pushes onto stack', () => {
    overlayStore.open('help');
    overlayStore.open('skills');
    expect(overlayStore.get().active).toBe('skills');
    expect(overlayStore.get().stack).toEqual([{ type: 'help', focus: undefined }]);
  });

  it('sets exclusive input', () => {
    overlayStore.setExclusive(true);
    expect(overlayStore.get().exclusive).toBe(true);
    overlayStore.setExclusive(false);
    expect(overlayStore.get().exclusive).toBe(false);
  });

  it('short-circuits when open() called with same type', () => {
    overlayStore.open('help');
    const before = overlayStore.get();
    overlayStore.open('help');
    expect(overlayStore.get()).toBe(before);
  });

  it('short-circuits when setExclusive() called with same value', () => {
    overlayStore.setExclusive(true);
    overlayStore.setExclusive(true);
    expect(overlayStore.get().exclusive).toBe(true);
  });

  it('open() resets exclusive to false', () => {
    overlayStore.open('settings');
    overlayStore.setExclusive(true);
    overlayStore.open('planner-picker');
    expect(overlayStore.get().active).toBe('planner-picker');
    expect(overlayStore.get().exclusive).toBe(false);
  });

  describe('focus', () => {
    it('stores focus when opening with focus param', () => {
      overlayStore.open('settings', 'planner.tool');
      expect(overlayStore.get().focus).toBe('planner.tool');
    });

    it('clears focus when opening without focus param', () => {
      overlayStore.open('settings', 'planner.tool');
      overlayStore.open('settings');
      expect(overlayStore.get().focus).toBeUndefined();
    });

    it('short-circuits when same type and same focus', () => {
      overlayStore.open('settings', 'planner.tool');
      const before = overlayStore.get();
      overlayStore.open('settings', 'planner.tool');
      expect(overlayStore.get()).toBe(before);
    });

    it('updates when same type but different focus', () => {
      overlayStore.open('settings', 'planner.tool');
      overlayStore.open('settings', 'implementer.model');
      expect(overlayStore.get().focus).toBe('implementer.model');
    });

    it('close clears focus', () => {
      overlayStore.open('settings', 'planner.tool');
      overlayStore.close();
      expect(overlayStore.get().focus).toBeUndefined();
    });
  });

  describe('stack', () => {
    it('open from none does not push onto stack', () => {
      overlayStore.open('planner-picker');
      expect(overlayStore.get().active).toBe('planner-picker');
      expect(overlayStore.get().stack).toEqual([]);
    });

    it('open from active overlay pushes parent onto stack', () => {
      overlayStore.open('settings');
      overlayStore.open('planner-picker', 'models');
      expect(overlayStore.get().active).toBe('planner-picker');
      expect(overlayStore.get().focus).toBe('models');
      expect(overlayStore.get().stack).toEqual([{ type: 'settings', focus: undefined }]);
    });

    it('close pops stack and restores parent', () => {
      overlayStore.open('settings');
      overlayStore.open('planner-picker', 'models');
      overlayStore.close();
      expect(overlayStore.get().active).toBe('settings');
      expect(overlayStore.get().focus).toBeUndefined();
      expect(overlayStore.get().stack).toEqual([]);
    });

    it('close from restored parent goes to none', () => {
      overlayStore.open('settings');
      overlayStore.open('planner-picker');
      overlayStore.close();
      overlayStore.close();
      expect(overlayStore.get().active).toBe('none');
      expect(overlayStore.get().stack).toEqual([]);
    });

    it('close with empty stack returns to initial state', () => {
      overlayStore.open('planner-picker');
      overlayStore.close();
      expect(overlayStore.get().active).toBe('none');
      expect(overlayStore.get().stack).toEqual([]);
    });

    it('preserves parent focus in stack', () => {
      overlayStore.open('settings', 'planner.tool');
      overlayStore.open('planner-picker', 'models');
      expect(overlayStore.get().stack).toEqual([{ type: 'settings', focus: 'planner.tool' }]);
      overlayStore.close();
      expect(overlayStore.get().active).toBe('settings');
      expect(overlayStore.get().focus).toBe('planner.tool');
    });

    it('reset clears everything including stack', () => {
      overlayStore.open('settings');
      overlayStore.open('planner-picker');
      overlayStore.reset();
      expect(overlayStore.get().active).toBe('none');
      expect(overlayStore.get().exclusive).toBe(false);
      expect(overlayStore.get().stack).toEqual([]);
    });
  });
});
