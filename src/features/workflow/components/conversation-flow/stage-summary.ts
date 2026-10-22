import type {
  TaskSummaryHeadingPart,
  TaskSummaryState,
} from '../../../../components/task-summary.js';
import type { ReviewStage, StageSummary } from '../../../../core/sections/event-sections.js';
import { formatDuration } from '../../../../utils/format-time.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { formatStageLabel } from '../../../../core/phase-display.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { oneLineDisplayText } from '../../../../utils/display-text.js';
import { finalReviewAnchor } from '../../../../core/recovery/headline.js';

export function stageSummaryRow(summary: StageSummary): {
  state: Extract<TaskSummaryState, { kind: 'stage' }>;
} {
  const duration =
    summary.stage === 'review' && summary.endUnknown === true
      ? `at least ${formatDuration(summary.duration)}`
      : formatDuration(summary.duration);
  const title =
    summary.stage === 'plan'
      ? oneLineDisplayText(summary.feature)
      : summary.outcome === 'passed' || summary.outcome === 'passed-with-notes'
        ? 'passed'
        : summary.outcome === 'no-verdict'
          ? 'no verdict'
          : summary.outcome === 'stopped'
            ? 'stopped'
            : '';
  const headingParts: Extract<TaskSummaryState, { kind: 'stage' }>['headingParts'] = {
    id: stageHeadingParts(summary),
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

// A task review names the brief it reviewed; the final review names itself, says how many fix
// cycles came before it, and marks a review run again within one cycle, as after a crash.
export function stageHeadingParts(
  stage: { stage: 'plan' } | ReviewStage,
): TaskSummaryHeadingPart[] {
  const finalReview = stage.stage === 'review' && stage.scope === 'final';
  const parts: TaskSummaryHeadingPart[] = [
    {
      text: finalReview ? 'Final review' : formatStageLabel(stage.stage),
      tone: CREW_SEAT_ROLES[stage.stage],
    },
  ];
  const anchor =
    stage.stage === 'plan'
      ? undefined
      : stage.scope === 'task'
        ? stage.afterTaskId
        : finalReviewAnchor(stage.fixCyclesBefore, stage.rerunsBefore);
  if (anchor !== undefined) parts.push({ text: ` ${anchor}`, tone: 'textDim' });
  return parts;
}
