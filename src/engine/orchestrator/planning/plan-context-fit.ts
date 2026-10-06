import type { PlanProposal } from '../../../core/schemas/plan.js';
import { buildRoutingPreviewMetadata } from '../../routing-preview.js';
import { pathsNotFiles, pathsOutsideProject, type PlanTaskFit } from '../../spec/plan-checks.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { refreshCurrentCode } from '../task/refresh-code.js';

/**
 * BUILD's fit for every plan task, estimated with the code the task gets at dispatch, and the
 * routing reason of a task no implementer can take. A task that names a path outside the project,
 * or one that is not a regular file, gets no estimate; `checkPlan` refuses it.
 */
export async function estimatePlanContextFits(
  plan: PlanProposal,
  opts: Omit<Parameters<typeof buildRoutingPreviewMetadata>[1], 'plan'>,
): Promise<Map<string, PlanTaskFit>> {
  const tasks = await Promise.all(
    plan.tasks
      .filter(
        (spec) =>
          pathsOutsideProject(spec, opts.projectDir).length === 0 &&
          pathsNotFiles(spec, opts.projectDir).length === 0,
      )
      .map((spec) => refreshCurrentCode(taskFromSpec(spec, opts.projectDir), opts.projectDir)),
  );
  const metadata = await buildRoutingPreviewMetadata(tasks, {
    ...opts,
    plan: {
      summary: plan.summary,
      decisions: plan.decisions.map((text) => ({ text, taskId: null })),
      criteria: plan.criteria,
    },
  });
  return new Map(
    metadata.flatMap((item) =>
      item.contextFit === undefined
        ? []
        : [
            [
              item.taskId,
              {
                fit: item.contextFit,
                ...(item.routingBlockKind !== undefined && {
                  blocked: item.routingReason ?? item.routingBlockKind,
                }),
              },
            ] as const,
          ],
    ),
  );
}
