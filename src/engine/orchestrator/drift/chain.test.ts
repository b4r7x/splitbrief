import { describe, expect, it } from 'vitest';
import { computePerTaskOutOfBounds, analyzeDriftChain } from './chain.js';
import type { PerTaskOutOfBoundsInput } from './chain.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ACCEPTED_SCOPE_CASES } from '#testing/helpers/factories/scope-attribution-cases.js';
import type { Task } from '../../../core/schemas/task.js';
import { taskId } from '../../../core/schemas/task.js';
import type { DriftChainState } from '../../../core/schemas/drift-chain.js';
import { DriftChainStateSchema } from '../../../core/schemas/drift-chain.js';

function makeState(overrides?: Partial<DriftChainState>): DriftChainState {
  return {
    version: 1,
    sessionId: 's1',
    activeChain: { entries: [], uniqueFiles: [], score: 0 },
    emittedChains: [],
    ...overrides,
  };
}

function outOfBounds(
  tasks: Task[],
  taskChangedFiles: string[],
  overrides?: Partial<PerTaskOutOfBoundsInput>,
): Set<string> {
  return computePerTaskOutOfBounds({
    tasks,
    taskChangedFiles,
    preRunChangedFiles: [],
    runAttributedFiles: new Set(),
    ...overrides,
  });
}

describe('computePerTaskOutOfBounds', () => {
  it.each(ACCEPTED_SCOPE_CASES)(
    'classifies $label paths with attribution parity',
    ({ task, changedFile, accepted }) => {
      const result = outOfBounds([makeTask(task)], [changedFile]);
      expect(result.has(changedFile)).toBe(!accepted);
    },
  );

  it('excludes matched scope paths while still flagging their untargeted siblings', () => {
    const approved = makeTask({
      file: 'src/a.ts',
      scope: { outOfBounds: ['src/secrets'], approvedOutOfBounds: ['src/secrets/safe.ts'] },
    });
    expect(
      outOfBounds([approved], ['src/a.ts', 'src/secrets/safe.ts', 'src/secrets/leak.ts']),
    ).toEqual(new Set(['src/secrets/leak.ts']));

    const inBounds = makeTask({ file: 'src/a.ts', scope: { inBounds: ['src/feature/**'] } });
    expect(
      outOfBounds([inBounds], ['src/a.ts', 'src/feature/widget.ts', 'src/other/leak.ts']),
    ).toEqual(new Set(['src/other/leak.ts']));
  });

  it("another brief's target file → excluded even without a dependsOn edge", () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/a.ts' }),
      makeTask({ id: 'T002', file: 'src/dep.ts' }),
    ];
    const result = outOfBounds(tasks, ['src/a.ts', 'src/dep.ts', 'src/leak.ts']);
    expect(result.has('src/dep.ts')).toBe(false);
    expect(result.has('src/leak.ts')).toBe(true);
  });

  it('session artifacts are orchestration, never out-of-bounds', () => {
    const result = outOfBounds(
      [makeTask({ file: 'src/a.ts' })],
      ['tasks.md', 'spec.md', 'src/a.ts'],
    );
    expect(result.size).toBe(0);
  });

  it('pre-run-dirty file the ledger never attributed → excluded; attributed → flagged', () => {
    const tasks = [makeTask({ file: 'src/a.ts' })];
    const changed = ['src/a.ts', 'notes/scratch.md'];

    const unattributed = outOfBounds(tasks, changed, {
      preRunChangedFiles: ['notes/scratch.md'],
    });
    expect(unattributed.size).toBe(0);

    const attributed = outOfBounds(tasks, changed, {
      preRunChangedFiles: ['notes/scratch.md'],
      runAttributedFiles: new Set(['notes/scratch.md']),
    });
    expect(attributed).toEqual(new Set(['notes/scratch.md']));
  });

  it('empty taskChangedFiles → empty set', () => {
    const result = outOfBounds([makeTask({ file: 'src/a.ts' })], []);
    expect(result.size).toBe(0);
  });

  it('returns deduplicated out-of-bounds files in deterministic order', () => {
    const result = outOfBounds(
      [makeTask({ file: 'src/primary.ts' })],
      ['src/z.ts', 'src/a.ts', 'src/z.ts', 'src/m.ts'],
    );
    expect([...result]).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('never flags the run-owned event sink dirty since run start (runA regression)', () => {
    // Real run: `runA.ndjson` was the orchestrator's own NDJSON sink inside the
    // project dir — dirty at run start, appended during every task, never
    // ledger-attributed. The final drift report scored it info/pre-existing
    // (passed:true score:1) while the chain emitted score 0.64 at T002.
    const tasks = [
      makeTask({ id: 'T001', file: 'src/text.ts' }),
      makeTask({ id: 'T002', file: 'src/text.test.ts' }),
    ];
    const preRunChangedFiles = ['runA.err', 'runA.ndjson', 'tasks.md'];
    const runAttributedFiles = new Set(['src/text.ts', 'src/text.test.ts']);

    const oob1 = outOfBounds(tasks, ['runA.ndjson', 'src/text.ts'], {
      preRunChangedFiles,
      runAttributedFiles,
    });
    const oob2 = outOfBounds(tasks, ['runA.ndjson', 'src/text.test.ts'], {
      preRunChangedFiles,
      runAttributedFiles,
    });
    expect(oob1.size).toBe(0);
    expect(oob2.size).toBe(0);

    const r1 = analyzeDriftChain(makeState(), taskId('T001'), oob1, 0.6);
    const r2 = analyzeDriftChain(r1.state, taskId('T002'), oob2, 0.6);
    expect(r1.emitted).toBeUndefined();
    expect(r2.emitted).toBeUndefined();
    expect(r2.state.activeChain.score).toBe(0);
  });
});

describe('analyzeDriftChain — reset semantics', () => {
  it('empty outOfBoundsFiles → entries become empty, score=0, no emit', () => {
    const state = makeState({
      activeChain: {
        entries: [{ taskId: taskId('T001'), outOfBoundsFiles: ['src/x.ts'] }],
        uniqueFiles: ['src/x.ts'],
        score: 0.3,
      },
    });
    const update = analyzeDriftChain(state, taskId('T002'), new Set(), 0.6);
    expect(update.state.activeChain.entries).toEqual([]);
    expect(update.state.activeChain.score).toBe(0);
    expect(update.emitted).toBeUndefined();
  });

  it('chain of 2 entries, 3rd task clean → chain resets to empty', () => {
    let state = makeState();
    state = analyzeDriftChain(state, taskId('T001'), new Set(['src/x.ts']), 0.6).state;
    state = analyzeDriftChain(state, taskId('T002'), new Set(['src/x.ts']), 0.6).state;
    expect(state.activeChain.entries).toHaveLength(2);

    const update = analyzeDriftChain(state, taskId('T003'), new Set(), 0.6);
    expect(update.state.activeChain.entries).toHaveLength(0);
    expect(update.emitted).toBeUndefined();
  });
});

describe('analyzeDriftChain — shared declared dependency does not chain', () => {
  it('consecutive tasks touching only a shared dependency brief target → no out-of-bounds, no emit', () => {
    const shared = 'src/shared-dep.ts';
    const tasks = [
      makeTask({ id: 'T000', file: shared }),
      makeTask({ id: 'T001', file: 'src/a.ts', dependsOn: ['T000'] }),
      makeTask({ id: 'T002', file: 'src/b.ts', dependsOn: ['T000'] }),
    ];

    const oob1 = outOfBounds(tasks, ['src/a.ts', shared]);
    const oob2 = outOfBounds(tasks, ['src/b.ts', shared]);
    expect(oob1.size).toBe(0);
    expect(oob2.size).toBe(0);

    let state = makeState();
    const r1 = analyzeDriftChain(state, taskId('T001'), oob1, 0.6);
    state = r1.state;
    const r2 = analyzeDriftChain(state, taskId('T002'), oob2, 0.6);

    expect(r2.state.activeChain.entries).toHaveLength(0);
    expect(r1.emitted).toBeUndefined();
    expect(r2.emitted).toBeUndefined();
  });
});

describe('analyzeDriftChain — extend semantics', () => {
  it('two consecutive tasks with overlapping out-of-bounds → chain length 2, score computed', () => {
    let state = makeState();
    state = analyzeDriftChain(state, taskId('T001'), new Set(['src/x.ts']), 0.6).state;
    const update = analyzeDriftChain(state, taskId('T002'), new Set(['src/x.ts']), 0.6);
    expect(update.state.activeChain.entries).toHaveLength(2);
    expect(update.state.activeChain.score).toBeGreaterThan(0);
  });

  it('three consecutive with full overlap extends chain, crosses threshold, and emits on third call', () => {
    let state = makeState();
    const files = new Set(['src/x.ts', 'src/y.ts', 'src/z.ts']);
    const r1 = analyzeDriftChain(state, taskId('T001'), files, 0.6);
    state = r1.state;
    expect(r1.emitted).toBeUndefined();

    state = analyzeDriftChain(state, taskId('T002'), files, 0.6).state;

    const r3 = analyzeDriftChain(state, taskId('T003'), files, 0.6);
    expect(r3.state.activeChain.entries).toHaveLength(3);
    expect(r3.state.activeChain.score).toBeGreaterThan(0.6);
    expect(r3.emitted).toBeDefined();
    expect(r3.emitted?.chainLength).toBe(3);
  });
});

describe('analyzeDriftChain — start new chain', () => {
  it('two tasks with NON-overlapping out-of-bounds → second task resets chain to length 1', () => {
    let state = makeState();
    state = analyzeDriftChain(state, taskId('T001'), new Set(['src/a.ts']), 0.6).state;
    const update = analyzeDriftChain(state, taskId('T002'), new Set(['src/b.ts']), 0.6);
    expect(update.state.activeChain.entries).toHaveLength(1);
    expect(update.state.activeChain.entries[0]?.taskId).toBe('T002');
  });

  it('new chain from scratch has score based only on length=1 + new-files (overlap=0)', () => {
    const state = makeState();
    const update = analyzeDriftChain(state, taskId('T001'), new Set(['src/a.ts']), 0.6);
    const chain = update.state.activeChain;
    // length=1: 1/5*0.3=0.06; overlap=0 (length<2); uniqueFiles=1: 1/10*0.2=0.02
    const expected = (1 / 5) * 0.3 + (1 / 10) * 0.2;
    expect(chain.score).toBeCloseTo(expected, 10);
  });

  it('sorts active and emitted file lists regardless of set insertion order', () => {
    const update = analyzeDriftChain(
      makeState(),
      taskId('T001'),
      new Set(['src/z.ts', 'src/a.ts', 'src/m.ts']),
      0,
    );

    expect(update.state.activeChain.entries[0]?.outOfBoundsFiles).toEqual([
      'src/a.ts',
      'src/m.ts',
      'src/z.ts',
    ]);
    expect(update.state.activeChain.uniqueFiles).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
    expect(update.emitted?.uniqueOutOfBoundsFiles).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('globally sorts an earlier-alphabetic file added while extending a chain', () => {
    const first = analyzeDriftChain(
      makeState(),
      taskId('T001'),
      new Set(['src/z.ts', 'src/m.ts']),
      1,
    );
    const update = analyzeDriftChain(
      first.state,
      taskId('T002'),
      new Set(['src/m.ts', 'src/a.ts']),
      0,
    );

    expect(update.state.activeChain.uniqueFiles).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
    expect(update.emitted?.uniqueOutOfBoundsFiles).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });
});

describe('analyzeDriftChain — score formula (deterministic)', () => {
  it('length 2, 100% overlap, 2 unique files: exact score', () => {
    // length=2: 2/5*0.3=0.12; overlap=1.0*0.5=0.5; unique=2: 2/10*0.2=0.04; total=0.66
    let state = makeState();
    state = analyzeDriftChain(state, taskId('T001'), new Set(['src/x.ts', 'src/y.ts']), 0.6).state;
    const update = analyzeDriftChain(state, taskId('T002'), new Set(['src/x.ts', 'src/y.ts']), 0.6);
    const score = update.state.activeChain.score;
    expect(score).toBeCloseTo(0.66, 10);
    expect(update.emitted).toBeDefined();
  });

  it('length 3, 4/6 overlap, 6 unique files: approximate score', () => {
    // We need: T001: {a,b,c,d,e}, T002: {a,b,c,d,e} full overlap chain len 2
    // T003: {a,b,c,d,f} — 4/6 union overlap with T002
    // overlap T002∩T003 = {a,b,c,d} = 4; union T002∪T003 = {a,b,c,d,e,f} = 6
    // overlapTerm = 4/6 * 0.5 = 0.3333
    // lengthTerm = 3/5 * 0.3 = 0.18
    // uniqueFiles after T003: {a,b,c,d,e,f} = 6 → 6/10*0.2 = 0.12
    // total = 0.18 + 0.3333 + 0.12 = 0.6333
    let state = makeState();
    const files5 = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    state = analyzeDriftChain(state, taskId('T001'), files5, 0.9).state;
    state = analyzeDriftChain(state, taskId('T002'), files5, 0.9).state;
    const files3rd = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/f.ts']);
    const update = analyzeDriftChain(state, taskId('T003'), files3rd, 0.9);
    const score = update.state.activeChain.score;
    expect(score).toBeCloseTo(0.6333, 3);
  });

  it('score always in [0, 1]', () => {
    let state = makeState();
    const bigSet = new Set(Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`));
    for (let i = 1; i <= 10; i++) {
      const update = analyzeDriftChain(state, taskId(`T${String(i).padStart(3, '0')}`), bigSet, 2);
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
    state = analyzeDriftChain(state, taskId('T001'), files, 0.9).state;
    state = analyzeDriftChain(state, taskId('T002'), files, 0.9).state;
    const r3 = analyzeDriftChain(state, taskId('T003'), files, 0.0);
    expect(r3.emitted).toBeDefined();
    const emittedCountAfterFirstCall = r3.state.emittedChains.length;
    state = r3.state;

    const r3b = analyzeDriftChain(state, taskId('T003'), files, 0.0);
    expect(r3b.emitted).toBeUndefined();
    expect(r3b.state.emittedChains).toHaveLength(emittedCountAfterFirstCall);
  });

  it('representativePath = most frequent path; alphabetical tiebreak', () => {
    let state = makeState();
    // T001: [a, b] — a appears once, b appears once
    state = analyzeDriftChain(state, taskId('T001'), new Set(['src/a.ts', 'src/b.ts']), 0.9).state;
    // T002: [a, c] — a appears twice, b once, c once; tie between b,c → alphabetical: b < c → but a wins with 2
    state = analyzeDriftChain(state, taskId('T002'), new Set(['src/a.ts', 'src/c.ts']), 0.9).state;
    // T003: [a, d] — a appears 3 times → representativePath = src/a.ts
    const update = analyzeDriftChain(state, taskId('T003'), new Set(['src/a.ts', 'src/d.ts']), 0.1);
    expect(update.emitted?.representativePath).toBe('src/a.ts');
  });

  it('representativePath tiebreak: alphabetical first when counts equal', () => {
    let state = makeState();
    // T001: [b, c] — b:1, c:1, tie → alphabetical → b
    state = analyzeDriftChain(state, taskId('T001'), new Set(['src/b.ts', 'src/c.ts']), 0.9).state;
    // T002: overlapping with T001 to extend chain, threshold very low to emit on T002
    const update = analyzeDriftChain(state, taskId('T002'), new Set(['src/b.ts', 'src/c.ts']), 0.0);
    expect(update.emitted?.representativePath).toBe('src/b.ts');
  });
});

describe('analyzeDriftChain — emitted chain contract', () => {
  it('emitted chain carries no timestamp field and round-trips through the persisted schema', () => {
    let state = makeState();
    const files = new Set(['src/x.ts', 'src/y.ts']);
    state = analyzeDriftChain(state, taskId('T001'), files, 0.6).state;
    const update = analyzeDriftChain(state, taskId('T002'), files, 0.6);

    expect(update.emitted).toBeDefined();
    expect(Object.keys(update.emitted ?? {})).not.toContain('ts');

    const roundTripped = DriftChainStateSchema.parse(JSON.parse(JSON.stringify(update.state)));
    expect(roundTripped.emittedChains[0]).toEqual(update.emitted);
    expect(roundTripped.emittedChains[0]).not.toHaveProperty('ts');
  });
});
