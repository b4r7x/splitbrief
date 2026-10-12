import type {
  TaskSummaryHeadingPart,
  TaskSummaryState,
} from '../../../../components/task-summary.js';
import type { StageSummary } from '../../../../core/sections/event-sections.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { formatStageLabel } from '../../../../core/phase-display.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { sanitizeTerminalDisplayText } from '../../../../utils/display-text.js';

export function stageSummaryRow(summary: StageSummary): {
  state: Extract<TaskSummaryState, { kind: 'stage' }>;
} {
  const duration = formatDuration(summary.duration);
  // A task review names the brief it reviewed; the final review names itself, says how many fix
  // cycles came before it, and marks a review run again within one cycle, as after a crash.
  const finalReview = summary.stage === 'review' && summary.scope === 'final';
  const idParts: TaskSummaryHeadingPart[] = [
    {
      text: finalReview ? 'Final review' : formatStageLabel(summary.stage),
      tone: CREW_SEAT_ROLES[summary.stage],
    },
  ];
  const anchor =
    summary.stage === 'plan'
      ? undefined
      : summary.scope === 'task'
        ? summary.afterTaskId
        : finalReviewAnchor(summary.fixCyclesBefore, summary.rerunsBefore);
  if (anchor !== undefined) idParts.push({ text: ` ${anchor}`, tone: 'textDim' });
  const title = sanitizeTerminalDisplayText(
    summary.stage === 'plan'
      ? summary.feature
      : summary.outcome === 'passed' || summary.outcome === 'passed-with-notes'
        ? 'passed'
        : summary.outcome === 'no-verdict'
          ? 'no verdict'
          : summary.outcome === 'stopped'
            ? 'stopped'
            : '',
  );
  const headingParts: Extract<TaskSummaryState, { kind: 'stage' }>['headingParts'] = {
    id: idParts,
    title:
      title === ''
        ? null
        : {
            text: title,
            tone:
              summary.stage === 'plan'
                ? ('text' as const)
                : stateTone(
                    summary.outcome === 'no-verdict'
                      ? 'failed'
                      : summary.outcome === 'stopped'
                        ? 'attention'
                        : 'passed',
                  ),
          },
  };
  if (summary.stage === 'plan') {
    return {
      state: { kind: 'stage', headingParts, outcome: 'passed', detail: [duration] },
    };
  }

  if (summary.outcome === 'passed' || summary.outcome === 'passed-with-notes') {
    return {
      state: {
        kind: 'stage',
        headingParts,
        outcome: 'passed',
        detail:
          summary.outcome === 'passed-with-notes' && summary.findings
            ? [
                countNoun(summary.findings.minor + (summary.findings.outOfScope ?? 0), 'note'),
                duration,
              ]
            : [duration],
      },
    };
  }

  if (summary.outcome === 'no-verdict' || summary.outcome === 'stopped') {
    return {
      state: {
        kind: 'stage',
        headingParts,
        outcome: summary.outcome,
        detail: [duration],
      },
    };
  }

  const failures = [...summary.failedCommands];
  if (summary.failedChecks > 0) failures.push(countNoun(summary.failedChecks, 'check'));
  const detail = summary.findings ? [`${summary.findings.blocking} blocking`] : [];
  if (failures.length > 0) detail.push(failures.join(', '));
  if (summary.fixes.length > 0) detail.push(`fixes ${summary.fixes.join(' ')}`);
  detail.push(duration);
  return {
    state: {
      kind: 'stage',
      headingParts,
      outcome: 'failed',
      detail,
    },
  };
}

function finalReviewAnchor(fixCycles: number, reruns: number): string | undefined {
  const parts = [
    ...(fixCycles > 0 ? [`after ${countNoun(fixCycles, 'fix cycle')}`] : []),
    ...(reruns > 0 ? [reruns === 1 ? 're-run' : `re-run ${reruns}`] : []),
  ];
  return parts.length === 0 ? undefined : parts.join(', ');
}
