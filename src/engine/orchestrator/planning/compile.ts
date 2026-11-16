import { resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import { PLAN_JSON_FILE } from '../../../core/paths.js';
import { PlanSchema, type PlanProposal } from '../../../core/schemas/plan.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow/discovered-validation.js';
import { writePlanJson, parsePlanJson } from '../../../core/sessions/plan-file.js';
import { readSpecFileOrEmpty, writeSpecFile } from '../../../core/sessions/spec-files.js';
import { readManifestCommands } from '../../../core/validation/manifest-commands.js';
import { detectStack } from '../../../core/validation/stacks/registry.js';
import { checkPlan, blocksPlan } from '../../spec/plan/checks.js';
import { renderCheckNotes } from '../../spec/plan/render-checks.js';
import type { PlanCheckError } from '../../spec/plan/types.js';
import { formatPlanMarkdown } from '../../spec/plan/markdown.js';
import { taskFromSpec } from '../../spec/plan/tasks.js';
import { writeAndPublishPlanArtifacts } from '../plan-files/write.js';
import { publishWarning } from '../publish/notice.js';
import { transitionAndSave } from '../state-ops/transition.js';
import type { PlannerCallbacksContext } from '../types.js';
import { estimatePlanContextFits } from './plan-context-fit.js';
import { sanitizeDiscoveredValidation } from '../validation/plan-policy/sanitize.js';
import type { PlanCheckContext } from './types.js';

function discoveredValidation(plan: PlanProposal): DiscoveredValidation | undefined {
  const { validation } = plan;
  if (validation === null) return undefined;
  return {
    ...(validation.language !== null && { language: validation.language }),
    ...(validation.test !== null && { testCommand: validation.test }),
    ...(validation.testPattern !== null && { testPattern: validation.testPattern }),
  };
}

/** A plan that passed its checks becomes the run's plan and its tasks. */
export function compilePlan(
  wctx: PlannerCallbacksContext,
  state: WorkflowState,
  plan: PlanProposal,
): { state: WorkflowState; tasks: WorkflowState['tasks'] } {
  const { projectDir, sessionId, bus, config } = wctx;
  const ref = { projectDir, sessionId };
  const tasks = plan.tasks.map((spec) => taskFromSpec(spec, projectDir));
  writePlanJson(ref, plan);
  writeAndPublishPlanArtifacts({
    projectDir,
    sessionId,
    bus,
    phase: state.phase,
    metadata: wctx.metadata,
    planMarkdown: formatPlanMarkdown(plan, renderCheckNotes(plan, config, wctx.modelCache)),
    tasks,
    replacedTasks: state.tasks,
  });
  const manifest = readManifestCommands(projectDir);
  const stack = detectStack(projectDir, config.validation.stack);
  const discovered = sanitizeDiscoveredValidation(
    discoveredValidation(plan),
    { bus, phase: state.phase },
    { projectDir, config, manifest, stack },
  );
  let next = discovered === undefined ? state : { ...state, discoveredValidation: discovered };
  if (next.pendingPlannerConversation !== undefined) {
    next = transitionAndSave(ref, next, { type: 'CLEAR_PLANNER_CONVERSATION' });
  }
  next = transitionAndSave(ref, next, {
    type: 'PLAN_COMPILED',
    plan: PlanSchema.parse(plan),
    tasks,
  });
  return { state: next, tasks };
}

/**
 * Every check a plan must pass before it becomes the run's plan, the context fit of each task
 * included. A plan the user edited at the card passes the same checks as one the planner returned.
 */
export async function checkFullPlan(
  wctx: PlanCheckContext,
  plan: PlanProposal,
): Promise<readonly PlanCheckError[]> {
  return checkPlan(
    plan,
    wctx.projectDir,
    await estimatePlanContextFits(plan, {
      config: wctx.config,
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
      detectedContextLength: wctx.detectedContextLength,
      skillsContext: wctx.skillsContext,
    }),
    wctx.config.validation.render,
    resolveApproveLevel(wctx.config) === 'plan',
  );
}

/**
 * The user's edit of plan.json at the card. A plan that passes every check is compiled again; any
 * other text is put back as it was, and one warning names what was wrong with it.
 */
export async function applyPlanEdit(
  wctx: PlannerCallbacksContext,
  state: WorkflowState,
  reviewed: string,
): Promise<WorkflowState> {
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const edited = readSpecFileOrEmpty(ref, PLAN_JSON_FILE);
  if (edited === reviewed) return state;
  const parsed = parsePlanJson(edited);
  const errors =
    'plan' in parsed
      ? (await checkFullPlan(wctx, parsed.plan)).filter(blocksPlan).map((error) => error.message)
      : parsed.errors;
  if ('plan' in parsed && errors.length === 0) {
    wctx.bus.publish({
      type: 'plan_regenerated',
      ts: Date.now(),
      phase: state.phase,
      comment: `(edited ${PLAN_JSON_FILE})`,
    });
    return compilePlan(wctx, state, parsed.plan).state;
  }
  writeSpecFile(ref, PLAN_JSON_FILE, reviewed, null);
  publishWarning({
    bus: wctx.bus,
    phase: state.phase,
    message: `The edited plan was not applied: ${errors.join(' ')}`,
  });
  return state;
}
