import type { Command } from 'commander';
import { loadRunRecord } from '../../core/sessions/run-record.js';
import { defaultRunRecordDeps } from '../../core/sessions/run-record-io.js';
import { addWorkflowOptions } from '../options.js';
import { canonicalizeProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import { checkSessionLiveness } from '../../core/sessions/lockfile.js';
import { sessionDir } from '../../core/paths.js';
import { emitRecoveryAndFailIfPending, recordWriterFor } from '../headless.js';
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

  // The record reads the run once: its state and what it left on disk. Liveness is
  // already settled above, so the record is told rather than asked.
  const record = loadRunRecord(
    { projectDir, sessionId },
    { ...defaultRunRecordDeps(), liveness: () => 'not-alive' },
  );
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
      writeRecord: recordWriterFor(opts.plain === true),
    });
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
