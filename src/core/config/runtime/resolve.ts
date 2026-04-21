import type { Config } from '../../schemas/config.js';
import type { ApproveLevel, EffortLevel, WorkflowMode } from '../../schemas/enums.js';
import { DEFAULT_WORKFLOW_MODE } from '../../schemas/config.js';

/**
 * Resolve the effective workflow mode from config + optional CLI override.
 * Single source of truth for mode resolution per spec invariant §1.
 */
export function resolveMode(opts: {
  config: Config;
  cliOverride?: WorkflowMode | undefined;
}): WorkflowMode {
  if (opts.cliOverride) return opts.cliOverride;
  return opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE;
}

/**
 * Per-mode default approval gate. Spec §4.2.
 */
const MODE_DEFAULT_APPROVE: Record<WorkflowMode, ApproveLevel> = {
  instant: 'none',
  quick: 'none',
  standard: 'spec',
  speckit: 'all',
};

/**
 * Resolve the effective approve level from config + optional CLI override + mode default.
 * Single source of truth for approve-level resolution per spec invariant §2.
 */
export function resolveApproveLevel(opts: {
  mode: WorkflowMode;
  configApprove?: ApproveLevel | undefined;
  cliOverride?: ApproveLevel | undefined;
  legacyAutoFlag?: boolean | undefined;
}): ApproveLevel {
  if (opts.legacyAutoFlag) return 'none';
  if (opts.cliOverride && opts.cliOverride !== 'default') return opts.cliOverride;
  if (opts.configApprove && opts.configApprove !== 'default') return opts.configApprove;
  return MODE_DEFAULT_APPROVE[opts.mode];
}

export function blocksSpecGate(level: ApproveLevel): boolean {
  return level === 'spec' || level === 'all';
}

export function blocksPlanGate(level: ApproveLevel): boolean {
  return level === 'plan' || level === 'all';
}

/**
 * Resolve the effective planner effort hint from config + optional CLI override.
 * Single source of truth for effort-level resolution per spec invariant §3.
 */
export function resolveEffortLevel(opts: {
  config: Config;
  cliOverride?: EffortLevel | undefined;
}): EffortLevel | undefined {
  if (opts.cliOverride) return opts.cliOverride;
  return opts.config.planner.effort;
}
