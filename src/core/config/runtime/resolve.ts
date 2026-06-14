import type { Config } from '../../schemas/config.js';
import type { ApproveLevel, EffortLevel, WorkflowMode } from '../../schemas/enums.js';
import { DEFAULT_WORKFLOW_MODE } from '../../schemas/config.js';

export function resolveMode(opts: {
  config: Config;
  cliOverride?: WorkflowMode | undefined;
  savedMode?: WorkflowMode | undefined;
}): WorkflowMode {
  if (opts.cliOverride) return opts.cliOverride;
  if (opts.savedMode) return opts.savedMode;
  return opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE;
}

const MODE_DEFAULT_APPROVE: Record<WorkflowMode, ApproveLevel> = {
  instant: 'none',
  quick: 'none',
  standard: 'spec',
  speckit: 'all',
};

export function resolveApproveLevel(opts: {
  mode: WorkflowMode;
  configApprove?: ApproveLevel | undefined;
  cliOverride?: ApproveLevel | undefined;
  legacyAutoFlag?: boolean | undefined;
  savedApprove?: ApproveLevel | undefined;
}): ApproveLevel {
  if (opts.legacyAutoFlag) return 'none';
  if (opts.cliOverride && opts.cliOverride !== 'default') return opts.cliOverride;
  if (opts.configApprove && opts.configApprove !== 'default') return opts.configApprove;
  if (opts.savedApprove && opts.savedApprove !== 'default') return opts.savedApprove;
  return MODE_DEFAULT_APPROVE[opts.mode];
}

export function blocksSpecGate(level: ApproveLevel): boolean {
  return level === 'spec' || level === 'all';
}

export function blocksPlanGate(level: ApproveLevel): boolean {
  return level === 'plan' || level === 'all';
}

export function resolveEffortLevel(opts: {
  config: Config;
  cliOverride?: EffortLevel | undefined;
}): EffortLevel | undefined {
  if (opts.cliOverride) return opts.cliOverride;
  return opts.config.planner.effort;
}
