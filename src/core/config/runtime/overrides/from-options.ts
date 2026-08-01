import type { Config } from '../../../schemas/config.js';
import type { WorkflowOpts } from '../../../types/config-options.js';
import type { WorkflowMode } from '../../../schemas/enums.js';
import { getWorkflowMode } from '../../accessors/values.js';
import type { CLIOverrides } from './schema.js';

export function resolveCliWorkflowMode(opts: WorkflowOpts, config: Config): WorkflowMode {
  return opts.mode ?? getWorkflowMode(config);
}

export function workflowOptsToCLIOverrides(opts: WorkflowOpts): CLIOverrides {
  return {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
      apiBase: opts.plannerApiBase,
      apiKey: opts.plannerApiKeyEnv,
      args: opts.plannerArgs,
      outputFormat: opts.plannerOutputFormat,
      contextLength: opts.plannerContextLength,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
      apiBase: opts.implementerApiBase,
      apiKey: opts.implementerApiKeyEnv,
      args: opts.implementerArgs,
      outputFormat: opts.implementerOutputFormat,
      contextLength: opts.implementerContextLength,
    },
    approve: opts.approve,
    mode: opts.mode,
    budget: opts.budget,
    plannerEffort: opts.plannerEffort,
    yolo: opts.yolo,
  };
}
