import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { HandoffInput, HandoffPack } from './types.js';
import { HANDOFF_TARGETS, validateHandoffTargetName } from '../../core/handoff/targets.js';
import { renderSpecKit } from './renderers/spec-kit.js';
import { renderAgentsMd } from './renderers/agents-md.js';
import { renderClaudeCode } from './renderers/claude-code.js';
import { renderCopilotIssue } from './renderers/copilot-issue.js';
import { loadRenderer } from './load-renderer.js';
import { error } from '../../utils/error.js';

export const handoffRenderError = {
  unknownTaskId: (id: string) => error('handoff-unknown-task-id', `unknown task id: ${id}`, { id }),
  unsupportedTarget: (target: string) => error('handoff-unsupported-target', `unsupported target: ${target}`, { target }),
  unknownTarget: (target: string) =>
    error('handoff-unknown-target', `unknown target: ${target}. No built-in or custom renderer found.`, { target }),
  invalidTarget: (target: string, reason: string) =>
    error('handoff-invalid-target', `invalid handoff target "${target}": ${reason}`, { target, reason }),
  loadFailed: (reason: string) => error('handoff-renderer-load-failed', reason, { reason }),
} as const;

export function renderHandoff(input: HandoffInput): HandoffPack {
  const tasks = input.selectedTaskIds
    ? input.selectedTaskIds.map(id => {
        const task = input.tasks.find(t => t.id === id);
        if (!task) throw handoffRenderError.unknownTaskId(id);
        return task;
      })
    : input.tasks;

  const filtered: HandoffInput = { ...input, tasks };

  switch (input.target) {
    case 'spec-kit':
      return renderSpecKit(filtered);
    case 'agents-md':
      return renderAgentsMd(filtered);
    case 'claude-code':
      return renderClaudeCode(filtered);
    case 'copilot-issue':
      return renderCopilotIssue(filtered);
    default: {
      const exhaustive: never = input.target;
      throw handoffRenderError.unsupportedTarget(exhaustive);
    }
  }
}

export async function renderHandoffWithCustom(
  input: Omit<HandoffInput, 'target'> & { target: string },
  projectDir: string,
): Promise<HandoffPack> {
  const validation = validateHandoffTargetName(input.target);
  if (!validation.ok) {
    throw handoffRenderError.invalidTarget(input.target, validation.reason);
  }

  if ((HANDOFF_TARGETS as readonly string[]).includes(input.target)) {
    return renderHandoff(input as HandoffInput);
  }

  const tsPath = join(projectDir, '.diptych', 'handoff-renderers', `${input.target}.ts`);
  const jsPath = join(projectDir, '.diptych', 'handoff-renderers', `${input.target}.js`);

  const resolvedPath = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null;

  if (resolvedPath === null) {
    throw handoffRenderError.unknownTarget(input.target);
  }

  const result = await loadRenderer(resolvedPath, projectDir);
  if (!result.ok) {
    throw handoffRenderError.loadFailed(result.reason);
  }

  return Promise.resolve(result.fn(input as HandoffInput));
}
