import { join } from 'node:path';
import { DRIFT_REPORT_FILE, sessionDir } from '../../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../../lib/fs.js';
import { DriftReportSchema, type DriftReport } from '../../../core/schemas/drift.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

export function driftReportPath(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), DRIFT_REPORT_FILE);
}

export function writeDriftReport(ref: SessionRef, report: DriftReport): void {
  writeSecureFile(driftReportPath(ref), `${JSON.stringify(report, null, 2)}\n`);
}

export function readDriftReport(ref: SessionRef): DriftReport | null {
  const raw = readJsonSafe(driftReportPath(ref));
  if (raw === null) return null;
  const parsed = DriftReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
