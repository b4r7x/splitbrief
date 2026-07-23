import { join } from 'node:path';
import { clearStaleSession } from '../../../core/sessions/guards.js';
import { beginSession } from '../../../core/sessions/lifecycle.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { collectReadiness } from '../../../core/readiness/collect.js';
import {
  createStartReadinessRecord,
  formatReadinessBlockers,
  readinessBlockerPointer,
} from '../../../core/readiness/format.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { READINESS_FILE, sessionDir } from '../../../core/paths.js';
import { writeSecureFile } from '../../../lib/fs.js';
import { cliError } from '../../errors.js';
import type { BootstrapSessionArgs, BootstrapSessionResult } from './types.js';

export function persistStartReadiness(ref: SessionRef, report: ReadinessReport): void {
  const record = createStartReadinessRecord(report);
  writeSecureFile(
    join(sessionDir(ref.projectDir, ref.sessionId), READINESS_FILE),
    JSON.stringify(record, null, 2) + '\n',
  );
}

export function assertReadinessCanStart(report: ReadinessReport, json: boolean | undefined): void {
  if (report.status !== 'blocked') return;
  if (!json) console.log(formatReadinessBlockers(report));
  throw cliError(readinessBlockerPointer(report), 1);
}

export function clearStaleSessionForCli(projectDir: string): void {
  try {
    clearStaleSession(projectDir);
  } catch (err) {
    if (sessionError.isStillActive(err)) {
      throw cliError(err.message, 1);
    }
    throw err;
  }
}

export async function bootstrapSession(
  args: BootstrapSessionArgs,
): Promise<BootstrapSessionResult> {
  const readiness = await collectReadiness({
    projectDir: args.projectDir,
    opts: args.opts,
    probeValidation: true,
    ...(args.defaultAutoApprove !== undefined && { defaultAutoApprove: args.defaultAutoApprove }),
  });
  args.emitReadiness(readiness.report);
  assertReadinessCanStart(readiness.report, args.assertJson);
  clearStaleSessionForCli(args.projectDir);
  const persistTranscript = readiness.config?.workflow.persistTranscript ?? true;
  const sessionId = beginSession(args.projectDir, args.feature, { persistTranscript });
  persistStartReadiness({ projectDir: args.projectDir, sessionId }, readiness.report);
  return { sessionId, readiness };
}
