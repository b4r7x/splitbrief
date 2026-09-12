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

export async function continueCommand(
  sessionInput: string | undefined,
  opts: { projectDir: string } & WorkflowOpts & { plain?: boolean | undefined },
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

  await resumeSavedSession({
    projectDir: opts.projectDir,
    sessionId,
    state: hydrated.state,
    opts,
    deps,
  });
}
