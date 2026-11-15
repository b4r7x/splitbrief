import { resolveApproveLevel, resolveEndChecks } from '../../../../core/config/runtime/resolve.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { Plan } from '../../../../core/schemas/plan.js';
import type { Check } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { readPackageScripts } from '../../../../core/readiness/repo-posture.js';
import { runCommand } from '../../../../lib/process/spawn/run-command.js';
import { parseShellCommand } from '../../../../utils/parse-shell-command.js';
import { runRenderCheck } from './render.js';
import { runCommandCheck } from './command.js';
import { runTestCheck } from './test.js';
import { buildStageContext, planTestCheck } from '../run.js';
import type { CheckRunResult, RunChecksOptions } from './types.js';

export function planApprovesNpmScripts(opts: {
  config: Config;
  state: Pick<WorkflowState, 'approve'>;
}): boolean {
  return resolveApproveLevel(opts.config) === 'plan' && opts.state.approve === 'plan';
}

/** The project gate the plan names as `cmd` checks `V1`, `V2`, … in its order. */
export function reviewCheckList(plan: Plan | undefined): Check[] {
  return (plan?.gate ?? []).map((command, index) => ({
    id: `V${index + 1}`,
    kind: 'cmd',
    value: command,
  }));
}

/** The reviewer checks a run may name: none while End-of-run checks are off. */
export function enabledReviewChecks(config: Config, plan: Plan | undefined): Check[] {
  return resolveEndChecks(config) ? reviewCheckList(plan) : [];
}

export function checkRegistry(
  opts: Pick<RunChecksOptions, 'task' | 'tasks' | 'plan' | 'reviewChecks'>,
): Map<string, Check> {
  return new Map(
    [
      ...(opts.plan?.checks ?? []),
      ...(opts.tasks ?? []).flatMap((task) => task.checks ?? []),
      ...(opts.task?.checks ?? []),
      ...(opts.reviewChecks ?? []),
    ].map((check) => [check.id, check]),
  );
}

export function createCheckRunner(opts: RunChecksOptions): (check: Check) => {
  command: string;
  run: () => Promise<CheckRunResult>;
} {
  const run = opts.runCommand ?? runCommand;
  const stageContext = buildStageContext({
    projectDir: opts.projectDir,
    config: opts.config,
    discoveredValidation: opts.discoveredValidation,
    notices: { bus: opts.bus, phase: opts.phase },
  });
  const packageScripts = readPackageScripts(opts.projectDir);
  const reviewIds = new Set((opts.reviewChecks ?? []).map((check) => check.id));
  return (check) => {
    if (check.kind === 'render') {
      return { command: '', run: () => runRenderCheck(check, opts, run) };
    }
    if (check.kind === 'cmd') {
      const files = opts.testFiles?.get(check.id);
      const planned = files === undefined ? null : planTestCheck(files, stageContext);
      const narrowed =
        planned?.kind === 'run' &&
        planned.narrowed &&
        parseShellCommand(check.value).join(' ') ===
          [planned.resolved.cmd, ...planned.resolved.args].join(' ')
          ? planned
          : null;
      return {
        command: narrowed?.command ?? check.value,
        run: () =>
          runCommandCheck(check, opts, run, packageScripts, reviewIds.has(check.id), narrowed),
      };
    }
    const planned = planTestCheck([check.value], stageContext);
    return {
      command: planned.kind === 'run' ? planned.command : '',
      run: () => runTestCheck(check, opts, run, planned),
    };
  };
}

export async function runChecks(
  checkIds: readonly string[],
  opts: RunChecksOptions,
  onStart?: (check: Check, command: string) => void,
): Promise<CheckRunResult[]> {
  const prepare = createCheckRunner(opts);
  const registry = checkRegistry(opts);
  const results: CheckRunResult[] = [];
  const seen = new Set<string>();
  for (const checkId of checkIds) {
    if (seen.has(checkId)) continue;
    seen.add(checkId);
    const check = registry.get(checkId);
    if (check === undefined) {
      results.push({ checkId, status: 'unknown', output: `no check ${checkId}` });
    } else {
      const prepared = prepare(check);
      onStart?.(check, prepared.command);
      results.push(await prepared.run());
    }
  }
  return results;
}
