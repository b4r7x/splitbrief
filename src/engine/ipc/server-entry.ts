import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../core/config/load/load.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { writeLockfile, markExited, markCrashed, markSignaled } from './lockfile.js';
import { startHeartbeat } from './heartbeat.js';
import { runWorkflow } from '../orchestrator/run/run.js';
import { startIpcServer } from './server.js';
import { createEventBus } from '../events/bus.js';
import { normalizeLegacyMode } from '../../core/schemas/enums.js';
import { createIpcWorkflowBridge } from './workflow-bridge.js';
import type { IpcPromptResponse } from './protocol.js';
import { applyCLIOverrides } from '../../core/config/runtime/overrides.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error } from '../../utils/error.js';
import { readIpcServerArgsFile, SERVER_ARGS_FILE, type IpcServerArgs } from './server-args.js';

const ipcServerEntryError = {
  promptResponseKindMismatch: (expected: string, actual: string) =>
    error('ipc-prompt-response-kind-mismatch', `IPC prompt response kind mismatch: expected ${expected}, got ${actual}`, { expected, actual }),
} as const;

function assertPromptResponse<T extends IpcPromptResponse['kind']>(
  response: IpcPromptResponse,
  kind: T,
): Extract<IpcPromptResponse, { kind: T }> {
  if (response.kind !== kind) {
    throw ipcServerEntryError.promptResponseKindMismatch(kind, response.kind);
  }
  return response as Extract<IpcPromptResponse, { kind: T }>;
}

function exitInvalidArgs(message: string): never {
  process.stderr.write(`server-entry: ${message}\n`);
  process.exit(1);
}

function readArgsFileOrExit(argsFile: string): IpcServerArgs {
  try {
    return readIpcServerArgsFile(argsFile);
  } catch (err) {
    exitInvalidArgs(toErrorMessage(err));
  }
}

function getArgv(): IpcServerArgs {
  const [, , firstArg, secondArg, feature, mode, configPath] = process.argv;
  if (firstArg && !secondArg) {
    return readArgsFileOrExit(firstArg);
  }
  if (firstArg === '--args-file' && secondArg) {
    return readArgsFileOrExit(secondArg);
  }

  const sessionId = firstArg;
  const projectDir = secondArg;
  if (!sessionId || !projectDir || !feature || !mode || !configPath) {
    exitInvalidArgs('missing required argv');
  }

  const argsFile = join(sessionDir(projectDir, sessionId), SERVER_ARGS_FILE);
  if (existsSync(argsFile)) {
    try {
      return readIpcServerArgsFile(argsFile);
    } catch {
      // Legacy argv launches can still run without persisted overrides.
    }
  }

  return { sessionId, projectDir, feature, mode, configPath, overrides: {} };
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
  const { config: rawConfig } = loadConfig(argv.projectDir);
  const config = applyCLIOverrides(rawConfig, argv.overrides);
  const ipcServer = await startIpcServer({
    sessionId: argv.sessionId,
    sessionDir: dir,
    startedAt: now,
    mode,
    feature: argv.feature,
    bus: ipcBus,
    onUserInput: ipcBridge.onUserInput,
    sessionJsonlPath: join(dir, SESSION_LOG_FILE),
    noClientPromptBehavior: config.approval?.headless === true ? 'fail-closed' : 'wait',
  });

  const onCleanup = async (exitCode: number) => {
    stopHeartbeat();
    ipcBridge.close();
    await ipcServer.close();
    await markExited(dir, exitCode);
  };

  const handleSignal = (signal: string) => {
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
    void markCrashed(dir, 'uncaught', toErrorMessage(reason)).then(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    void markCrashed(dir, 'uncaught', err.message).then(() => process.exit(1));
  });

  await runWorkflow({
    feature: argv.feature,
    projectDir: argv.projectDir,
    config,
    headless: true,
    sessionId: argv.sessionId,
    eventBus: ipcBus,
    sinks: ipcBridge.sinks,
    callbacks: {
      onApprovalNeeded: async (approvalType, filePath) => {
        const response = assertPromptResponse(
          await ipcServer.requestClientPrompt({ kind: 'approval_needed', approvalType, filePath }),
          'approval_needed',
        );
        return {
          approved: response.approved,
          ...(response.comment !== undefined && { comment: response.comment }),
          ...(response.action !== undefined && { action: response.action }),
        };
      },
      onUserEditConflict: async (conflict) => {
        const response = assertPromptResponse(
          await ipcServer.requestClientPrompt({ kind: 'user_edit_conflict', conflict }),
          'user_edit_conflict',
        );
        return response.selectedAction;
      },
      onQuestionAsked: async (question, num, total) => {
        const response = assertPromptResponse(
          await ipcServer.requestClientPrompt({ kind: 'question_asked', question, num, total }),
          'question_asked',
        );
        return response.answer;
      },
      onBudgetExceeded: async (currentCost, maxBudget) => {
        const response = assertPromptResponse(
          await ipcServer.requestClientPrompt({ kind: 'budget_exceeded', currentCost, maxBudget }),
          'budget_exceeded',
        );
        return response.proceed;
      },
      onBudgetPaused: async (currentCost, maxBudget) => {
        const response = assertPromptResponse(
          await ipcServer.requestClientPrompt({ kind: 'budget_paused', currentCost, maxBudget }),
          'budget_paused',
        );
        return response.decision;
      },
      onContinuationNeeded: async (partialResponse) => {
        const response = assertPromptResponse(
          await ipcServer.requestClientPrompt({ kind: 'continuation_needed', partialResponse }),
          'continuation_needed',
        );
        return response.text;
      },
      onTieredApproval: async (request) => {
        const response = assertPromptResponse(
          await ipcServer.requestClientPrompt({ kind: 'tiered_approval', request }),
          'tiered_approval',
        );
        return response.response;
      },
      onComplete: () => undefined,
    },
  });

  await onCleanup(0);
}

main().catch((err) => {
  void markCrashed(dir, 'uncaught', toErrorMessage(err)).then(() => process.exit(1));
});
