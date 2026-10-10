import { describe, expect, it } from 'vitest';
import { analyzeBriefDrift } from './analyze.js';
import { formatDriftReportForPrompt, publishDriftReport } from './format.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { EventBus } from '../../events/types.js';

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
    };
    const report = analyzeBriefDrift({
      tasks: [
        makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' }),
        makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], status: 'failed' }),
      ],
      changedFiles: ['src/a.ts', 'src/b.ts'],
      preRunChangedFiles: [],
    });

    publishDriftReport(bus, 'final-review', report);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'drift_report',
      phase: 'final-review',
      passed: false,
      errorCount: 1,
      warningCount: 0,
      findings: report.findings,
    });
  });
});

describe('formatDriftReportForPrompt', () => {
  it('states passed and the findings with their severity, and no score', () => {
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts', 'src/extra.ts'],
      preRunChangedFiles: [],
    });
    const out = formatDriftReportForPrompt(report);
    expect(out).toContain('passed: true');
    expect(out).not.toContain('score');
    expect(out).toContain('[info] out_of_scope_file');
    expect(out).toContain('src/extra.ts');
  });

  it('emits "findings: none" when report is clean', () => {
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'done' })];
    const report = analyzeBriefDrift({
      tasks,
      changedFiles: ['src/a.ts'],
      preRunChangedFiles: [],
    });
    expect(formatDriftReportForPrompt(report)).toContain('findings: none');
  });
});
