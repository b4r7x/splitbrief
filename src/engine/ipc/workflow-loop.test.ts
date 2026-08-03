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

  it('maps immutable artifact reviews to the content-only IPC prompt', async () => {
    const review = Object.freeze({
      label: 'Custom planner artifact',
      text: '# candidate\n\u0000artifact-text-58192\n',
    });
    const server: IpcServer = {
      requestClientPrompt: async (request: IpcPromptRequest) => {
        expect(request).toEqual({ kind: 'artifact_review', review });
        expect(request.kind).toBe('artifact_review');
        if (request.kind !== 'artifact_review') throw new Error('unexpected prompt');
        expect(request.review).toBe(review);
        return { kind: 'artifact_review', approved: true };
      },
    } as IpcServer;

    const callbacks = makeCallbacks(server);
    await expect(callbacks.onApprovalNeeded('artifact', review)).resolves.toEqual({
      approved: true,
    });
  });

  it('keeps ordinary file reviews on approval_needed', async () => {
    const server: IpcServer = {
      requestClientPrompt: async (request: IpcPromptRequest) => {
        expect(request).toEqual({
          kind: 'approval_needed',
          approvalType: 'spec',
          filePath: '/tmp/spec.md',
        });
        return { kind: 'approval_needed', approved: false };
      },
    } as IpcServer;

    const callbacks = makeCallbacks(server);
    await expect(callbacks.onApprovalNeeded('spec', '/tmp/spec.md')).resolves.toEqual({
      approved: false,
    });
  });
});
