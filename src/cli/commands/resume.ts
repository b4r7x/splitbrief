import type { Command } from 'commander';
import { loadOwnerWorkflowState } from '../../core/state/resume-hydration.js';
import { addWorkflowOptions } from '../options.js';
import { canonicalizeProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import { checkSessionLiveness } from '../../core/sessions/lockfile.js';
import { sessionDir } from '../../core/paths.js';
import { resumeSavedSession } from './continue/resume.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export interface ResumeDeps {
  checkSessionLiveness: typeof checkSessionLiveness;
  resumeSavedSession: typeof resumeSavedSession;
}

const defaultResumeDeps: ResumeDeps = {
  checkSessionLiveness,
  resumeSavedSession,
};

export async function resumeCommand(
  opts: { projectDir: string } & WorkflowOpts,
  deps: ResumeDeps = defaultResumeDeps,
): Promise<void> {
  const { projectDir } = opts;

  const sessionId = readActive(projectDir);
  if (!sessionId) {
    throw cliError('no active session to resume.');
  }

  const status = deps.checkSessionLiveness(sessionDir(projectDir, sessionId));
  if (status.alive) {
    throw cliError(
      `session '${sessionId}' is running — stop it before resuming, or use \`splitbrief continue\` once it has ended.`,
      1,
    );
  }

  if (status.processAlive) {
    throw cliError(
      `session process ${status.data?.pid} exists but is unresponsive — kill it first`,
      1,
    );
  }

  const hydrated = loadOwnerWorkflowState({ projectDir, sessionId });

  if (hydrated.kind === 'invalid') {
    throw cliError(`session '${sessionId}' has invalid saved state: ${hydrated.message}`, 1);
  }

  if (hydrated.kind === 'missing') {
    throw cliError(
      `session '${sessionId}' has no usable state.json — cannot resume. Start a new workflow with \`splitbrief start\`.`,
    );
  }

  await deps.resumeSavedSession({ projectDir, sessionId, state: hydrated.state, opts });
}

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program.command('resume').description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    const projectDir = await canonicalizeProjectDir(opts);
    await resumeCommand({ ...opts, projectDir });
  });
}
