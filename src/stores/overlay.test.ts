import { describe, it, expect, beforeEach } from 'vitest';
import { overlayStore } from './overlay.js';

describe('overlayStore', () => {
  beforeEach(() => overlayStore.reset());

  it('starts with no active overlay', () => {
    expect(overlayStore.get().active).toBe('none');
    expect(overlayStore.get().exclusive).toBe(false);
  });

  it('opens an overlay', () => {
    overlayStore.open('help');
    expect(overlayStore.get().active).toBe('help');
  });

  it('closes an overlay and resets exclusive', () => {
    overlayStore.open('picker');
    overlayStore.setExclusive(true);
    overlayStore.close();
    expect(overlayStore.get().active).toBe('none');
    expect(overlayStore.get().exclusive).toBe(false);
  });

  it('switches between overlays', () => {
    overlayStore.open('help');
    overlayStore.open('skills');
    expect(overlayStore.get().active).toBe('skills');
  });

  it('sets exclusive input', () => {
    overlayStore.setExclusive(true);
    expect(overlayStore.get().exclusive).toBe(true);
    overlayStore.setExclusive(false);
    expect(overlayStore.get().exclusive).toBe(false);
  });
});
