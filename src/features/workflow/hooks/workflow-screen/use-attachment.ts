import { useEffect } from 'react';
import { useApp, useInput } from 'ink';
import { createIpcPromptDispatcher } from '../../ipc-prompt-dispatcher.js';
import { useIpcClient, type IpcClientStatus } from '../use-ipc-client.js';
import type { UseInputModeResult } from '../use-input-mode.js';
import type { ReviewInputHandler } from '../../review-parser.js';
import { sessionDir } from '../../../../core/paths.js';
import { feedbackStore } from '../../../../stores/ui/feedback.js';
import { resetWorkflow } from '../../../../stores/workflow/actions/reset.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { configStore } from '../../../../stores/project/config.js';
import { addTuiEvent } from '../../tui-sink.js';

export interface WorkflowAttachRoute {
  sockPath: string;
  authToken: string;
}

export function useWorkflowAttachment(opts: {
  attach: WorkflowAttachRoute | undefined;
  projectDir: string;
  sessionId: string | undefined;
  inputMode: UseInputModeResult;
  review: ReviewInputHandler;
  onRuntimeCommand: (command: string) => void;
  hasOverlay: boolean;
}): {
  isAttachedClient: boolean;
  ipcStatus: IpcClientStatus;
  handleAttachedInput: (text: string) => void;
  handleAttachedRuntimeCommand: (command: string) => void;
} {
  const { attach, projectDir, sessionId, inputMode, review, onRuntimeCommand, hasOverlay } = opts;
  const { exit } = useApp();
  const config = configStore.useConfig();
  const isAttachedClient = attach !== undefined;

  const handleIpcPrompt = createIpcPromptDispatcher(inputMode, {
    sessionDirPath: sessionId === undefined ? undefined : sessionDir(projectDir, sessionId),
  });
  const [ipcState, ipcActions] = useIpcClient({
    sockPath: attach?.sockPath ?? '',
    authToken: attach?.authToken ?? '',
    enabled: isAttachedClient,
    onEvent: (event) =>
      addTuiEvent(event, {
        persistTranscript: config.workflow.persistTranscript,
      }),
    onPromptRequest: handleIpcPrompt,
  });

  useEffect(() => {
    if (!isAttachedClient) return;
    resetWorkflow();
    conversationScrollStore.reset();
  }, [isAttachedClient, attach?.sockPath]);

  useInput(
    (input, key) => {
      if (!(key.ctrl && input === 'd')) return;
      ipcActions.detach();
      exit();
    },
    { isActive: isAttachedClient && !hasOverlay },
  );

  const handleAttachedInput = (text: string) => {
    if (ipcState.status !== 'connected') {
      feedbackStore.setError('Cannot send input: not connected to server.');
      return;
    }
    if (inputMode.mode !== 'normal') {
      void review.handleInput(text);
      return;
    }
    ipcActions.sendUserInput(text);
  };

  const handleAttachedRuntimeCommand = (command: string) => {
    if (command.trim().toLowerCase() === '/queue clear') {
      if (ipcState.status !== 'connected') {
        feedbackStore.setError('Cannot clear queue: not connected to server.');
        return;
      }
      ipcActions.clearQueue();
      feedbackStore.setMessage('Queue clear requested');
      return;
    }
    onRuntimeCommand(command);
  };

  return {
    isAttachedClient,
    ipcStatus: ipcState.status,
    handleAttachedInput,
    handleAttachedRuntimeCommand,
  };
}
