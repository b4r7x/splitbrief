import { assertCandidateFilesAbsent } from '../../../core/runners/candidate-admission.js';
import { cliAdmissionError } from '../../../core/runners/cli-admission-error.js';
import {
  ANTIGRAVITY_CLI_CANDIDATE_PATHS,
  CURSOR_CLI_CANDIDATE_PATHS,
  IMPLEMENTER_CLI_TOOL_IDS,
  PLANNER_CLI_TOOL_IDS,
} from '../../../core/runners/cli-tool-catalog.js';
import type { PlannerCliToolId, ImplementerCliToolId } from '../../../core/schemas/enums.js';
import { includes } from '../../../utils/type-guards.js';
import { runnerConfigError } from '../errors.js';
import { aiderImplementerAdapter, aiderPlannerAdapter } from './aider.js';
import { claudeCodeImplementerAdapter, claudeCodePlannerAdapter } from './claude-code.js';
import { codexImplementerAdapter, codexPlannerAdapter } from './codex.js';
import { copilotImplementerAdapter, copilotPlannerAdapter } from './copilot.js';
import { kiloImplementerAdapter, kiloPlannerAdapter } from './kilo-code.js';
import { opencodeImplementerAdapter, opencodePlannerAdapter } from './opencode.js';
import type { CliImplementerAdapter, CliPlannerAdapter } from './contract.js';

function assembleImplementerAdapters(): Record<ImplementerCliToolId, CliImplementerAdapter> {
  const adapters = {
    'claude-code': claudeCodeImplementerAdapter,
    codex: codexImplementerAdapter,
    opencode: opencodeImplementerAdapter,
    aider: aiderImplementerAdapter,
    copilot: copilotImplementerAdapter,
    'kilo-code': kiloImplementerAdapter,
  } satisfies Record<ImplementerCliToolId, CliImplementerAdapter>;

  assertCandidateFilesAbsent(
    [...CURSOR_CLI_CANDIDATE_PATHS, ...ANTIGRAVITY_CLI_CANDIDATE_PATHS],
    cliAdmissionError.omitRequiresAbsentSource,
  );

  return Object.freeze(adapters);
}

function assemblePlannerAdapters(): Record<PlannerCliToolId, CliPlannerAdapter> {
  return Object.freeze({
    'claude-code': claudeCodePlannerAdapter,
    codex: codexPlannerAdapter,
    opencode: opencodePlannerAdapter,
    aider: aiderPlannerAdapter,
    copilot: copilotPlannerAdapter,
    'kilo-code': kiloPlannerAdapter,
  });
}

export const CLI_PLANNER_ADAPTERS = assemblePlannerAdapters();
export const CLI_IMPLEMENTER_ADAPTERS = assembleImplementerAdapters();

export function lookupCliPlannerAdapter(toolId: string): CliPlannerAdapter {
  if (!includes(PLANNER_CLI_TOOL_IDS, toolId)) {
    throw runnerConfigError.missingToolConfig(toolId, 'planner');
  }
  return CLI_PLANNER_ADAPTERS[toolId];
}

export function lookupCliImplementerAdapter(toolId: string): CliImplementerAdapter {
  if (!includes(IMPLEMENTER_CLI_TOOL_IDS, toolId)) {
    throw runnerConfigError.missingToolConfig(toolId, 'implementer');
  }
  return CLI_IMPLEMENTER_ADAPTERS[toolId];
}
