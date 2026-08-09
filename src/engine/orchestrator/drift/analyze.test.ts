import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { analyzeBriefDrift } from './analyze.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createEvidenceLedger, withUpdatedTask } from '../../../core/evidence/ledger-state.js';
import { recordRetryOrEscalationEvidence } from '../evidence/task.js';
import {
  captureChangedFilesBaseline,
  inferTaskAcceptedChangedFiles,
} from '../changed-files-baseline.js';

const acceptedScopeCases = [
  {
    label: 'exact primary',
    task: makeTask({ file: 'src/primary.ts', status: 'done' }),
    changedFile: 'src/primary.ts',
    accepted: true,
  },
  {
    label: 'glob primary',
    task: makeTask({ file: 'src/primary/*.ts', status: 'done' }),
    changedFile: 'src/primary/matched.ts',
    accepted: true,
  },
  {
    label: 'exact in-bounds',
    task: makeTask({
      file: 'src/primary.ts',
      status: 'done',
      scope: { inBounds: ['src/in-bounds.ts'] },
    }),
    changedFile: 'src/in-bounds.ts',
    accepted: true,
  },
  {
    label: 'glob in-bounds',
    task: makeTask({
      file: 'src/primary.ts',
      status: 'done',
      scope: { inBounds: ['src/in-bounds/**'] },
    }),
    changedFile: 'src/in-bounds/matched.ts',
    accepted: true,
  },
  {
    label: 'exact approved',
    task: makeTask({
      file: 'src/primary.ts',
      status: 'done',
      scope: { approvedOutOfBounds: ['generated/exact.ts'] },
    }),
    changedFile: 'generated/exact.ts',
    accepted: true,
  },
  {
    label: 'glob approved',
    task: makeTask({
      file: 'src/primary.ts',
      status: 'done',
      scope: { approvedOutOfBounds: ['generated/**'] },
    }),
    changedFile: 'generated/matched.ts',
    accepted: true,
  },
  {
    label: 'truly untargeted',
    task: makeTask({ file: 'src/primary.ts', status: 'done' }),
    changedFile: 'unrelated/extra.ts',
    accepted: false,
  },
] as const;

describe('analyzeBriefDrift', () => {
  it.each(acceptedScopeCases)('matches task attribution for $label paths', async ({
    task,
    changedFile,
    accepted,
  }) => {
    await withTempDir('drift-scope-parity', async (projectDir) => {
      createTestGitRepo(projectDir);
      const target = join(projectDir, changedFile);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'export const changed = true;\n');
      const baseline = await captureChangedFilesBaseline(projectDir, []);

      const attributed = await inferTaskAcceptedChangedFiles(projectDir, task, baseline.head);
      const report = analyzeBriefDrift({
        tasks: [task],
        changedFiles: [changedFile],
        diff: '',
        preRunChangedFiles: [],
      });
      const reportedUntargeted = report.findings.some(
        (finding) => finding.code === 'out_of_scope_file' && finding.file === changedFile,
      );

      expect(attributed.includes(changedFile)).toBe(accepted);
      expect(reportedUntargeted).toBe(!accepted);
    });
  });

  it('passes when only the exact task files changed', () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' }),
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'done' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      diff: 'diff stuff',
      preRunChangedFiles: [],
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
      preRunChangedFiles: [],
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
      preRunChangedFiles: [],
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
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.code === 'failed_task_with_diff');
    expect(finding?.severity).toBe('error');
    expect(finding?.taskId).toBe('T001');
    expect(report.passed).toBe(false);
  });

  it('errors when a failed task leaves a changed file matching its primary glob', () => {
    const task = makeTask({ id: 'T001', file: 'src/failed/*.ts', status: 'failed' });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/failed/matched.ts'],
      diff: '',
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
      preRunChangedFiles: [],
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
      preRunChangedFiles: [],
    });
    expect(report.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(true);
    expect(report.passed).toBe(false);
  });

  it('attributes a bare-directory out-of-bounds pattern to the changed file, not to diff text', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        file: 'src/a.ts',
        status: 'done',
        scope: { outOfBounds: ['node_modules'] },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'node_modules/left-pad/index.js'],
      diff: 'diff --git a/package.json b/package.json\n+  "node_modules": "ignored"\n',
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.code === 'out_of_bounds_text_match');
    expect(finding?.severity).toBe('error');
    expect(finding?.file).toBe('node_modules/left-pad/index.js');
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
      preRunChangedFiles: [],
    });
    expect(report.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(false);
    expect(report.passed).toBe(true);
  });

  it('skips reviewer prose out-of-bounds entries instead of substring-matching them', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        file: 'src/text.ts',
        status: 'done',
        scope: {
          outOfBounds: ['Modifying `src/slug.ts`, `src/slug.test.ts`, or any config files.'],
        },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/text.ts'],
      diff: 'Modifying `src/slug.ts`, `src/slug.test.ts`, or any config files.',
      preRunChangedFiles: [],
    });
    expect(report.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(false);
    expect(report.passed).toBe(true);
  });

  it('excludes the planner-written root tasks.md from the drift universe', () => {
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
      changedFiles: ['src/a.ts', 'tasks.md'],
      diff: '',
      preRunChangedFiles: [],
    });
    expect(report.changedFiles).toEqual(['src/a.ts']);
    expect(report.findings).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('still reports a nested tasks.md because only root phase files are session artifacts', () => {
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'docs/tasks.md'],
      diff: '',
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.file === 'docs/tasks.md');
    expect(finding?.code).toBe('out_of_scope_file');
  });

  it('keeps a root artifact file that a Task Brief explicitly targets', () => {
    const tasks = [makeTask({ id: 'T001', file: 'tasks.md', status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['tasks.md'],
      diff: '',
      preRunChangedFiles: [],
    });
    expect(report.changedFiles).toEqual(['tasks.md']);
    expect(report.findings.some((f) => f.code === 'missing_expected_file')).toBe(false);
  });

  it('flags a non-targeted changed file matching a glob out-of-bounds path', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        file: 'src/a.ts',
        status: 'done',
        scope: { outOfBounds: ['src/legacy/*.ts'] },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/legacy/x.ts'],
      diff: '',
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.code === 'out_of_bounds_text_match');
    expect(finding?.severity).toBe('error');
    expect(finding?.file).toBe('src/legacy/x.ts');
  });

  it('never counts a task-targeted file as an out-of-bounds hit', () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/text.ts', status: 'done' }),
      makeTask({
        id: 'T002',
        file: 'src/text.test.ts',
        status: 'done',
        scope: { outOfBounds: ['src/text.ts'] },
      }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/text.test.ts', 'src/text.ts'],
      diff: '',
      preRunChangedFiles: [],
    });
    expect(report.findings).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('does not match a symbol inside a session artifact diff section', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        file: 'src/a.ts',
        status: 'done',
        scope: { outOfBounds: ['SECRET_TOKEN'] },
      }),
    ];
    const artifactOnlyDiff = [
      'diff --git a/tasks.md b/tasks.md',
      '--- a/tasks.md',
      '+++ b/tasks.md',
      '+**Out of bounds:**',
      '+- SECRET_TOKEN',
      '',
    ].join('\n');
    const clean = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      diff: artifactOnlyDiff,
      preRunChangedFiles: [],
    });
    expect(clean.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(false);
    expect(clean.passed).toBe(true);

    const offending = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      diff: `${artifactOnlyDiff}diff --git a/src/a.ts b/src/a.ts\n+export const SECRET_TOKEN = 1;\n`,
      preRunChangedFiles: [],
    });
    expect(offending.findings.some((f) => f.code === 'out_of_bounds_text_match')).toBe(true);
    expect(offending.passed).toBe(false);
  });

  it('passes the real run-B universe: prose scopes, planner tasks.md in the diff, clean tasks', () => {
    const tasks = [
      makeTask({
        id: 'T001',
        file: 'src/text.ts',
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
        file: 'src/text.test.ts',
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
    const diff = [
      'diff --git a/tasks.md b/tasks.md',
      '+++ b/tasks.md',
      '+**Out of bounds:**',
      '+- Modifying `src/slug.ts`, `src/slug.test.ts`, or any config files.',
      '+- Adding extra utility functions, options parameters, or locale handling.',
      '+- Modifying `src/text.ts`, `src/slug.test.ts`, or vitest/tsconfig configuration.',
      'diff --git a/src/text.ts b/src/text.ts',
      '+export function titleCase(input: string): string {',
      'diff --git a/src/text.test.ts b/src/text.test.ts',
      "+import { titleCase } from './text.js';",
      '',
    ].join('\n');
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['runB.err', 'runB.ndjson', 'src/text.test.ts', 'src/text.ts', 'tasks.md'],
      diff,
      briefHash: 'e0ea1cbfbbf2f73228274a3e402f2a22d211befacf49d67d56062c6289167188',
      preRunChangedFiles: ['runB.err', 'runB.ndjson', 'tasks.md'],
    });

    expect(report.passed).toBe(true);
    expect(report.score).toBe(1);
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
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
    const report = analyzeBriefDrift({ tasks, changedFiles: [], diff: '', preRunChangedFiles: [] });
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
      preRunChangedFiles: [],
    });
    expect(report.findings.some((f) => f.code === 'missing_expected_file')).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('treats a glob primary match as present without changing the primary expected file', () => {
    const task = makeTask({ file: 'src/feature/*.ts', status: 'done' });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/feature/matched.ts'],
      diff: '',
      preRunChangedFiles: [],
    });

    expect(report.expectedFiles).toEqual(['src/feature/*.ts']);
    expect(report.findings.some((finding) => finding.code === 'missing_expected_file')).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'out_of_scope_file')).toBe(false);
  });

  it('sorts changed files, primary expected files, and file findings deterministically', () => {
    const tasks = [
      makeTask({ id: 'T002', file: 'src/z.ts', status: 'done' }),
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' }),
    ];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/z.ts', 'src/extra-z.ts', 'src/a.ts', 'src/extra-a.ts', 'src/z.ts'],
      diff: '',
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

  it('warns when a done task observed only orchestrator bookkeeping stamps', () => {
    const task = makeTask({
      id: 'T001',
      file: 'src/a.ts',
      status: 'done',
      evidence: ['hello returns greeting'],
    });
    let ledger = createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] });
    // Stamps 'task reached done' and 'diff written for src/a.ts' — the
    // orchestrator's own bookkeeping, not evidence the implementer produced.
    ledger = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'done',
      escalated: false,
    });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts'],
      diff: '',
      ledger,
      preRunChangedFiles: [],
    });
    const f = report.findings.find((x) => x.code === 'missing_evidence');
    expect(f?.severity).toBe('warning');
    expect(f?.taskId).toBe('T001');
  });

  it('does not warn when a validation outcome was observed', () => {
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
      validation: [{ stage: 'test', passed: true }],
    });
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts'],
      diff: '',
      ledger,
      preRunChangedFiles: [],
    });
    expect(report.findings.find((x) => x.code === 'missing_evidence')).toBeUndefined();
  });

  it('treats a ledger-unattributed file absent from the run-start baseline as run-produced', () => {
    const task = makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 's1', feature: 'f', tasks: [task] }),
      'T001',
      (t) => ({ ...t, changedFiles: ['src/a.ts'] }),
    );
    const report = analyzeBriefDrift({
      tasks: [task],
      changedFiles: ['src/a.ts', 'src/unattributed.ts'],
      diff: '',
      ledger,
      preRunChangedFiles: [],
    });
    const finding = report.findings.find((f) => f.file === 'src/unattributed.ts');
    expect(finding?.code).toBe('out_of_scope_file');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).not.toContain('pre-existing');
  });

  it('uses an explicit run-start baseline to distinguish pre-existing files from unattributed run-produced files', () => {
    const task = makeTask({
      id: 'T001',
      file: 'src/a.ts',
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
      diff: '',
      ledger,
      preRunChangedFiles: ['src/legacy.ts'],
    });
    expect(report.findings.find((f) => f.file === 'src/legacy.ts')).toMatchObject({
      code: 'out_of_scope_file',
      severity: 'info',
    });
    expect(report.findings.find((f) => f.file === 'src/extra.ts')).toMatchObject({
      code: 'out_of_scope_file',
      severity: 'error',
    });
    expect(report.passed).toBe(false);
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

  it('treats a ledger-attributed baseline file as run-produced but still out-of-scope when untargeted', () => {
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
      preRunChangedFiles: [],
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
      preRunChangedFiles: [],
    });
    expect(report.findings.some((f) => f.code === 'orphan_diff')).toBe(true);
    expect(report.passed).toBe(false);
  });

  it('produces a deterministic score', () => {
    const tasks = [
      makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' }),
      makeTask({ id: 'T002', file: 'src/b.ts', status: 'failed' }),
    ];
    const r1 = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      diff: '',
      preRunChangedFiles: [],
    });
    const r2 = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      diff: '',
      preRunChangedFiles: [],
    });
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
      preRunChangedFiles: [],
    });
    expect(report.briefHash).toBe('abc123');
  });

  it('sets briefHash: null when not supplied', () => {
    const report = analyzeBriefDrift({
      tasks: [],
      changedFiles: [],
      diff: '',
      preRunChangedFiles: [],
    });
    expect(report.briefHash).toBeNull();
  });
});
