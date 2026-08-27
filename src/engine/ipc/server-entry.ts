import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../core/config/load/io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { writeLockfile, markExited, markCrashed, markSignaled } from './lockfile.js';
import { startHeartbeat } from './heartbeat.js';
import { startIpcServer } from './server.js';
import type { IpcServer } from './server.js';
import { createEventBus } from '../events/bus.js';
import { createIpcWorkflowBridge } from './workflow-bridge.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../../core/config/runtime/effective-config.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import {
  readIpcServerArgsFileConfined,
  writeDetachedPreparedResultFile,
  type IpcServerArgs,
} from './server-args.js';
import {
  clearActiveReceipt,
  type SessionOwnershipReceipt,
} from '../../core/sessions/active-pointer.js';
import { featureForTranscriptPolicy } from '../../core/sessions/session-id.js';
import {
  acceptDetachedSessionHandoff,
  rollbackDetachedSessionHandoff,
  settleDetachedSessionHandoff,
} from '../../core/sessions/detached-handoff.js';
import { rollbackPreparedSession } from '../../core/sessions/prepare.js';
import { loadState, loadStateForResume } from '../../core/state/persistence.js';
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
import { canSignalProcess } from '../../lib/process/liveness.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { bootstrapOtel, flushOtel } from '../../lib/otel.js';
import { runWorkflowLoop } from './workflow-loop/run.js';
import { prepareExecution } from '../runners/prepare-execution.js';
import { error } from '../../utils/error.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';

type ServerTermination =
  | { kind: 'exit'; exitCode: number }
  | { kind: 'signal'; signal: string }
  | { kind: 'crash'; cause: string };

type ServerCleanupOptions = {
  cleanupProcesses: () => Promise<void>;
  stopHeartbeat: () => void;
  closeBridge: () => void;
  closeServer: () => Promise<void>;
  terminalize: (termination: ServerTermination) => Promise<void>;
  flushTelemetry: () => Promise<void>;
  releaseAuthority?: (() => boolean | undefined | Promise<boolean | undefined>) | undefined;
};

type ExitProcess = (code: number) => void;

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

type ParentAcceptance = Readonly<{
  version: 1;
  sessionId: string;
  generation: string;
  childPid: number;
}>;

export const detachedServerEntryError = {
  parentExited: (parentPid: number) =>
    error('detached-parent-exited', 'Detached parent exited before accepting startup.', {
      parentPid,
    }),
  parentAcceptanceTimeout: (timeoutMs: number) =>
    error(
      'detached-parent-acceptance-timeout',
      'Timed out waiting for detached parent acceptance.',
      { timeoutMs },
    ),
  authorityUnavailable: (kind: StateAuthorityAcquisitionResult['kind']) =>
    error(
      'detached-state-authority-unavailable',
      `Detached startup requires a usable state authority; acquisition returned ${kind}.`,
      { kind },
    ),
  authorityHydration: (kind: string) =>
    error(
      'detached-state-authority-hydration-failed',
      `Detached startup could not hydrate the owner state (${kind}).`,
      { kind },
    ),
  startupCleanup: (failureCount: number, cause: unknown) =>
    error(
      'detached-startup-cleanup-failed',
      `Detached startup cleanup failed in ${failureCount} step${failureCount === 1 ? '' : 's'}.`,
      { failureCount },
      cause,
    ),
} as const;

export function createParentAcceptanceBarrier(
  input: Readonly<{
    candidate: SessionOwnershipReceipt;
    authority?: StateAuthorityReceipt | undefined;
    assertAuthority?: (() => void) | undefined;
    parentPid: number;
    childPid: number;
    timeoutMs: number;
    acceptHandoff: () => boolean;
    settleHandoff: () => 'accepted' | 'rolled-back';
  }>,
): Readonly<{
  accept: (acceptance: ParentAcceptance) => boolean;
  wait: () => Promise<void>;
}> {
  let accepted = false;
  let closed = false;
  const acceptanceDeadline = Date.now() + input.timeoutMs;
  let handoffDeadline = acceptanceDeadline;
  let waitPromise: Promise<void> | undefined;

  return {
    accept: (acceptance) => {
      if (
        closed ||
        accepted ||
        Date.now() >= acceptanceDeadline ||
        acceptance.version !== input.candidate.version ||
        acceptance.sessionId !== input.candidate.sessionId ||
        acceptance.generation !== input.candidate.generation ||
        acceptance.childPid !== input.childPid
      ) {
        return false;
      }
      if (input.assertAuthority !== undefined) {
        try {
          input.assertAuthority();
        } catch {
          return false;
        }
      }
      accepted = true;
      handoffDeadline = Date.now() + input.timeoutMs;
      return true;
    },
    wait: () => {
      waitPromise ??= new Promise<void>((resolve, reject) => {
        const succeed = () => {
          closed = true;
          resolve();
        };
        const fail = (cause: unknown) => {
          closed = true;
          reject(cause);
        };
        const poll = () => {
          const parentAlive = canSignalProcess(input.parentPid);
          const now = Date.now();
          if (accepted) {
            try {
              input.assertAuthority?.();
              if (input.acceptHandoff()) {
                succeed();
                return;
              }
              if (!parentAlive || now >= handoffDeadline) {
                if (input.settleHandoff() === 'accepted') {
                  succeed();
                  return;
                }
                fail(
                  parentAlive
                    ? detachedServerEntryError.parentAcceptanceTimeout(input.timeoutMs)
                    : detachedServerEntryError.parentExited(input.parentPid),
                );
                return;
              }
            } catch (cause) {
              fail(cause);
              return;
            }
          } else {
            if (!parentAlive) {
              fail(detachedServerEntryError.parentExited(input.parentPid));
              return;
            }
            if (now >= acceptanceDeadline) {
              fail(detachedServerEntryError.parentAcceptanceTimeout(input.timeoutMs));
              return;
            }
          }
          setTimeout(poll, 100);
        };
        poll();
      });
      return waitPromise;
    },
  };
}

export function createServerProcessCleanup(): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= (async () => {
      await killAllProcesses();
    })();
    return cleanupPromise;
  };
}

// A runner group that survives reaping is reported to the caller, but it must not cost the session
// its terminal state or leave the IPC socket bound: the remaining owners run first, then the
// failure is surfaced.
export function createServerCleanup(
  options: ServerCleanupOptions,
): (termination: ServerTermination) => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return (termination) => {
    if (cleanupPromise !== null) return cleanupPromise;
    options.stopHeartbeat();
    cleanupPromise = (async () => {
      let reaping: { error: unknown } | undefined;
      try {
        await options.cleanupProcesses();
      } catch (cause) {
        reaping = { error: cause };
      }
      options.closeBridge();
      await options.closeServer();
      await options.terminalize(termination);
      if (termination.kind !== 'crash' && options.releaseAuthority !== undefined) {
        await options.releaseAuthority();
      }
      await options.flushTelemetry();
      if (reaping !== undefined) throw reaping.error;
    })();
    return cleanupPromise;
  };
}

export function createServerExitHandlers(options: {
  cleanup: (termination: ServerTermination) => Promise<void>;
  exitProcess?: ExitProcess;
}): {
  signal: (signal: string) => Promise<void>;
  crash: (reason: unknown) => Promise<void>;
} {
  const exitProcess = options.exitProcess ?? process.exit;
  // The process must reach an exit on every termination path: a failed cleanup is reported and
  // exits non-zero. A rejection here would instead be re-entered by the next signal or by the
  // `unhandledRejection` handler — which receives the same memoized rejection — and leave an
  // orphaned server bound to its socket, so even the report cannot throw.
  const exitAfterCleanup = async (termination: ServerTermination, successCode: number) => {
    try {
      await options.cleanup(termination);
    } catch (err) {
      try {
        process.stderr.write(`server-entry: cleanup failed: ${toErrorMessage(err)}\n`);
      } catch {
        // An unwritable stderr must not keep a terminating server alive.
      }
      exitProcess(1);
      return;
    }
    exitProcess(successCode);
  };
  return {
    signal: (signal) => exitAfterCleanup({ kind: 'signal', signal }, 0),
    crash: (reason) => exitAfterCleanup({ kind: 'crash', cause: toErrorMessage(reason) }, 1),
  };
}

function exitInvalidArgs(message: string): never {
  process.stderr.write(`server-entry: ${message}\n`);
  process.exit(1);
}

function readConfinedArgsFileOrExit(argsFile: string): IpcServerArgs {
  try {
    return readIpcServerArgsFileConfined({ argsFile });
  } catch (err) {
    exitInvalidArgs(toErrorMessage(err));
  }
}

export function getArgv(processArgv: string[]): { args: IpcServerArgs; bootstrapDir: string } {
  const argsFile = processArgv[2];
  if (!argsFile) {
    exitInvalidArgs('missing required argv');
  }
  const args = readConfinedArgsFileOrExit(argsFile);
  try {
    unlinkSync(argsFile);
  } catch {
    exitInvalidArgs('could not consume detached bootstrap request');
  }
  return { args, bootstrapDir: dirname(argsFile) };
}

export async function writeStartupLockfile(
  dir: string,
  input: Readonly<{
    argv: IpcServerArgs;
    mode: Parameters<typeof writeLockfile>[1]['mode'];
    persistTranscript: boolean;
  }>,
): Promise<{ authToken: string; startedAt: number }> {
  const now = Date.now();
  const authToken = randomBytes(32).toString('hex');
  await writeLockfile(dir, {
    pid: process.pid,
    startTimeMs: now,
    lastAliveMs: now,
    sessionId: input.argv.candidate.sessionId,
    mode: input.mode,
    // `splitbrief ps` prints this field, so it is a consumer surface: redact it under
    // persistTranscript:false. The raw feature still reaches the planner via argv.feature.
    feature: featureForTranscriptPolicy(input.argv.feature, input.persistTranscript),
    authToken,
  });
  return { authToken, startedAt: now };
}

async function cleanupBeforeParentAcceptance(
  input: Readonly<{
    cleanup: (termination: ServerTermination) => Promise<void>;
    rollback: (session: Parameters<typeof rollbackPreparedSession>[0]) => void;
    session: Parameters<typeof rollbackPreparedSession>[0];
    active: Parameters<typeof clearActiveReceipt>[1];
    bootstrapDir: string;
    cause: unknown;
  }>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await input.cleanup({ kind: 'exit', exitCode: 1 });
  } catch (err) {
    failures.push(err);
  }
  try {
    input.rollback(input.session);
  } catch (err) {
    failures.push(err);
    try {
      clearActiveReceipt(input.session.ref, input.active);
    } catch (clearErr) {
      failures.push(clearErr);
    }
  }
  try {
    rmSync(input.bootstrapDir, { recursive: true, force: true });
  } catch (err) {
    failures.push(err);
  }
  if (failures.length > 0) {
    throw detachedServerEntryError.startupCleanup(failures.length, {
      startupCause: input.cause,
      failures,
    });
  }
}

async function cleanupBeforeServe(
  input: Readonly<{
    rollback: (session: Parameters<typeof rollbackPreparedSession>[0]) => void;
    rollbackHandoff: (session: Parameters<typeof rollbackDetachedSessionHandoff>[0]) => void;
    session: Parameters<typeof rollbackPreparedSession>[0];
    ref: Parameters<typeof releaseStateAuthority>[0];
    receipt: StateAuthorityReceipt | undefined;
    releaseAuthority: typeof releaseStateAuthority;
    stopHeartbeat?: (() => void) | undefined;
    closeBridge?: (() => void) | undefined;
    closeServer?: (() => Promise<void>) | undefined;
    terminalize?: ((termination: ServerTermination) => Promise<void>) | undefined;
    bootstrapDir: string;
    cause: unknown;
  }>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    input.stopHeartbeat?.();
  } catch (err) {
    failures.push(err);
  }
  try {
    input.closeBridge?.();
  } catch (err) {
    failures.push(err);
  }
  try {
    await input.closeServer?.();
  } catch (err) {
    failures.push(err);
  }
  try {
    await input.terminalize?.({ kind: 'exit', exitCode: 1 });
  } catch (err) {
    failures.push(err);
  }
  if (input.receipt !== undefined) {
    try {
      input.releaseAuthority(input.ref, input.receipt);
    } catch (err) {
      failures.push(err);
    }
  }
  try {
    input.rollback(input.session);
  } catch (err) {
    failures.push(err);
    try {
      input.rollbackHandoff(input.session);
    } catch (handoffErr) {
      failures.push(handoffErr);
    }
    try {
      clearActiveReceipt(input.session.ref, input.session.ownership);
    } catch (clearErr) {
      failures.push(clearErr);
    }
  }
  try {
    rmSync(input.bootstrapDir, { recursive: true, force: true });
  } catch (err) {
    failures.push(err);
  }
  if (failures.length > 0) {
    throw detachedServerEntryError.startupCleanup(failures.length, {
      startupCause: input.cause,
      failures,
    });
  }
}

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
