import { describe, expect, it } from 'vitest';
import { computePerTaskOutOfBounds, analyzeDriftChain } from './chain.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { DriftChainState } from '../../../core/schemas/drift-chain.js';

function makeState(overrides?: Partial<DriftChainState>): DriftChainState {
  return {
    version: 1,
    sessionId: 's1',
    activeChain: { entries: [], uniqueFiles: [], score: 0 },
    emittedChains: [],
    ...overrides,
  };
}

describe('computePerTaskOutOfBounds', () => {
  it('own file only → empty set', () => {
    const task = makeTask({ file: 'src/a.ts' });
    const result = computePerTaskOutOfBounds(task, ['src/a.ts']);
    expect(result.size).toBe(0);
  });

  it('own file + extra file → extra file in set', () => {
    const task = makeTask({ file: 'src/a.ts' });
    const result = computePerTaskOutOfBounds(task, ['src/a.ts', 'src/b.ts']);
    expect(result).toEqual(new Set(['src/b.ts']));
  });

  it('outOfBounds pattern matches via substring → included', () => {
    const task = makeTask({ file: 'src/a.ts', scope: { outOfBounds: ['src/secrets'] } });
    const result = computePerTaskOutOfBounds(task, ['src/a.ts', 'src/secrets/leak.ts']);
    expect(result.has('src/secrets/leak.ts')).toBe(true);
  });

  it('file matching approvedOutOfBounds → excluded from result', () => {
    const task = makeTask({
      file: 'src/a.ts',
      scope: { outOfBounds: ['src/secrets'], approvedOutOfBounds: ['src/secrets/safe.ts'] },
    });
    const result = computePerTaskOutOfBounds(task, ['src/a.ts', 'src/secrets/safe.ts', 'src/secrets/leak.ts']);
    expect(result.has('src/secrets/safe.ts')).toBe(false);
    expect(result.has('src/secrets/leak.ts')).toBe(true);
  });

  it('empty taskChangedFiles → empty set', () => {
    const task = makeTask({ file: 'src/a.ts' });
    const result = computePerTaskOutOfBounds(task, []);
    expect(result.size).toBe(0);
  });

  it('undefined scope → no crash, empty set when only own file changed', () => {
    const task = makeTask({ file: 'src/a.ts', scope: undefined });
    const result = computePerTaskOutOfBounds(task, ['src/a.ts']);
    expect(result.size).toBe(0);
  });

  it('undefined scope + extra file → extra file in set', () => {
    const task = makeTask({ file: 'src/a.ts', scope: undefined });
    const result = computePerTaskOutOfBounds(task, ['src/a.ts', 'src/c.ts']);
    expect(result).toEqual(new Set(['src/c.ts']));
  });
});

describe('analyzeDriftChain — reset semantics', () => {
  it('empty outOfBoundsFiles → entries become empty, score=0, no emit', () => {
    const state = makeState({
      activeChain: {
        entries: [{ taskId: 'T001', outOfBoundsFiles: ['src/x.ts'] }],
        uniqueFiles: ['src/x.ts'],
        score: 0.3,
      },
    });
    const update = analyzeDriftChain(state, 'T002', new Set(), 0.6);
    expect(update.state.activeChain.entries).toEqual([]);
    expect(update.state.activeChain.score).toBe(0);
    expect(update.emitted).toBeUndefined();
  });

  it('chain of 2 entries, 3rd task clean → chain resets to empty', () => {
    let state = makeState();
    state = analyzeDriftChain(state, 'T001', new Set(['src/x.ts']), 0.6).state;
    state = analyzeDriftChain(state, 'T002', new Set(['src/x.ts']), 0.6).state;
    expect(state.activeChain.entries).toHaveLength(2);

    const update = analyzeDriftChain(state, 'T003', new Set(), 0.6);
    expect(update.state.activeChain.entries).toHaveLength(0);
    expect(update.emitted).toBeUndefined();
  });
});

describe('analyzeDriftChain — extend semantics', () => {
  it('two consecutive tasks with overlapping out-of-bounds → chain length 2, score computed', () => {
    let state = makeState();
    state = analyzeDriftChain(state, 'T001', new Set(['src/x.ts']), 0.6).state;
    const update = analyzeDriftChain(state, 'T002', new Set(['src/x.ts']), 0.6);
    expect(update.state.activeChain.entries).toHaveLength(2);
    expect(update.state.activeChain.score).toBeGreaterThan(0);
  });

  it('three consecutive with full overlap → length 3, score above 0.6', () => {
    let state = makeState();
    const files = new Set(['src/x.ts', 'src/y.ts', 'src/z.ts']);
    state = analyzeDriftChain(state, 'T001', files, 0.6).state;
    state = analyzeDriftChain(state, 'T002', files, 0.6).state;
    const update = analyzeDriftChain(state, 'T003', files, 0.6);
    expect(update.state.activeChain.entries).toHaveLength(3);
    expect(update.state.activeChain.score).toBeGreaterThan(0.6);
  });

  it('three consecutive crossing threshold → emitted defined on third call', () => {
    let state = makeState();
    const files = new Set(['src/x.ts', 'src/y.ts', 'src/z.ts']);
    const r1 = analyzeDriftChain(state, 'T001', files, 0.6);
    state = r1.state;
    expect(r1.emitted).toBeUndefined();

    const r2 = analyzeDriftChain(state, 'T002', files, 0.6);
    state = r2.state;

    const r3 = analyzeDriftChain(state, 'T003', files, 0.6);
    expect(r3.emitted).toBeDefined();
    expect(r3.emitted?.chainLength).toBe(3);
  });
});

describe('analyzeDriftChain — start new chain', () => {
  it('two tasks with NON-overlapping out-of-bounds → second task resets chain to length 1', () => {
    let state = makeState();
    state = analyzeDriftChain(state, 'T001', new Set(['src/a.ts']), 0.6).state;
    const update = analyzeDriftChain(state, 'T002', new Set(['src/b.ts']), 0.6);
    expect(update.state.activeChain.entries).toHaveLength(1);
    expect(update.state.activeChain.entries[0]?.taskId).toBe('T002');
  });

  it('new chain from scratch has score based only on length=1 + new-files (overlap=0)', () => {
    const state = makeState();
    const update = analyzeDriftChain(state, 'T001', new Set(['src/a.ts']), 0.6);
    const chain = update.state.activeChain;
    // length=1: 1/5*0.3=0.06; overlap=0 (length<2); uniqueFiles=1: 1/10*0.2=0.02
    const expected = (1 / 5) * 0.3 + (1 / 10) * 0.2;
    expect(chain.score).toBeCloseTo(expected, 10);
  });
});

describe('analyzeDriftChain — score formula (deterministic)', () => {
  it('length 2, 100% overlap, 2 unique files: exact score', () => {
    // length=2: 2/5*0.3=0.12; overlap=1.0*0.5=0.5; unique=2: 2/10*0.2=0.04; total=0.66
    let state = makeState();
    state = analyzeDriftChain(state, 'T001', new Set(['src/x.ts', 'src/y.ts']), 0.6).state;
    const update = analyzeDriftChain(state, 'T002', new Set(['src/x.ts', 'src/y.ts']), 0.6);
    const score = update.state.activeChain.score;
    expect(score).toBeCloseTo(0.66, 10);
  });

  it('length 3, 80% overlap (4/5 files), 3 unique files: approximate score', () => {
    // We need: T1: {a,b,c,d,e}, T2: {a,b,c,d,e} full overlap chain len 2
    // T3: {a,b,c,d,f} — 4/5 with T2 (a,b,c,d common, e not in T3, f new)
    // overlap T2∩T3 = {a,b,c,d} = 4; union T2∪T3 = {a,b,c,d,e,f} = 6
    // overlapTerm = 4/6 * 0.5 = 0.3333
    // lengthTerm = 3/5 * 0.3 = 0.18
    // uniqueFiles after T3: {a,b,c,d,e,f} = 6 → 6/10*0.2 = 0.12
    // total = 0.18 + 0.3333 + 0.12 = 0.6333
    let state = makeState();
    const files5 = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    state = analyzeDriftChain(state, 'T001', files5, 0.9).state;
    state = analyzeDriftChain(state, 'T002', files5, 0.9).state;
    const files3rd = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/f.ts']);
    const update = analyzeDriftChain(state, 'T003', files3rd, 0.9);
    const score = update.state.activeChain.score;
    expect(score).toBeCloseTo(0.6333, 3);
  });

  it('score always in [0, 1]', () => {
    let state = makeState();
    const bigSet = new Set(Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`));
    for (let i = 1; i <= 10; i++) {
      const update = analyzeDriftChain(state, `T00${i}`, bigSet, 2);
      state = update.state;
      expect(state.activeChain.score).toBeGreaterThanOrEqual(0);
      expect(state.activeChain.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('analyzeDriftChain — emit behavior', () => {
  it('calling twice with same taskId does NOT produce duplicate emitted entries', () => {
    let state = makeState();
    const files = new Set(['src/x.ts', 'src/y.ts', 'src/z.ts']);
    // Use a high threshold so only the final task crosses it
    state = analyzeDriftChain(state, 'T001', files, 0.9).state;
    state = analyzeDriftChain(state, 'T002', files, 0.9).state;
    // First call with T003 — should emit (score ~0.74 but threshold 0.9: need longer chain)
    // Use threshold 0.0 to force emit on T003
    const r3 = analyzeDriftChain(state, 'T003', files, 0.0);
    expect(r3.emitted).toBeDefined();
    const emittedCountAfterFirstCall = r3.state.emittedChains.length;
    state = r3.state;

    // Second call with same T003 — should NOT emit again, no new entry
    const r3b = analyzeDriftChain(state, 'T003', files, 0.0);
    expect(r3b.emitted).toBeUndefined();
    expect(r3b.state.emittedChains).toHaveLength(emittedCountAfterFirstCall);
  });

  it('representativePath = most frequent path; alphabetical tiebreak', () => {
    let state = makeState();
    // T001: [a, b] — a appears once, b appears once
    state = analyzeDriftChain(state, 'T001', new Set(['src/a.ts', 'src/b.ts']), 0.9).state;
    // T002: [a, c] — a appears twice, b once, c once; tie between b,c → alphabetical: b < c → but a wins with 2
    state = analyzeDriftChain(state, 'T002', new Set(['src/a.ts', 'src/c.ts']), 0.9).state;
    // T003: [a, d] — a appears 3 times → representativePath = src/a.ts
    const update = analyzeDriftChain(state, 'T003', new Set(['src/a.ts', 'src/d.ts']), 0.1);
    expect(update.emitted?.representativePath).toBe('src/a.ts');
  });

  it('representativePath tiebreak: alphabetical first when counts equal', () => {
    let state = makeState();
    // T001: [b, c] — b:1, c:1, tie → alphabetical → b
    state = analyzeDriftChain(state, 'T001', new Set(['src/b.ts', 'src/c.ts']), 0.9).state;
    // T002: overlapping with T001 to extend chain, threshold very low to emit on T002
    const update = analyzeDriftChain(state, 'T002', new Set(['src/b.ts', 'src/c.ts']), 0.0);
    expect(update.emitted?.representativePath).toBe('src/b.ts');
  });
});

describe('analyzeDriftChain — threshold', () => {
  it('score < threshold → no emit', () => {
    const state = makeState();
    // length=1, 1 unique file: score = 1/5*0.3 + 1/10*0.2 = 0.06 + 0.02 = 0.08
    const update = analyzeDriftChain(state, 'T001', new Set(['src/a.ts']), 0.6);
    expect(update.emitted).toBeUndefined();
  });

  it('score >= threshold → emit', () => {
    let state = makeState();
    const files = new Set(['src/x.ts', 'src/y.ts']);
    state = analyzeDriftChain(state, 'T001', files, 0.6).state;
    // T002 will produce score 0.66 (length=2, overlap=1.0, unique=2)
    const update = analyzeDriftChain(state, 'T002', files, 0.6);
    expect(update.emitted).toBeDefined();
    expect(update.state.activeChain.score).toBeGreaterThanOrEqual(0.6);
  });
});
