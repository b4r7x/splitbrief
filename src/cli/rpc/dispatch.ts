import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../../engine/events/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import { executeRuntimeCommand } from '../../core/runtime/commands/dispatch.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { createRpcCommandContext } from './command-context.js';
import type { RpcCommand } from './types.js';

function ackCommandName(raw: string): string {
  const trimmed = raw.trim();
  const firstWhitespace = trimmed.search(/\s/);
  return firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
}

function slashAckData(
  raw: string,
  messages: string[],
  persistTranscript: boolean,
): { command: string; messages: string[] } {
  return {
    command: persistTranscript ? raw : ackCommandName(raw),
    messages,
  };
}

export function createCommandHandler(deps: {
  projectDir: string;
  getSessionId: () => string | undefined;
  getState: () => WorkflowState | null;
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  getPhase: () => Phase;
  getQueueHandler: () => QueueHandler | null;
  getClearQueueHandler: () => ClearQueueHandler | null;
  abort: (reason?: unknown) => void;
  bus: EventBus;
  approvalGate: { handle: (cmd: RpcCommand) => boolean };
  messageGate: { resolve: (value: string) => boolean };
  receiveRecoveryAction: (action: string) => boolean;
  writeStatus: () => void;
  writer: {
    ack: (command: string, data?: unknown) => void;
    error: (message: string) => void;
  };
  pendingQueueDepth: (state: WorkflowState | null) => number;
}): (cmd: RpcCommand) => void {
  let runtimeChain: Promise<void> = Promise.resolve();

  const executeRpcRuntimeCommand = async (raw: string) => {
    const messages: string[] = [];
    const errors: string[] = [];
    const context = createRpcCommandContext({
      projectDir: deps.projectDir,
      getSessionId: deps.getSessionId,
      getState: deps.getState,
      getConfig: deps.getConfig,
      setConfig: deps.setConfig,
      getPhase: deps.getPhase,
      queueHandler: deps.getQueueHandler,
      clearQueueHandler: deps.getClearQueueHandler,
      abort: deps.abort,
      bus: deps.bus,
      messages,
      errors,
      pendingQueueDepth: deps.pendingQueueDepth,
    });
    await executeRuntimeCommand(createRuntimeCommands(context), raw, {
      screen: 'workflow',
      phase: deps.getPhase(),
      onError: (message) => errors.push(message),
    });
    if (errors.length > 0) {
      for (const error of errors) deps.writer.error(error);
      return;
    }
    deps.writer.ack(
      'slash',
      slashAckData(raw, messages, deps.getConfig().workflow.persistTranscript),
    );
  };

  return (cmd: RpcCommand) => {
    if (cmd.type === 'approve' || cmd.type === 'reject' || cmd.type === 'regenerate') {
      if (deps.approvalGate.handle(cmd)) {
        deps.writer.ack(cmd.type);
        return;
      }
      deps.writer.error(`No pending approval gate for ${cmd.type}.`);
      return;
    }

    if (cmd.type === 'message') {
      if (deps.messageGate.resolve(cmd.text)) {
        deps.writer.ack('message');
        return;
      }
      const handler = deps.getQueueHandler();
      if (!handler) {
        deps.writer.error('Workflow queue is not ready.');
        return;
      }
      void Promise.resolve(handler(cmd.text, deps.getPhase()))
        .then((result) => {
          if (result.status === 'rejected') {
            deps.writer.error(result.message);
            return;
          }
          deps.writer.ack('message');
        })
        .catch((err) => {
          deps.writer.error(toErrorMessage(err));
        });
      return;
    }

    if (cmd.type === 'recovery') {
      if (deps.receiveRecoveryAction(cmd.action)) {
        deps.writer.ack('recovery', { action: cmd.action, queued: true });
      }
      return;
    }

    if (cmd.type === 'status') {
      deps.writeStatus();
      return;
    }

    if (cmd.type === 'abort') {
      deps.abort();
      deps.writer.ack('abort');
      return;
    }

    runtimeChain = runtimeChain
      .then(() => executeRpcRuntimeCommand(cmd.command))
      .catch((err) => {
        deps.writer.error(toErrorMessage(err));
      });
  };
}
