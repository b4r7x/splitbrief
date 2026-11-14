import {
  type RunnerConfig,
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../../config/accessors/runner-config.js';
import {
  formatSlotLabel,
  REVIEW_NONE,
  PLANNER_INHERITANCE,
  CREW_IDENTITY_SEPARATOR,
} from '../../../crew/identity.js';
import { isAutomaticModel } from '../../../providers/automatic-model.js';
import {
  type SeatImageFact,
  seatSupportsImages,
  reviewSeatRenderNote,
} from '../../../runners/capabilities.js';
import type { Config } from '../../../schemas/config.js';
import type { ReadinessModelSelection } from '../../../schemas/readiness.js';
import type { ReviewerConfig } from '../../../schemas/runner/reviewer.js';
import type { SeatNamer, ReadinessCheck } from '../../types.js';

/** With `validation.render` set, the REVIEW line says when its seat cannot see the renders. */
export function reviewSeatRenderCheckDetail(
  config: Config,
  runner: RunnerConfig,
  seatImageFact: SeatImageFact,
): string[] {
  if (config.validation.render === undefined) return [];
  if (seatSupportsImages({ runner, detected: seatImageFact(runner, 'reviewer') })) return [];
  const review = formatSlotLabel({ role: 'reviewer' });
  return [
    `${reviewSeatRenderNote({ runner, renderCheckIds: [] })} In Settings > Crew > ${review}, change the review seat to a tool that reads images.`,
  ];
}

export function seatConfiguredCheck(
  role: 'planner' | 'reviewer',
  runner: Config['planner'] | ReviewerConfig,
  nameSeat: SeatNamer,
  details: readonly string[],
): ReadinessCheck {
  return {
    id: `runners.${role}.configured`,
    severity: 'ok',
    summary: `${formatSlotLabel({ role })} ${nameSeat(runner, role)} configured.`,
    ...(details.length > 0 && { details: [...details] }),
    metadata: {
      role,
      kind: runner.kind,
      name: getRunnerDisplayName(runner),
      model: getRunnerModelName(runner) ?? null,
      modelSelection: modelSelection(runner),
      contextLength: runner.contextLength ?? null,
    },
  };
}

export function noReviewerCheck(): ReadinessCheck {
  return {
    id: 'runners.reviewer.none',
    severity: 'ok',
    summary: `${formatSlotLabel({ role: 'reviewer' })} ${REVIEW_NONE.mark}. No review, no end-of-run checks and no render check run.`,
    metadata: { role: 'reviewer' },
  };
}

/** With no reviewer block PLAN's seat reviews, so REVIEW names that seat after the inheritance mark. */
export function inheritedReviewerCheck(
  runner: Config['planner'],
  nameSeat: SeatNamer,
  renderDetails: readonly string[],
): ReadinessCheck {
  const review = formatSlotLabel({ role: 'reviewer' });
  const plan = formatSlotLabel({ role: 'planner' });
  return {
    id: 'runners.reviewer.inherited',
    severity: 'ok',
    summary: `${review} ${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${nameSeat(runner, 'reviewer')}.`,
    details: [
      `${review} uses the tool and model of ${plan}. To give ${review} its own seat, choose one in Settings > Crew > ${review}.`,
      ...renderDetails,
    ],
    metadata: { role: 'reviewer', modelSelection: modelSelection(runner) },
  };
}

export function modelSelection(
  runner: Config['planner'] | Config['implementer'],
): ReadinessModelSelection {
  if (isAutomaticModel(runner.model, getRunnerDisplayName(runner))) return 'auto';
  return runner.model === undefined ? 'unset' : 'explicit';
}
