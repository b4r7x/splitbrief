import { describe, it, expect } from 'vitest';
import { makeCallbacks } from './workflow-loop/prompts.js';
import type { IpcServer } from './server.js';
import type { IpcPromptRequest } from './protocol.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';

describe('workflow-loop prompts', () => {
  it('forwards question answers from IPC prompt responses', async () => {
    const question: ClarificationQuestion = { id: 'q1', type: 'input', text: 'Proceed?' };
    const server: IpcServer = {
      requestClientPrompt: async (request: IpcPromptRequest) => {
        if (request.kind !== 'question_asked') {
          throw new Error(`unexpected prompt ${request.kind}`);
        }
        return { kind: 'question_asked', answer: 'yes' };
      },
    } as IpcServer;

    const callbacks = makeCallbacks(server);
    await expect(callbacks.onQuestionAsked?.(question, 1, 1)).resolves.toBe('yes');
  });
});
