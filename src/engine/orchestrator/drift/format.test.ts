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
        makeTask({
          id: 'T001',
          file: 'src/a.ts',
          status: 'done',
          scope: { outOfBounds: ['src/extra.ts'] },
        }),
      ],
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
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
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
    const tasks = [makeTask({ id: 'T001', file: 'src/a.ts', status: 'done' })];
    const report = analyzeBriefDrift({ tasks, changedFiles: ['src/a.ts'], diff: '' });
    expect(formatDriftReportForPrompt(report)).toContain('findings: none');
  });
});
