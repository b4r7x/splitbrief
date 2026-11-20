import type { ImplementerOptions, ImplementerResult } from '../types.js';
import type { RunnerCallResult } from '../../calls/types.js';
import type { BundleBaseline } from '../file-bundle/contract.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import type { createTranscriptBuffer } from '../../streaming/transcript-buffer.js';
import { summarizeChanges, type ChangeDetectorBaseline } from '../../change-detection.js';
import { runnerCallFailureMessage, runnerCallOutcome } from './call-result.js';
import { processImplementerOutput } from './extracted-code.js';
import { extractLastJsonObject } from '../../runners/extract-json.js';
import { readImplementerReport, type ImplementerReport } from '../../../core/schemas/consult.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { formatCheckoutChanges } from '../isolation/checkout-audit.js';
import { checkoutEscape, type CheckoutRead } from './checkout-guard.js';
import { applyBundleOutput } from './bundle-io.js';
import type { CallSeat } from './types.js';

/** An implementer call that returned a result, with what the call read before it ran. */
type ReturnedCall = Readonly<{
  opts: ImplementerOptions;
  callResult: RunnerCallResult;
  callId: string;
  startTime: number;
  implBuffer: ReturnType<typeof createTranscriptBuffer> | null;
  checkoutDir: string | undefined;
  checkoutBefore: CheckoutRead | undefined;
  baselines: readonly BundleBaseline[];
  oldContent: string | null;
  changeBaseline: ChangeDetectorBaseline | undefined;
}>;

/**
 * A returned call as the implementer's result: the isolation audit first, then
 * the call's own status, the direct writer's closing report and the files the
 * reply wrote.
 */
export async function callOutcome(seat: CallSeat, call: ReturnedCall): Promise<ImplementerResult> {
  const { opts, callResult, implBuffer } = call;
  const outputText = callResult.text;

  const escaped = await checkoutEscape(seat.publisher, opts, call.checkoutDir, call.checkoutBefore);
  if (escaped.length > 0) {
    implBuffer?.flush();
    const changes = formatCheckoutChanges(escaped);
    // A call the tripwire already stopped keeps its own evidence ahead of what the audit found.
    if (
      callResult.status !== 'completed' &&
      callResult.error.code === 'implementer-left-isolation'
    ) {
      const error = `${callResult.error.message}; ran while your checkout changed: ${changes}`;
      seat.failTask(opts, error);
      return {
        success: false,
        output: outputText,
        error,
        outcome: 'implementer-left-isolation',
      };
    }
    seat.failTask(opts, changes);
    return {
      success: false,
      output: outputText,
      error: changes,
      outcome: 'checkout-changed',
    };
  }

  if (callResult.status !== 'completed') {
    const error = runnerCallFailureMessage(callResult, opts.signal);
    if (callResult.status === 'aborted' && opts.signal?.aborted) {
      implBuffer?.flushInterrupted();
    } else {
      implBuffer?.flush();
      seat.failTask(opts, error);
    }
    const outcome = runnerCallOutcome(callResult);
    return {
      success: false,
      output: outputText,
      error,
      ...(outcome.state !== 'success' && { outcome: outcome.state }),
      ...(callResult.error.code === 'prompt-transport-error' && {
        transportError: callResult.error,
      }),
    };
  }

  implBuffer?.flush();

  const report = directReport(seat, opts, outputText);
  if (report?.status === 'blocked') {
    return {
      success: false,
      output: outputText,
      error: `Implementer is blocked: ${report.question}`,
      report,
      blocked: { question: report.question, filesNeeded: report.filesNeeded },
    };
  }
  return writeOutput(seat, call, outputText, report);
}

function directReport(
  seat: CallSeat,
  opts: ImplementerOptions,
  outputText: string,
): ImplementerReport | undefined {
  const { task, phase } = opts;
  // The direct writer's closing report is the last JSON object of the reply; a reply without
  // one changes nothing, and there is no repair call.
  const extracted =
    seat.outputContract === 'direct' ? extractLastJsonObject(outputText) : undefined;
  const read = extracted?.kind === 'ok' ? readImplementerReport(extracted.value) : undefined;
  if (phase && extracted?.kind === 'ok' && read === undefined) {
    seat.publisher?.publishWarning({
      phase,
      taskId: task.id,
      message: `Task ${task.id}: the implementer report has no "done" or "blocked" status, so SPLITBRIEF did not read it.`,
      safety: { category: 'implementer', code: 'implementer_report_unread' },
    });
  } else if (phase && read !== undefined && read.dropped.length > 0) {
    seat.publisher?.publishWarning({
      phase,
      taskId: task.id,
      message: `Task ${task.id}: the implementer report did not match its contract in ${read.dropped.join(', ')}; SPLITBRIEF kept the other fields.`,
      safety: { category: 'implementer', code: 'implementer_report_field_dropped' },
    });
  }
  return read?.report;
}

/** The files a completed reply wrote, read by the BUILD grammar of the seat. */
async function writeOutput(
  seat: CallSeat,
  call: ReturnedCall,
  outputText: string,
  report: ImplementerReport | undefined,
): Promise<ImplementerResult> {
  const { opts, changeBaseline, startTime } = call;
  const { task, projectDir, config, phase } = opts;

  let noChange = false;
  try {
    if (seat.outputContract === 'file-bundle-v1') {
      return await applyBundleOutput(seat, {
        opts,
        baselines: call.baselines,
        callId: call.callId,
        text: outputText,
        status: call.callResult.status,
        startTime,
      });
    }

    if (seat.outputContract === 'legacy-code-v1') {
      const result = await processImplementerOutput({
        text: outputText,
        task,
        projectDir,
        approvedBaselineContent: call.oldContent,
        approveWrite: opts.approveWrite,
      });
      if (!result.success) {
        seat.failTask(opts, result.error);
        return { success: false, output: outputText, error: result.error };
      }
      if (phase) {
        seat.publisher?.publishDone({
          phase,
          taskId: task.id,
          file: task.suggestedFiles[0],
          files: [task.suggestedFiles[0]],
          diff: result.diff,
          linesAdded: result.linesAdded,
          linesRemoved: result.linesRemoved,
          duration: Date.now() - startTime,
          kept: opts.continuation?.kept,
        });
      }
      return { success: true, output: outputText };
    }

    if (seat.detectChanges && changeBaseline) {
      const changes = await seat.detectChanges(projectDir, changeBaseline);
      noChange = !changes.changed;
      if (noChange && opts.allowNoChange !== true) {
        if (phase) {
          seat.publisher?.publishWarning({
            phase,
            taskId: task.id,
            message: `Implementer ${getRunnerCatalogDisplayName(config.implementer)} wrote nothing for task ${task.id}: ${changes.output}`,
            safety: {
              category: 'implementer',
              code: 'implementer_wrote_nothing',
            },
          });
        }
        seat.failTask(opts, changes.output);
        return {
          success: false,
          output: outputText,
          error: changes.output,
          outcome: 'no-staged-change',
        };
      }
    }
  } catch (err) {
    const error = toErrorMessage(err);
    seat.failTask(opts, error);
    return {
      success: false,
      output: outputText,
      error,
    };
  }

  if (phase && changeBaseline !== undefined) {
    const changes = await summarizeChanges(projectDir, changeBaseline, task.suggestedFiles);
    seat.publisher?.publishDone({
      phase,
      taskId: task.id,
      file: task.suggestedFiles[0],
      ...changes,
      duration: Date.now() - startTime,
      ...(noChange && { noChange: true }),
      kept: opts.continuation?.kept,
    });
  }
  return {
    success: true,
    output: outputText,
    ...(report !== undefined && { report }),
  };
}
