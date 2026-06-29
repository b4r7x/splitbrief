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
import { printCrashDiagnostic } from '../crash-diagnostic.js';
import { sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { readActive, writeActive } from '../../core/sessions/lifecycle.js';
import { loadState, consoleWorkflowFeature } from '../../core/state/persistence.js';
import { loadConfig } from '../../core/config/load/io.js';
import { routerStore } from '../../stores/navigation/router.js';
import { skillsStore } from '../../stores/project/skills.js';
import {
  addWorkflowOptions,
  assertModeFlagsExclusive,
  assertWorktreeStartOnly,
} from '../options.js';
import { maybeMigrateAndReport } from './migrate.js';
import { renderAttachClient } from './attach.js';
import { runHeadless } from '../headless.js';
import { runRpc } from '../rpc/run.js';
import { resolveSessionAlias } from '../sessions/aliases.js';
import { findSingleRunningSession } from '../sessions/single-running.js';
import { assertResumableState, assertSessionExists } from '../sessions/resolve.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

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

function reconcileResumeMode(
  state: WorkflowState,
  cliMode: WorkflowMode | undefined,
): WorkflowState {
  if (cliMode === undefined || state.mode === undefined || cliMode === state.mode) return state;
  console.warn(
    `Overriding saved workflow mode '${state.mode}' with --mode ${cliMode} for this resume.`,
  );
  return { ...state, mode: cliMode };
}

export async function resumeSavedSession(args: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  opts: WorkflowOpts;
  deps?: ResumeTailDeps | undefined;
}): Promise<void> {
  const { projectDir, sessionId, opts } = args;
  const deps = args.deps ?? defaultResumeTailDeps;
  const state = reconcileResumeMode(args.state, opts.mode);

  assertResumableState(state, sessionId);

  writeActive({ projectDir, sessionId });

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
    `Resuming: ${consoleWorkflowFeature(state.feature, loadConfig(projectDir).config.workflow.persistTranscript)} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`,
  );

  const { useFullscreen, useMouse, useHover } = await deps.setupWorkflow(opts);

  await deps.initStores(projectDir, opts);
  if (state.selectedSkills && state.selectedSkills.length > 0) {
    skillsStore.setSelected(new Set(state.selectedSkills));
  }
  routerStore.init({ screen: 'workflow', feature: state.feature, resumeState: state, sessionId });

  await deps.renderApp(createElement(App), {
    fullscreen: useFullscreen,
    mouse: useMouse,
    hover: useHover,
    projectDir,
  });
}

export interface ContinueDeps {
  checkServerStatus: typeof checkServerStatus;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  runHeadless: typeof runHeadless;
  runRpc: typeof runRpc;
  setupWorkflow: typeof setupWorkflow;
  printCrashDiagnostic: typeof printCrashDiagnostic;
}

const defaultContinueDeps: ContinueDeps = {
  checkServerStatus,
  initStores,
  renderApp,
  runHeadless,
  runRpc,
  setupWorkflow,
  printCrashDiagnostic,
};

async function resolveTargetSession(
  sessionInput: string | undefined,
  projectDir: string,
  deps: ContinueDeps,
): Promise<string> {
  const resolved = await resolveSessionAlias(sessionInput, projectDir);
  if (resolved !== undefined) {
    assertSessionExists(projectDir, resolved);
    return resolved;
  }

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
  assertModeFlagsExclusive(opts);
  assertWorktreeStartOnly(opts);

  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir, deps);
  const sessDir = sessionDir(opts.projectDir, sessionId);

  const status = await deps.checkServerStatus(sessDir);

  if (status.alive) {
    // Live attach speaks the IPC/attach lifecycle that only the non-Windows path supports;
    // interrupted sessions below take the platform-neutral resume path instead.
    assertNotWindows();
    if (opts.rpc) throw cliError('--rpc cannot attach to a running detached session yet.');
    if (status.data.authToken === undefined) {
      throw cliError(`session ${sessionId} does not support authenticated attach`, 1);
    }
    // renderAttachClient takes explicit fullscreen/mouse/hover from setupWorkflow.
    const { useFullscreen, useMouse, useHover } = await deps.setupWorkflow(opts);
    await renderAttachClient(
      {
        projectDir: opts.projectDir,
        sessionId,
        feature: status.data.feature,
        sockPath: join(sessDir, IPC_SOCK_FILE),
        authToken: status.data.authToken,
      },
      deps,
      { fullscreen: useFullscreen, mouse: useMouse, hover: useHover },
    );
    return;
  }

  if (status.processAlive) {
    throw cliError(
      `server process ${status.data?.pid} exists but is unresponsive — kill it first`,
      1,
    );
  }

  if (status.crashed) {
    await deps.printCrashDiagnostic(sessDir, status);
  }

  await maybeMigrateAndReport(opts.projectDir, opts);

  const state = loadState({ projectDir: opts.projectDir, sessionId });

  if (!state) {
    throw cliError(
      `session '${sessionId}' has no usable saved state and is not running — cannot continue. Start a new workflow with \`diptych start\`.`,
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
