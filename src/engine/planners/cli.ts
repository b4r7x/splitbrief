import type { Config } from '../../core/types/config-options.js';
import type { InvokeResult } from '../../core/types/runner.js';
import type { Planner, PlannerCallbacks } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../lib/availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { resolveAutoModel } from '../../core/providers/index.js';
import { assertPlannerKind } from '../config-assertions.js';
import { createSessionResumeState } from '../session-expiry.js';

export function createCliPlanner(config: Config, initialSessionId?: string | null): Planner {
  const plannerCfg = assertPlannerKind(config, 'cli');
  const resolvedModel = resolveAutoModel(plannerCfg.model, plannerCfg.tool);
  const tool = CLI_TOOLS[plannerCfg.tool];
  if (!tool.planner) {
    throw new Error(`CLI tool '${plannerCfg.tool}' has no planner configuration`);
  }
  const planner = tool.planner;
  const supportsSessionResume = planner.supportsSessionResume === true;

  let pendingExpiredCallback: ((id: string) => void) | undefined;
  const session = createSessionResumeState({
    onExpired: (id) => pendingExpiredCallback?.(id),
  });
  if (supportsSessionResume) session.capture(initialSessionId ?? null);

  async function runOnce(
    prompt: string,
    projectDir: string,
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId'>,
    mode: 'plan' | 'escalate',
    resumeId: string | null,
  ): Promise<InvokeResult> {
    let stderrOutput = '';
    const buildOpts: Parameters<typeof planner.buildArgs>[0] = {
      prompt,
      projectDir,
      mode,
      ...(resolvedModel !== undefined && { model: resolvedModel }),
      ...(supportsSessionResume && resumeId ? { sessionId: resumeId } : {}),
    };

    const result = await spawnAndCollect({
      command: tool.command,
      args: planner.buildArgs(buildOpts),
      cwd: projectDir,
      notFoundMessage: tool.notFoundMessage,
      parseLine: planner.parseLine,
      onText: callbacks.onOutput,
      onStderr: planner.postProcess ? (chunk) => { stderrOutput += chunk; } : undefined,
      ...(supportsSessionResume && {
        onSessionId: (id: string) => {
          session.capture(id);
          callbacks.onSessionId?.(id);
        },
      }),
    });

    if (planner.postProcess) return planner.postProcess(result.text, stderrOutput, result.usage);
    return { text: result.text, usage: result.usage };
  }

  async function invoke(
    prompt: string,
    projectDir: string,
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId' | 'onSessionExpired'>,
    mode: 'plan' | 'escalate',
  ): Promise<InvokeResult> {
    if (!supportsSessionResume) {
      return runOnce(prompt, projectDir, callbacks, mode, null);
    }

    pendingExpiredCallback = callbacks.onSessionExpired;
    try {
      try {
        return await runOnce(prompt, projectDir, callbacks, mode, session.getResumeId());
      } catch (err) {
        if (session.handleResumeError(err)) {
          return await runOnce(prompt, projectDir, callbacks, mode, null);
        }
        throw err;
      }
    } finally {
      pendingExpiredCallback = undefined;
    }
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks, 'plan'),
    invokeEscalate: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks, 'escalate'),
    hintSuccessMode: 'files',

    ...createCommandAvailability(tool.command, planner.isAvailableOpts),

    capabilities: { ...ONE_SHOT_API_CAPS, supportsSessionResume },
  });
}
