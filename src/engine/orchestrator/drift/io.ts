import { join } from 'node:path';
import { DRIFT_REPORT_FILE, sessionDir } from '../../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../../lib/fs.js';
import { isDriftReport, type DriftReport } from '../../../core/schemas/drift.js';

export function driftReportPath(projectDir: string, sessionId: string): string {
  return join(sessionDir(projectDir, sessionId), DRIFT_REPORT_FILE);
}

export function writeDriftReport(projectDir: string, sessionId: string, report: DriftReport): void {
  writeSecureFile(driftReportPath(projectDir, sessionId), `${JSON.stringify(report, null, 2)}\n`);
}

export function readDriftReport(projectDir: string, sessionId: string): DriftReport | null {
  const raw = readJsonSafe(driftReportPath(projectDir, sessionId));
  if (raw === null) return null;
  if (!isDriftReport(raw)) return null;
  return { ...raw, briefHash: raw.briefHash ?? null };
}
