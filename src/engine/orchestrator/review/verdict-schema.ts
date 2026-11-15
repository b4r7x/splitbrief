import { type ReviewScope, verdictCoverageErrors } from '../../../core/review/scope.js';
import type { Config } from '../../../core/schemas/config.js';
import { ReviewAnswerSchema } from '../../../core/schemas/review/verdict.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import {
  refusedCheckErrors,
  unconfiguredRenderCheckErrors,
} from '../../spec/plan/render-checks.js';
import { enabledReviewChecks, planApprovesNpmScripts } from '../validation/checks/runner.js';
import { type StageContext, unresolvedTestCheckErrors } from '../validation/run.js';
import { triageContractErrors, fixTaskTargetErrors } from './contract-errors.js';

/**
 * The review answer contract. Coverage is a contract rule: an incomplete or invented answer fails
 * the schema, so the seat gets its one repair instead of a silent pass. The check reads the state
 * when it runs, because the call drains the queue and rebases the state before the answer comes.
 */
export function reviewVerdictSchema(input: {
  getState: () => WorkflowState;
  scope: ReviewScope;
  config: Config;
  workspaceDir: string;
  userFiles: ReadonlySet<string>;
  testChecks: StageContext;
}) {
  const { scope, config } = input;
  return ReviewAnswerSchema.superRefine((candidate, ctx) => {
    const state = input.getState();
    for (const message of [
      ...verdictCoverageErrors(candidate, scope),
      ...triageContractErrors(
        candidate,
        state.plan,
        candidate.findings,
        state.pendingTriage?.inputs ?? [],
        state.tasks,
        enabledReviewChecks(config, state.plan),
        scope,
      ),
      ...fixTaskTargetErrors(candidate.fixTasks, input.userFiles),
      ...refusedCheckErrors(
        candidate.fixTasks.flatMap((task) => task.checks),
        {
          npmScriptsApproved: planApprovesNpmScripts({ config, state }),
          projectDir: input.workspaceDir,
          writtenFiles: candidate.fixTasks.flatMap((task) => task.suggestedFiles),
        },
      ).map((error) => error.message),
      ...unconfiguredRenderCheckErrors(
        candidate.fixTasks.flatMap((task) => task.checks),
        config.validation.render,
      ),
      ...unresolvedTestCheckErrors(candidate.fixTasks, input.testChecks, []),
    ]) {
      ctx.addIssue({ code: 'custom', message });
    }
  });
}
