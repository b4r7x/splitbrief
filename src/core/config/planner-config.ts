import type { PlannerConfig, PlannerTool } from '../types/config.js';
import { isCliTool } from '../types/config.js';

interface BuildPlannerConfigOpts {
  model?: string | undefined;
  command?: string | undefined;
  customModels?: string[] | undefined;
  existing?: PlannerConfig | undefined;
}

export function buildPlannerConfig(tool: PlannerTool, opts?: BuildPlannerConfigOpts): PlannerConfig {
  const { model, command, customModels, existing } = opts ?? {};
  const customModelsProp = customModels !== undefined ? { customModels } : {};

  if (tool === 'shell') {
    const cmd = command ?? (existing?.kind === 'shell' ? existing.command : '');
    return { kind: 'shell', command: cmd, ...(model !== undefined && { model }), ...customModelsProp };
  }
  if (tool === 'agent-sdk') {
    return { kind: 'agent-sdk', ...(model !== undefined && { model }), ...customModelsProp };
  }
  if (isCliTool(tool)) {
    return { kind: 'cli', tool, ...(model !== undefined && { model }), ...customModelsProp };
  }
  return { kind: 'api', provider: tool, model: model ?? 'default', ...customModelsProp };
}

export function getPlannerToolName(planner: PlannerConfig): PlannerTool {
  switch (planner.kind) {
    case 'cli':
      return planner.tool;
    case 'agent-sdk':
      return 'agent-sdk';
    case 'api':
      return planner.provider;
    case 'shell':
      return 'shell';
    default: {
      const _exhaustive: never = planner;
      return _exhaustive;
    }
  }
}

export function getPlannerCommand(planner: PlannerConfig): string | undefined {
  return planner.kind === 'shell' ? planner.command : undefined;
}
