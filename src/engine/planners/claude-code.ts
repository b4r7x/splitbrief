import type { Planner, EscalationResult } from './types.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { CONVERSATIONAL_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../lib/availability.js';
import { writeProjectFile } from '../../core/paths-io.js';
import { runClaudePlannerStream, runClaudeOneShot } from '../claude-runner.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { createSessionResumeState, runWithResumeFallback } from '../session-expiry.js';

export function createClaudeCodePlanner(model?: string, initialSessionId?: string | null, effort?: EffortLevel): Planner {
  const resolvedModel = resolveAutoModel(model, 'claude-code');
  const session = createSessionResumeState();
  session.capture(initialSessionId ?? null);

  async function invokeWithSessionFallback(
    prompt: string,
    projectDir: string,
    callbacks: { onOutput: (text: string) => void; onSessionId?: ((id: string) => void) | undefined; onSessionExpired?: ((id: string) => void) | undefined; onQuestion?: ((q: ClarificationQuestion[]) => void) | undefined },
    images?: Attachment[] | undefined,
  ) {
    const priorId = session.getResumeId();
    return runWithResumeFallback(
      session,
      (resumeId) => runClaudePlannerStream({
        prompt, projectDir, sessionId: resumeId ?? null,
        onOutput: callbacks.onOutput, onQuestion: callbacks.onQuestion, model: resolvedModel,
        ...(effort !== undefined && { effort }),
        ...(images && images.length > 0 ? { images } : {}),
      }),
      () => { if (priorId) callbacks.onSessionExpired?.(priorId); },
    );
  }

  return createPlannerBase({
    async invokePlan({ prompt, projectDir, callbacks, images }) {
      const result = await invokeWithSessionFallback(prompt, projectDir, callbacks, images);
      session.capture(result.sessionId);
      if (result.sessionId) callbacks.onSessionId?.(result.sessionId);
      return { text: result.text, usage: result.usage };
    },

    async invokeEscalate({ prompt, projectDir, callbacks }) {
      return runClaudeOneShot({
        prompt, projectDir, onOutput: callbacks.onOutput, model: resolvedModel,
        ...(effort !== undefined && { effort }),
      });
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
        ...(effort !== undefined && { effort }),
      });
    },

    capabilities: { ...CONVERSATIONAL_CAPS, supportsHintEscalation: false },

    escalateFullPostProcess(task, result, extracted, projectDir): EscalationResult {
      writeProjectFile(projectDir, task.file, extracted.code);
      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },
  });
}
