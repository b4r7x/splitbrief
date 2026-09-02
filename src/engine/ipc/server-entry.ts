import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../core/config/load/io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { markExited, markCrashed, markSignaled } from './lockfile.js';
import { startHeartbeat } from './heartbeat.js';
import { startIpcServer } from './server.js';
import type { IpcServer } from './server.js';
import { createEventBus } from '../events/bus.js';
import { createIpcWorkflowBridge } from './workflow-bridge.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../../core/config/runtime/effective-config.js';
import { writeDetachedPreparedResultFile, type IpcServerArgs } from './server-args.js';
import { createParentAcceptanceBarrier, detachedServerEntryError } from './server-acceptance.js';
import { getArgv, writeStartupLockfile } from './server-bootstrap.js';
import {
  cleanupBeforeParentAcceptance,
  cleanupBeforeServe,
  createServerCleanup,
  createServerExitHandlers,
  createServerProcessCleanup,
  type ServerTermination,
} from './server-cleanup.js';
import { clearActiveReceipt } from '../../core/sessions/active-pointer.js';
import {
  acceptDetachedSessionHandoff,
  rollbackDetachedSessionHandoff,
  settleDetachedSessionHandoff,
} from '../../core/sessions/detached-handoff.js';
import { rollbackPreparedSession } from '../../core/sessions/prepare.js';
import { loadState } from '../../core/state/persistence.js';
import { loadStateForResume } from '../../core/state/resume-authority.js';
import {
  acquireStateAuthority,
  assertStateAuthority,
  releaseStateAuthority,
} from '../../core/state/authority.js';
import type {
  StateAuthorityAcquisitionResult,
  StateAuthorityReceipt,
} from '../../core/state/types.js';
import { shouldPreserveActiveState } from '../orchestrator/session-lifecycle/finalize.js';
import { bootstrapOtel, flushOtel } from '../../lib/otel.js';
import { runWorkflowLoop } from './workflow-loop/run.js';
import { prepareExecution } from '../runners/prepare-execution/prepare-execution.js';
import { error } from '../../utils/error.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';

type ServerMainDependencies = Readonly<{
  prepare: typeof prepareExecution;
  startServer: typeof startIpcServer;
  runLoop: typeof runWorkflowLoop;
  writePreparedResult: typeof writeDetachedPreparedResultFile;
  rollback: typeof rollbackPreparedSession;
  rollbackHandoff: typeof rollbackDetachedSessionHandoff;
  acceptHandoff: typeof acceptDetachedSessionHandoff;
  settleHandoff: typeof settleDetachedSessionHandoff;
  acquireAuthority: typeof acquireStateAuthority;
  assertAuthority: typeof assertStateAuthority;
  hydrateState: typeof loadStateForResume;
  releaseAuthority: typeof releaseStateAuthority;
}>;

const DEFAULT_SERVER_MAIN_DEPENDENCIES: ServerMainDependencies = {
  prepare: prepareExecution,
  startServer: startIpcServer,
  runLoop: runWorkflowLoop,
  writePreparedResult: writeDetachedPreparedResultFile,
  rollback: rollbackPreparedSession,
  rollbackHandoff: rollbackDetachedSessionHandoff,
  acceptHandoff: acceptDetachedSessionHandoff,
  settleHandoff: settleDetachedSessionHandoff,
  acquireAuthority: acquireStateAuthority,
  assertAuthority: assertStateAuthority,
  hydrateState: loadStateForResume,
  releaseAuthority: releaseStateAuthority,
};

export async function main(
  input: Readonly<{
    argv: IpcServerArgs;
    bootstrapDir: string;
    cleanupProcesses?: (() => Promise<void>) | undefined;
    dependencies?: Partial<ServerMainDependencies> | undefined;
  }>,
) {
  const {
    argv,
    bootstrapDir,
    cleanupProcesses = createServerProcessCleanup(),
    dependencies: dependencyOverrides = {},
  } = input;
  const deps = { ...DEFAULT_SERVER_MAIN_DEPENDENCIES, ...dependencyOverrides };
  bootstrapOtel();
  const { config: rawConfig, loaderDiagnostics } = loadConfig(argv.projectDir);
  const { config, warnings } = resolveEffectiveConfig({
    base: rawConfig,
    overrides: argv.overrides,
    loaderDiagnostics,
  });
  emitEffectiveConfigWarnings(warnings);
  const preparation = await deps.prepare({
    projectDir: argv.projectDir,
    feature: argv.feature,
    effectiveConfig: config,
    policy: {
      purpose: 'new-workflow',
      interaction: 'headless',
      unverifiedAuth: argv.allowUnverifiedAuth === true ? 'allowed' : 'denied',
      allowHooks: argv.allowHooks ?? false,
      allowRepoRunners: argv.allowRepoRunners ?? false,
    },
    signal: new AbortController().signal,
    candidate: argv.candidate,
    ...(argv.plannerContext !== undefined && { plannerContext: argv.plannerContext }),
  });
  if (preparation.kind !== 'prepared') {
    throw error('detached-preparation-failed', `Detached startup preparation ${preparation.kind}.`);
  }
  const prepared = preparation.execution;
  const ownership = prepared.session.kind === 'new' ? prepared.session.ownership : undefined;
  const active = prepared.session.active;
  if (
    prepared.session.kind !== 'new' ||
    prepared.session.ref.sessionId !== argv.candidate.sessionId ||
    ownership?.version !== argv.candidate.version ||
    ownership?.sessionId !== argv.candidate.sessionId ||
    ownership?.generation !== argv.candidate.generation ||
    active.version !== argv.candidate.version ||
    active.sessionId !== argv.candidate.sessionId ||
    active.generation !== argv.candidate.generation
  ) {
    throw error('detached-preparation-mismatch', 'Detached preparation returned another session.');
  }
  const sessionRef = prepared.session.ref;
  const owned = {
    ref: sessionRef,
    ownership: prepared.session.ownership,
  };
  const dir = sessionDir(argv.projectDir, argv.candidate.sessionId);
  let authorityReceipt: StateAuthorityReceipt | undefined;
  let authorityResult: StateAuthorityAcquisitionResult | undefined;
  let stopHeartbeat: () => void = () => {};
  let closeBridge: (() => void) | undefined;
  let terminalize: ((termination: ServerTermination) => Promise<void>) | undefined;
  const abortStartup = (
    cause: unknown,
    receipt: StateAuthorityReceipt | undefined = authorityReceipt,
  ): Promise<void> =>
    cleanupBeforeServe({
      rollback: deps.rollback,
      rollbackHandoff: deps.rollbackHandoff,
      session: owned,
      ref: sessionRef,
      receipt,
      releaseAuthority: deps.releaseAuthority,
      stopHeartbeat,
      closeBridge,
      terminalize,
      bootstrapDir,
      cause,
    });
  try {
    authorityResult = deps.acquireAuthority({
      ref: sessionRef,
      purpose: prepared.session.kind === 'new' ? 'new-workflow' : 'resume',
    });
    if (authorityResult.kind === 'read-only') {
      throw detachedServerEntryError.authorityUnavailable(authorityResult.kind);
    }
    if (authorityResult.kind === 'fenced') {
      const hydrated = deps.hydrateState({ ref: sessionRef, authority: authorityResult });
      if (hydrated.kind === 'invalid') {
        throw detachedServerEntryError.authorityHydration(hydrated.code);
      }
      authorityReceipt = authorityResult.receipt;
      deps.assertAuthority({ ref: sessionRef, receipt: authorityReceipt });
    }
  } catch (cause) {
    await abortStartup(
      cause,
      authorityResult?.kind === 'fenced' ? authorityResult.receipt : undefined,
    );
    throw cause;
  }
  terminalize = async (termination) => {
    if (termination.kind === 'exit' && existsSync(dir)) await markExited(dir, termination.exitCode);
  };
  let authToken: string;
  let startedAt: number;
  try {
    ({ authToken, startedAt } = await writeStartupLockfile(dir, {
      argv,
      mode: prepared.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      persistTranscript: prepared.config.workflow.persistTranscript,
    }));
  } catch (cause) {
    await abortStartup(cause);
    throw cause;
  }

  try {
    stopHeartbeat = startHeartbeat(dir);
  } catch (cause) {
    await abortStartup(cause);
    throw cause;
  }
  const ipcBus = createEventBus();
  const ipcBridge = createIpcWorkflowBridge(ipcBus);
  closeBridge = ipcBridge.close;
  const acceptance = createParentAcceptanceBarrier({
    candidate: argv.candidate,
    ...(authorityReceipt === undefined
      ? {}
      : {
          authority: authorityReceipt,
          assertAuthority: () =>
            deps.assertAuthority({ ref: sessionRef, receipt: authorityReceipt }),
        }),
    parentPid: argv.parentPid,
    childPid: process.pid,
    timeoutMs: 10_000,
    acceptHandoff: () => deps.acceptHandoff(owned),
    settleHandoff: () => deps.settleHandoff(owned),
  });
  let ipcServer: IpcServer;
  try {
    ipcServer = await deps.startServer({
      // Attached TUI clients connect here; user_input and queue_clear are the runtime-command IPC
      // bridges documented in docs/SLASH-COMMANDS-REFERENCE.md § Attached clients.
      sessionId: argv.candidate.sessionId,
      sessionDir: dir,
      startedAt,
      mode: prepared.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      feature: argv.feature,
      authToken,
      bus: ipcBus,
      onUserInput: ipcBridge.onUserInput,
      onQueueClear: ipcBridge.onQueueClear,
      sessionJsonlPath: join(dir, SESSION_LOG_FILE),
      noClientPromptBehavior: prepared.config.approval?.headless === true ? 'fail-closed' : 'wait',
      persistTranscript: prepared.config.workflow.persistTranscript,
      onParentAccept: acceptance.accept,
    });
  } catch (cause) {
    await abortStartup(cause);
    throw cause;
  }
  const onCleanup = createServerCleanup({
    cleanupProcesses,
    stopHeartbeat,
    closeBridge: ipcBridge.close,
    closeServer: ipcServer.close,
    terminalize: async (termination) => {
      if (!existsSync(dir)) return;
      switch (termination.kind) {
        case 'exit':
          await markExited(dir, termination.exitCode);
          break;
        case 'signal':
          await markSignaled(dir, termination.signal);
          await markExited(dir, 0);
          break;
        case 'crash':
          await markCrashed(dir, 'uncaught', termination.cause);
          return;
      }
      const finalState = loadState(sessionRef);
      if (!shouldPreserveActiveState(finalState)) {
        clearActiveReceipt(sessionRef, prepared.session.active);
      }
    },
    flushTelemetry: flushOtel,
    ...(authorityReceipt === undefined
      ? {}
      : { releaseAuthority: () => deps.releaseAuthority(sessionRef, authorityReceipt) }),
  });

  try {
    deps.writePreparedResult({
      bootstrapDir,
      result: {
        version: 1,
        kind: 'prepared',
        sessionId: argv.candidate.sessionId,
        ownership: prepared.session.ownership,
        active: prepared.session.active,
        pid: process.pid,
      },
    });
  } catch (cause) {
    await cleanupBeforeParentAcceptance({
      cleanup: onCleanup,
      rollback: (session) => {
        try {
          deps.rollback(session);
        } catch {
          deps.rollbackHandoff(session);
        }
      },
      session: owned,
      active: prepared.session.active,
      bootstrapDir,
      cause,
    });
    throw cause;
  }

  try {
    await acceptance.wait();
  } catch (err) {
    await cleanupBeforeParentAcceptance({
      cleanup: onCleanup,
      rollback: (session) => {
        try {
          deps.rollback(session);
        } catch {
          deps.rollbackHandoff(session);
        }
      },
      session: owned,
      active: prepared.session.active,
      bootstrapDir,
      cause: err,
    });
    throw err;
  }

  const exitHandlers = createServerExitHandlers({ cleanup: onCleanup });

  const handleSignal = (signal: string) => {
    void exitHandlers.signal(signal);
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    void exitHandlers.crash(reason);
  });

  process.on('uncaughtException', (err) => {
    void exitHandlers.crash(err);
  });

  try {
    const loopContext = {
      prepared,
      attachments: argv.attachments,
      authority: authorityReceipt,
    };
    const summary = await deps.runLoop(loopContext, ipcServer, ipcBridge, ipcBus);

    const completedTasks = summary.completedByLocal + summary.escalatedToPlanner + summary.skipped;
    const isIncomplete = summary.totalTasks > 0 && completedTasks < summary.totalTasks;
    const exitCode = summary.failed > 0 || isIncomplete ? 1 : 0;
    await onCleanup({ kind: 'exit', exitCode });
  } catch (err) {
    await exitHandlers.crash(err);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { args: argv, bootstrapDir } = getArgv(process.argv);
  const dir = sessionDir(argv.projectDir, argv.candidate.sessionId);
  const cleanupProcesses = createServerProcessCleanup();
  const exitHandlers = createServerExitHandlers({
    cleanup: createServerCleanup({
      cleanupProcesses,
      stopHeartbeat: () => {},
      closeBridge: () => {},
      closeServer: () => Promise.resolve(),
      terminalize: (termination) =>
        termination.kind === 'crash' && existsSync(dir)
          ? markCrashed(dir, 'uncaught', termination.cause)
          : Promise.resolve(),
      flushTelemetry: flushOtel,
    }),
  });
  main({ argv, bootstrapDir, cleanupProcesses }).catch((err) => exitHandlers.crash(err));
}
