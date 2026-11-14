import { describe, expect, it } from 'vitest';
import { RUN, reportWith } from '#testing/helpers/readiness-format.js';
import { StartReadinessRecordSchema } from '../schemas/readiness.js';
import { buildRepoChecks } from './checks/repo.js';
import {
  createStartReadinessRecord,
  formatReadinessReport,
  startReadinessWarnings,
} from './format.js';
import { READINESS_DIAGNOSTIC_REMEDIATION } from './json.js';

describe('start readiness record', () => {
  it('keeps a checkout warning with its details and fix', () => {
    const report = reportWith(
      buildRepoChecks(
        { isGitRepo: true, hasCommits: true, dirtyFiles: ['src/a.ts'], untrackedFiles: [] },
        'none',
      ),
    );

    const dirty = createStartReadinessRecord(report, RUN).checks.find(
      (check) => check.id === 'repo.dirty-worktree',
    );

    expect(dirty?.details).toContain('Examples: src/a.ts');
    expect(dirty?.remediation).toContain('The run edits this checkout.');
    expect(dirty?.remediation).toContain(
      'A revert saves the files it replaces in .splitbrief/sessions/2026-01-01-fix-the-readme/reverted/.',
    );
  });

  it('records the diagnostic remediation of a warning that names no fix, and no ok or info check', () => {
    const record = createStartReadinessRecord(
      reportWith([
        {
          id: 'auth',
          severity: 'warning',
          summary: 'Sign-in is not proven.',
          diagnosticState: 'auth-unknown',
        },
        { id: 'fine', severity: 'ok', summary: 'Fine.', fix: 'Nothing.' },
        { id: 'note', severity: 'info', summary: 'A note.' },
      ]),
      RUN,
    );

    expect(record.checks).toEqual([
      {
        id: 'auth',
        severity: 'warning',
        summary: 'Sign-in is not proven.',
        remediation: READINESS_DIAGNOSTIC_REMEDIATION['auth-unknown'],
      },
    ]);
  });

  it('still reads a record that holds only the summary of each check', () => {
    expect(
      StartReadinessRecordSchema.parse({
        type: 'start-readiness',
        generatedAt: '2026-01-01T00:00:00.000Z',
        status: 'ready-with-warnings',
        nextAction: 'continue',
        blockerCount: 0,
        warningCount: 1,
        checks: [
          {
            id: 'repo.dirty-worktree',
            severity: 'warning',
            summary: 'Working tree has 1 changed file.',
          },
        ],
      }).checks,
    ).toHaveLength(1);
  });

  it('states each warning as its summary, its details, then its fix, and leaves blockers out', () => {
    const record = createStartReadinessRecord(
      reportWith([
        { id: 'stop', severity: 'blocker', summary: 'Cannot start.', fix: 'Install it.' },
        {
          id: 'dirty',
          severity: 'warning',
          summary: 'Working tree has 1 changed file.',
          details: ['Examples: a.ts'],
          fix: 'Commit it.',
        },
        {
          id: 'runners.preparation.implementer',
          severity: 'warning',
          summary: 'Implementer is ready with warnings.',
          details: ['The sandbox profile is missing.'],
        },
        { id: 'plain', severity: 'warning', summary: 'A plain warning.' },
      ]),
      RUN,
    );

    expect(startReadinessWarnings(record)).toEqual([
      'Working tree has 1 changed file.\nExamples: a.ts\nFix: Commit it.',
      'Implementer is ready with warnings.\nThe sandbox profile is missing.',
      'A plain warning.',
    ]);
  });

  it('states a checkout warning in the words doctor prints, with the run folder named', () => {
    const report = reportWith(
      buildRepoChecks(
        { isGitRepo: true, hasCommits: true, dirtyFiles: ['README.md'], untrackedFiles: [] },
        'none',
      ),
    );
    const [warning = ''] = startReadinessWarnings(createStartReadinessRecord(report, RUN));
    const doctor = formatReadinessReport(report);

    expect(warning.split('\n')).toEqual([
      'Working tree has 1 changed file.',
      'Examples: README.md',
      'An attempt revert restores only the paths that attempt changed.',
      'Fix: The run edits this checkout. A revert saves the files it replaces in .splitbrief/sessions/2026-01-01-fix-the-readme/reverted/. Commit or stash the edits you do not want this run to touch.',
    ]);
    for (const line of warning.split('\n').slice(0, 3)) expect(doctor).toContain(line);
    expect(doctor).toContain(
      "A revert saves the files it replaces in the run's reverted/ folder, under .splitbrief/sessions/.",
    );
  });
});
