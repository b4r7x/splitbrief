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
      state: { kind: 'stage', failed: false, detail: [duration] },
    };
  }

  if (summary.outcome === 'passed') {
    return {
      id: `Review ${summary.ordinal}`,
      title: 'passed',
      state: { kind: 'stage', failed: false, detail: [duration] },
    };
  }

  const failures = [...summary.failedCommands];
  if (summary.failedChecks > 0) failures.push(countNoun(summary.failedChecks, 'check'));
  const detail = failures.length > 0 ? [failures.join(', ')] : [];
  if (summary.fixes.length > 0) detail.push(`fixes ${summary.fixes.join(' ')}`);
  detail.push(duration);
  return {
    id: `Review ${summary.ordinal}`,
    title: '',
    state: {
      kind: 'stage',
      failed: true,
      detail,
    },
  };
}
