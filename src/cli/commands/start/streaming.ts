import { ensureGitAndConfig } from '../../setup.js';
import { serializeReadinessReportJson } from '../../../core/readiness/format.js';
import { writeHeadlessJsonRecord } from '../../../engine/events/public-json.js';
import { releasePreparedExecutionOwnership } from '../../../engine/runners/prepared-execution.js';
import { createResponseWriter } from '../../rpc/writer.js';
import { prepareStartExecution } from './readiness.js';
import type { RequiredFeatureDispatchArgs } from './types.js';

export async function runJsonStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const execution = await prepareStartExecution({
    projectDir,
    feature: enrichedFeature ?? feature,
    plannerContext,
    opts,
    transport: 'json',
    defaultApprove: 'none',
    emitReadiness: (report) => {
      writeHeadlessJsonRecord({
        type: 'readiness_report',
        report: serializeReadinessReportJson(report),
      });
    },
    ...(deps.prepareExecution !== undefined && { prepare: deps.prepareExecution }),
  });
  releasePreparedExecutionOwnership(execution);
  await deps.runHeadless({ prepared: execution });
}

export async function runRpcStart(args: RequiredFeatureDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  await ensureGitAndConfig(projectDir);
  const execution = await prepareStartExecution({
    projectDir,
    feature: enrichedFeature ?? feature,
    plannerContext,
    opts,
    transport: 'rpc',
    emitReadiness: (report) => {
      createResponseWriter({ stream: process.stdout, onClose: () => {} }).status({
        type: 'readiness_report',
        report: serializeReadinessReportJson(report),
      });
    },
    ...(deps.prepareExecution !== undefined && { prepare: deps.prepareExecution }),
  });
  releasePreparedExecutionOwnership(execution);
  await deps.runRpc({ prepared: execution });
}
