import type { Command } from 'commander';
import { addWorkflowOptions } from '../options/workflow.js';
import { canonicalizeProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { checkSessionLiveness } from '../../core/sessions/lock/file.js';
import { resolveTargetRun } from '../sessions/resolve.js';
import { resolveRunConfig } from '../build-overrides.js';
import { emitRecoveryAndFailIfPending, recordWriterFor } from '../headless/outcome.js';
import { resolveReviewCadence } from '../../core/config/runtime/resolve.js';
import { openOwnedRun, resumeSavedSession } from './continue/resume.js';
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
  sessionInput?: string,
): Promise<void> {
  const { projectDir } = opts;

  const record = await resolveTargetRun({
    projectDir,
    sessionInput,
    checkLiveness: deps.checkSessionLiveness,
  });
  if (record === null) {
    throw cliError('no active session to resume.');
  }

  if (await openOwnedRun(record, opts)) return;
  const { sessionId } = record.ref;
  const hydrated = record.hydration;

  if (hydrated.kind === 'invalid') {
    throw cliError(`session '${sessionId}' has invalid saved state: ${hydrated.message}`, 1);
  }

  if (hydrated.kind === 'missing') {
    throw cliError(
      `session '${sessionId}' has no usable state.json — cannot resume. Start a new workflow with \`splitbrief start\`.`,
    );
  }

  // A halted session has nothing to resume until its recovery is answered. Headless
  // says so — with the `continue --action …` line — instead of walking into preparation.
  if (opts.json === true || opts.plain === true) {
    emitRecoveryAndFailIfPending({
      state: hydrated.state,
      sessionId,
      reviewNone: resolveReviewCadence(resolveRunConfig({ projectDir, opts }).config) === 'none',
      writeRecord: recordWriterFor(opts.plain === true),
    });
  }

  await deps.resumeSavedSession({ projectDir, sessionId, state: hydrated.state, opts });
}

export function registerResumeCommand(
  program: Command,
  deps: ResumeDeps = defaultResumeDeps,
): void {
  addWorkflowOptions(
    program
      .command('resume [session-id]')
      .description('Resume the most recent run or select one by id or alias'),
  ).action(async (sessionInput: string | undefined, opts: WorkflowOpts) => {
    const projectDir = await canonicalizeProjectDir(opts);
    await resumeCommand({ ...opts, projectDir }, deps, sessionInput);
  });
}
