import type { RunnerKind } from '../schemas/enums.js';
import {
  CLI_TOOL_TRUST,
  type CliToolId,
  type RunnerRole,
  type RunnerRoleTrustMetadata,
  type RunnerTrustMetadata,
} from './cli-tool-catalog.js';

type RunnerTrustConfig = { kind: 'cli'; tool: CliToolId } | { kind: Exclude<RunnerKind, 'cli'> };

const API_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: false,
  mayUseNetwork: true,
  mayWriteFilesDirectly: false,
  autoAllowFlags: [],
};

const COMMAND_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: true,
  autoAllowFlags: [],
};

const AGENT_SDK_PLANNER_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: false,
  mayUseNetwork: true,
  mayWriteFilesDirectly: false,
  autoAllowFlags: [],
};

const AGENT_SDK_IMPLEMENTER_TRUST: RunnerTrustMetadata = {
  executesLocalCommand: true,
  mayUseNetwork: true,
  mayWriteFilesDirectly: true,
  autoAllowFlags: [],
};

// Non-CLI kinds expose one role map. CLI trust is keyed by the catalog tool
// because permission flags and posture are tool-specific.
const RUNNER_KIND_TRUST = {
  cli: CLI_TOOL_TRUST,
  api: {
    planner: API_TRUST,
    implementer: API_TRUST,
  },
  shell: {
    planner: COMMAND_TRUST,
    implementer: COMMAND_TRUST,
  },
  agent: {
    planner: COMMAND_TRUST,
    implementer: COMMAND_TRUST,
  },
  'agent-sdk': {
    planner: AGENT_SDK_PLANNER_TRUST,
    implementer: AGENT_SDK_IMPLEMENTER_TRUST,
  },
} as const satisfies Record<RunnerKind, RunnerRoleTrustMetadata | typeof CLI_TOOL_TRUST>;

export function getRunnerTrustMeta(
  role: RunnerRole,
  runner: RunnerTrustConfig,
): RunnerTrustMetadata {
  if (runner.kind === 'cli') return CLI_TOOL_TRUST[runner.tool][role];
  return RUNNER_KIND_TRUST[runner.kind][role];
}
