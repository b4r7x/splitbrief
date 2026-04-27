import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../core/config/load/load.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { writeLockfile, markExited, markCrashed } from './lockfile.js';
import { startHeartbeat } from './heartbeat.js';
import { runWorkflow } from '../orchestrator/run/run.js';
import { startIpcServer } from './server.js';
import { createEventBus } from '../events/bus.js';
import { normalizeLegacyMode } from '../../core/schemas/enums.js';
import { createIpcWorkflowBridge } from './workflow-bridge.js';

function getArgv(): { sessionId: string; projectDir: string; feature: string; mode: string; configPath: string } {
  const [, , sessionId, projectDir, feature, mode, configPath] = process.argv;
  if (!sessionId || !projectDir || !feature || !mode || !configPath) {
    process.stderr.write('server-entry: missing required argv\n');
    process.exit(1);
  }
  return { sessionId, projectDir, feature, mode, configPath };
}

const argv = getArgv();
const dir = sessionDir(argv.projectDir, argv.sessionId);

async function main() {
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  await writeLockfile(dir, {
    pid: process.pid,
    startTimeMs: now,
    lastAliveMs: now,
    sessionId: argv.sessionId,
    mode: argv.mode,
    feature: argv.feature,
  });

  const stopHeartbeat = startHeartbeat(dir);

  const ipcBus = createEventBus();
  const ipcBridge = createIpcWorkflowBridge(ipcBus);
  const mode = normalizeLegacyMode(argv.mode) ?? 'standard';
  const ipcServer = await startIpcServer({
    sessionId: argv.sessionId,
    sessionDir: dir,
    startedAt: now,
    mode,
    feature: argv.feature,
    bus: ipcBus,
    onUserInput: ipcBridge.onUserInput,
    sessionJsonlPath: join(dir, SESSION_LOG_FILE),
  });

  const onCleanup = async (exitCode: number) => {
    stopHeartbeat();
    ipcBridge.close();
    await ipcServer.close();
    await markExited(dir, exitCode);
  };

  process.on('SIGTERM', () => {
    void onCleanup(0).then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    void onCleanup(0).then(() => process.exit(0));
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    void markCrashed(dir, 'uncaught', msg).then(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    void markCrashed(dir, 'uncaught', err.message).then(() => process.exit(1));
  });

  const { config } = loadConfig(argv.projectDir);

  await runWorkflow({
    feature: argv.feature,
    projectDir: argv.projectDir,
    config,
    headless: true,
    sessionId: argv.sessionId,
    eventBus: ipcBus,
    sinks: ipcBridge.sinks,
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onExternalChanges: async () => true,
      onQuestionAsked: async () => '',
      onBudgetExceeded: async () => true,
      onBudgetPaused: async () => {
        process.exit(1);
      },
      onContinuationNeeded: async () => '',
      onComplete: () => undefined,
    },
  });

  await onCleanup(0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  void markCrashed(dir, 'uncaught', msg).then(() => process.exit(1));
});
