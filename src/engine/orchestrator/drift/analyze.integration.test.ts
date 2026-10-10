import { describe, expect, it } from 'vitest';
import { analyzeBriefDrift } from './analyze.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ACCEPTED_SCOPE_CASES } from '#testing/helpers/factories/scope-attribution-cases.js';
import { SCOPE_ENTRY_CASES } from '#testing/helpers/scope-entries.js';
import { createEvidenceLedger, withUpdatedTask } from '../../../core/evidence/ledger-state.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';

describe('analyzeBriefDrift', () => {
  it.each(ACCEPTED_SCOPE_CASES)(
    'matches the declared set for $label paths',
    ({ task: overrides, changedFile, accepted }) => {
      const task = makeTask({ ...overrides, status: 'done' });
      const declared = isInDeclaredSet(changedFile, taskDeclaredPatterns(task));
      const report = analyzeBriefDrift({
        tasks: [task],
        changedFiles: [changedFile],
        preRunChangedFiles: [],
      });
      const reportedUntargeted = report.findings.some(
        (finding) => finding.code === 'out_of_scope_file' && finding.file === changedFile,
      );

      expect(declared).toBe(accepted);
      expect(reportedUntargeted).toBe(!accepted);
      expect(reportedUntargeted).toBe(!declared);
    },
  );

  it('passes when only the exact task files changed', () => {
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' }),
      makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], status: 'done' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      preRunChangedFiles: [],
    });
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.briefHash).toBeNull();
  });

  it('an undeclared path is info: touched, not suggested by any task', () => {
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.code === 'out_of_scope_file');
    expect(finding?.severity).toBe('info');
    expect(finding?.file).toBe('src/extra.ts');
    expect(finding?.message).toBe('src/extra.ts touched, not suggested by any task.');
    expect(report.passed).toBe(true);
  });

  it('second declared file changed by the run is not out_of_scope_file', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        suggestedFiles: ['src/a.ts', 'src/a.test.ts'],
        status: 'done',
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/a.test.ts'],
      preRunChangedFiles: [],
    });
    expect(report.findings).toEqual([]);
    expect(report.expectedFiles).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect(report.passed).toBe(true);
  });

  it.each(SCOPE_ENTRY_CASES)(
    'prose in-bounds bullet is accepted: $name',
    ({ entry, matches, nonMatches }) => {
      const tasks = [
        makeTask({
          id: 'T001',
          suggestedFiles: ['src/a.ts'],
          status: 'done',
          scope: { inBounds: [entry] },
        }),
      ];
      const report = analyzeBriefDrift({
        tasks,
        changedFiles: ['src/a.ts', ...matches, ...nonMatches],
        preRunChangedFiles: [],
      });
      expect(
        report.findings.filter((f) => f.code === 'out_of_scope_file').map((f) => f.file),
      ).toEqual(nonMatches);
    },
  );

  it('an extra changed file stays info when a task declares out-of-bounds', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        suggestedFiles: ['src/a.ts'],
        status: 'done',
        scope: { outOfBounds: ['src/forbidden'] },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      preRunChangedFiles: [],
    });
    const out = report.findings.find((f) => f.code === 'out_of_scope_file');
    expect(out?.severity).toBe('info');
    expect(report.passed).toBe(true);
  });

  it('errors when failed task left a changed file', () => {
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'failed' }),
      makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], status: 'done' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.code === 'failed_task_with_diff');
    expect(finding?.severity).toBe('error');
    expect(finding?.taskId).toBe('T001');
    expect(report.passed).toBe(false);
  });

  it('errors when a failed task leaves a changed file matching its primary glob', () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/failed/*.ts'], status: 'failed' });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/failed/matched.ts'],
      preRunChangedFiles: [],
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: 'failed_task_with_diff',
        taskId: 'T001',
        file: 'src/failed/*.ts',
      }),
    );
  });

  it('excludes the planner-written root tasks.md from the drift universe', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        suggestedFiles: ['src/a.ts'],
        status: 'done',
        scope: { outOfBounds: ['src/forbidden'] },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'tasks.md'],
      preRunChangedFiles: [],
    });
    expect(report.changedFiles).toEqual(['src/a.ts']);
    expect(report.findings).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('still reports a nested tasks.md because only root phase files are session artifacts', () => {
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'docs/tasks.md'],
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.file === 'docs/tasks.md');
    expect(finding?.code).toBe('out_of_scope_file');
  });

  it('keeps a root artifact file that a Task Brief explicitly targets', () => {
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['tasks.md'], status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['tasks.md'],
      preRunChangedFiles: [],
    });
    expect(report.changedFiles).toEqual(['tasks.md']);
    expect(report.findings.some((f) => f.code === 'missing_expected_file')).toBe(false);
  });

  it('passes the real run-B universe: prose scopes, planner tasks.md in the diff, clean tasks', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        suggestedFiles: ['src/text.ts'],
        status: 'done',
        scope: {
          inBounds: ['Creating `src/text.ts` with the single `titleCase` export.'],
          outOfBounds: [
            'Modifying `src/slug.ts`, `src/slug.test.ts`, or any config files.',
            'Adding extra utility functions, options parameters, or locale handling.',
          ],
          approvedOutOfBounds: ['None.'],
        },
      }),
      makeTask({
        id: 'T002',
        suggestedFiles: ['src/text.test.ts'],
        status: 'done',
        scope: {
          inBounds: ['Creating `src/text.test.ts` with tests for `titleCase`.'],
          outOfBounds: [
            'Modifying `src/text.ts`, `src/slug.test.ts`, or vitest/tsconfig configuration.',
          ],
          approvedOutOfBounds: ['None.'],
        },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['runB.err', 'runB.ndjson', 'src/text.test.ts', 'src/text.ts', 'tasks.md'],
      briefHash: 'e0ea1cbfbbf2f73228274a3e402f2a22d211befacf49d67d56062c6289167188',
      preRunChangedFiles: ['runB.err', 'runB.ndjson', 'tasks.md'],
    });

    expect(report.passed).toBe(true);
    expect(report.briefHash).toBe(
      'e0ea1cbfbbf2f73228274a3e402f2a22d211befacf49d67d56062c6289167188',
    );
    expect(report.changedFiles).toEqual([
      'runB.err',
      'runB.ndjson',
      'src/text.test.ts',
      'src/text.ts',
    ]);
    expect(report.findings.map((f) => ({ severity: f.severity, code: f.code }))).toEqual([
      { severity: 'info', code: 'out_of_scope_file' },
      { severity: 'info', code: 'out_of_scope_file' },
    ]);
  });

  it('warns missing_expected_file when a completed task file is absent from the changed universe', () => {
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' })];
    const report = analyzeBriefDrift({ tasks, changedFiles: [], preRunChangedFiles: [] });
    const finding = report.findings.find((f) => f.code === 'missing_expected_file');
    expect(finding?.severity).toBe('warning');
    expect(finding?.taskId).toBe('T001');
    expect(finding?.file).toBe('src/a.ts');
  });

  it('emits no missing_expected_file when the completed task file is in the changed universe', () => {
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      preRunChangedFiles: [],
    });
    expect(report.findings).toEqual([]);
  });

  it('treats a glob primary match as present without changing the primary expected file', () => {
    const task = makeTask({ suggestedFiles: ['src/feature/*.ts'], status: 'done' });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/feature/matched.ts'],
      preRunChangedFiles: [],
    });

    expect(report.expectedFiles).toEqual(['src/feature/*.ts']);
    expect(report.findings.some((finding) => finding.code === 'missing_expected_file')).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'out_of_scope_file')).toBe(false);
  });

  it('sorts changed files, primary expected files, and file findings deterministically', () => {
    const tasks = [
      makeTask({ id: 'T002', suggestedFiles: ['src/z.ts'], status: 'done' }),
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/z.ts', 'src/extra-z.ts', 'src/a.ts', 'src/extra-a.ts', 'src/z.ts'],
      preRunChangedFiles: [],
    });

    expect(report.changedFiles).toEqual([
      'src/a.ts',
      'src/extra-a.ts',
      'src/extra-z.ts',
      'src/z.ts',
    ]);
    expect(report.expectedFiles).toEqual(['src/a.ts', 'src/z.ts']);
    expect(
      report.findings
        .filter((finding) => finding.code === 'out_of_scope_file')
        .map((finding) => finding.file),
    ).toEqual(['src/extra-a.ts', 'src/extra-z.ts']);
  });

  it('treats a ledger-unattributed file absent from the run-start baseline as run-produced', () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/unattributed.ts'],
      ledger,
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.file === 'src/unattributed.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).not.toContain('pre-existing');
  });

  it('uses an explicit run-start baseline to distinguish pre-existing files from unattributed run-produced files', () => {
    const task = makeTask({
      id: 'T001',
      suggestedFiles: ['src/a.ts'],
      status: 'done',
      scope: { outOfBounds: ['src/forbidden'] },
    });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/legacy.ts', 'src/extra.ts'],
      ledger,
      preRunChangedFiles: ['src/legacy.ts'],
    });
    expect(report.findings.find((f) => f.file === 'src/legacy.ts')).toMatchObject({
      code: 'out_of_scope_file',
      severity: 'info',
    });
    expect(report.findings.find((f) => f.file === 'src/extra.ts')).toMatchObject({
      code: 'out_of_scope_file',
      severity: 'info',
      message: 'src/extra.ts touched, not suggested by any task.',
    });
    expect(report.passed).toBe(true);
  });

  it('annotates a pre-run-dirty file as pre-existing using the run-start status baseline when no ledger is present', () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/legacy.ts'],
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
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'failed' }),
      makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], status: 'skipped' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/legacy.ts'],
      preRunChangedFiles: ['src/legacy.ts'],
    });
    expect(report.findings.some((f) => f.code === 'orphan_diff')).toBe(false);
  });

  it('treats a ledger-attributed baseline file as run-produced but still out-of-scope when untargeted', () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts', 'src/legacy.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/legacy.ts'],
      ledger,
      preRunChangedFiles: ['src/legacy.ts'],
    });
    const finding = report.findings.find((f) => f.file === 'src/legacy.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('info');
    expect(finding?.message).not.toContain('pre-existing');
  });

  it('reports a run-attributed file that no Task Brief targets as touched, never as a failure', () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts', 'src/extra.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      ledger,
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.file === 'src/extra.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('info');
    expect(report.passed).toBe(true);
  });

  it('errors when diff exists but every task is failed/skipped', () => {
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'failed' }),
      makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], status: 'skipped' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/c.ts'],
      preRunChangedFiles: [],
    });
    expect(report.findings.some((f) => f.code === 'orphan_diff')).toBe(true);
    expect(report.passed).toBe(false);
  });
});
