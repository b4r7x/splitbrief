import { join } from 'node:path';
import { createElement } from 'react';
import type { Command } from 'commander';
import { App } from '../../app.js';
import { setupWorkflow, resolveProjectDir } from '../setup.js';
import { initStores } from '../init-stores.js';
import { renderApp } from '../render.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../windows-guard.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { showCrashDiagnostic } from '../crash-diagnostic.js';
import { sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { loadState } from '../../core/state/persistence.js';
import { routerStore } from '../../stores/navigation/router.js';
import { addWorkflowOptions } from '../options.js';
import { maybeMigrateAndReport } from './migrate.js';
import { runHeadless } from '../headless.js';
import { runRpc } from '../rpc/run.js';
import { isNumericAlias, resolveNumericAlias } from '../session-aliases.js';
import { findSingleRunningSession } from '../sessions/single-running-session.js';
import { assertResumableState } from '../session-resolve.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';

type ResumeTailDeps = Pick<
  ContinueDeps,
  'initStores' | 'renderApp' | 'runHeadless' | 'runRpc' | 'setupWorkflow'
>;

const defaultResumeTailDeps: ResumeTailDeps = {
  initStores,
  renderApp,
  runHeadless,
  runRpc,
  setupWorkflow,
};

export async function resumeSavedSession(args: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  opts: WorkflowOpts;
  deps?: ResumeTailDeps | undefined;
}): Promise<void> {
  const { projectDir, sessionId, state, opts } = args;
  const deps = args.deps ?? defaultResumeTailDeps;

  assertResumableState(state, sessionId);

  if (opts.json) {
    await deps.runHeadless({
      feature: state.feature,
      projectDir,
      opts,
      savedState: state,
      sessionId,
    });
    return;
  }

  if (opts.rpc) {
    await deps.runRpc({ feature: state.feature, projectDir, opts, savedState: state, sessionId });
    return;
  }

  console.log(
    `Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`,
  );

  const { useFullscreen, useMouse } = await deps.setupWorkflow(opts);

  await deps.initStores(projectDir, opts);
  routerStore.init({ screen: 'workflow', feature: state.feature, resumeState: state, sessionId });

  await deps.renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
}

export interface ContinueDeps {
  checkServerStatus: typeof checkServerStatus;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  runHeadless: typeof runHeadless;
  runRpc: typeof runRpc;
  setupWorkflow: typeof setupWorkflow;
  showCrashDiagnostic: typeof showCrashDiagnostic;
}

const defaultContinueDeps: ContinueDeps = {
  checkServerStatus,
  initStores,
  renderApp,
  runHeadless,
  runRpc,
  setupWorkflow,
  showCrashDiagnostic,
};

export async function resolveSessionInput(
  input: string | undefined,
  projectDir: string,
): Promise<string | undefined> {
  if (input === undefined) return undefined;

  if (isNumericAlias(input)) {
    return resolveNumericAlias(input, projectDir);
  }

  return input;
}

async function resolveTargetSession(
  sessionInput: string | undefined,
  projectDir: string,
  deps: ContinueDeps,
): Promise<string> {
  const resolved = await resolveSessionInput(sessionInput, projectDir);
  if (resolved !== undefined) return resolved;

  // No explicit ID: use the active session pointer (same as resume).
  const active = readActive(projectDir);
  if (active) return active;

  const result = await findSingleRunningSession(projectDir, deps);
  if (result.kind === 'single') return result.id;
  if (result.kind === 'multiple') {
    throw cliError(
      `multiple sessions found (${result.ids.join(', ')}); pass a session ID or use \`diptych ps\` to list them.`,
      1,
    );
  }
  throw cliError('no session to continue; start one with `diptych start`.', 1);
}

export async function continueCommand(
  sessionInput: string | undefined,
  opts: { projectDir: string } & WorkflowOpts,
  deps: ContinueDeps = defaultContinueDeps,
): Promise<void> {
  assertNotWindows();
  if (opts.json && opts.rpc) throw cliError('--json and --rpc cannot be combined');

  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir, deps);
  const sessDir = sessionDir(opts.projectDir, sessionId);

  const status = await deps.checkServerStatus(sessDir);

  if (status.alive) {
    if (opts.rpc) throw cliError('--rpc cannot attach to a running detached session yet.');
    const sockPath = join(sessDir, IPC_SOCK_FILE);
    await deps.initStores(opts.projectDir);
    routerStore.init({
      screen: 'workflow',
      feature: status.data.feature,
      sessionId,
      attach: { sockPath },
    });

    const useFullscreen = Boolean(process.stdout.isTTY) && !process.env['CI'];
    await deps.renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useFullscreen });
    return;
  }

  if (status.crashed) {
    await deps.showCrashDiagnostic(sessDir, status);
  }

  await maybeMigrateAndReport(opts.projectDir, opts);

  const state = loadState(opts.projectDir, sessionId);

  if (!state) {
    throw cliError(
      `session '${sessionId}' has no saved state and is not running — cannot continue.`,
      1,
    );
  }

  await resumeSavedSession({ projectDir: opts.projectDir, sessionId, state, opts, deps });
}

export function registerContinueCommand(
  program: Command,
  deps: ContinueDeps = defaultContinueDeps,
): void {
  addWorkflowOptions(
    program
      .command('continue [session-id]')
      .description('Continue a session: attaches if running, resumes if interrupted'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await continueCommand(sessionId, { ...opts, projectDir }, deps);
  });
}
