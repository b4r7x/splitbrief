import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetMouseZones,
  hitTopmostZone,
  registerMouseZone,
  unregisterMouseZone,
} from './mouse-zones.js';

beforeEach(() => {
  _resetMouseZones();
});

describe('mouse-zones', () => {
  it('hits a zone whose rect contains the point', () => {
    registerMouseZone({ id: 'a', left: 2, right: 6, top: 3, bottom: 3, z: 0 });
    expect(hitTopmostZone(4, 3)?.id).toBe('a');
    expect(hitTopmostZone(1, 3)).toBeUndefined();
    expect(hitTopmostZone(4, 4)).toBeUndefined();
  });

  it('picks the highest z when zones overlap', () => {
    registerMouseZone({ id: 'low', left: 1, right: 10, top: 1, bottom: 5, z: 0 });
    registerMouseZone({ id: 'high', left: 1, right: 10, top: 1, bottom: 5, z: 5 });
    expect(hitTopmostZone(5, 3)?.id).toBe('high');
  });

  it('replaces a zone registered under an existing id', () => {
    registerMouseZone({ id: 'x', left: 1, right: 2, top: 1, bottom: 1, z: 0 });
    registerMouseZone({ id: 'x', left: 8, right: 9, top: 1, bottom: 1, z: 0 });
    expect(hitTopmostZone(1, 1)).toBeUndefined();
    expect(hitTopmostZone(8, 1)?.id).toBe('x');
  });

  it('does not unregister a replaced zone when an old disposer runs', () => {
    const dispose1 = registerMouseZone({ id: 'x', left: 1, right: 2, top: 1, bottom: 1, z: 0 });
    registerMouseZone({ id: 'x', left: 8, right: 9, top: 1, bottom: 1, z: 0 });
    dispose1();
    expect(hitTopmostZone(8, 1)?.id).toBe('x');
    expect(hitTopmostZone(1, 1)).toBeUndefined();
  });

  it('unregisters via the returned disposer', () => {
    const dispose = registerMouseZone({ id: 'a', left: 1, right: 4, top: 1, bottom: 1, z: 0 });
    dispose();
    expect(hitTopmostZone(2, 1)).toBeUndefined();
  });

  it('unregisters by id', () => {
    registerMouseZone({ id: 'a', left: 1, right: 4, top: 1, bottom: 1, z: 0 });
    unregisterMouseZone('a');
    expect(hitTopmostZone(2, 1)).toBeUndefined();
  });

  it('invokes the zone onClick handler', () => {
    const onClick = vi.fn();
    registerMouseZone({ id: 'a', left: 1, right: 4, top: 1, bottom: 1, z: 0, onClick });
    hitTopmostZone(2, 1)?.onClick?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('skips zones below the requested minimum layer', () => {
    registerMouseZone({ id: 'screen', left: 1, right: 10, top: 1, bottom: 1, z: 50 });
    registerMouseZone({ id: 'overlay', left: 1, right: 10, top: 2, bottom: 2, z: 100 });

    // A floor above the screen zone hides it while keeping the overlay zone reachable.
    expect(hitTopmostZone(5, 1, { minZ: 100 })).toBeUndefined();
    expect(hitTopmostZone(5, 2, { minZ: 100 })?.id).toBe('overlay');
    // Without a floor both layers are eligible.
    expect(hitTopmostZone(5, 1)?.id).toBe('screen');
  });
});
