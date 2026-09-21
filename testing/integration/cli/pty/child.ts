import { mkdirSync, writeFileSync } from 'node:fs';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { App, type AppProps } from '../../../../src/app/root.js';
import { createDefaultConfig } from '../../../../src/core/config/load/defaults.js';
import { createInitialState, transition } from '../../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../../src/core/paths-io.js';
import { artifactPresence } from '../../../../src/core/sessions/run-record-io.js';
import { resumeStep } from '../../../../src/core/sessions/run-status.js';
import { saveState } from '../../../../src/core/state/persistence.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import type { RunWorkflowOptions } from '../../../../src/engine/orchestrator/run/init.js';
import {
  rebaseOnPersistedWorkflowState,
  transitionAndSave,
} from '../../../../src/engine/orchestrator/state-ops.js';
import { throwIfAborted } from '../../../../src/utils/abort.js';
import { prepareExecution } from '../../../../src/engine/runners/prepare-execution/prepare-execution.js';
import type { PreparationPolicy } from '../../../../src/engine/runners/prepare-execution/types.js';
import type { PreparedExecution } from '../../../../src/engine/runners/prepared-execution.js';
import { renderApp as productionRenderApp } from '../../../../src/cli/render/app.js';
import { configStore } from '../../../../src/stores/project/config.js';
import { routerStore } from '../../../../src/stores/navigation/router.js';
import { terminalSizeStore } from '../../../../src/stores/ui/terminal-size.js';
import { resetAllStores } from '../../../helpers/stores.js';
import { trustDeclaredRunners } from '../../../helpers/runner-trust.js';
import {
  isDirectExecution,
  PTY_ACTIVE_REVIEW_MARKER,
  PTY_APPROVED_MARKER,
  PTY_CHILD_PROJECT_ENV,
  PTY_VIEWPORT,
} from './contract.js';

export interface PtyChildResult {
  readonly approved: true;
}

// This child only ever renders <App>, so the injected renderer takes the
// element the child builds and tests can read AppProps off it.
interface PtyChildDependencies {
  renderApp: (
    appElement: ReactElement<AppProps>,
    options: Parameters<typeof productionRenderApp>[1],
  ) => ReturnType<typeof productionRenderApp>;
}

const DEFAULT_DEPENDENCIES: PtyChildDependencies = {
  renderApp: productionRenderApp,
};
const PTY_FEATURE = 'PTY behavior contract';
export const PTY_REVIEW_SESSION_ID = 'pty-review-session';

const APP_ABORTED = Symbol('PTY child app aborted');

/**
 * Bounds every fixture wait by the app's lifetime: an abort resolves the race
 * instead of leaving the wait pending, and the abort listener is always
 * removed. The sentinel resolves rather than rejects so a lost race can never
 * become an unhandled rejection.
 */
function whileAppLives<T>(
  options: Pick<RunWorkflowOptions, 'signal'>,
  wait: Promise<T>,
): Promise<T | typeof APP_ABORTED> {
  const { signal } = options;
  if (signal === undefined) return wait;
  if (signal.aborted) return Promise.resolve(APP_ABORTED);
  const aborted = Promise.withResolvers<typeof APP_ABORTED>();
  const onAbort = (): void => {
    aborted.resolve(APP_ABORTED);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([wait, aborted.promise]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

export function parsePtyChildArgs(argv: readonly string[]): void {
  if (argv.length !== 0) throw new Error('PTY child does not accept arguments');
}

export async function runPtyChild(
  argv: readonly string[],
  dependencies: PtyChildDependencies = DEFAULT_DEPENDENCIES,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PtyChildResult> {
  parsePtyChildArgs(argv);
  const configuredProjectDir = env[PTY_CHILD_PROJECT_ENV];
  if (
    !configuredProjectDir ||
    !isAbsolute(configuredProjectDir) ||
    resolve(configuredProjectDir) !== configuredProjectDir ||
    dirname(configuredProjectDir) === configuredProjectDir
  ) {
    throw new Error('PTY child project path is unavailable or unsafe');
  }
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    resetAllStores();
  };
  process.once('exit', cleanup);
  try {
    mkdirSync(configuredProjectDir);
    const projectDir = configuredProjectDir;
    const reviewPath = join(projectDir, 'supporting-spec.md');
    writeFileSync(
      reviewPath,
      `# ${PTY_ACTIVE_REVIEW_MARKER}\n\nApprove this deterministic contract.\n`,
      'utf8',
    );

    resetAllStores();
    const defaults = createDefaultConfig();
    const config: ReturnType<typeof createDefaultConfig> = {
      ...defaults,
      planner: {
        kind: 'shell',
        command: process.execPath,
        model: 'pty-planner',
        outputFormat: 'text',
      },
      workflow: {
        ...defaults.workflow,
      },
    };
    configStore.__testReset({
      config,
      projectDir,
    });
    terminalSizeStore.__testReset({
      cols: PTY_VIEWPORT.cols,
      rows: PTY_VIEWPORT.rows,
      isSmall: false,
    });
    const prepared = await preparePtyExecution(projectDir, config);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord(),
      execution: { kind: 'local', prepared },
    });

    let result: { approved: boolean } | undefined;
    const runWorkflow = async (options: RunWorkflowOptions): Promise<never> => {
      publishEvent(options, {
        type: 'workflow_started',
        ts: Date.now(),
        phase: 'reviewing-spec',
        feature: PTY_FEATURE,
      });
      const approval = await whileAppLives(
        options,
        options.callbacks.onApprovalNeeded('spec', reviewPath),
      );
      if (approval === APP_ABORTED) {
        throwIfAborted(options.signal);
        throw new Error('PTY review exited before approval');
      }
      result = approval;
      if (approval.approved !== true || Object.keys(approval).length !== 1) {
        throw new Error('PTY review did not return exactly approved true');
      }
      const interrupted = Promise.withResolvers<void>();
      // The stop's local interrupt is live before the marker: the quit that
      // follows must land on an abortable wait, never on a fixture that can
      // only pend forever.
      options.sinks.setAbortHandler(() => interrupted.resolve());
      try {
        process.stdout.write(`${PTY_APPROVED_MARKER}\n`);
        await whileAppLives(options, interrupted.promise);
        throwIfAborted(options.signal);
        const cut = options.sinks.consumeBoundaryInterrupt?.() === true ? 'boundary' : 'mid-step';
        const ref = { projectDir, sessionId: PTY_REVIEW_SESSION_ID };
        const current = rebaseOnPersistedWorkflowState(ref, reviewingSpecState());
        const parked = transitionAndSave(ref, current, {
          type: 'INTERRUPT_STEP',
          step: resumeStep(current, artifactPresence(ref)),
          source: 'user',
          cut,
        });
        publishEvent(options, {
          type: 'turn_interrupted',
          ts: Date.now(),
          phase: parked.phase,
          source: 'user',
          at: cut,
        });
        await whileAppLives(
          options,
          Promise.resolve(options.callbacks.onContinuationNeeded?.('', cut) ?? ''),
        );
        throwIfAborted(options.signal);
        throw new Error('PTY fixture run ended at the continuation park');
      } finally {
        options.sinks.setAbortHandler(null);
      }
    };

    await dependencies.renderApp(createElement<AppProps>(App, { workflowDeps: { runWorkflow } }), {
      fullscreen: true,
      projectDir,
    });
    if (result?.approved !== true) throw new Error('PTY review exited before approval');
    return { approved: true };
  } finally {
    process.off('exit', cleanup);
    cleanup();
  }
}

function reviewingSpecState() {
  const initial = createInitialState(PTY_FEATURE, new Date(0));
  const researching = transition(initial, { type: 'START' });
  const specifying = transition(researching, { type: 'RESEARCH_DONE' });
  return transition(specifying, { type: 'SPEC_DONE' });
}

async function preparePtyExecution(
  projectDir: string,
  config: ReturnType<typeof createDefaultConfig>,
): Promise<PreparedExecution> {
  const resumeState = reviewingSpecState();
  const ref = { projectDir, sessionId: PTY_REVIEW_SESSION_ID };
  ensureSessionDir(ref.projectDir, ref.sessionId);
  // A gate is a durable wait: the phase it parks at is on disk before the run
  // mounts, so the app hydrates it and the resume is real.
  saveState(ref, resumeState);
  // The fixture planner is a declared shell command, so this child models an
  // owner who already granted it, into a throwaway trust directory.
  const stateDir = join(projectDir, 'pty-runner-trust');
  mkdirSync(stateDir, { recursive: true });
  await trustDeclaredRunners({ projectDir, config, stateDir });
  const policy: Extract<PreparationPolicy, { purpose: 'resume' }> = {
    purpose: 'resume',
    interaction: 'interactive',
    unverifiedAuth: 'disclosed',
    allowRepoRunners: false,
    allowHooks: false,
    stateDir,
  };
  const outcome = await prepareExecution({
    existingSession: ref,
    feature: PTY_FEATURE,
    effectiveConfig: config,
    resumeState,
    policy,
    signal: new AbortController().signal,
    deps: {
      collectReadiness: async () => ({ report: readyReadiness(projectDir), config }),
      newPreparationId: () => 'pty-review-preparation',
    },
  });
  if (outcome.kind !== 'prepared') {
    throw new Error(`PTY workflow preparation failed: ${outcome.kind}`);
  }
  return outcome.execution;
}

function readyReadiness(projectDir: string) {
  return {
    generatedAt: new Date(0).toISOString(),
    projectDir,
    status: 'ready' as const,
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue' as const, label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

function publishEvent(options: RunWorkflowOptions, event: EngineEvent): void {
  if (!options.tuiSink) throw new Error('PTY child has no production TUI event sink');
  options.tuiSink(event);
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown PTY child failure';
  process.stderr.write(`PTY child failed: ${message}\n`);
  process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  void runPtyChild(process.argv.slice(2)).catch(reportFailure);
}
