import type { Config, InvokeResult } from '../../types.js';
import type { Planner, PlannerCallbacks } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../utils/availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { resolveAutoModel } from '../../core/providers.js';
import { assertPlannerKind } from './utils.js';

export function createCliPlanner(config: Config, initialSessionId?: string | null): Planner {
  const plannerCfg = assertPlannerKind(config, 'cli');
  const resolvedModel = resolveAutoModel(plannerCfg.model, plannerCfg.tool);
  const tool = CLI_TOOLS[plannerCfg.tool];
  if (!tool.planner) {
    throw new Error(`CLI tool '${plannerCfg.tool}' has no planner configuration`);
  }
  const planner = tool.planner;
  const supportsSessionResume = planner.supportsSessionResume === true;
  let currentSessionId: string | null = supportsSessionResume ? (initialSessionId ?? null) : null;

  async function invoke(
    prompt: string,
    projectDir: string,
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId'>,
    mode: 'plan' | 'escalate',
  ): Promise<InvokeResult> {
    let stderrOutput = '';
    const buildOpts: Parameters<typeof planner.buildArgs>[0] = {
      prompt,
      projectDir,
      mode,
      ...(resolvedModel !== undefined && { model: resolvedModel }),
      ...(supportsSessionResume && currentSessionId ? { sessionId: currentSessionId } : {}),
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
          currentSessionId = id;
          callbacks.onSessionId?.(id);
        },
      }),
    });

    if (planner.postProcess) return planner.postProcess(result.text, stderrOutput, result.usage);
    return { text: result.text, usage: result.usage };
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks, 'plan'),
    invokeEscalate: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks, 'escalate'),
    hintSuccessMode: 'files',

    ...createCommandAvailability(tool.command, planner.isAvailableOpts),

    capabilities: {
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume,
      supportsMidStreamInjection: false,
    },
  });
}
