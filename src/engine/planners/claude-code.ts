import type { Planner, EscalationResult } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { writeProjectFile } from '../../core/paths-io.js';
import { runClaudePlannerStream, runClaudeOneShot } from '../claude-runner.js';

export function createClaudeCodePlanner(model?: string): Planner {
  let currentSessionId: string | null = null;

  return createPlannerBase({
    async invokePlan({ prompt, projectDir, callbacks }) {
      const result = await runClaudePlannerStream({
        prompt,
        projectDir,
        sessionId: currentSessionId,
        onOutput: callbacks.onOutput,
        onQuestion: callbacks.onQuestion,
        model,
      });
      currentSessionId = result.sessionId;
      return { text: result.text, usage: result.usage };
    },

    async invokeEscalate({ prompt, projectDir, callbacks }) {
      return runClaudeOneShot({ prompt, projectDir, onOutput: callbacks.onOutput, model });
    },

    ...createCommandAvailability('claude'),

    escalateHintSuccess: () => false,

    escalateFullPostProcess(task, result, extracted, projectDir): EscalationResult {
      writeProjectFile(projectDir, task.file, extracted.code);
      return { success: true, output: result.text, code: extracted.code, usage: result.usage };
    },
  });
}
