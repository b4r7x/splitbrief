import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import {
  seatSupportsImages,
  reviewSeatRenderNote,
  REVIEW_SEAT_IMAGE_FIX,
} from '../../../core/runners/capabilities.js';
import type { Config } from '../../../core/schemas/config.js';
import { readPackageScripts } from '../../../core/readiness/repo-posture.js';
import type { TaskSpec, PlanProposal } from '../../../core/schemas/plan.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import { pluralize } from '../../../utils/pluralize.js';
import { missingNpmScript } from '../../orchestrator/validation/plan-policy/npm-scripts.js';
import { commandTextRefusal } from '../../orchestrator/validation/plan-policy/command.js';
import { resolveSeatImageFact } from '../../providers/model/resolution.js';
import type { ModelCacheAccessor } from '../../providers/model/runtime-snapshot.js';
import type { PlanCheckError } from './types.js';

/** The ids of every `render` check in `checks`, in order. */
function renderCheckIds(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind'>[],
): string[] {
  return checks.filter((check) => check.kind === 'render').map((check) => check.id);
}

/** The ids of every `render` check in `checks`, in order, or none when the run sets `validation.render`. */
export function unconfiguredRenderCheckIds(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind'>[],
  renderCommand: string | undefined,
): string[] {
  if (renderCommand !== undefined) return [];
  return renderCheckIds(checks);
}

/** "Render checks A, B need validation.render, which is not set", in the number the ids have. */
export function renderChecksNeedCommand(ids: readonly string[]): string {
  return `${pluralize(ids.length, 'Render check')} ${ids.join(', ')} ${pluralize(ids.length, 'needs', 'need')} validation.render, which is not set`;
}

/**
 * The plan card's notes on its render checks: one for the checks while `validation.render` is not
 * set, and one when the review seat cannot see the renders, so their criteria cannot pass.
 */
export function renderCheckNotes(
  plan: PlanProposal,
  config: Config,
  modelCache: ModelCacheAccessor | undefined,
): string[] {
  const checks = [...plan.checks, ...plan.tasks.flatMap((task) => task.checks)];
  if (resolveReviewCadence(config) === 'none') {
    const ids = [
      ...plan.checks.map((check) => check.id),
      ...renderCheckIds(plan.tasks.flatMap((task) => task.checks)),
    ];
    if (ids.length === 0) return [];
    return [
      `${pluralize(ids.length, 'Check')} ${ids.join(', ')} ${pluralize(ids.length, 'does', 'do')} not run: REVIEW is None, so only the checks of a brief run, and no render check runs. Request changes to move or drop ${pluralize(ids.length, 'it', 'them')}.`,
    ];
  }
  const notes: string[] = [];
  const unconfigured = unconfiguredRenderCheckIds(checks, config.validation.render);
  if (unconfigured.length > 0) {
    notes.push(
      `${renderChecksNeedCommand(unconfigured)}. Add it to .splitbrief/config.yaml, or request changes to drop ${pluralize(unconfigured.length, 'it', 'them')}; without it the run halts before its review.`,
    );
  }
  const reviewNote = reviewSeatRenderCheckNote(checks, config, modelCache);
  if (reviewNote !== undefined) {
    const count = renderCheckIds(checks).length;
    notes.push(
      `${reviewNote} Change the review seat to a tool that reads images, or request changes to drop ${pluralize(count, 'it', 'them')}.`,
    );
  }
  return notes;
}

/** The note that the review seat of `config` cannot see the renders of `checks`; none when it can. */
function reviewSeatRenderCheckNote(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind'>[],
  config: Config,
  modelCache: ModelCacheAccessor | undefined,
): string | undefined {
  const ids = renderCheckIds(checks);
  if (ids.length === 0) return undefined;
  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'none') return undefined;
  const { runner } = reviewer;
  const detected = resolveSeatImageFact({ runner, role: 'reviewer', cache: modelCache });
  return seatSupportsImages({ runner, detected })
    ? undefined
    : reviewSeatRenderNote({ runner, renderCheckIds: ids });
}

/** The run's note after a review seat change, with the control that changes the seat mid-run. */
export function reviewSeatRunNote(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind'>[],
  config: Config,
  modelCache: ModelCacheAccessor | undefined,
): string | undefined {
  const note = reviewSeatRenderCheckNote(checks, config, modelCache);
  return note === undefined ? undefined : `${note} ${REVIEW_SEAT_IMAGE_FIX}.`;
}

/**
 * The render checks of the tasks a review or a consult writes, refused while the run sets no
 * `validation.render`: no user is asked about them, so they go back to the seat that wrote them.
 */
export function unconfiguredRenderCheckErrors(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind'>[],
  renderCommand: string | undefined,
): string[] {
  const ids = unconfiguredRenderCheckIds(checks, renderCommand);
  return ids.length === 0 ? [] : [`${renderChecksNeedCommand(ids)}; use a check of another kind.`];
}

/** The shape of a render check's value: one gallery scenario id. */
export const RENDER_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * The checks refused before they run: a plan's checks, the checks of the fix tasks a review writes,
 * and the checks of a consult's rewrite or split. A refused command, an npm script that
 * package.json lacks while no task writes package.json, a `test` check that holds more than one
 * path, or a `render` check that names no scenario id never becomes a check of the run.
 */
export function refusedCheckErrors(
  checks: readonly Pick<TaskSpec['checks'][number], 'id' | 'kind' | 'value'>[],
  policy: { npmScriptsApproved: boolean; projectDir: string; writtenFiles: readonly string[] },
): PlanCheckError[] {
  const packageScripts = policy.writtenFiles.includes('package.json')
    ? null
    : readPackageScripts(policy.projectDir);
  return checks.flatMap((check): PlanCheckError[] => {
    if (check.kind === 'test') {
      return parseShellCommand(check.value).length === 1
        ? []
        : [
            {
              code: 'refused-check-command',
              message: `Check ${check.id} is refused: a \`test\` check names one test file, and \`${check.value}\` is not one file. Make it a \`cmd\` check that runs this command, or set its value to the test file.`,
            },
          ];
    }
    if (check.kind === 'render') {
      return RENDER_ID_PATTERN.test(check.value)
        ? []
        : [
            {
              code: 'refused-check-command',
              message: `Check ${check.id} is refused: a \`render\` check names one scenario id of lowercase letters, digits and hyphens, and \`${check.value}\` is not one.`,
            },
          ];
    }
    const refusal = commandTextRefusal(check.value, policy.npmScriptsApproved);
    if (refusal !== null) {
      return [
        {
          code: 'refused-check-command',
          message: `Check ${check.id} is refused: \`${check.value}\` ${refusal}. Change it to a command that plan checks allow, or to a check of kind \`test\` that names a test file.`,
        },
      ];
    }
    const missing =
      packageScripts === null
        ? null
        : missingNpmScript(check.value, policy.npmScriptsApproved, packageScripts);
    return missing === null
      ? []
      : [
          {
            code: 'refused-check-command',
            message: `Check ${check.id} is refused: \`${check.value}\` ${missing}. Name a script that package.json defines, or list package.json in the task's files and add the script there.`,
          },
        ];
  });
}
