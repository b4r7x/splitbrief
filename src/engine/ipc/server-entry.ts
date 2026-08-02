import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../core/config/load/io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { writeLockfile, markExited, markCrashed, markSignaled } from './lockfile.js';
import { startHeartbeat } from './heartbeat.js';
import { startIpcServer } from './server.js';
import { createEventBus } from '../events/bus.js';
import { createIpcWorkflowBridge } from './workflow-bridge.js';
import {
  emitEffectiveConfigWarnings,
  resolveEffectiveConfig,
} from '../../core/config/runtime/effective-config.js';
import type { EffectiveConfigWarning } from '../../core/config/runtime/effective-config.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { readIpcServerArgsFileConfined, type IpcServerArgs } from './server-args.js';
import {
  writeActive,
  clearActive,
  featureForTranscriptPolicy,
} from '../../core/sessions/lifecycle.js';
import { clearStaleSession } from '../../core/sessions/guards.js';
import { loadState } from '../../core/state/persistence.js';
import { shouldPreserveActiveState } from '../orchestrator/session-lifecycle/finalize.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { bootstrapOtel, flushOtel } from '../../lib/otel.js';
import { runWorkflowLoop } from './workflow-loop/run.js';
import { cliStartGatesFromArray } from '../runners/start-gate.js';

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
};

type ExitProcess = (code: number) => void;

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
      } catch (error) {
        reaping = { error };
      }
      options.closeBridge();
      await options.closeServer();
      await options.terminalize(termination);
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

export function emitConfigWarnings(warnings: readonly EffectiveConfigWarning[]): void {
  emitEffectiveConfigWarnings(warnings);
}

function readConfinedArgsFileOrExit(argsFile: string): IpcServerArgs {
  try {
    return readIpcServerArgsFileConfined(argsFile);
  } catch (err) {
    exitInvalidArgs(toErrorMessage(err));
  }
}

export function getArgv(processArgv: string[]): IpcServerArgs {
  const argsFile = processArgv[2];
  if (!argsFile) {
    exitInvalidArgs('missing required argv');
  }
  return readConfinedArgsFileOrExit(argsFile);
}

export async function writeStartupLockfile(
  dir: string,
  argv: IpcServerArgs,
): Promise<{ authToken: string; startedAt: number }> {
  const now = Date.now();
  const authToken = randomBytes(32).toString('hex');
  await writeLockfile(dir, {
    pid: process.pid,
    startTimeMs: now,
    lastAliveMs: now,
    sessionId: argv.sessionId,
    mode: argv.mode,
    // `splitbrief ps` prints this field, so it is a consumer surface: redact it under
    // persistTranscript:false. The raw feature still reaches the planner via argv.feature.
    feature: featureForTranscriptPolicy(argv.feature, argv.persistTranscript ?? true),
    authToken,
  });
  return { authToken, startedAt: now };
}

export async function main(
  argv: IpcServerArgs,
  dir: string,
  cleanupProcesses = createServerProcessCleanup(),
) {
  bootstrapOtel();
  mkdirSync(dir, { recursive: true });

  const { authToken, startedAt } = await writeStartupLockfile(dir, argv);

  clearStaleSession(argv.projectDir);
  writeActive({ projectDir: argv.projectDir, sessionId: argv.sessionId });

  const stopHeartbeat = startHeartbeat(dir);

  const ipcBus = createEventBus();
  const ipcBridge = createIpcWorkflowBridge(ipcBus);
  const { config: rawConfig, loaderDiagnostics } = loadConfig(argv.projectDir);
  const { config, warnings } = resolveEffectiveConfig({
    base: rawConfig,
    overrides: argv.overrides,
    loaderDiagnostics,
  });
  emitConfigWarnings(warnings);
  const ipcServer = await startIpcServer({
    // Attached TUI clients connect here; user_input and queue_clear are the runtime-command IPC
    // bridges documented in docs/SLASH-COMMANDS-REFERENCE.md § Attached clients.
    sessionId: argv.sessionId,
    sessionDir: dir,
    startedAt,
    mode: argv.mode,
    feature: argv.feature,
    authToken,
    bus: ipcBus,
    onUserInput: ipcBridge.onUserInput,
    onQueueClear: ipcBridge.onQueueClear,
    sessionJsonlPath: join(dir, SESSION_LOG_FILE),
    noClientPromptBehavior: config.approval?.headless === true ? 'fail-closed' : 'wait',
    persistTranscript: config.workflow.persistTranscript,
  });

  const sessionRef = { projectDir: argv.projectDir, sessionId: argv.sessionId };
  const onCleanup = createServerCleanup({
    cleanupProcesses,
    stopHeartbeat,
    closeBridge: ipcBridge.close,
    closeServer: ipcServer.close,
    terminalize: async (termination) => {
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
      if (!shouldPreserveActiveState(finalState)) clearActive(sessionRef);
    },
    flushTelemetry: flushOtel,
  });

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
    const summary = await runWorkflowLoop(
      {
        projectDir: argv.projectDir,
        sessionId: argv.sessionId,
        feature: argv.feature,
        plannerContext: argv.plannerContext,
        allowHooks: argv.allowHooks,
        allowRepoRunners: argv.allowRepoRunners,
        attachments: argv.attachments,
        trustedCliGates: cliStartGatesFromArray(argv.trustedCliGates),
      },
      ipcServer,
      ipcBridge,
      ipcBus,
      config,
    );

    const completedTasks = summary.completedByLocal + summary.escalatedToPlanner + summary.skipped;
    const isIncomplete = summary.totalTasks > 0 && completedTasks < summary.totalTasks;
    const exitCode = summary.failed > 0 || isIncomplete ? 1 : 0;
    await onCleanup({ kind: 'exit', exitCode });
  } catch (err) {
    await exitHandlers.crash(err);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = getArgv(process.argv);
  const dir = sessionDir(argv.projectDir, argv.sessionId);
  const cleanupProcesses = createServerProcessCleanup();
  const exitHandlers = createServerExitHandlers({
    cleanup: createServerCleanup({
      cleanupProcesses,
      stopHeartbeat: () => {},
      closeBridge: () => {},
      closeServer: () => Promise.resolve(),
      terminalize: (termination) =>
        termination.kind === 'crash'
          ? markCrashed(dir, 'uncaught', termination.cause)
          : Promise.resolve(),
      flushTelemetry: flushOtel,
    }),
  });
  main(argv, dir, cleanupProcesses).catch((err) => exitHandlers.crash(err));
}
