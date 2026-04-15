import type { Planner, EscalationResult } from './types.js';
import type { ClarificationQuestion } from '../../types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { writeProjectFile } from '../../core/paths-io.js';
import { runClaudePlannerStream, runClaudeOneShot } from '../claude-runner.js';
import { resolveAutoModel } from '../../core/providers.js';

const SESSION_EXPIRED_PATTERNS = [
  'session not found',
  'session_not_found',
  'invalid session',
  'expired session',
];

function isSessionExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return SESSION_EXPIRED_PATTERNS.some(p => msg.includes(p));
}

export function createClaudeCodePlanner(model?: string, initialSessionId?: string | null): Planner {
  const resolvedModel = resolveAutoModel(model, 'claude-code');
  let currentSessionId: string | null = initialSessionId ?? null;

  async function invokeWithSessionFallback(
    prompt: string,
    projectDir: string,
    callbacks: { onOutput: (text: string) => void; onSessionId?: ((id: string) => void) | undefined; onSessionExpired?: ((id: string) => void) | undefined; onQuestion?: ((q: ClarificationQuestion[]) => void) | undefined },
  ) {
    try {
      return await runClaudePlannerStream({
        prompt, projectDir, sessionId: currentSessionId,
        onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion, model: resolvedModel,
      });
    } catch (err) {
      if (currentSessionId && isSessionExpiredError(err)) {
        const expiredId = currentSessionId;
        currentSessionId = null;
        callbacks.onSessionExpired?.(expiredId);
        return runClaudePlannerStream({
          prompt, projectDir, sessionId: null,
          onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion, model: resolvedModel,
        });
      }
      throw err;
    }
  }

  return createPlannerBase({
    async invokePlan({ prompt, projectDir, callbacks }) {
      const result = await invokeWithSessionFallback(prompt, projectDir, callbacks);
      currentSessionId = result.sessionId;
      if (result.sessionId) callbacks.onSessionId?.(result.sessionId);
      return { text: result.text, usage: result.usage };
    },

    async invokeEscalate({ prompt, projectDir, callbacks }) {
      return runClaudeOneShot({ prompt, projectDir, onOutput: callbacks.onOutput, model: resolvedModel });
    },

    ...createCommandAvailability('claude'),

    capabilities: {
      supportsConversationalPlanning: true,
      supportsHintEscalation: false,
      supportsSessionResume: true,
      supportsMidStreamInjection: true,
    },

    escalateFullPostProcess(task, result, extracted, projectDir): EscalationResult {
      writeProjectFile(projectDir, task.file, extracted.code);
      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },
  });
}
