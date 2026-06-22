import { describe, it, expect } from 'vitest';
import { formatPlanEditorFooterLines, getContextualBindings } from './footer.js';
import type { ContextualBindingsInput } from './footer.js';

function makeState(overrides: Partial<ContextualBindingsInput> = {}): ContextualBindingsInput {
  return {
    tasks: { length: 3 },
    cursor: 0,
    dirty: false,
    flaggedIds: new Set<string>(),
    isPacketPreviewOpen: false,
    focus: 'task-list',
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

  it('shows draft save when dirty and gated approve when clean', () => {
    const clean = getContextualBindings(makeState({ dirty: false }));
    const dirty = getContextualBindings(makeState({ dirty: true }));
    expect(clean.find((b) => b.key === 'Y')!.label).toBe('approve checks');
    expect(dirty.find((b) => b.key === 'Y')!.label).toBe('save draft');
  });

  it('shows close preview when packet preview is open', () => {
    const closed = getContextualBindings(makeState({ isPacketPreviewOpen: false }));
    const open = getContextualBindings(makeState({ isPacketPreviewOpen: true }));
    expect(closed.find((b) => b.key === 'p')!.label).toBe('preview');
    expect(open.find((b) => b.key === 'p')!.label).toBe('close preview');
  });

  it('always shows reject, discard, and help', () => {
    const bindings = getContextualBindings(makeState());
    expect(bindings.map((b) => b.key)).toContain('N');
    expect(bindings.map((b) => b.key)).toContain('q');
    expect(bindings.map((b) => b.key)).toContain('?');
  });

  it('shows section and field editing bindings for semantic brief edits', () => {
    expect(getContextualBindings(makeState({ focus: 'section-list' })).map((b) => b.key)).toEqual([
      'j/k',
      'e',
      'c',
      'esc',
      'Y',
      'N',
      'q',
      '?',
    ]);
    expect(
      getContextualBindings(makeState({ focus: 'editing-section' })).map((b) => b.key),
    ).toEqual(['enter', '^enter', 'esc']);
  });

  it('shows submit and cancel while collecting a targeted regeneration reason', () => {
    expect(getContextualBindings(makeState({ focus: 'regen-reason' }))).toEqual([
      { key: 'enter', label: 'regen flagged' },
      { key: 'esc', label: 'cancel regen' },
    ]);
  });

  it('limits load-failed rich review to safe exit/help actions', () => {
    expect(getContextualBindings(makeState({ loadFailed: true }))).toEqual([
      { key: 'N', label: 'reject' },
      { key: 'q', label: 'discard' },
      { key: '?', label: 'help' },
    ]);
  });

  it('packs narrow footer lines by measured width while preserving priority exits', () => {
    const bindings = getContextualBindings(makeState({ flaggedIds: new Set(['t1', 't2']) }));

    const lines = formatPlanEditorFooterLines({ bindings, width: 48, isNarrow: true });
    const secondLine = lines[1] ?? '';

    expect(lines).toHaveLength(2);
    expect(secondLine).toContain('Y app');
    expect(secondLine).toContain('N rej');
    expect(secondLine).toContain('q dis');
  });
});
