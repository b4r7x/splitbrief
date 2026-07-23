import { describe, expect, it } from 'vitest';
import { analyzeBriefDrift } from './analyze.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger, withUpdatedTask } from '../../../core/evidence/ledger-state.js';
import { recordRetryOrEscalationEvidence } from '../evidence/task.js';

describe('analyzeBriefDrift', () => {
  it('passes when only the exact task files changed', () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' }),
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'done' }),
    ];
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
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
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
      makeTask({
        id: 'T001',
        file: 'src/a.ts',
        status: 'done',
        scope: { outOfBounds: ['src/forbidden'] },
      }),
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
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'done' }),
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
    const tasks = [
      makeTask({
        id: 'T001',
        file: 'src/a.ts',
        status: 'done',
        scope: { outOfBounds: ['src/secrets'] },
      }),
    ];
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
      makeTask({
        id: 'T001',
        file: 'src/a.ts',
        status: 'done',
        scope: { outOfBounds: ['SECRET_TOKEN'] },
      }),
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
    const tasks = [
      makeTask({
        id: 'T001',
        file: 'src/a.ts',
        status: 'done',
        scope: { outOfBounds: ['src/*.ts'] },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      diff: 'src/foo.ts',
    });
    expect(report.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(false);
    expect(report.passed).toBe(true);
  });

  it('warns missing_expected_file when a completed task file is absent from the changed universe', () => {
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
    const report = analyzeBriefDrift({ tasks, changedFiles: [], diff: '' });
    const finding = report.findings.find((f) => f.code === 'missing_expected_file');
    expect(finding?.severity).toBe('warning');
    expect(finding?.taskId).toBe('T001');
    expect(finding?.file).toBe('src/a.ts');
  });

  it('emits no missing_expected_file when the completed task file is in the changed universe', () => {
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      diff: 'diff --git a/src/a.ts b/src/a.ts',
    });
    expect(report.findings.some((f) => f.code === 'missing_expected_file')).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('warns when expected evidence missing in ledger', () => {
    const task = makeTask({
      id: 'T001',
      file: 'src/a.ts',
      status: 'done',
      evidence: ['hello returns greeting'],
    });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    ledger = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'done',
      escalated: false,
    });
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

  it('annotates a pre-run-dirty changed file as pre-existing instead of out-of-scope when the ledger does not attribute it to the run', () => {
    const task = makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/legacy.ts'],
      diff: '',
      ledger,
    });
    const finding = report.findings.find((f) => f.file === 'src/legacy.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('pre-existing');
    expect(report.passed).toBe(true);
    expect(report.findings.some((f) => f.file === 'src/legacy.ts' && f.severity !== 'info')).toBe(
      false,
    );
  });

  it('annotates a pre-run-dirty file as pre-existing using the run-start status baseline when no ledger is present', () => {
    const task = makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/legacy.ts'],
      diff: '',
      preRunChangedFiles: ['src/legacy.ts'],
    });
    const finding = report.findings.find((f) => f.file === 'src/legacy.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).toContain('pre-existing');
    expect(report.passed).toBe(true);
    expect(report.findings.some((f) => f.file === 'src/legacy.ts' && f.severity !== 'info')).toBe(
      false,
    );
  });

  it('does not raise orphan_diff when every changed file is a pre-run-dirty baseline file', () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'failed' }),
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'skipped' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/legacy.ts'],
      diff: '',
      preRunChangedFiles: ['src/legacy.ts'],
    });
    expect(report.findings.some((f) => f.code === 'orphan_diff')).toBe(false);
  });

  it('still warns out-of-scope for a run-produced file not in the run-start status baseline', () => {
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      diff: '',
      preRunChangedFiles: ['src/legacy.ts'],
    });
    const finding = report.findings.find((f) => f.file === 'src/extra.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('warning');
    expect(report.passed).toBe(true);
  });

  it('keeps a baseline file in scope when the ledger attributes it to the run', () => {
    const task = makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts', 'src/legacy.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/legacy.ts'],
      diff: '',
      ledger,
      preRunChangedFiles: ['src/legacy.ts'],
    });
    const finding = report.findings.find((f) => f.file === 'src/legacy.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('warning');
  });

  it('still warns out-of-scope for a run-attributed file that no Task Brief targets', () => {
    const task = makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts', 'src/extra.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      diff: '',
      ledger,
    });
    const finding = report.findings.find((f) => f.file === 'src/extra.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('warning');
    expect(report.passed).toBe(true);
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
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' }),
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'failed' }),
    ];
    const r1 = analyzeBriefDrift({ tasks, changedFiles: ['src/a.ts', 'src/b.ts'], diff: '' });
    const r2 = analyzeBriefDrift({ tasks, changedFiles: ['src/a.ts', 'src/b.ts'], diff: '' });
    expect(r1.score).toBe(r2.score);
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
