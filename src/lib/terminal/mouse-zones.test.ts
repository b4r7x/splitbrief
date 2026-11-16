import { beforeEach, describe, expect, it } from 'vitest';
import { _resetMouseZones, clickAt, hitTopmostZone, registerMouseZone } from './mouse-zones.js';

beforeEach(() => {
  _resetMouseZones();
});

describe('mouse-zones', () => {
  it('hits a zone whose rect contains the point', () => {
    registerMouseZone({ id: 'a', left: 2, right: 6, top: 3, bottom: 3, z: 0, owner: {} });
    expect(hitTopmostZone(4, 3)?.id).toBe('a');
    expect(hitTopmostZone(1, 3)).toBeUndefined();
    expect(hitTopmostZone(4, 4)).toBeUndefined();
  });

  it('picks the highest z when zones overlap', () => {
    registerMouseZone({ id: 'low', left: 1, right: 10, top: 1, bottom: 5, z: 0, owner: {} });
    registerMouseZone({ id: 'high', left: 1, right: 10, top: 1, bottom: 5, z: 5, owner: {} });
    expect(hitTopmostZone(5, 3)?.id).toBe('high');
  });

  it('replaces a zone registered under an existing id', () => {
    registerMouseZone({ id: 'x', left: 1, right: 2, top: 1, bottom: 1, z: 0, owner: {} });
    registerMouseZone({ id: 'x', left: 8, right: 9, top: 1, bottom: 1, z: 0, owner: {} });
    expect(hitTopmostZone(1, 1)).toBeUndefined();
    expect(hitTopmostZone(8, 1)?.id).toBe('x');
  });

  it('does not unregister a replaced zone when an old disposer runs', () => {
    const dispose1 = registerMouseZone({
      id: 'x',
      left: 1,
      right: 2,
      top: 1,
      bottom: 1,
      z: 0,
      owner: {},
    });
    registerMouseZone({ id: 'x', left: 8, right: 9, top: 1, bottom: 1, z: 0, owner: {} });
    dispose1();
    expect(hitTopmostZone(8, 1)?.id).toBe('x');
    expect(hitTopmostZone(1, 1)).toBeUndefined();
  });

  it('unregisters via the returned disposer', () => {
    const dispose = registerMouseZone({
      id: 'a',
      left: 1,
      right: 4,
      top: 1,
      bottom: 1,
      z: 0,
      owner: {},
    });
    dispose();
    expect(hitTopmostZone(2, 1)).toBeUndefined();
  });

  it('skips zones below the requested minimum layer', () => {
    registerMouseZone({ id: 'screen', left: 1, right: 10, top: 1, bottom: 1, z: 50, owner: {} });
    registerMouseZone({ id: 'overlay', left: 1, right: 10, top: 2, bottom: 2, z: 100, owner: {} });

    // A floor above the screen zone hides it while keeping the overlay zone reachable.
    expect(hitTopmostZone(5, 1, { minZ: 100 })).toBeUndefined();
    expect(hitTopmostZone(5, 2, { minZ: 100 })?.id).toBe('overlay');
    // Without a floor both layers are eligible.
    expect(hitTopmostZone(5, 1)?.id).toBe('screen');
  });

  describe('a click read against the frame on screen', () => {
    const at = { left: 1, right: 10, top: 1, bottom: 1, z: 0 };

    it('runs the handler that its row holds when the action runs, at the place it moved to', () => {
      const row = {};
      const log: string[] = [];
      registerMouseZone({ id: 'row:a', ...at, owner: row, onClick: () => log.push('drawn') });
      const action = clickAt(5, 1);
      registerMouseZone({
        id: 'row:a',
        ...at,
        top: 4,
        bottom: 4,
        owner: row,
        onClick: () => log.push('now'),
      });
      action?.();
      expect(log).toEqual(['now']);
    });

    it('does nothing when another row holds the id of the drawn row', () => {
      const log: string[] = [];
      const dispose = registerMouseZone({
        id: 'row:a',
        ...at,
        owner: {},
        onClick: () => log.push('drawn'),
      });
      const action = clickAt(5, 1);
      dispose();
      registerMouseZone({ id: 'row:a', ...at, owner: {}, onClick: () => log.push('other') });
      action?.();
      expect(log).toEqual([]);
    });

    it('does nothing when the drawn row is gone', () => {
      const log: string[] = [];
      const dispose = registerMouseZone({
        id: 'row:a',
        ...at,
        owner: {},
        onClick: () => log.push('drawn'),
      });
      const action = clickAt(5, 1);
      dispose();
      action?.();
      expect(log).toEqual([]);
    });

    it('reads no click where the frame shows no zone', () => {
      expect(clickAt(5, 1)).toBeUndefined();
    });
  });
});
