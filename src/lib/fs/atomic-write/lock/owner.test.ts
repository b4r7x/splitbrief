import { describe, expect, it } from 'vitest';
import { atomicLockOwner, atomicLockOwnerState } from './owner.js';

describe('atomicLockOwnerState', () => {
  it('reads an owner of this process with a start time 2000 ms off as live', () => {
    const owner = atomicLockOwner();

    expect(atomicLockOwnerState({ ...owner, startTimeMs: owner.startTimeMs + 2000 })).toBe('live');
  });

  it('reads an owner of this process with a start time 2001 ms off as dead', () => {
    const owner = atomicLockOwner();

    expect(atomicLockOwnerState({ ...owner, startTimeMs: owner.startTimeMs + 2001 })).toBe('dead');
  });

  it('reads an owner whose pid has no process as dead', () => {
    expect(atomicLockOwnerState({ ...atomicLockOwner(), pid: 99_999_999 })).toBe('dead');
  });
});
