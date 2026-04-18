import type { Planner, EscalationResult } from './types.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import { CONVERSATIONAL_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../lib/availability.js';
import { writeProjectFile } from '../../core/paths-io.js';
import { runClaudePlannerStream, runClaudeOneShot } from '../claude-runner.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { createSessionResumeState } from '../session-expiry.js';

export function createClaudeCodePlanner(model?: string, initialSessionId?: string | null): Planner {
  const resolvedModel = resolveAutoModel(model, 'claude-code');
  let pendingExpiredCallback: ((id: string) => void) | undefined;
  const session = createSessionResumeState({
    onExpired: (id) => pendingExpiredCallback?.(id),
  });
  session.capture(initialSessionId ?? null);

  async function invokeWithSessionFallback(
    prompt: string,
    projectDir: string,
    callbacks: { onOutput: (text: string) => void; onSessionId?: ((id: string) => void) | undefined; onSessionExpired?: ((id: string) => void) | undefined; onQuestion?: ((q: ClarificationQuestion[]) => void) | undefined },
  ) {
    pendingExpiredCallback = callbacks.onSessionExpired;
    try {
      try {
        return await runClaudePlannerStream({
          prompt, projectDir, sessionId: session.getResumeId(),
          onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion, model: resolvedModel,
        });
      } catch (err) {
        if (session.handleResumeError(err)) {
          return await runClaudePlannerStream({
            prompt, projectDir, sessionId: null,
            onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion, model: resolvedModel,
          });
        }
        throw err;
      }
    } finally {
      pendingExpiredCallback = undefined;
    }
  }

  return createPlannerBase({
    async invokePlan({ prompt, projectDir, callbacks }) {
      const result = await invokeWithSessionFallback(prompt, projectDir, callbacks);
      session.capture(result.sessionId);
      if (result.sessionId) callbacks.onSessionId?.(result.sessionId);
      return { text: result.text, usage: result.usage };
    },

    async invokeEscalate({ prompt, projectDir, callbacks }) {
      return runClaudeOneShot({ prompt, projectDir, onOutput: callbacks.onOutput, model: resolvedModel });
    },

    ...createCommandAvailability('claude'),

    async injectUserTurn(text: string, projectDir: string): Promise<void> {
      const sessionId = session.getResumeId();
      if (!sessionId) return;
      await runClaudePlannerStream({
        prompt: text,
        projectDir,
        sessionId,
        onOutput: () => {},
        model: resolvedModel,
      });
    },

    capabilities: { ...CONVERSATIONAL_CAPS, supportsHintEscalation: false },

    escalateFullPostProcess(task, result, extracted, projectDir): EscalationResult {
      writeProjectFile(projectDir, task.file, extracted.code);
      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },
  });
}
