import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEvidenceSummary,
  buildRejectionContext,
  createEvidenceLedger,
  evidenceLedgerPath,
  readEvidenceLedger,
  recordFinalReviewEvidence,
  recordLocalTaskEvidence,
  recordRejectionEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from './evidence.js';
import { makeTask } from '../../../testing/helpers/factories/task.js';
import type { ValidationResult } from '../../core/types/summary.js';
import { EvidenceLedgerSchema } from '../../core/schemas/evidence.js';
import type { EvidenceLedger } from '../../core/schemas/evidence.js';

function passing(stage: 'tsc' | 'lint' | 'test'): ValidationResult {
  return { passed: true, stage };
}
function failing(stage: 'tsc' | 'lint' | 'test', error: string): ValidationResult {
  return { passed: false, stage, error };
}

describe('createEvidenceLedger', () => {
  it('seeds an entry for each task with expected evidence', () => {
    const tasks = [
      makeTask({ id: 'T001', evidence: ['hello returns greeting'], tests: ['unit test passes'] }),
      makeTask({ id: 'T002', file: 'src/world.ts', evidence: [], tests: [] }),
    ];
    const ledger = createEvidenceLedger({ sessionId: 's1', feature: 'demo', mode: 'standard', tasks });
    expect(ledger.version).toBe(1);
    expect(ledger.sessionId).toBe('s1');
    expect(ledger.mode).toBe('standard');
    expect(ledger.tasks).toHaveLength(2);
    expect(ledger.tasks[0]?.expectedEvidence).toEqual(['hello returns greeting', 'unit test passes']);
    expect(ledger.tasks[0]?.observedEvidence).toEqual([]);
    expect(ledger.tasks[1]?.expectedEvidence).toEqual([]);
    expect(ledger.validationSummary).toEqual({ passed: 0, failed: 0, skipped: 0, escalated: 0 });
  });
});

describe('recordLocalTaskEvidence', () => {
  it('records validation pass strings, diff written, and task reached done', () => {
    const task = makeTask({ id: 'T001', file: 'src/hello.ts' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger,
      task: { ...task, status: 'done' },
      status: 'done',
      method: 'local',
      retries: 0,
      durationMs: 1234,
      validation: [passing('tsc'), passing('lint'), passing('test')],
      changedFiles: ['src/hello.ts'],
    });
    const entry = ledger.tasks.find(t => t.id === 'T001');
    expect(entry?.status).toBe('done');
    expect(entry?.method).toBe('local');
    expect(entry?.durationMs).toBe(1234);
    expect(entry?.changedFiles).toEqual(['src/hello.ts']);
    expect(entry?.validation.map(v => `${v.stage}:${v.passed}`)).toEqual([
      'tsc:true', 'lint:true', 'test:true',
    ]);
    expect(entry?.observedEvidence).toEqual([
      'task reached done',
      'tsc passed', 'lint passed', 'test passed',
      'diff written for src/hello.ts',
    ]);
    expect(ledger.validationSummary.passed).toBe(1);
  });

  it('captures error summary for failed validation stages', () => {
    const task = makeTask({ id: 'T001' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger, task, status: 'failed', validation: [failing('test', 'err line 1\nerr line 2')],
    });
    const entry = ledger.tasks.find(t => t.id === 'T001');
    expect(entry?.validation[0]?.errorSummary).toContain('err line 1');
    expect(entry?.observedEvidence).not.toContain('test passed');
    expect(ledger.validationSummary.failed).toBe(1);
  });
});

describe('recordRetryOrEscalationEvidence', () => {
  it('marks escalated and includes diff written line', () => {
    const task = makeTask({ id: 'T002', file: 'src/world.ts' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordRetryOrEscalationEvidence({
      ledger, task, status: 'escalated', method: 'escalated-full',
      retries: 2, escalated: true, validation: [passing('tsc')],
    });
    const entry = ledger.tasks.find(t => t.id === 'T002');
    expect(entry?.escalated).toBe(true);
    expect(entry?.retries).toBe(2);
    expect(entry?.observedEvidence).toContain('task reached escalated');
    expect(entry?.observedEvidence).toContain('diff written for src/world.ts');
    expect(ledger.validationSummary.escalated).toBe(1);
  });
});

describe('recordSkippedTaskEvidence', () => {
  it('marks task skipped with reason', () => {
    const task = makeTask({ id: 'T003' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordSkippedTaskEvidence({ ledger, task, reason: 'pre_task hook denied' });
    const entry = ledger.tasks.find(t => t.id === 'T003');
    expect(entry?.status).toBe('skipped');
    expect(entry?.method).toBe('skipped');
    expect(entry?.observedEvidence).toContain('skipped: pre_task hook denied');
    expect(ledger.validationSummary.skipped).toBe(1);
  });
});

describe('recordFinalReviewEvidence', () => {
  it('appends final review written line for completed tasks', () => {
    const task = makeTask({ id: 'T001' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger, task, status: 'done', method: 'local',
      validation: [passing('tsc'), passing('lint'), passing('test')],
    });
    ledger = recordFinalReviewEvidence({ ledger, status: 'written' });
    expect(ledger.finalReview).toEqual({ path: 'review.md', status: 'written' });
    const entry = ledger.tasks.find(t => t.id === 'T001');
    expect(entry?.observedEvidence).toContain('final review written');
  });

  it('records failed and skipped statuses without appending evidence line', () => {
    const task = makeTask({ id: 'T001' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger, task, status: 'done', validation: [passing('tsc')],
    });
    const failed = recordFinalReviewEvidence({ ledger, status: 'failed' });
    expect(failed.finalReview?.status).toBe('failed');
    expect(failed.tasks[0]?.observedEvidence).not.toContain('final review written');
    const skipped = recordFinalReviewEvidence({ ledger, status: 'skipped' });
    expect(skipped.finalReview?.status).toBe('skipped');
  });
});

describe('buildEvidenceSummary', () => {
  it('computes counts for the rollup that lands on Summary', () => {
    const a = makeTask({ id: 'T001' });
    const b = makeTask({ id: 'T002' });
    const c = makeTask({ id: 'T003' });
    let ledger: EvidenceLedger = createEvidenceLedger({
      sessionId: 's1', feature: 'f', tasks: [a, b, c],
    });
    ledger = recordLocalTaskEvidence({
      ledger, task: a, status: 'done', validation: [passing('tsc')],
    });
    ledger = recordRetryOrEscalationEvidence({
      ledger, task: b, status: 'escalated', escalated: true, validation: [passing('tsc')],
    });
    ledger = recordLocalTaskEvidence({
      ledger, task: c, status: 'failed', validation: [failing('tsc', 'boom')],
    });
    const summary = buildEvidenceSummary(ledger);
    expect(summary).toEqual({
      path: 'evidence.json',
      totalTasks: 3,
      tasksWithValidationEvidence: 2,
      escalatedTasks: 1,
      failedTasks: 1,
      rejectionCount: 0,
    });
  });
});

describe('writeEvidenceLedger / readEvidenceLedger', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'evidence-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips the ledger to disk with trailing newline', () => {
    const task = makeTask({ id: 'T001' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'demo', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger, task, status: 'done', method: 'local',
      validation: [passing('tsc'), passing('lint'), passing('test')],
    });
    writeEvidenceLedger(dir, 's1', ledger);
    const path = evidenceLedgerPath(dir, 's1');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    const round = readEvidenceLedger(dir, 's1');
    expect(round?.sessionId).toBe('s1');
    expect(round?.tasks[0]?.observedEvidence).toContain('task reached done');
  });

  it('returns null when no ledger has been written', () => {
    expect(readEvidenceLedger(dir, 'missing')).toBeNull();
  });
});

describe('briefHash propagation', () => {
  it('createEvidenceLedger with briefHash sets it on ledger and all seeded tasks', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks, briefHash: 'hash-A' });
    expect(ledger.briefHash).toBe('hash-A');
    expect(ledger.tasks[0]?.briefHash).toBe('hash-A');
    expect(ledger.tasks[1]?.briefHash).toBe('hash-A');
  });

  it('createEvidenceLedger without briefHash sets briefHash: null on ledger and tasks', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks });
    expect(ledger.briefHash).toBeNull();
    expect(ledger.tasks[0]?.briefHash).toBeNull();
  });

  it('recordLocalTaskEvidence propagates briefHash to updated task entry', () => {
    const task = makeTask({ id: 'T001' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordLocalTaskEvidence({
      ledger, task, status: 'done', validation: [], briefHash: 'hash-X',
    });
    expect(ledger.tasks.find(t => t.id === 'T001')?.briefHash).toBe('hash-X');
  });

  it('mid-run regen: T001 keeps hash-A, T002 gets hash-B, ledger stays hash-A', () => {
    const t1 = makeTask({ id: 'T001' });
    const t2 = makeTask({ id: 'T002' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [t1, t2], briefHash: 'hash-A' });
    ledger = recordLocalTaskEvidence({ ledger, task: t1, status: 'done', validation: [], briefHash: 'hash-A' });
    ledger = recordLocalTaskEvidence({ ledger, task: t2, status: 'done', validation: [], briefHash: 'hash-B' });
    expect(ledger.tasks.find(t => t.id === 'T001')?.briefHash).toBe('hash-A');
    expect(ledger.tasks.find(t => t.id === 'T002')?.briefHash).toBe('hash-B');
    expect(ledger.briefHash).toBe('hash-A');
  });

  it('recordSkippedTaskEvidence with briefHash preserves it on the task', () => {
    const task = makeTask({ id: 'T001' });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordSkippedTaskEvidence({ ledger, task, reason: 'denied', briefHash: 'hash-S' });
    expect(ledger.tasks.find(t => t.id === 'T001')?.briefHash).toBe('hash-S');
  });
});

describe('readEvidenceLedger backward compat — missing briefHash', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'evidence-compat-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('does not throw when ledger JSON has no briefHash field', () => {
    const task = makeTask({ id: 'T001' });
    const ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    const { briefHash: _bh, ...ledgerWithout } = ledger;
    const { tasks } = ledgerWithout as typeof ledger;
    const tasksWithout = tasks.map(({ briefHash: _tbh, ...t }) => t);
    writeEvidenceLedger(dir, 's1', { ...ledgerWithout, tasks: tasksWithout } as typeof ledger);
    expect(() => readEvidenceLedger(dir, 's1')).not.toThrow();
    const round = readEvidenceLedger(dir, 's1');
    expect(round).not.toBeNull();
    expect(round?.briefHash == null).toBe(true);
  });
});

describe('EvidenceLedgerSchema — mixed briefHash regeneration scenario', () => {
  function minimalTask(id: string) {
    return {
      id,
      title: 'Test task',
      file: 'src/foo.ts',
      status: 'pending',
      retries: 0,
      changedFiles: [],
      validation: [],
      expectedEvidence: [],
      observedEvidence: [],
      escalated: false,
    };
  }

  it('parses a ledger with mixed briefHash values (hash-A, hash-B, absent)', () => {
    const ledger = {
      version: 1,
      sessionId: 's1',
      feature: 'test',
      generatedAt: new Date().toISOString(),
      tasks: [
        { ...minimalTask('T001'), briefHash: 'hash-A' },
        { ...minimalTask('T002'), briefHash: 'hash-B' },
        { ...minimalTask('T003') },
      ],
      validationSummary: { passed: 0, failed: 0, skipped: 0, escalated: 0 },
    };
    const result = EvidenceLedgerSchema.safeParse(ledger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tasks[0]?.briefHash).toBe('hash-A');
    expect(result.data.tasks[1]?.briefHash).toBe('hash-B');
    expect(result.data.tasks[2]?.briefHash).toBeUndefined();
  });
});

describe('recordRejectionEvidence', () => {
  function makeLedger() {
    return createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [makeTask({ id: 'T001' })] });
  }

  it('appends to rejections when array already exists', () => {
    const task = makeTask({ id: 'T001' });
    let ledger = makeLedger();
    ledger = recordRejectionEvidence({
      ledger,
      tier: 'sticky',
      actionClass: 'write_out_of_scope',
      actionDescription: 'modify src/other.ts',
      taskId: task.id,
      reason: 'APPROVAL_REQUIRED',
    });
    ledger = recordRejectionEvidence({
      ledger,
      tier: 'confirm',
      actionClass: 'destructive',
      actionDescription: 'delete dist/',
      reason: 'user denied',
    });
    expect(ledger.rejections).toHaveLength(2);
    expect(ledger.rejections?.[0]?.tier).toBe('sticky');
    expect(ledger.rejections?.[1]?.tier).toBe('confirm');
  });

  it('creates the rejections array when none exists', () => {
    const ledger = makeLedger();
    expect(ledger.rejections).toBeUndefined();
    const updated = recordRejectionEvidence({
      ledger,
      tier: 'sticky',
      actionClass: 'network',
      actionDescription: 'fetch https://example.com',
      reason: 'APPROVAL_REQUIRED',
    });
    expect(updated.rejections).toHaveLength(1);
    expect(updated.rejections?.[0]?.actionClass).toBe('network');
  });

  it('updates generatedAt to a valid ISO timestamp', () => {
    const ledger = makeLedger();
    const updated = recordRejectionEvidence({
      ledger,
      tier: 'confirm',
      actionClass: 'destructive',
      actionDescription: 'rm -rf',
      reason: 'denied',
    });
    expect(() => new Date(updated.generatedAt)).not.toThrow();
    expect(new Date(updated.generatedAt).toISOString()).toBe(updated.generatedAt);
  });

  it('is pure — does not mutate the input ledger', () => {
    const ledger = makeLedger();
    const originalRejections = ledger.rejections;
    recordRejectionEvidence({
      ledger,
      tier: 'sticky',
      actionClass: 'write_out_of_scope',
      actionDescription: 'modify src/other.ts',
      reason: 'APPROVAL_REQUIRED',
    });
    expect(ledger.rejections).toBe(originalRejections);
    expect(ledger.rejections).toBeUndefined();
  });
});

describe('buildEvidenceSummary — rejectionCount', () => {
  it('returns rejectionCount: 0 when rejections is undefined', () => {
    const ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [] });
    expect(ledger.rejections).toBeUndefined();
    const summary = buildEvidenceSummary(ledger);
    expect(summary.rejectionCount).toBe(0);
  });

  it('returns correct rejectionCount when populated', () => {
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [] });
    ledger = recordRejectionEvidence({ ledger, tier: 'sticky', actionClass: 'network', actionDescription: 'curl', reason: 'denied' });
    ledger = recordRejectionEvidence({ ledger, tier: 'confirm', actionClass: 'destructive', actionDescription: 'rm', reason: 'denied' });
    const summary = buildEvidenceSummary(ledger);
    expect(summary.rejectionCount).toBe(2);
  });
});

describe('buildRejectionContext', () => {
  it('returns empty string for ledger with no rejections', () => {
    const ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [] });
    expect(buildRejectionContext(ledger)).toBe('');
  });

  it('returns empty string for ledger with empty rejections array', () => {
    const ledger: EvidenceLedger = {
      ...createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [] }),
      rejections: [],
    };
    expect(buildRejectionContext(ledger)).toBe('');
  });

  it('returns formatted lines for populated rejections', () => {
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [] });
    ledger = recordRejectionEvidence({
      ledger, tier: 'sticky', actionClass: 'network',
      actionDescription: 'fetch api.example.com', reason: 'APPROVAL_REQUIRED',
    });
    ledger = recordRejectionEvidence({
      ledger, tier: 'confirm', actionClass: 'destructive',
      actionDescription: 'delete build/', reason: 'user denied',
    });
    const ctx = buildRejectionContext(ledger);
    expect(ctx).toContain('Previous rejections:');
    expect(ctx).toContain('[sticky] network: fetch api.example.com (reason: APPROVAL_REQUIRED)');
    expect(ctx).toContain('[confirm] destructive: delete build/ (reason: user denied)');
    expect(ctx.endsWith('\n')).toBe(true);
  });
});

describe('readEvidenceLedger backward compat — missing rejections', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'evidence-reject-compat-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('does not throw when ledger JSON has no rejections field', () => {
    const task = makeTask({ id: 'T001' });
    const ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    writeEvidenceLedger(dir, 's1', ledger);
    expect(ledger.rejections).toBeUndefined();
    expect(() => readEvidenceLedger(dir, 's1')).not.toThrow();
    const round = readEvidenceLedger(dir, 's1');
    expect(round).not.toBeNull();
    expect(round?.rejections).toBeUndefined();
  });
});
