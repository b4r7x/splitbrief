import { ensureGitAndConfig } from '../../setup.js';
import {
  formatReadinessBlockers,
  serializeReadinessReportJson,
} from '../../../core/readiness/format.js';
import { writeHeadlessJsonRecord } from '../../../engine/events/public-json.js';
import { releasePreparedExecutionOwnership } from '../../../engine/runners/prepared-execution.js';
import { prepareStartExecution } from './readiness.js';
import type { RequiredFeatureDispatchArgs } from './types.js';

/**
 * `--json` and `--plain` are two renderings of one headless run, so they share
 * this dispatch. Only the JSON rendering writes the readiness record on stdout:
 * the plain stream is one line per phase, so its blocker report goes to stderr
 * rather than nowhere — the thrown pointer tells the reader to resolve it.
 */
export async function runHeadlessStart(
  args: RequiredFeatureDispatchArgs & { mode: 'json' | 'plain' },
): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts, mode } = args;
  await ensureGitAndConfig(projectDir);
  const execution = await prepareStartExecution({
    projectDir,
    feature: enrichedFeature ?? feature,
    plannerContext,
    opts,
    transport: 'headless',
    defaultApprove: 'none',
    emitReadiness: (report) => {
      if (mode !== 'json') {
        if (report.counts.blocker > 0) process.stderr.write(`${formatReadinessBlockers(report)}\n`);
        return;
      }
      writeHeadlessJsonRecord({
        type: 'readiness_report',
        report: serializeReadinessReportJson(report),
      });
    },
    ...(deps.prepareExecution !== undefined && { prepare: deps.prepareExecution }),
  });
  releasePreparedExecutionOwnership(execution);
  await deps.runHeadless({ prepared: execution, ...(mode === 'plain' && { plain: true }) });
}
