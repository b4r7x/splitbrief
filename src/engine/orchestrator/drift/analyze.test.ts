import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeBriefDrift } from './analyze.js';
import { driftReportPath, readDriftReport, writeDriftReport } from './io.js';
import { formatDriftReportForPrompt, publishDriftReport } from './format.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger.js';
import { recordRetryOrEscalationEvidence } from '../evidence/task.js';
import type { Task } from '../../../core/schemas/task.js';
import type { EventBus } from '../../events/types.js';

type MakeTaskOverrides = Parameters<typeof makeTask>[0];

function done(task: MakeTaskOverrides = {}): Task {
  return makeTask({ ...(task ?? {}), status: 'done' });
}

describe('analyzeBriefDrift', () => {
  it('passes when only the exact task files changed', () => {
    const tasks = [done({ id: 'T001', file: 'src/a.ts' }), done({ id: 'T002', file: 'src/b.ts' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      diff: 'diff stuff',
    });
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(1);
  });

  it('warns about an extra changed file when no out-of-bounds is declared', () => {
    const tasks = [done({ id: 'T001', file: 'src/a.ts' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      diff: '',
    });
    const finding = report.findings.find((f) => f.code === 'out_of_scope_file');
    expect(finding?.severity).toBe('warning');
    expect(finding?.file).toBe('src/extra.ts');
    expect(report.passed).toBe(true);
  });

  it('errors on extra changed file when any task declares out-of-bounds', () => {
    const tasks = [
      done({ id: 'T001', file: 'src/a.ts', scope: { outOfBounds: ['src/forbidden'] } }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      diff: '',
    });
    const out = report.findings.find((f) => f.code === 'out_of_scope_file');
    expect(out?.severity).toBe('error');
    expect(report.passed).toBe(false);
  });

  it('errors when failed task left a changed file', () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'failed' }),
      done({ id: 'T002', file: 'src/b.ts' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      diff: '',
    });
    const finding = report.findings.find((f) => f.code === 'failed_task_with_diff');
    expect(finding?.severity).toBe('error');
    expect(finding?.taskId).toBe('T001');
    expect(report.passed).toBe(false);
  });

  it('errors when out-of-bounds pattern matches changed file', () => {
    const tasks = [done({ id: 'T001', file: 'src/a.ts', scope: { outOfBounds: ['src/secrets'] } })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/secrets/leak.ts'],
      diff: '',
    });
    const finding = report.findings.find((f) => f.code === 'out_of_bounds_text_match');
    expect(finding?.severity).toBe('error');
    expect(finding?.file).toBe('src/secrets/leak.ts');
  });

  it('errors when out-of-bounds quoted symbol appears in diff text', () => {
    const tasks = [
      done({ id: 'T001', file: 'src/a.ts', scope: { outOfBounds: ['SECRET_TOKEN'] } }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      diff: 'export const SECRET_TOKEN = 1;',
    });
    expect(report.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(true);
    expect(report.passed).toBe(false);
  });

  it('treats out-of-bounds patterns as literal substrings, not regex globs', () => {
    const tasks = [done({ id: 'T001', file: 'src/a.ts', scope: { outOfBounds: ['src/*.ts'] } })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      diff: 'src/foo.ts',
    });
    expect(report.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(false);
    expect(report.passed).toBe(true);
  });

  it('warns when expected evidence missing in ledger', () => {
    const task = done({ id: 'T001', file: 'src/a.ts', evidence: ['hello returns greeting'] });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    // Deliberately mark done WITHOUT validation to leave observedEvidence empty
    ledger = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'done',
      escalated: false,
    });
    // Strip observedEvidence to simulate truly missing observations
    ledger = {
      ...ledger,
      tasks: ledger.tasks.map((t) => ({ ...t, observedEvidence: [] })),
    };
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts'],
      diff: '',
      ledger,
    });
    const f = report.findings.find((x) => x.code === 'missing_evidence');
    expect(f?.severity).toBe('warning');
    expect(f?.taskId).toBe('T001');
  });

  it('errors when diff exists but every task is failed/skipped', () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'failed' }),
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'skipped' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/c.ts'],
      diff: '',
    });
    expect(report.findings.some((f) => f.code === 'orphan_diff')).toBe(true);
    expect(report.passed).toBe(false);
  });

  it('produces a deterministic score', () => {
    const tasks = [
      done({ id: 'T001', file: 'src/a.ts' }),
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'failed' }),
    ];
    const r1 = analyzeBriefDrift({ tasks, changedFiles: ['src/a.ts', 'src/b.ts'], diff: '' });
    const r2 = analyzeBriefDrift({ tasks, changedFiles: ['src/a.ts', 'src/b.ts'], diff: '' });
    expect(r1.score).toBe(r2.score);
    // 1 error (failed_task_with_diff: -0.25) -> 0.75
    expect(r1.score).toBeCloseTo(0.75, 5);
    expect(r1.passed).toBe(false);
  });
});

describe('analyzeBriefDrift — briefHash', () => {
  it('includes briefHash in returned report when supplied', () => {
    const report = analyzeBriefDrift({
      tasks: [],
      changedFiles: [],
      diff: '',
      briefHash: 'abc123',
    });
    expect(report.briefHash).toBe('abc123');
  });

  it('sets briefHash: null when not supplied', () => {
    const report = analyzeBriefDrift({ tasks: [], changedFiles: [], diff: '' });
    expect(report.briefHash).toBeNull();
  });
});

describe('readDriftReport — backward compat', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-compat-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not throw on legacy JSON without briefHash and normalizes to null', () => {
    const report = analyzeBriefDrift({ tasks: [], changedFiles: [], diff: '' });
    const { briefHash: _bh, ...legacy } = report;
    const sessionPath = join(dir, '.diptych', 'sessions', 's1');
    mkdirSync(sessionPath, { recursive: true });
    const path = driftReportPath(dir, 's1');
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);
    expect(() => readDriftReport(dir, 's1')).not.toThrow();
    const result = readDriftReport(dir, 's1');
    expect(result).not.toBeNull();
    expect(result?.briefHash).toBeNull();
  });
});

describe('writeDriftReport', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the report at the session path with trailing newline', () => {
    const report = analyzeBriefDrift({ tasks: [], changedFiles: [], diff: '' });
    writeDriftReport(dir, 's1', report);
    const path = driftReportPath(dir, 's1');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).version).toBe(1);
  });

  it('returns null when the report file is missing', () => {
    expect(readDriftReport(dir, 'missing')).toBeNull();
  });

  it('returns null when the report file cannot be parsed', () => {
    const path = driftReportPath(dir, 's1');
    mkdirSync(join(dir, '.diptych', 'sessions', 's1'), { recursive: true });
    writeFileSync(path, '{not valid json');
    expect(readDriftReport(dir, 's1')).toBeNull();
  });
});

describe('publishDriftReport', () => {
  it('publishes a drift_report event with counts derived from findings', () => {
    const events: Array<Parameters<EventBus['publish']>[0]> = [];
    const bus: EventBus = {
      publish(event) {
        events.push(event);
      },
      subscribe() {
        return () => {};
      },
      unsubscribeAll() {},
    };
    const report = analyzeBriefDrift({
      tasks: [done({ id: 'T001', file: 'src/a.ts', scope: { outOfBounds: ['src/extra.ts'] } })],
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      diff: '',
    });

    publishDriftReport(bus, 'final-review', report);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'drift_report',
      phase: 'final-review',
      passed: false,
      errorCount: 2,
      warningCount: 0,
    });
  });
});

describe('formatDriftReportForPrompt', () => {
  it('includes passed/score and findings list with severity prefix', () => {
    const tasks = [done({ id: 'T001', file: 'src/a.ts' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      diff: '',
    });
    const out = formatDriftReportForPrompt(report);
    expect(out).toContain('passed: true');
    expect(out).toContain('score: 0.92');
    expect(out).toContain('[warning] out_of_scope_file');
    expect(out).toContain('src/extra.ts');
  });

  it('emits "findings: none" when report is clean', () => {
    const tasks = [done({ id: 'T001', file: 'src/a.ts' })];
    const report = analyzeBriefDrift({ tasks, changedFiles: ['src/a.ts'], diff: '' });
    expect(formatDriftReportForPrompt(report)).toContain('findings: none');
  });
});
