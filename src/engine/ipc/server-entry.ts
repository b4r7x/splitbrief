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
    // `diptych ps` prints this field, so it is a consumer surface: redact it under
    // persistTranscript:false. The raw feature still reaches the planner via argv.feature.
    feature: featureForTranscriptPolicy(argv.feature, argv.persistTranscript ?? true),
    authToken,
  });
  return { authToken, startedAt: now };
}

export async function main(argv: IpcServerArgs, dir: string) {
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

  const onCleanup = async (exitCode: number) => {
    killAllProcesses();
    stopHeartbeat();
    ipcBridge.close();
    await ipcServer.close();
    await markExited(dir, exitCode);
    const sessionRef = { projectDir: argv.projectDir, sessionId: argv.sessionId };
    const finalState = loadState(sessionRef);
    if (!shouldPreserveActiveState(finalState)) clearActive(sessionRef);
    await flushOtel();
  };

  const handleSignal = (signal: string) => {
    stopHeartbeat();
    void (async () => {
      try {
        await markSignaled(dir, signal);
        await onCleanup(0);
        process.exit(0);
      } catch {
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    stopHeartbeat();
    killAllProcesses();
    void markCrashed(dir, 'uncaught', toErrorMessage(reason))
      .then(() => flushOtel())
      .catch(() => {})
      .finally(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    stopHeartbeat();
    killAllProcesses();
    void markCrashed(dir, 'uncaught', toErrorMessage(err))
      .then(() => flushOtel())
      .catch(() => {})
      .finally(() => process.exit(1));
  });

  const summary = await runWorkflowLoop(
    {
      projectDir: argv.projectDir,
      sessionId: argv.sessionId,
      feature: argv.feature,
      plannerContext: argv.plannerContext,
      allowHooks: argv.allowHooks,
      allowRepoRunners: argv.allowRepoRunners,
      attachments: argv.attachments,
    },
    ipcServer,
    ipcBridge,
    ipcBus,
    config,
  );

  const completedTasks = summary.completedByLocal + summary.escalatedToPlanner + summary.skipped;
  const isIncomplete = summary.totalTasks > 0 && completedTasks < summary.totalTasks;
  const exitCode = summary.failed > 0 || isIncomplete ? 1 : 0;
  await onCleanup(exitCode);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = getArgv(process.argv);
  const dir = sessionDir(argv.projectDir, argv.sessionId);
  main(argv, dir).catch((err) => {
    killAllProcesses();
    void markCrashed(dir, 'uncaught', toErrorMessage(err))
      .then(() => flushOtel())
      .catch(() => {})
      .finally(() => process.exit(1));
  });
}
