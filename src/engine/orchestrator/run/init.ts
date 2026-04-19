import type { Config } from '../../../core/schemas/config.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { ProjectContext } from '../../../core/types/state-actions.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { SkillMeta } from '../../skills/discovery.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { appendMessage } from '../../../core/state/persistence.js';
import { ensureSessionDir, ensureDiptychDir, type SpecMetadata } from '../../../core/paths-io.js';
import { readPackageJson } from '../../../core/project-meta.js';
import { createPlanner, createImplementer } from '../../runners/factory.js';

import type { WorkflowContext, WorkflowSinks, ResumeContextHolder } from '../types.js';
import { buildSummary, type SummaryBase } from '../summary.js';
import { emit, emitError, emitPlannerStatus, emitWorkflowConfig, emitUserMessage } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { applyRebuiltContext } from '../resume-context.js';
import { createValidator } from '../validation.js';

export type RunWorkflowOptions = {
  feature: string;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  savedState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  signal?: AbortSignal | undefined;
};

export type InitResult =
  | { ok: true; state: WorkflowState; wctx: WorkflowContext }
  | { ok: false; summary: Summary };

export async function initializeWorkflow(
  opts: RunWorkflowOptions,
  sessionId: string,
  summaryBase: SummaryBase,
  metadata: SpecMetadata,
  setTrackedState: (s: WorkflowState) => void,
  resumeHolder: ResumeContextHolder,
): Promise<InitResult> {
  const { feature, projectDir, config, callbacks, savedState, sinks } = opts;

  ensureDiptychDir(projectDir);
  ensureSessionDir(projectDir, sessionId);

  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const planner = createPlanner(config, initialSessionId);
  if (savedState && !planner.capabilities.supportsSessionResume) {
    await applyRebuiltContext({ projectDir, sessionId, callbacks, config, resumeHolder, requireNonEmpty: true });
  }
  const available = await planner.isAvailable();
  if (!available) {
    emitError(callbacks, `Planner '${getRunnerDisplayName(config.planner)}' is not available. Make sure it's installed.`);
    return { ok: false, summary: buildSummary({ ...summaryBase, state: createInitialState(feature) }) };
  }

  const implementer = createImplementer(config);

  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    emitPlannerStatus(callbacks, state, 'running');
    emit(projectDir, sessionId, state, 'workflow_resumed', undefined, {});
  } else {
    state = createInitialState(feature);
    state = {
      ...state,
      plannerTool: summaryBase.plannerTool,
      ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
      implementerTool: summaryBase.implementerTool,
      ...(summaryBase.implementerModel !== undefined && { implementerModel: summaryBase.implementerModel }),
    };
    state = transitionAndSave(projectDir, sessionId, state, { type: 'START', feature });
    setTrackedState(state);
    emitPlannerStatus(callbacks, state, 'running');
    emit(projectDir, sessionId, state, 'workflow_started', undefined, {});
    appendMessage(projectDir, sessionId, { role: 'user', text: feature }, config.workflow.persistTranscript);
    emitUserMessage(callbacks, feature);
  }

  emitWorkflowConfig(callbacks, {
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
  });

  const pkg = readPackageJson(projectDir);
  const context: ProjectContext = {
    name: typeof pkg?.['name'] === 'string' ? pkg['name'] : 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand: config.validation.testCommand,
  };

  const validator = createValidator();
  const wctx: WorkflowContext = { projectDir, sessionId, config, callbacks, planner, context, implementer, signal: opts.signal, metadata, resumeHolder, sinks, validator };

  return { ok: true, state, wctx };
}
