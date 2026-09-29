import { error } from '../../utils/error.js';
import type { RunnerCallResult } from '../calls/types.js';
import { stderrUsageLimit } from '../runners/usage-limit.js';

export function requireCompletedCall(result: RunnerCallResult): RunnerCallResult {
  let failed = result;
  if (result.status === 'completed') {
    // Nothing produced beside a usage limit on stderr is a call out of quota, the way the BUILD
    // seat's effect gate reads the same shape, so it fails with the limit's words, not silence.
    const produced = result.text.trim() !== '' || result.artifacts.length > 0;
    const limit = produced ? undefined : stderrUsageLimit(result.warnings);
    if (limit === undefined) return result;
    failed = {
      ...result,
      status: 'failed',
      error: { code: 'usage-limit', message: limit },
      partial: true,
    };
  }
  throw error('runner-call-failed', `Planner ${failed.role} call ${failed.status}`, {
    callId: failed.callId,
    role: failed.role,
    backendKind: failed.backendKind,
    status: failed.status,
    partial: failed.partial,
    error: failed.error,
  });
}
