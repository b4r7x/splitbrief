import { describe, it, expect } from 'vitest';
import { getContextualBindings } from './footer.js';
import type { ContextualBindingsInput } from './footer.js';

function makeState(overrides: Partial<ContextualBindingsInput> = {}): ContextualBindingsInput {
  return {
    tasks: { length: 3 },
    cursor: 0,
    dirty: false,
    flaggedIds: new Set<string>(),
    isPacketPreviewOpen: false,
    ...overrides,
  };
}

describe('getContextualBindings', () => {
  it('shows navigation and task actions when tasks exist', () => {
    const bindings = getContextualBindings(makeState());
    const keys = bindings.map((b) => b.key);
    expect(keys).toContain('j/k');
    expect(keys).toContain('enter');
    expect(keys).toContain('x');
    expect(keys).toContain('d');
  });

  it('hides navigation and task actions when no tasks', () => {
    const bindings = getContextualBindings(makeState({ tasks: { length: 0 } }));
    const keys = bindings.map((b) => b.key);
    expect(keys).not.toContain('j/k');
    expect(keys).not.toContain('enter');
    expect(keys).not.toContain('d');
  });

  it('shows merge only when cursor > 0', () => {
    const at0 = getContextualBindings(makeState({ cursor: 0 }));
    const at1 = getContextualBindings(makeState({ cursor: 1 }));
    expect(at0.map((b) => b.key)).not.toContain('m');
    expect(at1.map((b) => b.key)).toContain('m');
  });

  it('shows reorder only when multiple tasks', () => {
    const single = getContextualBindings(makeState({ tasks: { length: 1 } }));
    const multi = getContextualBindings(makeState({ tasks: { length: 3 } }));
    expect(single.map((b) => b.key)).not.toContain('^j/^k');
    expect(multi.map((b) => b.key)).toContain('^j/^k');
  });

  it('shows flagged regen with count when tasks are flagged', () => {
    const none = getContextualBindings(makeState());
    const two = getContextualBindings(makeState({ flaggedIds: new Set(['t1', 't2']) }));
    expect(none.map((b) => b.key)).not.toContain('R');
    expect(two.map((b) => b.key)).toContain('R');
    expect(two.find((b) => b.key === 'R')!.label).toBe('regen 2 flagged');
  });

  it('shows save when dirty, approve when clean', () => {
    const clean = getContextualBindings(makeState({ dirty: false }));
    const dirty = getContextualBindings(makeState({ dirty: true }));
    expect(clean.find((b) => b.key === 'Y')!.label).toBe('approve');
    expect(dirty.find((b) => b.key === 'Y')!.label).toBe('save');
  });

  it('shows close preview when packet preview is open', () => {
    const closed = getContextualBindings(makeState({ isPacketPreviewOpen: false }));
    const open = getContextualBindings(makeState({ isPacketPreviewOpen: true }));
    expect(closed.find((b) => b.key === 'p')!.label).toBe('preview');
    expect(open.find((b) => b.key === 'p')!.label).toBe('close preview');
  });

  it('always shows discard and help', () => {
    const bindings = getContextualBindings(makeState());
    expect(bindings.map((b) => b.key)).toContain('q');
    expect(bindings.map((b) => b.key)).toContain('?');
  });
});
