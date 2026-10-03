import type { WorkflowOpts } from '../../../types/config-options.js';
import type { CLIOverrides } from './schema.js';

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
    reviewer: {
      tool: opts.reviewer,
      model: opts.reviewerModel,
      command: opts.reviewerCommand,
      apiBase: opts.reviewerApiBase,
      apiKey: opts.reviewerApiKeyEnv,
      args: opts.reviewerArgs,
      outputFormat: opts.reviewerOutputFormat,
      contextLength: opts.reviewerContextLength,
    },
    plannerEffort: opts.plannerEffort,
    reviewerEffort: opts.reviewerEffort,
    yolo: opts.yolo,
  };
}
