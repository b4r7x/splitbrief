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
import { DIPTYCH_DIR } from '../../core/paths.js';
import { includes } from '../../utils/type-guards.js';

export const handoffRenderError = {
  unknownTaskId: (id: string) => error('handoff-unknown-task-id', `unknown task id: ${id}`, { id }),
  unsupportedTarget: (target: string) =>
    error('handoff-unsupported-target', `unsupported target: ${target}`, { target }),
  unknownTarget: (target: string) =>
    error(
      'handoff-unknown-target',
      `unknown target: ${target}. No built-in or custom renderer found.`,
      { target },
    ),
  invalidTarget: (target: string, reason: string) =>
    error('handoff-invalid-target', `invalid handoff target "${target}": ${reason}`, {
      target,
      reason,
    }),
  loadFailed: (reason: string) => error('handoff-renderer-load-failed', reason, { reason }),
  customRendererBlocked: (target: string) =>
    error(
      'handoff-custom-renderer-blocked',
      `Custom renderer "${target}" blocked: repo-local renderers require trust.customRenderers: true in config or --allow-custom-renderer.`,
      { target },
    ),
} as const;

export function renderHandoff(input: HandoffInput): HandoffPack {
  const tasks = input.selectedTaskIds
    ? input.selectedTaskIds.map((id) => {
        const task = input.tasks.find((t) => t.id === id);
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

export interface RenderHandoffWithCustomOptions {
  trustCustomRenderers?: boolean;
}

function isBuiltInHandoffInput(
  input: Omit<HandoffInput, 'target'> & { target: string },
): input is HandoffInput {
  return includes(HANDOFF_TARGETS, input.target);
}

export async function renderHandoffWithCustom(
  input: Omit<HandoffInput, 'target'> & { target: string },
  projectDir: string,
  options: RenderHandoffWithCustomOptions = {},
): Promise<HandoffPack> {
  const validation = validateHandoffTargetName(input.target);
  if (!validation.ok) {
    throw handoffRenderError.invalidTarget(input.target, validation.reason);
  }

  if (isBuiltInHandoffInput(input)) {
    return renderHandoff(input);
  }

  if (!options.trustCustomRenderers) {
    throw handoffRenderError.customRendererBlocked(input.target);
  }

  const tsPath = join(projectDir, DIPTYCH_DIR, 'handoff-renderers', `${input.target}.ts`);
  const jsPath = join(projectDir, DIPTYCH_DIR, 'handoff-renderers', `${input.target}.js`);

  const resolvedPath = existsSync(tsPath) ? tsPath : existsSync(jsPath) ? jsPath : null;

  if (resolvedPath === null) {
    throw handoffRenderError.unknownTarget(input.target);
  }

  const result = await loadRenderer(resolvedPath, projectDir);
  if (!result.ok) {
    throw handoffRenderError.loadFailed(result.reason);
  }

  return Promise.resolve(result.fn(input));
}
