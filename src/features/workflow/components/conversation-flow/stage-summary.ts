import type { TaskSummaryState } from '../../../../components/task-summary.js';
import type { StageSummary } from '../../../../core/sections/event-sections.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { countNoun } from '../../../../utils/pluralize.js';

export function stageSummaryRow(summary: StageSummary): {
  id: string;
  title: string;
  state: TaskSummaryState;
} {
  const duration = formatDuration(summary.duration);
  if (summary.stage === 'plan') {
    return {
      id: 'Plan',
      title: summary.feature,
      state: { kind: 'stage', outcome: 'passed', detail: [duration] },
    };
  }

  const anchor = summary.scope === 'task' ? summary.afterTaskId : summary.ordinal;
  const id = anchor === undefined ? 'Review' : `Review ${anchor}`;
  if (summary.outcome === 'passed' || summary.outcome === 'passed-with-notes') {
    return {
      id,
      title: 'passed',
      state: {
        kind: 'stage',
        outcome: 'passed',
        detail:
          summary.outcome === 'passed-with-notes' && summary.findings
            ? [countNoun(summary.findings.minor, 'note'), duration]
            : [duration],
      },
    };
  }

  if (summary.outcome === 'no-verdict' || summary.outcome === 'stopped') {
    return {
      id,
      title: summary.outcome === 'no-verdict' ? 'no verdict' : 'stopped',
      state: { kind: 'stage', outcome: summary.outcome, detail: [duration] },
    };
  }

  const failures = [...summary.failedCommands];
  if (summary.failedChecks > 0) failures.push(countNoun(summary.failedChecks, 'check'));
  const detail = summary.findings ? [`${summary.findings.blocking} blocking`] : [];
  if (failures.length > 0) detail.push(failures.join(', '));
  if (summary.fixes.length > 0) detail.push(`fixes ${summary.fixes.join(' ')}`);
  detail.push(duration);
  return {
    id,
    title: '',
    state: {
      kind: 'stage',
      outcome: 'failed',
      detail,
    },
  };
}
