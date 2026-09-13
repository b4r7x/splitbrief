import { setupWorkflow } from '../../setup.js';
import { initStores } from '../../init-stores.js';
import { renderApp } from '../../render/app.js';
import { cliError } from '../../errors.js';
import { loadOwnerWorkflowState } from '../../../core/state/resume-hydration.js';
import { runHeadless } from '../../headless.js';
import { resolveSessionAlias } from '../../sessions/aliases.js';
import { assertSessionExists } from '../../sessions/resolve.js';
import { readActive } from '../../../core/sessions/active-pointer.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { RecoveryActionOption } from '../../options.js';
import { resolveRunConfig } from '../../build-overrides.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { applyRecoveryAction } from '../../../engine/orchestrator/recovery/actions.js';
import { resumeSavedSession } from './resume.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';

export interface ContinueDeps {
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  runHeadless: typeof runHeadless;
  setupWorkflow: typeof setupWorkflow;
  prepareExecution: typeof prepareExecution;
}

export const defaultContinueDeps: ContinueDeps = {
  initStores,
  renderApp,
  runHeadless,
  setupWorkflow,
  prepareExecution,
};

async function resolveTargetSession(
  sessionInput: string | undefined,
  projectDir: string,
): Promise<string> {
  const resolved = await resolveSessionAlias(sessionInput, projectDir);
  if (resolved !== undefined) {
    assertSessionExists(projectDir, resolved);
    return resolved;
  }

  const active = readActive(projectDir);
  if (active) return active;

  throw cliError('no session to continue; start one with `splitbrief start`.', 1);
}

type ContinueOpts = { projectDir: string } & WorkflowOpts & {
    action?: RecoveryActionOption | undefined;
  };

/**
 * `--action` answers the pending recovery before the run re-enters: the same
 * transition the TUI panel applies, taken from the resume line an earlier halt
 * printed. A blocked action is the operator's error, not the run's.
 */
function applyPendingRecoveryAction(args: {
  sessionId: string;
  state: WorkflowState;
  action: RecoveryActionOption;
  opts: ContinueOpts;
}): { state: WorkflowState; config?: Config } {
  const projectDir = args.opts.projectDir;
  const result = applyRecoveryAction({
    projectDir,
    sessionId: args.sessionId,
    state: args.state,
    action: args.action.action,
    bus: createEventBus(),
    config: resolveRunConfig({ projectDir, opts: args.opts }),
    ...(args.action.candidate !== undefined && { candidate: args.action.candidate }),
  });
  if (!result.ok) throw cliError(result.message, 1);
  return {
    state: result.state,
    ...(result.switchedConfig !== undefined && { config: result.switchedConfig }),
  };
}

export async function continueCommand(
  sessionInput: string | undefined,
  opts: ContinueOpts,
  deps: ContinueDeps = defaultContinueDeps,
): Promise<void> {
  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir);

  const hydrated = loadOwnerWorkflowState({ projectDir: opts.projectDir, sessionId });

  if (hydrated.kind === 'invalid') {
    throw cliError(
      `session '${sessionId}' has no usable saved state and is not running — invalid saved state: ${hydrated.message}`,
      1,
    );
  }

  if (hydrated.kind === 'missing') {
    throw cliError(
      `session '${sessionId}' has no usable saved state and is not running — cannot continue. Start a new workflow with \`splitbrief start\`.`,
      1,
    );
  }

  const resumed =
    opts.action === undefined
      ? { state: hydrated.state }
      : applyPendingRecoveryAction({
          sessionId,
          state: hydrated.state,
          action: opts.action,
          opts,
        });

  await resumeSavedSession({
    projectDir: opts.projectDir,
    sessionId,
    state: resumed.state,
    opts,
    ...(resumed.config !== undefined && { config: resumed.config }),
    deps,
  });
}
